import { test, expect, type Page } from "@playwright/test";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Make model controls visible and interactive without loading real forecast data */
async function showModelControls(page: Page) {
  await page.evaluate(() => {
    // Show the forecast container and model controls
    document.getElementById("forecast")!.classList.remove("hidden");
    document.getElementById("model-controls")!.classList.remove("hidden");
  });
}

/** Block all Zarr store requests */
async function blockZarrRequests(page: Page) {
  await page.route("**/data.dynamical.org/**", (route) =>
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

/** Build per-model forecast points with distinct values per model */
function makeModelPoints(base: number) {
  const now = Date.now();
  return Array.from({ length: 24 }, (_, i) => ({
    time: new Date(now + i * 3 * 3600_000).toISOString(),
    hoursFromNow: i * 3,
    median: base + Math.sin(i) * 2,
    p10: base - 2,
    p90: base + 2,
    min: base - 4,
    max: base + 4,
  }));
}

/** Build mock cache entry matching ZIP 10001 (40.75, -74.00) */
function buildCacheEntry() {
  const now = Date.now();
  const initTime = new Date(now - 3600_000).toISOString(); // 1 hour ago
  // Blended points (average of models)
  const points = makeModelPoints(15);
  // Per-model data with DIFFERENT values so toggling models changes the chart
  const gefsPoints = makeModelPoints(10); // cooler
  const ecmwfPoints = makeModelPoints(20); // warmer
  const variables = ["temperature", "precipitation", "windSpeed", "cloudCover"] as const;
  const modelInputs: Record<string, Array<{ model: string; points: typeof points; isEnsemble: boolean }>> = {};
  for (const v of variables) {
    modelInputs[v] = [
      { model: "NOAA GEFS", points: v === "temperature" ? gefsPoints : points, isEnsemble: true },
      { model: "ECMWF IFS ENS", points: v === "temperature" ? ecmwfPoints : points, isEnsemble: true },
    ];
  }
  return {
    timestamp: now,
    forecast: {
      location: { latitude: 40.75, longitude: -74.0 },
      initTime,
      temperature: points,
      precipitation: points.map((p) => ({ ...p, median: 0.5, p10: 0, p90: 1.5, min: 0, max: 3 })),
      windSpeed: points.map((p) => ({ ...p, median: 4, p10: 2, p90: 7, min: 1, max: 12 })),
      cloudCover: points.map((p) => ({ ...p, median: 0.5, p10: 0.2, p90: 0.8, min: 0.1, max: 0.95 })),
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

/** Seed localStorage with a cached forecast for ZIP 10001 */
async function seedCache(page: Page) {
  const entry = buildCacheEntry();
  await page.addInitScript((entryJson) => {
    const store: Record<string, unknown> = {};
    store["40.75,-74.00"] = JSON.parse(entryJson);
    localStorage.setItem("weather-cache", JSON.stringify(store));
  }, JSON.stringify(entry));
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe("model selection controls", () => {
  test.beforeEach(async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");
    // Clear localStorage so tests start fresh
    await page.evaluate(() => {
      localStorage.removeItem("enabled-models");
      localStorage.removeItem("magic-blend");
    });
  });

  test("model controls are hidden initially before forecast loads", async ({
    page,
  }) => {
    await expect(page.locator("#model-controls")).toHaveClass(/hidden/);
  });

  test("all three model checkboxes exist", async ({ page }) => {
    await showModelControls(page);

    await expect(page.locator("#model-gefs")).toBeAttached();
    await expect(page.locator("#model-hrrr")).toBeAttached();
    await expect(page.locator("#model-ecmwf")).toBeAttached();
  });

  test("all checkboxes are checked by default", async ({ page }) => {
    await showModelControls(page);

    await expect(page.locator("#model-gefs")).toBeChecked();
    await expect(page.locator("#model-hrrr")).toBeChecked();
    await expect(page.locator("#model-ecmwf")).toBeChecked();
  });

  test("blend toggle buttons exist with Magic Blend active by default", async ({
    page,
  }) => {
    await showModelControls(page);

    await expect(page.locator("#magic-blend-btn")).toBeVisible();
    await expect(page.locator("#equal-blend-btn")).toBeVisible();
    await expect(page.locator("#magic-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#equal-blend-btn")).not.toHaveClass(/active/);
  });

  test("can uncheck a model checkbox", async ({ page }) => {
    await showModelControls(page);

    await page.locator("#model-gefs").uncheck();

    await expect(page.locator("#model-gefs")).not.toBeChecked();
    await expect(page.locator("#model-hrrr")).toBeChecked();
    await expect(page.locator("#model-ecmwf")).toBeChecked();
  });

  test("can select only HRRR as the sole model", async ({ page }) => {
    await showModelControls(page);

    // Uncheck GEFS and ECMWF, leaving only HRRR
    await page.locator("#model-gefs").uncheck();
    await page.locator("#model-ecmwf").uncheck();

    await expect(page.locator("#model-gefs")).not.toBeChecked();
    await expect(page.locator("#model-hrrr")).toBeChecked();
    await expect(page.locator("#model-ecmwf")).not.toBeChecked();
  });

  test("cannot deselect the last remaining model", async ({ page }) => {
    await showModelControls(page);

    // Uncheck two models
    await page.locator("#model-gefs").uncheck();
    await page.locator("#model-ecmwf").uncheck();

    // Try to uncheck the last one (HRRR) — should stay checked
    await page.locator("#model-hrrr").click();

    await expect(page.locator("#model-hrrr")).toBeChecked();
  });

  test("can re-check a previously unchecked model", async ({ page }) => {
    await showModelControls(page);

    await page.locator("#model-gefs").uncheck();
    await expect(page.locator("#model-gefs")).not.toBeChecked();

    await page.locator("#model-gefs").check();
    await expect(page.locator("#model-gefs")).toBeChecked();
  });

  test("clicking Equal Blend activates it and deactivates Magic Blend", async ({
    page,
  }) => {
    await showModelControls(page);

    await page.locator("#equal-blend-btn").click();

    await expect(page.locator("#equal-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#magic-blend-btn")).not.toHaveClass(/active/);
  });

  test("clicking Magic Blend after Equal restores Magic Blend", async ({
    page,
  }) => {
    await showModelControls(page);

    await page.locator("#equal-blend-btn").click();
    await page.locator("#magic-blend-btn").click();

    await expect(page.locator("#magic-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#equal-blend-btn")).not.toHaveClass(/active/);
  });

  test("blend toggle is disabled when only one model is selected", async ({
    page,
  }) => {
    await showModelControls(page);

    await page.locator("#model-gefs").uncheck();
    await page.locator("#model-hrrr").uncheck();

    // Only ECMWF remains — blend toggle should be disabled
    await expect(page.locator("#magic-blend-btn")).toBeDisabled();
    await expect(page.locator("#equal-blend-btn")).toBeDisabled();
  });

  test("blend toggle re-enables when second model is checked", async ({
    page,
  }) => {
    await showModelControls(page);

    // Get down to one model
    await page.locator("#model-gefs").uncheck();
    await page.locator("#model-hrrr").uncheck();
    await expect(page.locator("#magic-blend-btn")).toBeDisabled();

    // Re-enable a second model
    await page.locator("#model-gefs").check();
    await expect(page.locator("#magic-blend-btn")).toBeEnabled();
    await expect(page.locator("#equal-blend-btn")).toBeEnabled();
  });

  test("model selection persists across page reloads", async ({ page }) => {
    await showModelControls(page);

    // Uncheck GEFS
    await page.locator("#model-gefs").uncheck();
    await expect(page.locator("#model-gefs")).not.toBeChecked();

    // Reload (don't clear localStorage this time)
    await page.goto("/");
    await showModelControls(page);

    // GEFS should still be unchecked
    await expect(page.locator("#model-gefs")).not.toBeChecked();
    await expect(page.locator("#model-hrrr")).toBeChecked();
    await expect(page.locator("#model-ecmwf")).toBeChecked();
  });

  test("blend mode persists across page reloads", async ({ page }) => {
    await showModelControls(page);

    await page.locator("#equal-blend-btn").click();
    await expect(page.locator("#equal-blend-btn")).toHaveClass(/active/);

    // Reload (don't clear localStorage this time)
    await page.goto("/");
    await showModelControls(page);

    await expect(page.locator("#equal-blend-btn")).toHaveClass(/active/);
    await expect(page.locator("#magic-blend-btn")).not.toHaveClass(/active/);
  });
});

test.describe("model controls with cached forecast", () => {
  test("model controls are visible when forecast loads from cache", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await seedCache(page);
    await page.goto("/");

    // Submit ZIP to trigger loadForecast with cached data
    await page.fill("#zip-input", "10001");
    await page.click('#zip-form button[type="submit"]');

    // Forecast should render from cache
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/);

    // Model controls should be visible
    await expect(page.locator("#model-controls")).toBeVisible();
    await expect(page.locator("#model-checkboxes")).toBeVisible();
    await expect(page.locator("#blend-toggle")).toBeVisible();
  });

  test("available model checkboxes are checked when loading from cache", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await seedCache(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");
    await page.click('#zip-form button[type="submit"]');

    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/);
    await expect(page.locator("#model-gefs")).toBeChecked();
    // HRRR is unavailable in the cached entry (non-CONUS location)
    await expect(page.locator("#model-hrrr")).not.toBeChecked();
    await expect(page.locator("#model-ecmwf")).toBeChecked();
  });

  test("blend toggle buttons are visible and Magic Blend is active when loading from cache", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await seedCache(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");
    await page.click('#zip-form button[type="submit"]');

    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/);
    await expect(page.locator("#magic-blend-btn")).toBeVisible();
    await expect(page.locator("#equal-blend-btn")).toBeVisible();
    await expect(page.locator("#magic-blend-btn")).toHaveClass(/active/);
  });

  test("model controls visible on auto-load from URL with cache", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await seedCache(page);

    // Navigate with ZIP in URL — triggers auto-load from cache
    await page.goto("/?zip=10001");

    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator("#model-controls")).toBeVisible();
    await expect(page.locator("#model-checkboxes")).toBeVisible();
    await expect(page.locator("#blend-toggle")).toBeVisible();
    await expect(page.locator("#magic-blend-btn")).toBeVisible();
    await expect(page.locator("#equal-blend-btn")).toBeVisible();
  });

  test("unchecking a model immediately changes the chart when loaded from cache", async ({
    page,
  }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await seedCache(page);

    await page.goto("/?zip=10001");
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForTimeout(300);

    // Capture chart pixel data with all models enabled
    const pixelsBefore = await page.evaluate(() => {
      const canvas = document.getElementById("temp-chart") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Hash: sum of all pixel values as a simple fingerprint
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]!;
      return sum;
    });

    // Uncheck GEFS — with per-model data cached, this should change the chart
    // (GEFS has temp base 10, ECMWF has base 20 — removing GEFS shifts the blend)
    await page.click("#model-gefs");
    await page.waitForTimeout(300);

    const pixelsAfter = await page.evaluate(() => {
      const canvas = document.getElementById("temp-chart") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]!;
      return sum;
    });

    // Chart content should have changed
    expect(pixelsAfter).not.toBe(pixelsBefore);
  });
});

test.describe("model controls sticky behavior", () => {
  test("model controls stick to top when scrolling", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    // Make the page tall enough to scroll by showing forecast and controls
    await page.evaluate(() => {
      document.getElementById("forecast")!.classList.remove("hidden");
      document.getElementById("model-controls")!.classList.remove("hidden");
    });

    // Verify model controls have sticky positioning
    const position = await page.locator("#model-controls").evaluate((el) => {
      return getComputedStyle(el).position;
    });
    expect(position).toBe("sticky");

    // Verify top is 0
    const top = await page.locator("#model-controls").evaluate((el) => {
      return getComputedStyle(el).top;
    });
    expect(top).toBe("0px");
  });
});

test.describe("model controls mobile layout", () => {
  test("forecast-meta-bar is centered on mobile", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    await page.evaluate(() => {
      document.getElementById("forecast-meta-bar")!.classList.remove("hidden");
      document.getElementById("init-time-label")!.textContent =
        "Forecast initialized Mar 18, 2:00 AM EDT";
    });

    const justifyContent = await page
      .locator("#forecast-meta-bar")
      .evaluate((el) => {
        return getComputedStyle(el).justifyContent;
      });
    expect(justifyContent).toBe("center");
  });

  test("model controls stack vertically on mobile", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await showModelControls(page);

    const flexDirection = await page
      .locator("#model-controls")
      .evaluate((el) => {
        return getComputedStyle(el).flexDirection;
      });
    expect(flexDirection).toBe("column");
  });

  test("model checkboxes are centered on mobile", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await showModelControls(page);

    const justifyContent = await page
      .locator("#model-checkboxes")
      .evaluate((el) => {
        return getComputedStyle(el).justifyContent;
      });
    expect(justifyContent).toBe("center");
  });

  test("blend toggle is centered on mobile", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await showModelControls(page);

    const justifyContent = await page
      .locator("#blend-toggle")
      .evaluate((el) => {
        return getComputedStyle(el).justifyContent;
      });
    expect(justifyContent).toBe("center");
  });
});
