import { test, expect, type Page } from "@playwright/test";
import { ProxyAgent } from "undici";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create an undici ProxyAgent if HTTPS_PROXY is set in the environment */
function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

/**
 * Route all external (non-localhost) requests through Node.js fetch
 * with proxy support. This bypasses browser CORS restrictions and
 * proxy authentication issues while keeping all data real.
 */
async function proxyExternalRequests(page: Page): Promise<void> {
  const dispatcher = getProxyDispatcher();
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    async (route) => {
      try {
        const request = route.request();
        const response = await fetch(request.url(), {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() || undefined,
          dispatcher,
        } as RequestInit);
        const body = Buffer.from(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          headers[key] = value;
        }
        await route.fulfill({ status: response.status, headers, body });
      } catch {
        await route.abort("failed");
      }
    },
  );
}

/**
 * Wait for a complete forecast to load and render.
 * Works for both fresh network loads and cache-based loads.
 * Detects error states early and provides a clear failure message.
 */
async function waitForForecastLoad(page: Page, timeout = 120_000): Promise<void> {
  // Wait for app to reach a terminal state: success or error
  await page.waitForFunction(
    () => {
      const error = document.getElementById("error");
      const forecast = document.getElementById("forecast");
      const initTime = document.getElementById("init-time-label");
      const btn = document.getElementById("geolocate-btn") as HTMLButtonElement | null;
      const controls = document.getElementById("model-controls");
      if (!error || !forecast || !initTime || !btn || !controls) return false;
      // Error state reached
      if (!error.classList.contains("hidden")) return true;
      // Full success: forecast visible, init time set, buttons enabled, controls visible
      return (
        !forecast.classList.contains("hidden") &&
        initTime.textContent !== "" &&
        !btn.disabled &&
        !controls.classList.contains("hidden")
      );
    },
    { timeout },
  );

  // Check for error
  const errorVisible = !(await page
    .locator("#error")
    .evaluate((el) => el.classList.contains("hidden")));
  if (errorVisible) {
    const msg = await page.locator("#error").textContent();
    throw new Error(`Forecast failed to load: ${msg}`);
  }

  // Wait for chart canvas to render
  await page.waitForFunction(
    () => {
      const canvas = document.getElementById("temp-chart") as HTMLCanvasElement | null;
      if (!canvas) return false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const { width, height } = canvas;
      if (width === 0 || height === 0) return false;
      const data = ctx.getImageData(0, 0, width, height).data;
      let nonTransparent = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i]! > 0) nonTransparent++;
      }
      return nonTransparent > width * height * 0.01;
    },
    { timeout: 30_000 },
  );
}

/** Extract the first cache entry from localStorage. */
async function extractCacheEntry(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("weather-cache");
    if (!raw) return null;
    const store = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(store);
    if (keys.length === 0) return null;
    return store[keys[0]!] as Record<string, unknown>;
  });
}

/** Check whether a canvas has non-trivial rendered content (≥1% non-transparent pixels). */
async function canvasHasContent(page: Page, canvasId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let nonTransparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 0) nonTransparent++;
    }
    return nonTransparent > width * height * 0.01;
  }, canvasId);
}

/** Get a pixel-sum fingerprint for a canvas (for change detection). */
async function getCanvasPixelSum(page: Page, canvasId: string): Promise<number> {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]!;
    return sum;
  }, canvasId);
}

/** Shape of a forecast data point extracted from cache */
interface CachedPoint {
  time: string;
  hoursFromNow: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

/** Shape of a per-model input extracted from cache */
interface CachedModelInput {
  model: string;
  points: CachedPoint[];
  isEnsemble: boolean;
}

// ── Tests: serial group with shared real data ───────────────────────────

test.describe("real forecast integration", () => {
  test.describe.configure({ mode: "serial" });

  /** Real forecast cache JSON saved by the first test, re-used by subsequent tests */
  let savedCacheJson: string | null = null;

  /**
   * Load the app with cached real forecast data and blocked data-store requests.
   * The ZIP API is proxied through Node.js; Zarr stores are blocked to prevent
   * background refresh interference during interaction testing.
   */
  async function loadFromCache(page: Page): Promise<void> {
    expect(savedCacheJson, "first test must populate savedCacheJson").toBeTruthy();
    await page.addInitScript((json: string) => {
      localStorage.setItem("weather-cache", json);
    }, savedCacheJson!);
    // Proxy the ZIP API through Node.js (bypasses browser CORS)
    await proxyExternalRequests(page);
    // Block Zarr data stores to prevent background refresh from interfering
    await page.route("**/data.dynamical.org/**", (route) => route.abort("blockedbyclient"));
    await page.route("**/*.s3.us-west-2.amazonaws.com/**", (route) =>
      route.abort("blockedbyclient"),
    );
    await page.goto("/?zip=10001");
    await waitForForecastLoad(page, 30_000);
  }

  // ─── Test 1: Full forecast load + data integrity ────────────────────

  test("loads complete forecast via ZIP and validates data integrity", async ({ page }) => {
    test.setTimeout(180_000);

    await page.addInitScript(() => localStorage.clear());
    await proxyExternalRequests(page);
    await page.goto("/?zip=10001");
    await waitForForecastLoad(page);

    // ── UI state ──

    const locationLabel = await page.locator("#location-label").textContent();
    expect(locationLabel).toContain("10001");
    expect(locationLabel).toMatch(/\d+\.\d+°[NS]/);
    expect(locationLabel).toMatch(/\d+\.\d+°[EW]/);

    const initTimeText = await page.locator("#init-time-label").textContent();
    expect(initTimeText).toMatch(/Forecast initialized/);

    await expect(page.locator("#model-controls")).toBeVisible();
    await expect(page.locator("#model-gefs")).toBeChecked();
    await expect(page.locator("#model-ecmwf")).toBeChecked();
    await expect(page.locator("#model-aifs")).toBeChecked();
    await expect(page.locator("#magic-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#blended-view-btn")).toHaveClass(/active/);

    // URL should reflect the ZIP
    expect(page.url()).toContain("zip=10001");

    // ── Extract forecast data from cache ──

    const cached = await extractCacheEntry(page);
    expect(cached).not.toBeNull();

    const forecast = cached!.forecast as Record<string, unknown>;
    expect(forecast).toBeDefined();

    // Location near NYC
    const location = forecast.location as { latitude: number; longitude: number };
    expect(location.latitude).toBeGreaterThan(40);
    expect(location.latitude).toBeLessThan(41.5);
    expect(location.longitude).toBeGreaterThan(-75);
    expect(location.longitude).toBeLessThan(-73);

    // Init time within last 48 hours
    const initTime = forecast.initTime as string;
    const hoursAgo = (Date.now() - new Date(initTime).getTime()) / (3600 * 1000);
    expect(hoursAgo).toBeGreaterThanOrEqual(0);
    expect(hoursAgo).toBeLessThan(48);

    // ── Validate all four forecast variables ──

    const variables = ["temperature", "precipitation", "windSpeed", "cloudCover"] as const;

    for (const varName of variables) {
      const points = forecast[varName] as CachedPoint[];
      expect(points, `${varName} should exist`).toBeDefined();
      expect(points.length, `${varName} point count`).toBeGreaterThanOrEqual(20);
      expect(points.length).toBeLessThanOrEqual(30);

      // Quantile ordering: min ≤ p10 ≤ median ≤ p90 ≤ max
      // (skip points with null/NaN values — JSON serialization converts NaN to null)
      let validPointCount = 0;
      for (let i = 0; i < points.length; i++) {
        const pt = points[i]!;
        if (pt.min == null || pt.max == null || pt.median == null) continue;
        validPointCount++;
        expect(pt.min, `${varName}[${i}] min ≤ p10`).toBeLessThanOrEqual(pt.p10 + 0.01);
        expect(pt.p10, `${varName}[${i}] p10 ≤ median`).toBeLessThanOrEqual(pt.median + 0.01);
        expect(pt.median, `${varName}[${i}] median ≤ p90`).toBeLessThanOrEqual(pt.p90 + 0.01);
        expect(pt.p90, `${varName}[${i}] p90 ≤ max`).toBeLessThanOrEqual(pt.max + 0.01);
      }
      // At least 80% of points should have valid quantile data
      expect(validPointCount, `${varName} valid points`).toBeGreaterThan(points.length * 0.8);

      // Chronological order
      for (let i = 1; i < points.length; i++) {
        const t1 = new Date(points[i - 1]!.time).getTime();
        const t2 = new Date(points[i]!.time).getTime();
        expect(t2, `${varName} times ordered`).toBeGreaterThan(t1);
      }

      // Points ~3 hours apart (some models use 6h for later lead times)
      for (let i = 1; i < points.length; i++) {
        const gapH =
          (new Date(points[i]!.time).getTime() - new Date(points[i - 1]!.time).getTime()) /
          (3600 * 1000);
        expect(gapH, `${varName} gap ~3h`).toBeGreaterThan(2);
        expect(gapH).toBeLessThan(7);
      }

      // Time span ~72 hours
      const first = new Date(points[0]!.time).getTime();
      const last = new Date(points[points.length - 1]!.time).getTime();
      const spanH = (last - first) / (3600 * 1000);
      expect(spanH, `${varName} spans ~72h`).toBeGreaterThan(60);
      expect(spanH).toBeLessThanOrEqual(80);
    }

    // ── Variable-specific value ranges (skip null/NaN points) ──

    for (const pt of forecast.temperature as CachedPoint[]) {
      if (pt.median == null) continue;
      expect(pt.median, "temp in range °C").toBeGreaterThan(-50);
      expect(pt.median).toBeLessThan(55);
    }
    for (const pt of forecast.precipitation as CachedPoint[]) {
      if (pt.min == null) continue;
      expect(pt.min, "precip ≥ 0").toBeGreaterThanOrEqual(-0.01);
    }
    for (const pt of forecast.windSpeed as CachedPoint[]) {
      if (pt.min == null || pt.median == null) continue;
      expect(pt.min, "wind ≥ 0").toBeGreaterThanOrEqual(-0.01);
      expect(pt.median, "wind < 100 m/s").toBeLessThan(100);
    }
    for (const pt of forecast.cloudCover as CachedPoint[]) {
      if (pt.min == null || pt.max == null) continue;
      expect(pt.min, "cloud ≥ 0").toBeGreaterThanOrEqual(-0.01);
      expect(pt.max, "cloud ≤ 1").toBeLessThanOrEqual(1.05);
    }

    // ── Per-model inputs ──

    const modelInputs = cached!.modelInputs as Record<string, CachedModelInput[]>;
    expect(modelInputs).toBeDefined();

    for (const varName of variables) {
      expect(modelInputs[varName], `modelInputs.${varName}`).toBeDefined();
      expect(modelInputs[varName]!.length, `${varName} ≥3 models`).toBeGreaterThanOrEqual(3);

      const models = modelInputs[varName]!.map((m) => m.model);
      expect(models).toContain("NOAA GEFS");
      expect(models).toContain("ECMWF IFS ENS");
      expect(models).toContain("ECMWF AIFS");
    }

    // Ensemble flags
    const gefs = modelInputs.temperature!.find((m) => m.model === "NOAA GEFS")!;
    expect(gefs.isEnsemble).toBe(true);
    const ecmwf = modelInputs.temperature!.find((m) => m.model === "ECMWF IFS ENS")!;
    expect(ecmwf.isEnsemble).toBe(true);
    const aifs = modelInputs.temperature!.find((m) => m.model === "ECMWF AIFS")!;
    expect(aifs.isEnsemble).toBe(false);

    // Ensemble models should have uncertainty spread (min ≠ max for some valid points)
    const gefsValidPts = gefs.points.filter((pt) => pt.max != null && pt.min != null);
    const gefsHasSpread = gefsValidPts.some((pt) => pt.max - pt.min > 0.1);
    expect(gefsHasSpread, "GEFS should have ensemble spread").toBe(true);
    const ecmwfValidPts = ecmwf.points.filter((pt) => pt.max != null && pt.min != null);
    const ecmwfHasSpread = ecmwfValidPts.some((pt) => pt.max - pt.min > 0.1);
    expect(ecmwfHasSpread, "ECMWF should have ensemble spread").toBe(true);

    // Deterministic models should have no spread (min ≈ max) for valid points
    const aifsValidPts = aifs.points.filter((pt) => pt.max != null && pt.min != null);
    const aifsNoSpread = aifsValidPts.every((pt) => Math.abs(pt.max - pt.min) < 0.01);
    expect(aifsNoSpread, "AIFS should have no ensemble spread").toBe(true);

    // Per-model data should also pass basic range checks
    for (const input of modelInputs.temperature!) {
      expect(input.points.length, `${input.model} temp points`).toBeGreaterThanOrEqual(10);
      for (const pt of input.points) {
        if (pt.median == null) continue;
        expect(pt.median, `${input.model} temp range`).toBeGreaterThan(-50);
        expect(pt.median).toBeLessThan(55);
      }
    }

    // ── Save cache for subsequent tests ──

    savedCacheJson = await page.evaluate(() => localStorage.getItem("weather-cache"));
    expect(savedCacheJson).toBeTruthy();
  });

  // ─── Test 2: Chart rendering ────────────────────────────────────────

  test("renders all four charts with real forecast data", async ({ page }) => {
    test.setTimeout(60_000);
    await loadFromCache(page);

    for (const chartId of ["temp-chart", "precip-chart", "wind-chart", "cloud-chart"]) {
      const hasContent = await canvasHasContent(page, chartId);
      expect(hasContent, `${chartId} should have rendered content`).toBe(true);
    }

    // Chart headers
    const titles = page.locator(".chart-header h2");
    await expect(titles.nth(0)).toHaveText("Temperature");
    await expect(titles.nth(1)).toHaveText("Precipitation");
    await expect(titles.nth(2)).toHaveText("Wind Speed");
    await expect(titles.nth(3)).toHaveText("Cloud Cover");

    // All chart canvases should have reasonable dimensions
    for (const chartId of ["temp-chart", "precip-chart", "wind-chart", "cloud-chart"]) {
      const dims = await page.evaluate((id) => {
        const c = document.getElementById(id) as HTMLCanvasElement;
        return { w: c.width, h: c.height };
      }, chartId);
      expect(dims.w, `${chartId} width`).toBeGreaterThan(100);
      expect(dims.h, `${chartId} height`).toBeGreaterThan(50);
    }
  });

  // ─── Test 3: Unit toggle ────────────────────────────────────────────

  test("unit toggle changes chart rendering and aberration text", async ({ page }) => {
    test.setTimeout(60_000);
    await loadFromCache(page);

    // Default is imperial
    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);

    const imperialSum = await getCanvasPixelSum(page, "temp-chart");

    // Switch to metric
    await page.click("#metric-btn");
    await expect(page.locator("#metric-btn")).toHaveClass(/active/);
    await expect(page.locator("#imperial-btn")).not.toHaveClass(/active/);

    // Temperature chart should re-render (different scale: °F vs °C)
    await expect(async () => {
      const metricSum = await getCanvasPixelSum(page, "temp-chart");
      expect(metricSum).not.toBe(imperialSum);
    }).toPass({ timeout: 5_000 });

    // Wind chart should also change (mph vs m/s)
    const windImperialSum = await getCanvasPixelSum(page, "wind-chart");
    await page.click("#imperial-btn");
    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);

    await expect(async () => {
      const windRestoredSum = await getCanvasPixelSum(page, "wind-chart");
      // Switching back should produce different pixels than metric view
      // (we switched back to imperial, so it should match original)
      expect(windRestoredSum).not.toBe(windImperialSum);
    }).toPass({ timeout: 5_000 });

    // If aberrations exist, verify they use the correct unit text
    const cardCount = await page.locator(".aberration-card").count();
    if (cardCount > 0) {
      // Currently in imperial
      const imperialText = await page.locator("#aberrations").textContent();
      if (imperialText?.includes("°")) {
        expect(imperialText).toContain("°F");
      }

      // Switch to metric and verify
      await page.click("#metric-btn");
      const metricText = await page.locator("#aberrations").textContent();
      if (metricText?.includes("°")) {
        expect(metricText).toContain("°C");
        expect(metricText).not.toContain("°F");
      }
    }
  });

  // ─── Test 4: Model selection and view modes ─────────────────────────

  test("model selection and view mode changes affect chart rendering", async ({ page }) => {
    test.setTimeout(60_000);
    await loadFromCache(page);

    // ── Model toggling ──

    const initialSum = await getCanvasPixelSum(page, "temp-chart");

    // Uncheck ECMWF — removes one model from blend, should change chart
    await page.locator("#model-ecmwf").uncheck();
    await expect(page.locator("#model-ecmwf")).not.toBeChecked();

    await expect(async () => {
      const afterUncheck = await getCanvasPixelSum(page, "temp-chart");
      expect(afterUncheck).not.toBe(initialSum);
    }).toPass({ timeout: 5_000 });

    // Re-check ECMWF — chart should restore to approximately original
    await page.locator("#model-ecmwf").check();
    await expect(page.locator("#model-ecmwf")).toBeChecked();

    await expect(async () => {
      const afterRecheck = await getCanvasPixelSum(page, "temp-chart");
      // Allow 0.1% tolerance for sub-pixel rendering variations
      expect(Math.abs(afterRecheck - initialSum)).toBeLessThan(initialSum * 0.001);
    }).toPass({ timeout: 5_000 });

    // ── Per-model view mode ──

    await page.click("#per-model-view-btn");
    await expect(page.locator("#per-model-view-btn")).toHaveClass(/active/);

    // Chart should look different in per-model view
    await expect(async () => {
      const perModelSum = await getCanvasPixelSum(page, "temp-chart");
      expect(perModelSum).not.toBe(initialSum);
    }).toPass({ timeout: 5_000 });

    // Blend toggle hidden in per-model view
    await expect(page.locator("#blend-toggle")).toHaveClass(/hidden/);

    // Model labels colored as legend in per-model view
    const gefsColor = await page.evaluate(() => {
      const cb = document.getElementById("model-gefs");
      return cb?.parentElement?.querySelector("span")?.style.color ?? "";
    });
    expect(gefsColor).not.toBe("");

    // Switch back to blended
    await page.click("#blended-view-btn");
    await expect(page.locator("#blended-view-btn")).toHaveClass(/active/);
    await expect(page.locator("#blend-toggle")).not.toHaveClass(/hidden/);

    // Chart should return to approximately blended state
    await expect(async () => {
      const blendedSum = await getCanvasPixelSum(page, "temp-chart");
      expect(Math.abs(blendedSum - initialSum)).toBeLessThan(initialSum * 0.001);
    }).toPass({ timeout: 5_000 });

    // ── Blend mode toggle ──

    const magicSum = await getCanvasPixelSum(page, "temp-chart");

    await page.click("#equal-blend-btn");
    await expect(page.locator("#equal-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#magic-blend-btn")).not.toHaveClass(/active/);

    // Switching blend modes may or may not change pixels
    // (depends on whether accuracy data produces different weights),
    // but the button state must be correct

    // Switch back to magic blend
    await page.click("#magic-blend-btn");
    await expect(page.locator("#magic-blend-btn")).toHaveClass(/active/);

    await expect(async () => {
      const restoredSum = await getCanvasPixelSum(page, "temp-chart");
      expect(Math.abs(restoredSum - magicSum)).toBeLessThan(magicSum * 0.001);
    }).toPass({ timeout: 5_000 });
  });

  // ─── Test 5: Aberrations and info panel ─────────────────────────────

  test("aberrations and info panel display correctly with real data", async ({ page }) => {
    test.setTimeout(60_000);
    await loadFromCache(page);

    // Aberrations section exists
    await expect(page.locator("#aberrations")).toBeAttached();

    const cardCount = await page.locator(".aberration-card").count();
    if (cardCount > 0) {
      for (let i = 0; i < cardCount; i++) {
        const card = page.locator(".aberration-card").nth(i);
        // Each card has an icon
        const icon = card.locator(".aberration-icon");
        await expect(icon).toBeVisible();
        const iconText = await icon.textContent();
        expect(iconText!.length).toBeGreaterThan(0);
        // Each card has message text (longer than just the icon)
        const cardText = await card.textContent();
        expect(cardText!.length).toBeGreaterThan(2);
        // Card has a type class (warm, cool, rain, danger)
        const classes = await card.getAttribute("class");
        expect(classes).toMatch(/warm|cool|rain|danger/);
      }
    }

    // ── Info panel ──

    await expect(page.locator("#info-panel")).toHaveClass(/hidden/);
    await page.click("#info-toggle");
    await expect(page.locator("#info-panel")).not.toHaveClass(/hidden/);

    // Blend weights should be populated with real accuracy data
    const weightsText = await page.locator("#blend-weights-info").textContent();
    expect(weightsText).toMatch(/Magic Blend weights/);
    expect(weightsText).toContain("GEFS");
    // Weights should contain percentage values
    expect(weightsText).toMatch(/\d+%/);

    await page.click("#info-toggle");
    await expect(page.locator("#info-panel")).toHaveClass(/hidden/);
  });

  // ─── Test 6: Cache-based reload performance ─────────────────────────

  test("cached forecast loads quickly on page reload", async ({ page }) => {
    test.setTimeout(60_000);

    expect(savedCacheJson).toBeTruthy();
    await page.addInitScript((json: string) => {
      localStorage.setItem("weather-cache", json);
    }, savedCacheJson!);
    // Proxy external requests (ZIP API) through Node.js
    await proxyExternalRequests(page);
    // Block Zarr data stores so cache is used without network validation
    await page.route("**/data.dynamical.org/**", (route) => route.abort("blockedbyclient"));
    await page.route("**/*.s3.us-west-2.amazonaws.com/**", (route) =>
      route.abort("blockedbyclient"),
    );

    const start = Date.now();
    await page.goto("/?zip=10001");
    await waitForForecastLoad(page, 30_000);
    const elapsed = Date.now() - start;

    // Cached load should be fast — well under 30 seconds
    expect(elapsed).toBeLessThan(30_000);

    // Data should match what was cached
    const cached = await extractCacheEntry(page);
    expect(cached).not.toBeNull();
    const forecast = cached!.forecast as Record<string, unknown>;
    const temp = forecast.temperature as CachedPoint[];
    expect(temp.length).toBeGreaterThanOrEqual(20);

    // Location label should show ZIP
    const label = await page.locator("#location-label").textContent();
    expect(label).toContain("10001");
  });
});

// ── Separate test: Geolocation flow ───────────────────────────────────

test("loads forecast via browser geolocation with real API data", async ({ page, context }) => {
  test.setTimeout(180_000);

  await page.addInitScript(() => localStorage.clear());
  await proxyExternalRequests(page);

  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 40.7484, longitude: -73.9967 });

  await page.goto("/");
  await page.click("#geolocate-btn");
  await waitForForecastLoad(page);

  // Location label shows coordinates without ZIP
  const label = await page.locator("#location-label").textContent();
  expect(label).toMatch(/40\.\d+/);
  expect(label).not.toContain("10001");

  // Validate loaded data
  const cached = await extractCacheEntry(page);
  expect(cached).not.toBeNull();

  const forecast = cached!.forecast as Record<string, unknown>;
  const location = forecast.location as { latitude: number; longitude: number };
  expect(location.latitude).toBeGreaterThan(40);
  expect(location.latitude).toBeLessThan(41.5);

  // Temperature data integrity (skip null/NaN points)
  const temp = forecast.temperature as CachedPoint[];
  expect(temp.length).toBeGreaterThanOrEqual(20);
  for (const pt of temp) {
    if (pt.min == null || pt.median == null) continue;
    expect(pt.min).toBeLessThanOrEqual(pt.p10 + 0.01);
    expect(pt.p10).toBeLessThanOrEqual(pt.median + 0.01);
    expect(pt.median).toBeLessThanOrEqual(pt.p90 + 0.01);
    expect(pt.p90).toBeLessThanOrEqual(pt.max + 0.01);
    expect(pt.median).toBeGreaterThan(-50);
    expect(pt.median).toBeLessThan(55);
  }

  // Precipitation non-negative
  const precip = forecast.precipitation as CachedPoint[];
  for (const pt of precip) {
    if (pt.min == null) continue;
    expect(pt.min).toBeGreaterThanOrEqual(-0.01);
  }

  // Wind speed non-negative
  const wind = forecast.windSpeed as CachedPoint[];
  for (const pt of wind) {
    if (pt.min == null) continue;
    expect(pt.min).toBeGreaterThanOrEqual(-0.01);
  }

  // Cloud cover 0-1
  const cloud = forecast.cloudCover as CachedPoint[];
  for (const pt of cloud) {
    if (pt.min == null || pt.max == null) continue;
    expect(pt.min).toBeGreaterThanOrEqual(-0.01);
    expect(pt.max).toBeLessThanOrEqual(1.05);
  }

  // Per-model inputs should exist
  const modelInputs = cached!.modelInputs as Record<string, CachedModelInput[]>;
  expect(modelInputs).toBeDefined();
  expect(modelInputs.temperature!.length).toBeGreaterThanOrEqual(3);
  const models = modelInputs.temperature!.map((m) => m.model);
  expect(models).toContain("NOAA GEFS");
  expect(models).toContain("ECMWF IFS ENS");
  expect(models).toContain("ECMWF AIFS");

  // Model controls visible
  await expect(page.locator("#model-controls")).toBeVisible();
  await expect(page.locator("#model-gefs")).toBeChecked();
});
