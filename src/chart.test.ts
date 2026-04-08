import { describe, it, expect } from "vitest";
import { computeXLabelTimes, computeYRange, timeMarkerLabel } from "./chart.js";

/** Helper: create a local-time Date. */
function localDate(
  year: number,
  month: number,
  day: number,
  hour: number = 0,
  min: number = 0,
): Date {
  return new Date(year, month - 1, day, hour, min);
}

describe("computeXLabelTimes", () => {
  it("returns empty array when time range is zero", () => {
    const t = localDate(2026, 4, 1, 12).getTime();
    expect(computeXLabelTimes(t, t, 6)).toEqual([]);
  });

  it("returns empty array when maxLabels is zero", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 4, 0).getTime();
    expect(computeXLabelTimes(first, last, 0)).toEqual([]);
  });

  it("snaps labels to clock-hour boundaries", () => {
    // 72h range, 6 labels → ~12h interval → 12h boundaries
    const first = localDate(2026, 4, 1, 2, 30).getTime();
    const last = localDate(2026, 4, 4, 2, 30).getTime();
    const labels = computeXLabelTimes(first, last, 6);
    for (const t of labels) {
      const d = new Date(t);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
      expect(d.getHours() % 12).toBe(0);
    }
  });

  it("produces consistent labels regardless of data density", () => {
    // Same time range but imagine different source combinations
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 4, 0).getTime();
    const maxLabels = 6;

    const labels1 = computeXLabelTimes(first, last, maxLabels);
    const labels2 = computeXLabelTimes(first, last, maxLabels);
    expect(labels1).toEqual(labels2);
  });

  it("labels stay within the data time range (exclusive of endpoints)", () => {
    const first = localDate(2026, 4, 1, 3).getTime();
    const last = localDate(2026, 4, 4, 3).getTime();
    const labels = computeXLabelTimes(first, last, 6);
    expect(labels.length).toBeGreaterThan(0);
    for (const t of labels) {
      expect(t).toBeGreaterThan(first);
      expect(t).toBeLessThan(last);
    }
  });

  it("uses 6h intervals for a ~24h range with 4 labels", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 2, 0).getTime();
    const labels = computeXLabelTimes(first, last, 4);
    // With 24h / 4 = 6h raw interval → 6h nice interval
    expect(labels.length).toBeGreaterThan(0);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]! - labels[i - 1]!).toBe(6 * 60 * 60 * 1000);
    }
  });

  it("uses 12h intervals for a 72h range with 6 labels", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 4, 0).getTime();
    const labels = computeXLabelTimes(first, last, 6);
    expect(labels.length).toBeGreaterThan(0);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]! - labels[i - 1]!).toBe(12 * 60 * 60 * 1000);
    }
  });

  it("does not exceed maxLabels", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 4, 0).getTime();
    for (const max of [4, 6, 8]) {
      const labels = computeXLabelTimes(first, last, max);
      expect(labels.length).toBeLessThanOrEqual(max);
    }
  });

  it("handles short time ranges with 3h intervals", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 1, 18).getTime();
    // 18h / 6 = 3h raw → 3h nice
    const labels = computeXLabelTimes(first, last, 6);
    expect(labels.length).toBeGreaterThan(0);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]! - labels[i - 1]!).toBe(3 * 60 * 60 * 1000);
    }
  });

  it("handles very long time ranges with 24h+ intervals", () => {
    const first = localDate(2026, 4, 1, 0).getTime();
    const last = localDate(2026, 4, 15, 0).getTime();
    // 336h / 6 = 56h → ceil(56/24)*24 = 72h
    const labels = computeXLabelTimes(first, last, 6);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(6);
  });
});

const mkData = (points: { min: number; max: number }[]) => points;

describe("computeYRange", () => {
  it("adds 10% padding above and below data range", () => {
    const data = mkData([{ min: 10, max: 20 }]);
    const { yMin, yMax } = computeYRange(data);
    expect(yMin).toBe(10 - 1); // 10% of 10 = 1
    expect(yMax).toBe(20 + 1);
  });

  it("uses fallback padding of 1 when data range is zero", () => {
    const data = mkData([{ min: 5, max: 5 }]);
    const { yMin, yMax } = computeYRange(data);
    expect(yMin).toBe(4);
    expect(yMax).toBe(6);
  });

  it("clamps yMin with yClampMin", () => {
    // Data min=0, padding pushes yMin negative
    const data = mkData([{ min: 0, max: 10 }]);
    const unclamped = computeYRange(data);
    expect(unclamped.yMin).toBeLessThan(0);

    const clamped = computeYRange(data, undefined, 0);
    expect(clamped.yMin).toBe(0);
  });

  it("clamps yMax with yClampMax", () => {
    // Data max close to 1 (cloud cover fraction), padding pushes yMax above 1
    const data = mkData([{ min: 0, max: 1 }]);
    const unclamped = computeYRange(data);
    expect(unclamped.yMax).toBeGreaterThan(1);

    const clamped = computeYRange(data, undefined, undefined, 1);
    expect(clamped.yMax).toBe(1);
  });

  it("clamps both yMin and yMax for cloud cover style charts", () => {
    const data = mkData([{ min: 0.05, max: 0.95 }]);
    const { yMin, yMax } = computeYRange(data, undefined, 0, 1);
    expect(yMin).toBeGreaterThanOrEqual(0);
    expect(yMax).toBeLessThanOrEqual(1);
  });

  it("does not clamp when data is well within bounds", () => {
    const data = mkData([{ min: 0.3, max: 0.6 }]);
    const { yMin, yMax } = computeYRange(data, undefined, 0, 1);
    // Padding: range=0.3, pad=0.03, yMin=0.27, yMax=0.63 — both within [0,1]
    expect(yMin).toBeGreaterThan(0);
    expect(yMax).toBeLessThan(1);
  });

  it("wind speed: yMin is clamped to 0", () => {
    const data = mkData([
      { min: 0, max: 5 },
      { min: 1, max: 8 },
    ]);
    const { yMin } = computeYRange(data, undefined, 0);
    expect(yMin).toBe(0);
  });

  it("forces yMin to 0 when intensity bands are present", () => {
    const bands = [
      { min: 0, max: 2, label: "Light", color: "rgba(0,0,0,0.1)" },
      { min: 2, max: 5, label: "Heavy", color: "rgba(0,0,0,0.2)" },
    ];
    const data = mkData([{ min: 1, max: 3 }]);
    const { yMin } = computeYRange(data, bands);
    expect(yMin).toBe(0);
  });

  it("extends yMax to cover band ceiling when bands are present", () => {
    const bands = [
      { min: 0, max: 2, label: "Light", color: "rgba(0,0,0,0.1)" },
      { min: 2, max: 10, label: "Heavy", color: "rgba(0,0,0,0.2)" },
    ];
    const data = mkData([{ min: 0.5, max: 1.5 }]);
    const { yMax } = computeYRange(data, bands);
    // Data max is 1.5, first band with max >= 1.5 is the "Light" band (max=2)
    expect(yMax).toBeGreaterThanOrEqual(2);
  });

  it("yClampMin applies after intensity band adjustments", () => {
    const bands = [{ min: 0, max: 5, label: "Low", color: "rgba(0,0,0,0.1)" }];
    const data = mkData([{ min: 1, max: 3 }]);
    // Bands force yMin=0, clamp can only raise it
    const { yMin } = computeYRange(data, bands, 1);
    expect(yMin).toBe(1);
  });

  it("spans multiple data points correctly", () => {
    const data = mkData([
      { min: 2, max: 5 },
      { min: 1, max: 8 },
      { min: 3, max: 6 },
    ]);
    const { yMin, yMax } = computeYRange(data);
    // Overall range: min=1, max=8, pad=0.7
    expect(yMin).toBeCloseTo(0.3, 5);
    expect(yMax).toBeCloseTo(8.7, 5);
  });
});

describe("timeMarkerLabel", () => {
  it("returns '12 AM' for midnight", () => {
    expect(timeMarkerLabel("midnight")).toBe("12 AM");
  });

  it("returns '12 PM' for noon", () => {
    expect(timeMarkerLabel("noon")).toBe("12 PM");
  });

  it("returns 'Sunrise' for sunrise", () => {
    expect(timeMarkerLabel("sunrise")).toBe("Sunrise");
  });

  it("returns 'Sunset' for sunset", () => {
    expect(timeMarkerLabel("sunset")).toBe("Sunset");
  });
});
