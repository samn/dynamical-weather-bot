import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts/chart.ts: DOM/canvas code needing browser environment
      // types.ts: only interfaces, no runtime code
      // weather.ts: pure utility functions are tested; Zarr network code needs integration tests
      // geo.ts: normalizeLongitude is tested; browser geolocation/fetch wrappers need integration tests
      exclude: [
        "src/**/*.test.ts",
        "src/main.ts",
        "src/chart.ts",
        "src/types.ts",
        "src/weather.ts",
        "src/geo.ts",
        "src/hrrr.ts",
        "src/ecmwf.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
