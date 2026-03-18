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
  test("forecast-meta is centered on mobile", async ({ page }) => {
    await blockZarrRequests(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    await page.evaluate(() => {
      document.getElementById("forecast")!.classList.remove("hidden");
      document.getElementById("init-time-label")!.textContent =
        "Forecast initialized Mar 18, 2:00 AM EDT";
    });

    const justifyContent = await page
      .locator("#forecast-meta")
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
