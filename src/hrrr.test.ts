import { describe, it, expect } from "vitest";
import { geoToHrrrIndex, toPoints } from "./hrrr.js";

/**
 * Approximate HRRR grid coordinate arrays for testing.
 * HRRR is ~3km resolution on a Lambert Conformal Conic projection.
 * We generate a small grid centered around the CONUS for testing purposes.
 */
function makeTestCoords(): { x: number[]; y: number[] } {
  // Grid with 3km spacing (3000m), ~1800 points in x, ~1060 in y
  // Origin roughly at the SW corner of the HRRR domain
  const xStart = -2697920;
  const yStart = -1588612;
  const step = 3000;
  const xCount = 1800;
  const yCount = 1060;

  const x = Array.from({ length: xCount }, (_, i) => xStart + i * step);
  const y = Array.from({ length: yCount }, (_, i) => yStart + i * step);

  return { x, y };
}

describe("geoToHrrrIndex", () => {
  const { x, y } = makeTestCoords();

  it("returns valid indices for a CONUS point (Chicago)", () => {
    const result = geoToHrrrIndex(41.88, -87.63, x, y);
    expect(result).not.toBeNull();
    expect(result!.xIdx).toBeGreaterThanOrEqual(0);
    expect(result!.xIdx).toBeLessThan(x.length);
    expect(result!.yIdx).toBeGreaterThanOrEqual(0);
    expect(result!.yIdx).toBeLessThan(y.length);
  });

  it("returns valid indices for a CONUS point (Denver)", () => {
    const result = geoToHrrrIndex(39.74, -104.99, x, y);
    expect(result).not.toBeNull();
    expect(result!.xIdx).toBeGreaterThanOrEqual(0);
    expect(result!.yIdx).toBeGreaterThanOrEqual(0);
  });

  it("returns null for London (outside CONUS)", () => {
    const result = geoToHrrrIndex(51.51, -0.13, x, y);
    expect(result).toBeNull();
  });

  it("returns null for Honolulu (outside CONUS)", () => {
    const result = geoToHrrrIndex(21.31, -157.86, x, y);
    expect(result).toBeNull();
  });

  it("returns null for empty coordinate arrays", () => {
    const result = geoToHrrrIndex(40, -90, [], []);
    expect(result).toBeNull();
  });

  it("returns null for single-element coordinate arrays", () => {
    const result = geoToHrrrIndex(40, -90, [0], [0]);
    expect(result).toBeNull();
  });
});

describe("toPoints", () => {
  it("omits missing values so NaN can't reach the blend", () => {
    // HRRR precipitation is NaN at lead 0 (an accumulation has no value at init)
    const points = toPoints([NaN, 0.5, 1], [0, 1, 2], new Date("2026-06-10T12:00:00Z"));
    expect(points.map((p) => p.time)).toEqual([
      "2026-06-10T13:00:00.000Z",
      "2026-06-10T14:00:00.000Z",
    ]);
    expect(points[0]!.median).toBe(0.5);
    expect(points[0]!.p90).toBe(0.5);
  });
});
