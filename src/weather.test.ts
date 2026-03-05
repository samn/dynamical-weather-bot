import { describe, it, expect } from "vitest";
import {
  percentile,
  windSpeed,
  precipToMmHr,
  cloudCoverToFraction,
  latToIndex,
  lonToIndex,
} from "./weather.js";

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the only element for single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 10)).toBe(42);
    expect(percentile([42], 90)).toBe(42);
  });

  it("returns correct median for odd-length sorted array", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("returns correct median for even-length sorted array", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("returns min at p0", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it("returns max at p100", () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  it("interpolates for p10", () => {
    // [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const arr = Array.from({ length: 10 }, (_, i) => i + 1);
    // p10 = index 0.9 -> between arr[0]=1 and arr[1]=2 -> 1 + 0.9 * (2-1) = 1.9
    expect(percentile(arr, 10)).toBeCloseTo(1.9, 5);
  });

  it("interpolates for p90", () => {
    const arr = Array.from({ length: 10 }, (_, i) => i + 1);
    // p90 = index 8.1 -> between arr[8]=9 and arr[9]=10 -> 9 + 0.1 * (10-9) = 9.1
    expect(percentile(arr, 90)).toBeCloseTo(9.1, 5);
  });
});

describe("windSpeed", () => {
  it("computes magnitude from u and v components", () => {
    expect(windSpeed(3, 4)).toBe(5);
  });

  it("returns 0 for zero wind", () => {
    expect(windSpeed(0, 0)).toBe(0);
  });

  it("handles negative components", () => {
    expect(windSpeed(-3, -4)).toBe(5);
  });
});

describe("precipToMmHr", () => {
  it("converts kg/m2/s to mm/hr", () => {
    // 1 kg/m2/s = 3600 mm/hr
    expect(precipToMmHr(1)).toBe(3600);
  });

  it("returns 0 for zero", () => {
    expect(precipToMmHr(0)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(precipToMmHr(-0.001)).toBe(0);
  });

  it("converts typical rate correctly", () => {
    // Light rain: ~0.0001 kg/m2/s = 0.36 mm/hr
    expect(precipToMmHr(0.0001)).toBeCloseTo(0.36, 2);
  });
});

describe("cloudCoverToFraction", () => {
  it("converts percent to fraction", () => {
    expect(cloudCoverToFraction(50)).toBe(0.5);
    expect(cloudCoverToFraction(100)).toBe(1);
    expect(cloudCoverToFraction(0)).toBe(0);
  });

  it("clamps out-of-range values", () => {
    expect(cloudCoverToFraction(-10)).toBe(0);
    expect(cloudCoverToFraction(150)).toBe(1);
  });
});

describe("latToIndex", () => {
  it("maps 90N to index 0", () => {
    expect(latToIndex(90)).toBe(0);
  });

  it("maps 0 to index 360", () => {
    expect(latToIndex(0)).toBe(360);
  });

  it("maps -90S to index 720", () => {
    expect(latToIndex(-90)).toBe(720);
  });

  it("maps 45N to index 180", () => {
    expect(latToIndex(45)).toBe(180);
  });

  it("clamps values beyond range", () => {
    expect(latToIndex(100)).toBe(0); // clamped to 90
    expect(latToIndex(-100)).toBe(720); // clamped to -90
  });
});

describe("lonToIndex", () => {
  it("maps -180 to index 0", () => {
    expect(lonToIndex(-180)).toBe(0);
  });

  it("maps 0 to index 720", () => {
    expect(lonToIndex(0)).toBe(720);
  });

  it("maps 179.75 to index 1439", () => {
    expect(lonToIndex(179.75)).toBe(1439);
  });

  it("maps -122.4 (San Francisco) to correct index", () => {
    // (-122.4 + 180) / 0.25 = 57.6 / 0.25 = 230.4 -> rounds to 230
    expect(lonToIndex(-122.4)).toBe(230);
  });
});
