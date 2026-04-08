import { test, expect, type Page } from "@playwright/test";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Block all data store requests */
async function blockZarrRequests(page: Page) {
  await page.route("**/data.dynamical.org/**", (route) =>
    route.abort("blockedbyclient"),
  );
  await page.route("**/*.s3.us-west-2.amazonaws.com/**", (route) =>
    route.abort("blockedbyclient"),
  );
}

/** Mock the zippopotam.us API for ZIP code lookups */
async function mockZipApi(page: Page) {
  await page.route("**/api.zippopotam.us/**", (route, request) => {
    const url = request.url();
    if (url.includes("/us/10001")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          "post code": "10001",
          country: "United States",
          places: [
            {
              "place name": "New York",
              state: "New York",
              latitude: "40.7484",
              longitude: "-73.9967",
            },
          ],
        }),
      });
    }
    return route.fulfill({ status: 404 });
  });
}

/** Build forecast points with fixed values across all timesteps */
function makePoints(opts: {
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}) {
  const now = Date.now();
  return Array.from({ length: 24 }, (_, i) => ({
    time: new Date(now + i * 3 * 3600_000).toISOString(),
    hoursFromNow: i * 3,
    ...opts,
  }));
}

/**
 * Build a cache entry with specific cloud cover and wind speed ranges.
 * Temperature and precipitation use safe defaults.
 */
function buildEdgeCaseCache(overrides: {
  cloudCover: { median: number; p10: number; p90: number; min: number; max: number };
  windSpeed: { median: number; p10: number; p90: number; min: number; max: number };
}) {
  const now = Date.now();
  const initTime = new Date(now - 3600_000).toISOString();
  const tempPoints = makePoints({ median: 15, p10: 13, p90: 17, min: 11, max: 19 });

  const variables = ["temperature", "precipitation", "windSpeed", "cloudCover"] as const;
  const modelInputs: Record<string, Array<{ model: string; points: typeof tempPoints; isEnsemble: boolean }>> = {};
  for (const v of variables) {
    modelInputs[v] = [
      { model: "NOAA GEFS", points: tempPoints, isEnsemble: true },
    ];
  }

  return {
    timestamp: now,
    forecast: {
      location: { latitude: 40.75, longitude: -74.0 },
      initTime,
      temperature: tempPoints,
      precipitation: makePoints({ median: 0.5, p10: 0, p90: 1.5, min: 0, max: 3 }),
      windSpeed: makePoints(overrides.windSpeed),
      cloudCover: makePoints(overrides.cloudCover),
    },
    recentWeather: {
      avgTemperature: 12,
      avgPrecipitation: 0.1,
      avgWindSpeed: 3,
      avgCloudCover: 0.4,
    },
    modelInputs,
    hrrrAvailable: false,
  };
}

/** Seed localStorage with a cached forecast */
async function seedCache(page: Page, entry: ReturnType<typeof buildEdgeCaseCache>) {
  await page.addInitScript((entryJson) => {
    const store: Record<string, unknown> = {};
    store["40.75,-74.00"] = JSON.parse(entryJson);
    localStorage.setItem("weather-cache", JSON.stringify(store));
  }, JSON.stringify(entry));
}

/**
 * Scan a rendered canvas and find the topmost and bottommost rows that
 * contain pixels matching a given chart colour (within tolerance).
 * Only scans within the chart drawing area's x-bounds to avoid matching
 * axis labels, time markers, or other annotations outside the chart.
 */
async function getChartPixelBounds(page: Page, canvasId: string, chartColor: string) {
  return page.evaluate(
    ({ canvasId, chartColor }) => {
      const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { width, height } = canvas;
      const imageData = ctx.getImageData(0, 0, width, height);
      const pixels = imageData.data;

      const r0 = parseInt(chartColor.slice(1, 3), 16);
      const g0 = parseInt(chartColor.slice(3, 5), 16);
      const b0 = parseInt(chartColor.slice(5, 7), 16);

      // Compute the chart area x-bounds in canvas pixels.
      // Only scan within these to avoid matching axis labels and markers.
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const compact = rect.width < 400;
      const paddingLeft = (compact ? 40 : 50) * dpr;
      const paddingRight = (compact ? 8 : 16) * dpr;
      const xStart = Math.ceil(paddingLeft) + 1; // slightly inset to avoid axis line
      const xEnd = Math.floor(width - paddingRight) - 1;

      let topmost = height;
      let bottommost = 0;

      for (let y = 0; y < height; y++) {
        for (let x = xStart; x <= xEnd; x++) {
          const idx = (y * width + x) * 4;
          const r = pixels[idx]!;
          const g = pixels[idx + 1]!;
          const b = pixels[idx + 2]!;
          const a = pixels[idx + 3]!;

          if (a < 5) continue;

          // Check if the pixel colour is close to the chart colour.
          // Bands use the same hue at lower alpha, so on a transparent
          // canvas the RGB values match exactly. Use tight tolerance (30)
          // to avoid matching axis labels (#8b8fa3) or the "now" text.
          const dr = Math.abs(r - r0);
          const dg = Math.abs(g - g0);
          const db = Math.abs(b - b0);

          if (dr < 30 && dg < 30 && db < 30) {
            if (y < topmost) topmost = y;
            if (y > bottommost) bottommost = y;
          }
        }
      }

      return { topmost, bottommost, canvasHeight: height, canvasWidth: width };
    },
    { canvasId, chartColor },
  );
}

/** Get the chart area boundaries in canvas pixel coordinates */
async function getChartBounds(page: Page, canvasId: string) {
  return page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const compact = rect.width < 400;
    const paddingTop = 10;
    const paddingBottom = compact ? 28 : 32;
    return {
      chartTop: paddingTop * dpr,
      chartBottom: (rect.height - paddingBottom) * dpr,
      dpr,
    };
  }, canvasId);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe("chart y-axis clamping", () => {
  test("cloud cover graph lines stay within chart area when data spans 0–100%", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    const entry = buildEdgeCaseCache({
      cloudCover: { median: 0.5, p10: 0.05, p90: 0.95, min: 0.0, max: 1.0 },
      windSpeed: { median: 4, p10: 2, p90: 7, min: 1, max: 12 },
    });
    await seedCache(page, entry);

    await page.goto("/?zip=10001");
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForTimeout(500);

    const bounds = await getChartPixelBounds(page, "cloud-chart", "#b0bec5");
    const chart = await getChartBounds(page, "cloud-chart");

    // Graph pixels must not extend above chart top or below chart bottom.
    // Allow 2px tolerance for anti-aliasing and line width.
    expect(bounds.topmost).toBeGreaterThanOrEqual(chart.chartTop - 2);
    expect(bounds.bottommost).toBeLessThanOrEqual(chart.chartBottom + 2);
  });

  test("cloud cover graph lines stay within chart area when data is at boundaries", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    // All values at 1.0 — a flat line at the very top
    const entry = buildEdgeCaseCache({
      cloudCover: { median: 1.0, p10: 1.0, p90: 1.0, min: 1.0, max: 1.0 },
      windSpeed: { median: 4, p10: 2, p90: 7, min: 1, max: 12 },
    });
    await seedCache(page, entry);

    await page.goto("/?zip=10001");
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForTimeout(500);

    const bounds = await getChartPixelBounds(page, "cloud-chart", "#b0bec5");
    const chart = await getChartBounds(page, "cloud-chart");

    expect(bounds.topmost).toBeGreaterThanOrEqual(chart.chartTop - 2);
    expect(bounds.bottommost).toBeLessThanOrEqual(chart.chartBottom + 2);
  });

  test("wind speed graph lines do not extend below chart area", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    // Wind data with min at 0
    const entry = buildEdgeCaseCache({
      cloudCover: { median: 0.5, p10: 0.2, p90: 0.8, min: 0.1, max: 0.95 },
      windSpeed: { median: 2, p10: 0.5, p90: 4, min: 0, max: 6 },
    });
    await seedCache(page, entry);

    await page.goto("/?zip=10001");
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForTimeout(500);

    const bounds = await getChartPixelBounds(page, "wind-chart", "#81c784");
    const chart = await getChartBounds(page, "wind-chart");

    // Wind graph should not extend below the chart area
    expect(bounds.bottommost).toBeLessThanOrEqual(chart.chartBottom + 2);
  });

  test("wind speed graph lines stay in bounds when all values are zero", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    // All wind values at 0 — flat line at bottom
    const entry = buildEdgeCaseCache({
      cloudCover: { median: 0.5, p10: 0.2, p90: 0.8, min: 0.1, max: 0.95 },
      windSpeed: { median: 0, p10: 0, p90: 0, min: 0, max: 0 },
    });
    await seedCache(page, entry);

    await page.goto("/?zip=10001");
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForTimeout(500);

    const bounds = await getChartPixelBounds(page, "wind-chart", "#81c784");
    const chart = await getChartBounds(page, "wind-chart");

    expect(bounds.topmost).toBeGreaterThanOrEqual(chart.chartTop - 2);
    expect(bounds.bottommost).toBeLessThanOrEqual(chart.chartBottom + 2);
  });
});
