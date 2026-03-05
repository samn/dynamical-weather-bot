import { describe, it, expect } from "vitest";
import { normalizeLongitude } from "./geo.js";

describe("normalizeLongitude", () => {
  it("keeps values in range unchanged", () => {
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(90)).toBe(90);
    expect(normalizeLongitude(-90)).toBe(-90);
    expect(normalizeLongitude(179)).toBe(179);
    expect(normalizeLongitude(-180)).toBe(-180);
  });

  it("wraps values above 180", () => {
    expect(normalizeLongitude(181)).toBeCloseTo(-179, 5);
    expect(normalizeLongitude(270)).toBeCloseTo(-90, 5);
    expect(normalizeLongitude(360)).toBeCloseTo(0, 5);
  });

  it("wraps values below -180", () => {
    expect(normalizeLongitude(-181)).toBeCloseTo(179, 5);
    expect(normalizeLongitude(-270)).toBeCloseTo(90, 5);
    expect(normalizeLongitude(-360)).toBeCloseTo(0, 5);
  });
});
