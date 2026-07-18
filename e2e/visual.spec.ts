import { test, expect, type Page } from "@playwright/test";
import { blockDataStores, proxyExternalRequests, waitForForecastLoad } from "./helpers.js";

/**
 * Visual regression tests.
 *
 * These tests screenshot the fully rendered app and compare against
 * committed baseline images (e2e/visual.spec.ts-snapshots/). Real forecast
 * data is fetched from the dynamical.org archives, but "now" is pinned to a
 * fixed timestamp so the app deterministically selects the same archived
 * init_time on every run (see findLatestInitIndex in src/weather.ts) and
 * every time-derived pixel (x-axis labels, past-dimming, day/night shading,
 * aberration phrasing) is identical run to run.
 *
 * To update baselines after an intentional visual change:
 *   npx playwright test e2e/visual.spec.ts --update-snapshots
 * then commit the regenerated PNGs alongside the code change.
 */

/**
 * The fixed "now". All four data stores (GEFS, ECMWF IFS, AIFS, HRRR)
 * archive their forecasts indefinitely, so data at/before this date is
 * immutable. Latest init times selected at this instant:
 *   GEFS 2026-06-10T00Z · ECMWF IFS 2026-06-10T00Z ·
 *   AIFS 2026-06-10T12Z · HRRR 2026-06-10T12Z
 */
const FIXED_NOW = new Date("2026-06-10T13:00:00Z");

/** Grid-aligned NYC coordinates (0.25° GEFS grid point) */
const LOCATION_QUERY = "/?lat=40.75&lon=-74";

// Baselines are rendered on Linux (CI and Claude's environment). Skip
// elsewhere so macOS dev machines don't fail on missing platform snapshots.
test.skip(
  process.platform !== "linux",
  "visual baselines are generated on Linux; run in CI or a Linux container",
);

// Pin everything that affects rendering: timezone and locale drive the
// x-axis/init-time labels, viewport drives canvas dimensions.
test.use({
  timezoneId: "America/New_York",
  locale: "en-US",
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
});

const CHART_IDS = ["temp-chart", "precip-chart", "wind-chart", "cloud-chart"] as const;

test.describe("visual snapshots", () => {
  test.describe.configure({ mode: "serial" });

  /** Real forecast cache saved by the first test, reused by later tests */
  let savedCacheJson: string | null = null;

  /** Pin the clock and load the app with real data fetched from the archives. */
  async function loadFresh(page: Page): Promise<void> {
    await page.clock.setFixedTime(FIXED_NOW);
    await proxyExternalRequests(page);
    await page.goto(LOCATION_QUERY);
    await waitForForecastLoad(page);
  }

  /** Pin the clock and load the app from the cache saved by the first test. */
  async function loadFromCache(page: Page): Promise<void> {
    expect(savedCacheJson, "first test must populate savedCacheJson").toBeTruthy();
    await page.clock.setFixedTime(FIXED_NOW);
    await page.addInitScript((json: string) => {
      localStorage.setItem("weather-cache", json);
    }, savedCacheJson!);
    // Block the data stores — the cached forecast must render identically
    // without any network, and background refresh checks fail silently.
    await blockDataStores(page);
    await page.goto(LOCATION_QUERY);
    await waitForForecastLoad(page, 30_000);
  }

  test("blended forecast page and charts match baseline", async ({ page }) => {
    test.setTimeout(240_000);
    await loadFresh(page);

    // Each chart canvas individually — tight, focused diffs
    for (const id of CHART_IDS) {
      await expect(page.locator(`#${id}`)).toHaveScreenshot(`${id}-blended.png`);
    }

    // Full page — catches layout, aberration cards, controls, footer
    await expect(page).toHaveScreenshot("forecast-page.png", { fullPage: true });

    savedCacheJson = await page.evaluate(() => localStorage.getItem("weather-cache"));
    expect(savedCacheJson).toBeTruthy();
  });

  test("metric units render matches baseline", async ({ page }) => {
    test.setTimeout(120_000);
    await loadFromCache(page);

    await page.click("#metric-btn");
    await expect(page.locator("#metric-btn")).toHaveClass(/active/);

    await expect(page.locator("#temp-chart")).toHaveScreenshot("temp-chart-metric.png");
    await expect(page.locator("#wind-chart")).toHaveScreenshot("wind-chart-metric.png");
  });

  test("per-model view matches baseline", async ({ page }) => {
    test.setTimeout(120_000);
    await loadFromCache(page);

    await page.click("#per-model-view-btn");
    await expect(page.locator("#per-model-view-btn")).toHaveClass(/active/);

    await expect(page.locator("#temp-chart")).toHaveScreenshot("temp-chart-per-model.png");
    await expect(page.locator("#precip-chart")).toHaveScreenshot("precip-chart-per-model.png");
  });
});
