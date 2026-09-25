import { describe, it, expect } from "vitest";
import { computeHeatSeries, heatIndexRisk, wetBulbRisk, wetBulbTemperature } from "./heat.js";
import { dewPointFromRelativeHumidity } from "./humidity.js";
import type { ForecastPoint } from "./types.js";

/** A forecast point; unless given, its valid time follows its hoursFromNow */
function point(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: new Date(
      new Date(2026, 6, 20, 12, 0, 0).getTime() + (overrides.hoursFromNow ?? 0) * 3600 * 1000,
    ).toISOString(),
    hoursFromNow: 0,
    median: 30,
    p10: 28,
    p90: 32,
    min: 27,
    max: 33,
    ...overrides,
  };
}

describe("wetBulbTemperature", () => {
  // Reference values from psychrometric tables; Stull's approximation is
  // accurate to a few tenths of a degree over this range.
  it.each([
    { tempC: 30, rhPct: 70, expected: 25.6 },
    { tempC: 35, rhPct: 60, expected: 28.5 },
    { tempC: 40, rhPct: 50, expected: 30.9 },
    { tempC: 20, rhPct: 50, expected: 13.7 },
  ])("gives $expected°C at $tempC°C / $rhPct% RH", ({ tempC, rhPct, expected }) => {
    expect(wetBulbTemperature(tempC, rhPct)).toBeCloseTo(expected, 0);
  });

  it("equals the air temperature at saturation", () => {
    expect(wetBulbTemperature(25, 100)).toBeCloseTo(25, 0);
  });

  it("is always at or below the air temperature", () => {
    for (const t of [0, 10, 20, 30, 40]) {
      for (const rh of [10, 30, 50, 70, 90]) {
        expect(wetBulbTemperature(t, rh)).toBeLessThanOrEqual(t + 0.1);
      }
    }
  });

  it("increases with humidity at fixed temperature", () => {
    const values = [20, 40, 60, 80, 95].map((rh) => wetBulbTemperature(32, rh));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it("clamps relative humidity to the range the approximation is fit for", () => {
    expect(wetBulbTemperature(30, 0)).toBe(wetBulbTemperature(30, 5));
    expect(wetBulbTemperature(30, 120)).toBe(wetBulbTemperature(30, 99));
  });
});

describe("wetBulbRisk", () => {
  it.each([
    { wetBulbC: 15, level: "safe", warn: false },
    { wetBulbC: 26, level: "elevated", warn: false },
    { wetBulbC: 28, level: "dangerous", warn: true },
    { wetBulbC: 33, level: "extreme", warn: true },
    { wetBulbC: 36, level: "unsurvivable", warn: true },
  ])("classifies $wetBulbC°C as $level", ({ wetBulbC, level, warn }) => {
    const risk = wetBulbRisk(wetBulbC);
    expect(risk.level).toBe(level);
    expect(risk.warn).toBe(warn);
  });

  it("gives warning bands a label, icon and advice", () => {
    for (const wetBulbC of [28, 33, 36]) {
      const risk = wetBulbRisk(wetBulbC);
      expect(risk.label).not.toBe("");
      expect(risk.icon).not.toBe("");
      expect(risk.advice).not.toBe("");
    }
  });
});

describe("heatIndexRisk", () => {
  it.each([
    { heatIndexC: 20, level: "none", warn: false },
    { heatIndexC: 28, level: "caution", warn: false },
    { heatIndexC: 35, level: "extreme-caution", warn: false },
    { heatIndexC: 42, level: "danger", warn: true },
    { heatIndexC: 55, level: "extreme-danger", warn: true },
  ])("classifies $heatIndexC°C as $level", ({ heatIndexC, level, warn }) => {
    const risk = heatIndexRisk(heatIndexC);
    expect(risk.level).toBe(level);
    expect(risk.warn).toBe(warn);
  });

  it("gives warning bands a label, icon and advice", () => {
    for (const heatIndexC of [42, 55]) {
      const risk = heatIndexRisk(heatIndexC);
      expect(risk.label).not.toBe("");
      expect(risk.icon).not.toBe("");
      expect(risk.advice).not.toBe("");
    }
  });
});

describe("computeHeatSeries", () => {
  it("returns nothing without a dew point series", () => {
    expect(computeHeatSeries([point()], undefined)).toEqual([]);
    expect(computeHeatSeries([point()], [])).toEqual([]);
  });

  it("computes humidity, heat index and wet bulb per timestep", () => {
    const dew = dewPointFromRelativeHumidity(35, 60);
    const series = computeHeatSeries(
      [point({ median: 35, p90: 35 })],
      [point({ median: dew, p90: dew })],
    );
    expect(series).toHaveLength(1);
    const p = series[0]!;
    expect(p.tempC).toBe(35);
    expect(p.relativeHumidity).toBeCloseTo(60, 1);
    expect(p.wetBulbC).toBeCloseTo(28.5, 0);
    // Rothfusz heat index at 95°F / 60% RH is 113°F ≈ 45.1°C
    expect(p.heatIndexC).toBeCloseTo(45.1, 0);
  });

  it("aligns the dew point series by valid time", () => {
    // Same valid time, but hoursFromNow computed at different fetch times
    const time = "2026-07-20T15:00:00.000Z";
    const temperature = [point({ hoursFromNow: 0 }), point({ time, hoursFromNow: 3.4 })];
    const dewPoint = [point({ time, hoursFromNow: 2.6, median: 20, p90: 20 })];
    const series = computeHeatSeries(temperature, dewPoint);
    expect(series).toHaveLength(1);
    expect(series[0]!.hoursFromNow).toBe(3.4);
    expect(series[0]!.dewPointC).toBe(20);
  });

  it("holds the dew point at its median for the p90 metrics", () => {
    const series = computeHeatSeries(
      [point({ median: 32, p90: 38 })],
      [point({ median: 24, p90: 27 })],
    );
    const p = series[0]!;
    expect(p.dewPointC).toBe(24);
    // Raising the air temperature at a fixed dew point lowers relative
    // humidity, but both hazard metrics still rise.
    expect(p.heatIndexP90C).toBeGreaterThan(p.heatIndexC);
    expect(p.wetBulbP90C).toBeGreaterThan(p.wetBulbC);
  });

  it("never reports a p90 metric below its median counterpart", () => {
    // A degenerate ensemble with p90 below the median (guard against the
    // heat index's discontinuity at its 80°F escalation threshold)
    const series = computeHeatSeries(
      [point({ median: 27, p90: 26 })],
      [point({ median: 20, p90: 20 })],
    );
    const p = series[0]!;
    expect(p.heatIndexP90C).toBe(p.heatIndexC);
    expect(p.wetBulbP90C).toBe(p.wetBulbC);
  });
});
