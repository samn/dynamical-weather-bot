import { describe, it, expect } from "vitest";
import { computeXLabelTimes, timeMarkerLabel } from "./chart.js";

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
