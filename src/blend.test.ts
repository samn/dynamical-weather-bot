import { describe, it, expect } from "vitest";
import { computeCommonTimeRange, computeWeights, blendForecasts, lookupAccuracy } from "./blend.js";
import type { ModelForecast, AccuracyGrid, ForecastPoint, NearbyStation } from "./types.js";

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
    isEnsemble: true,
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
    isEnsemble: false,
    location: { latitude: 40, longitude: -90 },
    initTime: "2026-03-16T00:00:00.000Z",
    temperature: points.map((p) => makeForecastPoint(p)),
    precipitation: points.map((p) => makeForecastPoint(p)),
    windSpeed: points.map((p) => makeForecastPoint(p)),
    cloudCover: points.map((p) => makeForecastPoint(p)),
  };
}

function makeEcmwf(points: Partial<ForecastPoint>[] = [{}]): ModelForecast {
  return {
    model: "ECMWF IFS ENS",
    isEnsemble: true,
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

/** Test user location: (40.2, -89.8), falls in cell "40.0,-90.0" */
const TEST_LOC = { latitude: 40.2, longitude: -89.8 };

/** Station ~5km from TEST_LOC */
function makeStation(
  id: string,
  latitude: number,
  longitude: number,
  metrics: NearbyStation["metrics"],
): NearbyStation {
  return { id, latitude, longitude, metrics };
}

describe("lookupAccuracy", () => {
  it("returns undefined for locations outside the grid", () => {
    const result = lookupAccuracy({ latitude: 60, longitude: -90 }, EMPTY_GRID);
    expect(result).toBeUndefined();
  });

  it("returns cell metrics when no nearby stations", () => {
    const grid = gridWithAccuracy(2.0, 1.5);
    const result = lookupAccuracy(TEST_LOC, grid);
    expect(result).toBeDefined();
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(2.0);
    expect(result?.["NOAA HRRR"]?.["temperature_2m"]?.["0"]).toBe(1.5);
  });

  it("uses IDW weighting across nearby stations", () => {
    // Station A: ~5km away (lat 40.245), error 2.0
    // Station B: ~10km away (lat 40.29), error 6.0
    // IDW weights: A = 1/25 = 0.04, B = 1/100 = 0.01
    // Weighted avg = (0.04*2 + 0.01*6) / (0.04+0.01) = 0.14/0.05 = 2.8
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 5,
          metrics: {
            "NOAA GEFS": { temperature_2m: { "0": 99 } }, // should be ignored when stations are in range
          },
          nearbyStations: [
            makeStation("A", 40.245, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
            }),
            makeStation("B", 40.29, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 6.0 } },
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    expect(result).toBeDefined();
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBeCloseTo(2.8, 0);
  });

  it("nearest station dominates with IDW weighting", () => {
    // Station A: ~2km away, error 4.0
    // Station B: ~20km away, error 1.0
    // IDW: A = 1/4 = 0.25, B = 1/400 = 0.0025
    // A has ~99% of the weight
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 5,
          metrics: { "NOAA GEFS": { temperature_2m: { "0": 99 } } },
          nearbyStations: [
            makeStation("CLOSE", 40.218, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 4.0 } },
            }),
            makeStation("FAR", 40.38, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 1.0 } },
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    // Close station should dominate — result should be very near 4.0
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBeCloseTo(4.0, 1);
  });

  it("falls back to cell metrics when all stations are beyond 50km", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 3,
          metrics: {
            "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
          },
          nearbyStations: [
            makeStation("DISTANT", 40.74, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 9.0 } },
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    // Station is ~60km away, beyond 50km radius → falls back to cell metrics
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(2.0);
  });

  it("applies minimum distance cap for co-located stations", () => {
    // Station at exact user location — distance ~0, capped to 1km
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 3,
          metrics: { "NOAA GEFS": { temperature_2m: { "0": 99 } } },
          nearbyStations: [
            makeStation("HERE", 40.2, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 3.0 } },
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    // Should return the station's metrics (no division by zero)
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBe(3.0);
  });

  it("handles stations with data for a model that other stations lack", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 3,
          metrics: { "NOAA GEFS": { temperature_2m: { "0": 99 } } },
          nearbyStations: [
            makeStation("A", 40.245, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 4.0 } },
              "NOAA HRRR": { temperature_2m: { "0": 1.0, "24": 1.5 } },
            }),
            makeStation("B", 40.29, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
              // No HRRR data
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    expect(result).toBeDefined();
    // GEFS blended across both stations
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBeDefined();
    // HRRR only from station A (the only one with HRRR data)
    expect(result?.["NOAA HRRR"]?.["temperature_2m"]?.["0"]).toBe(1.0);
    expect(result?.["NOAA HRRR"]?.["temperature_2m"]?.["24"]).toBe(1.5);
  });

  it("handles stations with different variables for same model", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 3,
          metrics: { "NOAA GEFS": { temperature_2m: { "0": 99 } } },
          nearbyStations: [
            makeStation("A", 40.245, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 4.0 }, precipitation_surface: { "0": 1.0 } },
            }),
            makeStation("B", 40.29, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
              // No precipitation data
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    // Temperature blended from both stations
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBeDefined();
    // Precipitation only from station A
    expect(result?.["NOAA GEFS"]?.["precipitation_surface"]?.["0"]).toBe(1.0);
  });

  it("handles stations with different lead times", () => {
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 3,
          metrics: { "NOAA GEFS": { temperature_2m: { "0": 99 } } },
          nearbyStations: [
            makeStation("A", 40.245, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 4.0 } },
            }),
            makeStation("B", 40.29, -89.8, {
              "NOAA GEFS": { temperature_2m: { "0": 2.0, "48": 5.0 } },
            }),
          ],
        },
      },
    };
    const result = lookupAccuracy(TEST_LOC, grid);
    // Lead "0" blended from both
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["0"]).toBeDefined();
    // Lead "48" only from station B
    expect(result?.["NOAA GEFS"]?.["temperature_2m"]?.["48"]).toBe(5.0);
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

  it("ignores models with zero error (treats as no data)", () => {
    const accuracy = {
      "NOAA GEFS": { temperature_2m: { "0": 2.0 } },
      "NOAA HRRR": { temperature_2m: { "0": 0 } },
    };
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, accuracy);
    // HRRR has 0 error → skipped, GEFS gets all weight
    expect(weights.get("NOAA GEFS")).toBe(1);
    expect(weights.get("NOAA HRRR")).toBe(0);
  });

  it("returns equal weights when accuracy has no matching variable", () => {
    const accuracy = {
      "NOAA GEFS": { wind_speed: { "0": 2.0 } },
    };
    const weights = computeWeights(["NOAA GEFS", "NOAA HRRR"], "temperature_2m", 0, accuracy);
    expect(weights.get("NOAA GEFS")).toBeCloseTo(0.5, 5);
    expect(weights.get("NOAA HRRR")).toBeCloseTo(0.5, 5);
  });

  it("computes weights for three models", () => {
    const accuracy = {
      "NOAA GEFS": { temperature_2m: { "0": 3.0 } },
      "NOAA HRRR": { temperature_2m: { "0": 1.0 } },
      "ECMWF IFS ENS": { temperature_2m: { "0": 2.0 } },
    };
    const weights = computeWeights(
      ["NOAA GEFS", "NOAA HRRR", "ECMWF IFS ENS"],
      "temperature_2m",
      0,
      accuracy,
    );
    // GEFS=1/9, HRRR=1/1, ECMWF=1/4. Total = 1/9 + 1 + 1/4 = 49/36
    const total = 1 / 9 + 1 + 1 / 4;
    expect(weights.get("NOAA GEFS")).toBeCloseTo(1 / 9 / total, 5);
    expect(weights.get("NOAA HRRR")).toBeCloseTo(1 / total, 5);
    expect(weights.get("ECMWF IFS ENS")).toBeCloseTo(1 / 4 / total, 5);
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

  it("throws when no ensemble model is provided", () => {
    const hrrr = makeHrrr();
    expect(() => blendForecasts([hrrr], EMPTY_GRID)).toThrow(
      "At least one ensemble model is required",
    );
  });

  it("throws when forecasts array is empty", () => {
    expect(() => blendForecasts([], EMPTY_GRID)).toThrow("At least one ensemble model is required");
  });

  it("matches HRRR points by rounded hoursFromNow", () => {
    // GEFS at 3.1 hours, HRRR at 2.9 hours — both round to 3
    const gefs = makeGefs([{ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: 3.1 }]);
    const hrrr = makeHrrr([{ median: 20, p10: 20, p90: 20, min: 20, max: 20, hoursFromNow: 2.9 }]);

    const result = blendForecasts([gefs, hrrr], EMPTY_GRID);

    // Equal weights (no accuracy data) → blended median = 15
    expect(result.temperature[0]!.median).toBeCloseTo(15, 5);
  });

  it("blends two ensemble models (GEFS + ECMWF) with equal weights", () => {
    const gefs = makeGefs([{ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: 0 }]);
    const ecmwf = makeEcmwf([{ median: 14, p10: 11, p90: 17, min: 9, max: 19, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, ecmwf], EMPTY_GRID);

    // Equal weights (no accuracy data) → average
    expect(result.temperature[0]!.median).toBeCloseTo(12, 5);
    // Bands are weighted average of both ensemble models' bands
    expect(result.temperature[0]!.p10).toBeCloseTo(9.5, 5);
    expect(result.temperature[0]!.p90).toBeCloseTo(14.5, 5);
    expect(result.temperature[0]!.min).toBeCloseTo(7.5, 5);
    expect(result.temperature[0]!.max).toBeCloseTo(16.5, 5);
  });

  it("blends three models (GEFS + ECMWF + HRRR) with equal weights", () => {
    const gefs = makeGefs([{ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: 0 }]);
    const ecmwf = makeEcmwf([{ median: 14, p10: 11, p90: 17, min: 9, max: 19, hoursFromNow: 0 }]);
    const hrrr = makeHrrr([{ median: 12, p10: 12, p90: 12, min: 12, max: 12, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, ecmwf, hrrr], EMPTY_GRID);

    // Equal weights (no accuracy) → median = (10+14+12)/3 = 12
    expect(result.temperature[0]!.median).toBeCloseTo(12, 5);
    // Ensemble bands from GEFS+ECMWF (equal ensemble weights), then shifted
    // Ensemble center = (10+14)/2 = 12, blended median = 12, offset = 0
    expect(result.temperature[0]!.p10).toBeCloseTo(9.5, 5);
    expect(result.temperature[0]!.p90).toBeCloseTo(14.5, 5);
  });

  it("blends three models with accuracy-weighted ECMWF", () => {
    // Grid with accuracy for all three models
    const grid: AccuracyGrid = {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {
        "40.0,-90.0": {
          stationCount: 5,
          metrics: {
            "NOAA GEFS": { temperature_2m: { "0": 3.0 } },
            "NOAA HRRR": { temperature_2m: { "0": 1.0 } },
            "ECMWF IFS ENS": { temperature_2m: { "0": 2.0 } },
          },
        },
      },
    };
    const gefs = makeGefs([{ median: 10, p10: 7, p90: 13, min: 5, max: 15, hoursFromNow: 0 }]);
    const ecmwf = makeEcmwf([{ median: 12, p10: 9, p90: 15, min: 7, max: 17, hoursFromNow: 0 }]);
    const hrrr = makeHrrr([{ median: 14, p10: 14, p90: 14, min: 14, max: 14, hoursFromNow: 0 }]);

    const result = blendForecasts([gefs, ecmwf, hrrr], grid);

    // Weights: GEFS=1/9, ECMWF=1/4, HRRR=1/1. Total = 1/9 + 1/4 + 1 = 49/36
    // GEFS norm = (1/9)/(49/36) = 4/49 ≈ 0.0816
    // ECMWF norm = (1/4)/(49/36) = 9/49 ≈ 0.1837
    // HRRR norm = 1/(49/36) = 36/49 ≈ 0.7347
    const gefsW = 1 / 9 / (1 / 9 + 1 / 4 + 1);
    const ecmwfW = 1 / 4 / (1 / 9 + 1 / 4 + 1);
    const hrrrW = 1 / (1 / 9 + 1 / 4 + 1);
    const expectedMedian = gefsW * 10 + ecmwfW * 12 + hrrrW * 14;
    expect(result.temperature[0]!.median).toBeCloseTo(expectedMedian, 3);

    // Ensemble weights (renormalized): GEFS and ECMWF only
    const ensGefsW = 1 / 9 / (1 / 9 + 1 / 4);
    const ensEcmwfW = 1 / 4 / (1 / 9 + 1 / 4);
    const ensP10 = ensGefsW * 7 + ensEcmwfW * 9;
    const ensP90 = ensGefsW * 13 + ensEcmwfW * 15;
    const ensCenter = ensGefsW * 10 + ensEcmwfW * 12;
    const offset = expectedMedian - ensCenter;
    expect(result.temperature[0]!.p10).toBeCloseTo(ensP10 + offset, 3);
    expect(result.temperature[0]!.p90).toBeCloseTo(ensP90 + offset, 3);
  });

  it("ECMWF-only forecast works as single ensemble model", () => {
    const ecmwf = makeEcmwf([{ median: 15, p10: 12, p90: 18, min: 10, max: 20 }]);
    const result = blendForecasts([ecmwf], EMPTY_GRID);

    expect(result.temperature[0]!.median).toBe(15);
    expect(result.temperature[0]!.p10).toBe(12);
    expect(result.temperature[0]!.p90).toBe(18);
  });
});

describe("computeCommonTimeRange", () => {
  function pts(startHour: number, endHour: number, stepHours: number): ForecastPoint[] {
    const result: ForecastPoint[] = [];
    for (let h = startHour; h <= endHour; h += stepHours) {
      const time = new Date(Date.UTC(2026, 3, 1, h)).toISOString();
      result.push(makeForecastPoint({ time, hoursFromNow: h }));
    }
    return result;
  }

  it("returns the intersection of overlapping time ranges", () => {
    const inputs = [
      { model: "NOAA GEFS" as const, points: pts(0, 72, 3), isEnsemble: true },
      { model: "NOAA HRRR" as const, points: pts(6, 48, 1), isEnsemble: false },
    ];
    const range = computeCommonTimeRange(inputs);
    expect(range).toBeDefined();
    // HRRR starts later (hour 6) and ends earlier (hour 48)
    expect(range![0]).toBe(new Date(Date.UTC(2026, 3, 1, 6)).getTime());
    expect(range![1]).toBe(new Date(Date.UTC(2026, 3, 1, 48)).getTime());
  });

  it("returns undefined for empty inputs", () => {
    expect(computeCommonTimeRange([])).toBeUndefined();
  });

  it("returns undefined when inputs have no overlap", () => {
    const inputs = [
      { model: "NOAA GEFS" as const, points: pts(0, 24, 3), isEnsemble: true },
      { model: "NOAA HRRR" as const, points: pts(48, 72, 1), isEnsemble: false },
    ];
    expect(computeCommonTimeRange(inputs)).toBeUndefined();
  });

  it("skips inputs with empty points", () => {
    const inputs = [
      { model: "NOAA GEFS" as const, points: pts(0, 72, 3), isEnsemble: true },
      { model: "NOAA HRRR" as const, points: [], isEnsemble: false },
    ];
    const range = computeCommonTimeRange(inputs);
    expect(range).toBeDefined();
    expect(range![0]).toBe(new Date(Date.UTC(2026, 3, 1, 0)).getTime());
    expect(range![1]).toBe(new Date(Date.UTC(2026, 3, 1, 72)).getTime());
  });

  it("returns same range regardless of which models are included", () => {
    const gefs = { model: "NOAA GEFS" as const, points: pts(0, 72, 3), isEnsemble: true };
    const hrrr = { model: "NOAA HRRR" as const, points: pts(6, 48, 1), isEnsemble: false };
    const ecmwf = { model: "ECMWF IFS ENS" as const, points: pts(0, 72, 3), isEnsemble: true };

    const allModels = computeCommonTimeRange([gefs, hrrr, ecmwf]);
    const gefsOnly = computeCommonTimeRange([gefs, hrrr, ecmwf]);
    expect(allModels).toEqual(gefsOnly);
  });
});
