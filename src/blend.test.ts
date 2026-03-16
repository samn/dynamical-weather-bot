import { describe, it, expect } from "vitest";
import { computeWeights, blendForecasts, lookupAccuracy } from "./blend.js";
import type { ModelForecast, AccuracyGrid, ForecastPoint } from "./types.js";

function makeForecastPoint(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: "2026-03-16T00:00:00.000Z",
    hoursFromNow: 0,
    median: 10,
    p10: 8,
    p90: 12,
    min: 6,
    max: 14,
    ...overrides,
  };
}

function makeGefs(points: Partial<ForecastPoint>[] = [{}]): ModelForecast {
  return {
    model: "NOAA GEFS",
    location: { latitude: 40, longitude: -90 },
    initTime: "2026-03-16T00:00:00.000Z",
    temperature: points.map((p) => makeForecastPoint(p)),
    precipitation: points.map((p) => makeForecastPoint(p)),
    windSpeed: points.map((p) => makeForecastPoint(p)),
    cloudCover: points.map((p) => makeForecastPoint(p)),
  };
}

function makeHrrr(points: Partial<ForecastPoint>[] = [{}]): ModelForecast {
  return {
    model: "NOAA HRRR",
    location: { latitude: 40, longitude: -90 },
    initTime: "2026-03-16T00:00:00.000Z",
    temperature: points.map((p) => makeForecastPoint(p)),
    precipitation: points.map((p) => makeForecastPoint(p)),
    windSpeed: points.map((p) => makeForecastPoint(p)),
    cloudCover: points.map((p) => makeForecastPoint(p)),
  };
}

const EMPTY_GRID: AccuracyGrid = {
  gridResolution: 0.5,
  bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
  cells: {},
};

function gridWithAccuracy(gefsError: number, hrrrError: number): AccuracyGrid {
  return {
    gridResolution: 0.5,
    bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
    cells: {
      "40.0,-90.0": {
        stationCount: 5,
        metrics: {
          "NOAA GEFS": {
            temperature_2m: { "0": gefsError, "24": gefsError, "48": gefsError },
            precipitation_surface: { "0": gefsError, "24": gefsError },
          },
          "NOAA HRRR": {
            temperature_2m: { "0": hrrrError, "24": hrrrError, "48": hrrrError },
            precipitation_surface: { "0": hrrrError, "24": hrrrError },
          },
        },
      },
    },
  };
}

describe("lookupAccuracy", () => {
  it("returns undefined for locations outside the grid", () => {
    const result = lookupAccuracy({ latitude: 60, longitude: -90 }, EMPTY_GRID);
    expect(result).toBeUndefined();
  });

  it("returns metrics for locations inside the grid", () => {
    const grid = gridWithAccuracy(2.0, 1.5);
    const result = lookupAccuracy({ latitude: 40.2, longitude: -89.8 }, grid);
    expect(result).toBeDefined();
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(2.0);
    expect(result?.["NOAA HRRR"]?.["temperature_2m"]?.["0"]).toBe(1.5);
  });

  it("blends with nearby station metrics when distance < 25km", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 6,
          metrics: {
            "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
          },
          nearbyStations: [
            {
              id: "KORD",
              distance: 10,
              metrics: {
                "NOAA GEFS": { temperature_2m: { "0": 4.0 } },
                "NOAA HRRR": { temperature_2m: { "0": 1.0 } },
              },
            },
          ],
        },
      },
    };
    const result = lookupAccuracy({ latitude: 40.2, longitude: -89.8 }, grid);
    expect(result).toBeDefined();
    // Blended: cell(2.0) + station(4.0) / 2 = 3.0
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(3.0);
    // Station-only: 1.0 (cell has no HRRR data, station does)
    expect(result?.["NOAA HRRR"]?.["temperature_2m"]?.["0"]).toBe(1.0);
  });

  it("does not blend with distant nearby stations (>= 25km)", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 6,
          metrics: {
            "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
          },
          nearbyStations: [
            {
              id: "KORD",
              distance: 30,
              metrics: {
                "NOAA GEFS": { temperature_2m: { "0": 4.0 } },
              },
            },
          ],
        },
      },
    };
    const result = lookupAccuracy({ latitude: 40.2, longitude: -89.8 }, grid);
    // Should return cell metrics directly, not blended
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(2.0);
  });
});

describe("computeWeights", () => {
  it("returns inverse-squared-error weights", () => {
    const accuracy = {
      "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
      "NOAA HRRR": { temperature_2m: { "0": 1.0 } },
    };
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, accuracy);

    // GEFS weight = 1/4, HRRR weight = 1/1, normalized: GEFS = 0.2, HRRR = 0.8
    expect(weights.get("NOAA GEFS")).toBeCloseTo(0.2, 5);
    expect(weights.get("NOAA HRRR")).toBeCloseTo(0.8, 5);
  });

  it("returns equal weights when no accuracy data", () => {
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, undefined);
    expect(weights.get("NOAA GEFS")).toBeCloseTo(0.5, 5);
    expect(weights.get("NOAA HRRR")).toBeCloseTo(0.5, 5);
  });

  it("handles missing model in accuracy data", () => {
    const accuracy = {
      "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
    };
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, accuracy);
    expect(weights.get("NOAA GEFS")).toBe(1);
    expect(weights.get("NOAA HRRR")).toBe(0);
  });

  it("snaps to nearest lead time bin", () => {
    const accuracy = {
      "NOAA GEFS": { temperature_2m: { "0": 2.0, "24": 3.0 } },
      "NOAA HRRR": { temperature_2m: { "0": 1.0, "24": 1.5 } },
    };
    // 10 hours → snaps to bin 0
    const w0 = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 10, accuracy);
    expect(w0.get("NOAA GEFS")).toBeCloseTo(0.2, 5);
    // 20 hours → snaps to bin 24
    const w24 = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 20, accuracy);
    // GEFS 1/9, HRRR 1/2.25 = 4/9, total = 5/9
    expect(w24.get("NOAA GEFS")).toBeCloseTo(1 / 9 / (1 / 9 + 4 / 9), 5);
  });

  it("returns equal weights when accuracy has no matching variable", () => {
    const accuracy = {
      "NOAA GEFS": { wind_speed: { "0": 2.0 } },
    };
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, accuracy);
    expect(weights.get("NOAA GEFS")).toBeCloseTo(0.5, 5);
    expect(weights.get("NOAA HRRR")).toBeCloseTo(0.5, 5);
  });
});

describe("blendForecasts", () => {
  it("returns GEFS data unchanged when only one model", () => {
    const gefs = makeGefs([{ median: 15, p10: 12, p90: 18, min: 10, max: 20 }]);
    const result = blendForecasts([gefs], EMPTY_GRID);

    expect(result.temperature[0]!.median).toBe(15);
    expect(result.temperature[0]!.p10).toBe(12);
    expect(result.temperature[0]!.p90).toBe(18);
  });

  it("blends two models with equal accuracy as average", () => {
    const grid = gridWithAccuracy(2.0, 2.0); // equal errors → equal weights
    const gefs = makeGefs([{ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: 0 }]);
    const hrrr = makeHrrr([{ median: 20, p10: 20, p90: 20, min: 20, max: 20, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, hrrr], grid);

    // Equal weights → average median = 15
    expect(result.temperature[0]!.median).toBeCloseTo(15, 5);
    // Offset = 15 - 10 = 5
    expect(result.temperature[0]!.p10).toBeCloseTo(13, 5);
    expect(result.temperature[0]!.p90).toBeCloseTo(17, 5);
    expect(result.temperature[0]!.min).toBeCloseTo(11, 5);
    expect(result.temperature[0]!.max).toBeCloseTo(19, 5);
  });

  it("shifts uncertainty bands correctly", () => {
    const grid = gridWithAccuracy(3.0, 1.0); // HRRR much better
    const gefs = makeGefs([{ median: 10, p10: 7, p90: 13, min: 5, max: 15, hoursFromNow: 0 }]);
    const hrrr = makeHrrr([{ median: 14, p10: 14, p90: 14, min: 14, max: 14, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, hrrr], grid);
    const pt = result.temperature[0]!;

    // GEFS weight = 1/9, HRRR weight = 1/1, total = 10/9
    // GEFS normalized = 1/10, HRRR normalized = 9/10
    const expectedMedian = (1 / 10) * 10 + (9 / 10) * 14; // = 1 + 12.6 = 13.6
    const offset = expectedMedian - 10;

    expect(pt.median).toBeCloseTo(expectedMedian, 5);
    expect(pt.p10).toBeCloseTo(7 + offset, 5);
    expect(pt.p90).toBeCloseTo(13 + offset, 5);
    expect(pt.min).toBeCloseTo(5 + offset, 5);
    expect(pt.max).toBeCloseTo(15 + offset, 5);
  });

  it("passes through GEFS data beyond 48hr (no matching HRRR timestep)", () => {
    const gefs = makeGefs([
      { median: 10, hoursFromNow: 0 },
      { median: 20, hoursFromNow: 60 }, // beyond 48hr
    ]);
    const hrrr = makeHrrr([{ median: 15, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, hrrr], EMPTY_GRID);

    // Second point has no HRRR match → passes through unchanged
    expect(result.temperature[1]!.median).toBe(20);
  });

  it("clamps precipitation to zero (never negative)", () => {
    // HRRR predicts 0, GEFS predicts 2 with spread down to min=0.5
    // Blending shifts median down, which could push min below zero
    const gefs = makeGefs([{ median: 2, p10: 1, p90: 3, min: 0.5, max: 4, hoursFromNow: 0 }]);
    const hrrr = makeHrrr([{ median: 0, p10: 0, p90: 0, min: 0, max: 0, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, hrrr], EMPTY_GRID);

    // With equal weights (no accuracy data), blended median = 1, offset = -1
    // min would be 0.5 + (-1) = -0.5, but should be clamped to 0
    expect(result.precipitation[0]!.min).toBe(0);
    expect(result.precipitation[0]!.p10).toBe(0);
    // Wind and cloud cover should also be clamped
    expect(result.windSpeed[0]!.min).toBe(0);
    expect(result.cloudCover[0]!.min).toBe(0);
    // Temperature can be negative — no clamping
    expect(result.temperature[0]!.min).toBeCloseTo(-0.5, 5);
  });

  it("preserves location from GEFS and uses most recent initTime", () => {
    const gefs = makeGefs();
    gefs.initTime = "2026-03-15T00:00:00.000Z";
    const hrrr = makeHrrr();
    hrrr.initTime = "2026-03-16T12:00:00.000Z";
    const result = blendForecasts([gefs, hrrr], EMPTY_GRID);

    expect(result.location).toEqual(gefs.location);
    // HRRR has a more recent init_time, so it should be used
    expect(result.initTime).toBe(hrrr.initTime);
  });

  it("uses GEFS initTime when HRRR initTime is older", () => {
    const gefs = makeGefs();
    gefs.initTime = "2026-03-16T00:00:00.000Z";
    const hrrr = makeHrrr();
    hrrr.initTime = "2026-03-15T18:00:00.000Z";
    const result = blendForecasts([gefs, hrrr], EMPTY_GRID);

    expect(result.initTime).toBe(gefs.initTime);
  });
});
