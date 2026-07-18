import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  expect: {
    toHaveScreenshot: {
      // Absorb minor antialiasing/font-rasterization differences between
      // Linux environments while still catching real visual regressions.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: "http://localhost:4000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:4000",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          // Deterministic text rasterization so canvas/DOM screenshots are
          // reproducible across Linux machines (visual snapshot tests).
          args: [
            "--font-render-hinting=none",
            "--disable-lcd-text",
            "--disable-font-subpixel-positioning",
          ],
        },
      },
    },
  ],
});
