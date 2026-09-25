import { test, expect, type Page } from "@playwright/test";
import {
  blockDataStores,
  proxyExternalRequests,
  waitForForecastLoad,
  extractCacheEntry,
  canvasHasContent,
  getCanvasPixelSum,
  type CachedPoint,
  type CachedModelInput,
} from "./helpers.js";

/**
 * Fixed "now" for the feels-like test: a January NYC forecast, archived
 * (and so immutable) in every data store.
 */
const FEELS_LIKE_NOW = new Date("2026-01-15T14:00:00Z");

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
    await blockDataStores(page);
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
      // 3-hourly steps from the base model's init until 72h past now. GEFS
      // runs once a day and can be ~30h old before the next run lands, so
      // up to (30 + 72) / 3 + 1 = 35 steps.
      expect(points.length, `${varName} point count`).toBeGreaterThanOrEqual(20);
      expect(points.length, `${varName} point count`).toBeLessThanOrEqual(35);

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

      // Series reach the 72h horizon past now (fetched up to the first
      // lead time at or past it, so at most one 3h step beyond)
      const last = new Date(points[points.length - 1]!.time).getTime();
      const aheadH = (last - Date.now()) / (3600 * 1000);
      expect(aheadH, `${varName} reaches ~72h ahead`).toBeGreaterThanOrEqual(71);
      expect(aheadH, `${varName} reaches ~72h ahead`).toBeLessThanOrEqual(76);
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

    // ── Dew point (drives humidity / feels-like) ──

    const dewPoint = forecast.dewPoint as CachedPoint[];
    expect(dewPoint, "dew point should exist").toBeDefined();
    expect(dewPoint.length, "dew point point count").toBeGreaterThanOrEqual(20);
    const temp = forecast.temperature as CachedPoint[];
    for (let i = 0; i < dewPoint.length; i++) {
      const dp = dewPoint[i]!;
      if (dp.median == null) continue;
      // Dew point is a physical temperature in a sane range
      expect(dp.median, "dew point in range °C").toBeGreaterThan(-60);
      expect(dp.median).toBeLessThan(40);
      // Dew point cannot exceed air temperature (allow small blend/interp slack)
      const airTemp = temp[i]?.median;
      if (airTemp != null) {
        expect(dp.median, `dew point ≤ temperature at ${i}`).toBeLessThanOrEqual(airTemp + 1);
      }
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
    expect(aifs.isEnsemble).toBe(true);

    // Ensemble models should have uncertainty spread (min ≠ max for some valid points)
    const gefsValidPts = gefs.points.filter((pt) => pt.max != null && pt.min != null);
    const gefsHasSpread = gefsValidPts.some((pt) => pt.max - pt.min > 0.1);
    expect(gefsHasSpread, "GEFS should have ensemble spread").toBe(true);
    const ecmwfValidPts = ecmwf.points.filter((pt) => pt.max != null && pt.min != null);
    const ecmwfHasSpread = ecmwfValidPts.some((pt) => pt.max - pt.min > 0.1);
    expect(ecmwfHasSpread, "ECMWF should have ensemble spread").toBe(true);
    const aifsValidPts = aifs.points.filter((pt) => pt.max != null && pt.min != null);
    const aifsHasSpread = aifsValidPts.some((pt) => pt.max - pt.min > 0.1);
    expect(aifsHasSpread, "AIFS ENS should have ensemble spread").toBe(true);

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

    // Chart headers — once rendered, titles include the display unit
    // (except cloud cover, whose values are already percentages)
    const titles = page.locator(".chart-header h2");
    await expect(titles.nth(0)).toHaveText(/^Temperature \(°[FC]\)$/);
    await expect(titles.nth(1)).toHaveText(/^Precipitation \((in|mm)\/h\)$/);
    await expect(titles.nth(2)).toHaveText(/^Wind Speed \((mph|m\/s)\)$/);
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

  // ─── Test: Feels-like toggle and dew point overlay ──────────────────

  test("temperature chart supports feels-like mode and a dew point overlay", async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      // Start from known defaults so the toggles begin in the "actual" state
      localStorage.clear();
    });
    // "Feels like" only differs from air temperature in hot (heat index) or
    // cold and windy (wind chill) weather — in mild weather both charts are
    // pixel-identical. Pin the clock to a January morning so the app selects
    // an archived NYC winter forecast, where wind chill always applies,
    // instead of whatever today's weather happens to be.
    await page.clock.setFixedTime(FEELS_LIKE_NOW);
    await proxyExternalRequests(page);
    await page.goto("/?lat=40.75&lon=-74");
    await waitForForecastLoad(page);

    // Controls exist and default to actual temperature
    await expect(page.locator("#temp-actual-btn")).toHaveClass(/active/);
    await expect(page.locator("#temp-feels-btn")).not.toHaveClass(/active/);
    await expect(page.locator("#show-dewpoint")).not.toBeChecked();
    await expect(page.locator(".chart-header h2").first()).toHaveText(/^Temperature/);

    const actualSum = await getCanvasPixelSum(page, "temp-chart");

    // Switch to "feels like" — title changes and the chart re-renders
    await page.click("#temp-feels-btn");
    await expect(page.locator("#temp-feels-btn")).toHaveClass(/active/);
    await expect(page.locator("#temp-actual-btn")).not.toHaveClass(/active/);
    await expect(page.locator(".chart-header h2").first()).toHaveText(/^Feels Like/);
    await expect(async () => {
      const feelsSum = await getCanvasPixelSum(page, "temp-chart");
      expect(feelsSum).not.toBe(actualSum);
    }).toPass({ timeout: 5_000 });

    // Switch back to actual temperature
    await page.click("#temp-actual-btn");
    await expect(page.locator(".chart-header h2").first()).toHaveText(/^Temperature/);

    // Either button flips the mode, like the blend and view toggles: clicking
    // the already-active button switches to the other mode.
    await page.click("#temp-actual-btn");
    await expect(page.locator("#temp-feels-btn")).toHaveClass(/active/);
    await expect(page.locator("#temp-actual-btn")).not.toHaveClass(/active/);
    await expect(page.locator(".chart-header h2").first()).toHaveText(/^Feels Like/);
    await page.click("#temp-feels-btn");
    await expect(page.locator("#temp-actual-btn")).toHaveClass(/active/);
    await expect(page.locator(".chart-header h2").first()).toHaveText(/^Temperature/);

    // Enable the dew point overlay — chart re-renders with the extra line
    const beforeOverlay = await getCanvasPixelSum(page, "temp-chart");
    await page.locator("#show-dewpoint").check();
    await expect(page.locator("#show-dewpoint")).toBeChecked();
    await expect(async () => {
      const withOverlay = await getCanvasPixelSum(page, "temp-chart");
      expect(withOverlay).not.toBe(beforeOverlay);
    }).toPass({ timeout: 5_000 });
  });

  // ─── Test 6: Cache-based reload performance ─────────────────────────

  test("still loads when one model's data store is down", async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => localStorage.clear());
    await proxyExternalRequests(page);
    // Registered after the proxy, so it takes precedence for this store
    await page.route("**/dynamical-ecmwf-aifs-ens.s3.us-west-2.amazonaws.com/**", (route) =>
      route.abort("failed"),
    );
    await page.goto("/?lat=40.75&lon=-74");
    await waitForForecastLoad(page);

    await expect(page.locator("#error")).toHaveClass(/hidden/);
    for (const chartId of ["temp-chart", "precip-chart", "wind-chart", "cloud-chart"]) {
      expect(await canvasHasContent(page, chartId), `${chartId} rendered`).toBe(true);
    }
    // AIFS is marked unavailable and left out; the other models are blended
    const aifsLabel = page.locator(".model-checkbox", { has: page.locator("#model-aifs") });
    await expect(aifsLabel).toHaveClass(/unavailable/);
    await expect(page.locator("#model-aifs")).not.toBeChecked();
    const entry = await extractCacheEntry(page);
    const modelInputs = entry!.modelInputs as Record<string, CachedModelInput[]>;
    const models = modelInputs.temperature!.map((i) => i.model);
    expect(models).toContain("NOAA GEFS");
    expect(models).not.toContain("ECMWF AIFS");
  });

  test("cached forecast loads quickly on page reload", async ({ page }) => {
    test.setTimeout(60_000);

    expect(savedCacheJson).toBeTruthy();
    await page.addInitScript((json: string) => {
      localStorage.setItem("weather-cache", json);
    }, savedCacheJson!);
    // Proxy external requests (ZIP API) through Node.js
    await proxyExternalRequests(page);
    // Block Zarr data stores so cache is used without network validation
    await blockDataStores(page);

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
