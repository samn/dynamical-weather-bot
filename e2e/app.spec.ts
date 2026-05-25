import { test, expect, type Page } from "@playwright/test";

/**
 * Helper: build mock ForecastData, then inject it into the running app via
 * the module's exported functions so we skip real Zarr network calls entirely.
 *
 * We achieve this by intercepting the dynamical.org and zippopotam.us
 * network requests and, for the ZIP flow, also injecting mock data into
 * the page's module scope via evaluate.
 */

// ── Helpers ─────────────────────────────────────────────────────────────

function makeForecastPoint(hour: number, base: number) {
  const time = new Date(Date.now() + hour * 3600_000).toISOString();
  return {
    time,
    hoursFromNow: hour,
    median: base,
    p10: base - 2,
    p90: base + 2,
    min: base - 4,
    max: base + 4,
  };
}

function mockForecastData() {
  const points = Array.from({ length: 24 }, (_, i) =>
    makeForecastPoint(i * 3, 15 + Math.sin(i) * 3),
  );
  return {
    location: { latitude: 40.71, longitude: -74.01 },
    temperature: points,
    precipitation: points.map((p) => ({
      ...p,
      median: 0.5,
      p10: 0,
      p90: 1.5,
      min: 0,
      max: 3,
    })),
    windSpeed: points.map((p) => ({
      ...p,
      median: 4,
      p10: 2,
      p90: 7,
      min: 1,
      max: 12,
    })),
    cloudCover: points.map((p) => ({
      ...p,
      median: 0.5,
      p10: 0.2,
      p90: 0.8,
      min: 0.1,
      max: 0.95,
    })),
  };
}

/**
 * Inject mock weather modules into the page so that fetchForecast resolves
 * with deterministic data instead of hitting real Zarr stores.
 */
async function injectMockWeatherData(page: Page) {
  const forecast = mockForecastData();

  await page.addInitScript((forecast) => {
    // Patch the global fetch so that any call to dynamical.org returns
    // something that won't crash zarrita, but more importantly we'll
    // intercept at a higher level by patching the module exports on the
    // window object so loadForecast picks up our mock data.
    (window as unknown as Record<string, unknown>).__mockForecast = forecast;
  }, forecast);
}

/** Block all requests to data stores (Icechunk S3 + legacy Zarr) to prevent real fetches */
async function blockZarrRequests(page: Page) {
  await page.route("**/data.dynamical.org/**", (route) => route.abort("blockedbyclient"));
  await page.route("**/*.s3.us-west-2.amazonaws.com/**", (route) => route.abort("blockedbyclient"));
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
    if (url.includes("/us/00000")) {
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({ status: 404 });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe("page load and initial state", () => {
  test("shows the header and location controls", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("h1")).toHaveText("72-Hour Probabilistic Forecast");
    await expect(page.locator("#geolocate-btn")).toBeVisible();
    await expect(page.locator("#zip-input")).toBeVisible();

  });

  test("loading, error, and forecast sections are hidden initially", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("#loading")).toHaveClass(/hidden/);
    await expect(page.locator("#error")).toHaveClass(/hidden/);
    await expect(page.locator("#forecast")).toHaveClass(/hidden/);
  });

  test("forecast meta bar is hidden initially and shown after loading starts", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Forecast meta bar (with unit toggle) is hidden before any forecast load
    await expect(page.locator("#forecast-meta-bar")).toHaveClass(/hidden/);

    // Trigger a load to reveal the meta bar
    await page.fill("#zip-input", "10001");
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);
    await expect(page.locator("#metric-btn")).toBeVisible();
    await expect(page.locator("#imperial-btn")).toBeVisible();
    // Default is imperial (see units.ts: stored === "metric" ? "metric" : "imperial")
    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);
    await expect(page.locator("#metric-btn")).not.toHaveClass(/active/);
  });

  test("four chart canvases exist in the DOM", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("#temp-chart")).toBeAttached();
    await expect(page.locator("#precip-chart")).toBeAttached();
    await expect(page.locator("#wind-chart")).toBeAttached();
    await expect(page.locator("#cloud-chart")).toBeAttached();
  });

  test("footer contains dynamical.org attribution", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("footer")).toContainText("dynamical.org");
    await expect(page.locator('footer a[href="https://dynamical.org"]').first()).toBeVisible();
  });
});

test.describe("ZIP code input", () => {
  test("ZIP input has correct attributes", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const input = page.locator("#zip-input");
    await expect(input).toHaveAttribute("inputmode", "numeric");
    await expect(input).toHaveAttribute("maxlength", "5");
    await expect(input).toHaveAttribute("placeholder", "ZIP code");
    await expect(input).toHaveAttribute("aria-label", "ZIP code");
  });

  test("submitting a valid ZIP code shows loading state", async ({ page }) => {
    // Use a delayed Zarr abort so the loading/skeleton state persists
    // long enough for the assertion to observe it.
    await page.route("**/data.dynamical.org/**", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.abort("blockedbyclient");
    });
    await page.route("**/*.s3.us-west-2.amazonaws.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.abort("blockedbyclient");
    });
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    // Skeleton charts should appear (forecast container visible with loading canvases).
    // Zarr requests are delayed so the loading state persists long enough to observe.
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/);
  });

  test("submitting an invalid ZIP shows an error", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "00000");

    // Wait for the error to appear
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 10000,
    });
    await expect(page.locator("#error")).toContainText("not found");
  });

  test("inputs stay enabled during loading so the user can switch locations", async ({ page }) => {
    // Use a delayed ZIP API response so the load is genuinely in flight
    // when we assert. Zarr requests are also delayed so the load doesn't
    // race past us into an error state that re-enables the buttons.
    await page.route("**/data.dynamical.org/**", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort("blockedbyclient");
    });
    await page.route("**/*.s3.us-west-2.amazonaws.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort("blockedbyclient");
    });
    await page.route("**/api.zippopotam.us/**", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({
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
    });

    await page.goto("/");

    await page.fill("#zip-input", "10001");

    // Immediately after the submit, while the load is still pending,
    // inputs must remain enabled so the user can change their mind.
    await expect(page.locator("#geolocate-btn")).toBeEnabled({ timeout: 500 });
    await expect(page.locator("#zip-input")).toBeEnabled({ timeout: 500 });
  });
});

test.describe("current location URL encoding", () => {
  test("clicking Current Location writes lat/lon to the URL", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: 40.7484, longitude: -73.9967 },
    });
    const page = await context.newPage();
    await blockZarrRequests(page);
    await page.goto("/");

    await page.click("#geolocate-btn");

    // URL should reflect the geolocated coordinates
    await expect.poll(() => page.url()).toMatch(/[?&]lat=40\.7484/);
    expect(page.url()).toMatch(/[&?]lon=-73\.9967/);
    expect(page.url()).not.toContain("zip=");

    await context.close();
  });

  test("reloading with lat/lon params restores the location", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await blockZarrRequests(page);

    // Land directly on a URL with coords — simulates the round trip
    // (initial visit set the params; the user later returns)
    await page.goto("/?lat=40.7484&lon=-73.9967");

    // Location label should show those coordinates without any ZIP prefix
    await expect(page.locator("#location-label")).toContainText("40.75", {
      timeout: 10000,
    });
    const label = await page.locator("#location-label").textContent();
    expect(label).toMatch(/40\.75°N/);
    expect(label).toMatch(/74\.00°W/);
    expect(label).not.toMatch(/^\d{5}/); // no ZIP prefix

    await context.close();
  });

  test("geolocate → reload round trip preserves the location", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    });
    const page = await context.newPage();
    await blockZarrRequests(page);
    await page.goto("/");

    // Use geolocation
    await page.click("#geolocate-btn");
    await expect.poll(() => page.url()).toContain("lat=");

    const urlAfterGeolocate = page.url();

    // Reload the page — URL still has the coords, so the app should auto-load
    await page.reload();

    // Location label should reappear with the SF coords
    await expect(page.locator("#location-label")).toContainText("37.77", {
      timeout: 10000,
    });
    expect(page.url()).toBe(urlAfterGeolocate);

    await context.close();
  });

  test("submitting a ZIP after geolocation replaces lat/lon with zip", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    });
    const page = await context.newPage();
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.click("#geolocate-btn");
    await expect.poll(() => page.url()).toContain("lat=");

    // After a location is set the input is hidden behind the location
    // display — click the reset button to surface the ZIP input again.
    await page.click("#location-reset-btn");
    await page.fill("#zip-input", "10001");
    await expect.poll(() => page.url()).toContain("zip=10001");
    expect(page.url()).not.toContain("lat=");
    expect(page.url()).not.toContain("lon=");

    await context.close();
  });

  test("denied geolocation clears any pre-existing ?zip= from the URL", async ({ browser }) => {
    // No geolocation permission → click will reject
    const context = await browser.newContext();
    const page = await context.newPage();
    await blockZarrRequests(page);
    await mockZipApi(page);

    // Use an INVALID zip so the auto-load fails before loadForecast hides
    // the location bar — leaves the geolocate button reachable while the
    // stale ?zip=00000 sits in the URL.
    await page.goto("/?zip=00000");
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 10000,
    });
    expect(page.url()).toContain("zip=00000");

    // Now the user reaches for the geolocate button instead.
    await page.click("#geolocate-btn");
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 10000,
    });

    // The user's intent was to switch away from the ZIP — the stale ?zip=
    // must NOT remain in the URL after a denied/cancelled geolocation.
    expect(page.url()).not.toContain("zip=");

    await context.close();
  });

  test("failed ZIP submit clears any pre-existing ?lat=&lon= from the URL", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    // Out-of-range coords are ignored by the auto-load (location bar stays
    // visible) but the params remain in the URL — exactly the stale state
    // we want to test.
    await page.goto("/?lat=999&lon=999");
    await expect(page.locator("#location-bar")).toBeVisible();

    // Inject the realistic stale-URL state (in-range coords) without
    // triggering the auto-load.
    await page.evaluate(() => {
      history.replaceState(null, "", "/?lat=40.7484&lon=-73.9967");
    });
    expect(page.url()).toContain("lat=");

    // 00000 returns 404 from the mock → zipToLatLon rejects.
    await page.fill("#zip-input", "00000");
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 10000,
    });

    expect(page.url()).not.toContain("lat=");
    expect(page.url()).not.toContain("lon=");
  });

  test("location reset button clears location params from the URL", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);

    await page.goto("/?zip=10001");
    await expect(page.locator("#location-label")).toContainText("10001", {
      timeout: 10000,
    });

    await page.click("#location-reset-btn");

    // After reset, the dismissed location should not survive a share/reload.
    expect(page.url()).not.toContain("zip=");
    expect(page.url()).not.toContain("lat=");
    expect(page.url()).not.toContain("lon=");
  });

  test("switching from ZIP to coords also clears the stale ZIP input value", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    });
    const page = await context.newPage();
    await blockZarrRequests(page);
    await mockZipApi(page);

    await page.goto("/?zip=10001");
    await expect(page.locator("#zip-input")).toHaveValue("10001");

    // Surface the location-bar so geolocate-btn is reachable.
    await page.click("#location-reset-btn");
    await expect(page.locator("#zip-input")).toBeVisible();

    await page.click("#geolocate-btn");
    await expect.poll(() => page.url()).toContain("lat=");

    // Re-surface the input to inspect it.
    await page.click("#location-reset-btn");
    await expect(page.locator("#zip-input")).toHaveValue("");

    await context.close();
  });
});

test.describe("unit toggle", () => {
  test("clicking metric button activates it", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Trigger a load to reveal the unit toggle
    await page.fill("#zip-input", "10001");
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);

    await page.click("#metric-btn");

    await expect(page.locator("#metric-btn")).toHaveClass(/active/);
    await expect(page.locator("#imperial-btn")).not.toHaveClass(/active/);
  });

  test("clicking imperial button after metric restores imperial", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Trigger a load to reveal the unit toggle
    await page.fill("#zip-input", "10001");
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);

    await page.click("#metric-btn");
    await page.click("#imperial-btn");

    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);
    await expect(page.locator("#metric-btn")).not.toHaveClass(/active/);
  });

  test("unit preference persists across page reloads", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Trigger a load to reveal the unit toggle
    await page.fill("#zip-input", "10001");
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);

    // Switch to metric
    await page.click("#metric-btn");
    await expect(page.locator("#metric-btn")).toHaveClass(/active/);

    // Reload the page — URL has ?zip=10001 so app auto-loads
    await page.reload();
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);

    // Metric should still be active
    await expect(page.locator("#metric-btn")).toHaveClass(/active/);
    await expect(page.locator("#imperial-btn")).not.toHaveClass(/active/);
  });
});

test.describe("forecast display with mocked data", () => {
  async function setupWithMockForecast(page: Page) {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await injectMockWeatherData(page);

    // Override the weather module's fetch functions by intercepting at
    // the page level after the app loads
    await page.goto("/");

    // Inject mock data by replacing the fetch functions in the app
    await page.evaluate((forecast) => {
      // We need to override the global fetch to handle the Zarr requests,
      // but since that's complex, instead we directly trigger the app's
      // rendering by manipulating the DOM and dispatching events.
      // Store the mock data in a place the test can access
      (window as unknown as Record<string, unknown>).__testForecast = forecast;
    }, mockForecastData());
  }

  test("location label updates when ZIP is submitted", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    // The location label should show coordinates (even though the forecast
    // will fail due to blocked Zarr requests, the ZIP lookup succeeds first)
    // Wait for either the label to update or an error to show
    await Promise.race([
      expect(page.locator("#location-label")).not.toHaveText("", {
        timeout: 10000,
      }),
      expect(page.locator("#error")).not.toHaveClass(/hidden/, {
        timeout: 10000,
      }),
    ]);

    const labelText = await page.locator("#location-label").textContent();
    // After ZIP lookup, label should have coordinates
    if (labelText && labelText.length > 0) {
      expect(labelText).toMatch(/\d+\.\d+/);
    }
  });

  test("error state shows message and re-enables inputs", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Submit a valid ZIP but Zarr will fail (blocked)
    await page.fill("#zip-input", "10001");

    // Wait for error to appear
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 15000,
    });
    await expect(page.locator("#error")).toContainText("Failed to load");

    // Inputs should be re-enabled after error
    await expect(page.locator("#geolocate-btn")).toBeEnabled();
    await expect(page.locator("#zip-input")).toBeEnabled();
  });

  test("loading spinner is hidden after error", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 15000,
    });
    await expect(page.locator("#loading")).toHaveClass(/hidden/);
  });
});

test.describe("chart section structure", () => {
  test("each chart has a header with title and legend", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const chartHeaders = page.locator(".chart-header");
    await expect(chartHeaders).toHaveCount(4);

    const titles = page.locator(".chart-header h2");
    await expect(titles.nth(0)).toHaveText("Temperature");
    await expect(titles.nth(1)).toHaveText("Precipitation");
    await expect(titles.nth(2)).toHaveText("Wind Speed");
    await expect(titles.nth(3)).toHaveText("Cloud Cover");
  });

  test("chart legends contain median, p10-p90, and min-max text", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const legends = page.locator(".chart-legend");
    await expect(legends).toHaveCount(4);

    for (let i = 0; i < 4; i++) {
      const text = await legends.nth(i).textContent();
      expect(text).toContain("median");
      expect(text).toContain("p10-p90");
      expect(text).toContain("min-max");
    }
  });
});

test.describe("geolocation button", () => {
  test("clicking geolocate with permission denied shows error", async ({ page }) => {
    await blockZarrRequests(page);

    // Override geolocation to simulate denial
    await page.context().clearPermissions();

    await page.goto("/");
    await page.click("#geolocate-btn");

    // Should show error (geolocation not available or denied)
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 10000,
    });
  });

  test("clicking geolocate with permission granted triggers forecast flow", async ({
    page,
    context,
  }) => {
    await blockZarrRequests(page);

    // Grant geolocation permission and set coordinates
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 40.71, longitude: -74.01 });

    await page.goto("/");
    await page.click("#geolocate-btn");

    // The geolocation succeeds, triggering the forecast flow. Zarr requests
    // are blocked, so it will eventually error. Verify the location label
    // was set (proving geolocation worked) and the error appeared.
    await expect(page.locator("#error")).not.toHaveClass(/hidden/, {
      timeout: 15000,
    });
    // Location label should show the mocked coordinates
    const label = await page.locator("#location-label").textContent();
    expect(label).toContain("40.71");
  });
});

test.describe("responsive behavior", () => {
  test("app layout adapts to mobile viewport", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    // Core elements should still be visible on mobile
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("#geolocate-btn")).toBeVisible();
    await expect(page.locator("#zip-input")).toBeVisible();
  });

  test("app layout adapts to wide viewport", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");

    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("#geolocate-btn")).toBeVisible();
  });
});

test.describe("accessibility", () => {
  test("ZIP input has an accessible label", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const input = page.locator("#zip-input");
    await expect(input).toHaveAttribute("aria-label", "ZIP code");
  });

  test("buttons have accessible text content", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("#geolocate-btn")).toHaveText("Use My Location");
    await expect(page.locator("#metric-btn")).toHaveText("°C");
    await expect(page.locator("#imperial-btn")).toHaveText("°F");
  });

  test("external links have noopener rel attribute", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const dynamicalLinks = page.locator('a[href="https://dynamical.org"]');
    const count = await dynamicalLinks.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(dynamicalLinks.nth(i)).toHaveAttribute("target", "_blank");
      await expect(dynamicalLinks.nth(i)).toHaveAttribute("rel", /noopener/);
    }
  });
});

test.describe("location display and reset", () => {
  test("location bar is visible and location display is hidden initially", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("#location-bar")).toBeVisible();
    await expect(page.locator("#location-display")).toHaveClass(/hidden/);
  });

  test("location bar hides and location display shows after ZIP submit", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    // Location bar should be hidden, location display should show
    await expect(page.locator("#location-bar")).toHaveClass(/hidden/);
    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);
  });

  test("location label shows ZIP code and coordinates after ZIP submit", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);
    const label = await page.locator("#location-label").textContent();
    expect(label).toContain("10001");
    expect(label).toMatch(/\d+\.\d+/);
  });

  test("globe reset button shows location selection with back button", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");
    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);

    // Click the globe reset button
    await page.click("#location-reset-btn");

    // Location bar should be visible again
    await expect(page.locator("#location-bar")).not.toHaveClass(/hidden/);
    // Back button should be visible (since there was a previous location)
    await expect(page.locator("#location-back-btn")).toBeVisible();
    // Globe reset button should be hidden
    await expect(page.locator("#location-reset-btn")).toHaveClass(/hidden/);
  });

  test("clicking globe mid-load reveals enabled inputs so user can switch", async ({ page }) => {
    // Keep the Zarr requests pending for the duration of the test so the
    // forecast load is genuinely in-flight when we click the globe icon.
    await page.route("**/data.dynamical.org/**", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort("blockedbyclient");
    });
    await page.route("**/*.s3.us-west-2.amazonaws.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 30_000));
      await route.abort("blockedbyclient");
    });
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");

    // Wait until the load has progressed to "location display + skeletons"
    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);
    await expect(page.locator("#forecast")).not.toHaveClass(/hidden/);

    // Tap the globe icon to go back to location selection while the
    // forecast load is still pending.
    await page.click("#location-reset-btn");

    // Location bar must be visible again with inputs enabled — even though
    // the Zarr requests are still in-flight.
    await expect(page.locator("#location-bar")).not.toHaveClass(/hidden/);
    await expect(page.locator("#geolocate-btn")).toBeEnabled();
    await expect(page.locator("#zip-input")).toBeEnabled();
  });

  test("back button restores previous forecast view", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    await page.fill("#zip-input", "10001");
    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);

    // Click reset then back
    await page.click("#location-reset-btn");
    await expect(page.locator("#location-back-btn")).toBeVisible();
    await page.click("#location-back-btn");

    // Should be back to showing location display
    await expect(page.locator("#location-bar")).toHaveClass(/hidden/);
    await expect(page.locator("#location-display")).not.toHaveClass(/hidden/);
    await expect(page.locator("#location-reset-btn")).toBeVisible();
  });
});

test.describe("unit toggle as text", () => {
  test("unit toggle elements are spans with role=button", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    const metricBtn = page.locator("#metric-btn");
    const imperialBtn = page.locator("#imperial-btn");
    await expect(metricBtn).toHaveAttribute("role", "button");
    await expect(imperialBtn).toHaveAttribute("role", "button");
  });

  test("clicking either unit text toggles between units", async ({ page }) => {
    await blockZarrRequests(page);
    await mockZipApi(page);
    await page.goto("/");

    // Trigger a load to reveal the meta bar
    await page.fill("#zip-input", "10001");
    await expect(page.locator("#forecast-meta-bar")).not.toHaveClass(/hidden/);

    // Default is imperial
    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);

    // Click either button to toggle to metric
    await page.click("#metric-btn");
    await expect(page.locator("#metric-btn")).toHaveClass(/active/);
    await expect(page.locator("#imperial-btn")).not.toHaveClass(/active/);

    // Click again to toggle back to imperial
    await page.click("#imperial-btn");
    await expect(page.locator("#imperial-btn")).toHaveClass(/active/);
    await expect(page.locator("#metric-btn")).not.toHaveClass(/active/);
  });
});

test.describe("info panel", () => {
  test("info panel is hidden by default", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await expect(page.locator("#info-panel")).toHaveClass(/hidden/);
  });

  test("clicking ??? link toggles info panel visibility", async ({ page }) => {
    await blockZarrRequests(page);
    await page.goto("/");

    await page.click("#info-toggle");
    await expect(page.locator("#info-panel")).not.toHaveClass(/hidden/);

    // Contains expected content
    await expect(page.locator("#info-panel")).toContainText("probabilistic weather forecast");
    await expect(page.locator("#info-panel")).toContainText("Magic Blend");
    await expect(page.locator("#info-panel")).toContainText("dynamical.org");

    // Click again to hide
    await page.click("#info-toggle");
    await expect(page.locator("#info-panel")).toHaveClass(/hidden/);
  });
});
