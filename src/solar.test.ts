import { describe, it, expect } from "vitest";
import { computeSunTimes, computeTimeMarkers, solarElevation } from "./solar.js";

/** Helper: create a UTC Date */
function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number = 0,
  min: number = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, min));
}

describe("computeSunTimes", () => {
  it("computes sunrise and sunset for New York on April 5 2026", () => {
    // New York: 40.7128 N, -74.006 W
    // Expected sunrise ~6:25 AM EDT (10:25 UTC), sunset ~7:23 PM EDT (23:23 UTC)
    const date = utcDate(2026, 4, 5);
    const result = computeSunTimes(date, 40.7128, -74.006);
    expect(result).toBeDefined();

    const sunrise = new Date(result!.sunrise);
    const sunset = new Date(result!.sunset);

    // Sunrise should be between 10:00 and 11:00 UTC (6:00-7:00 EDT)
    expect(sunrise.getUTCHours()).toBeGreaterThanOrEqual(10);
    expect(sunrise.getUTCHours()).toBeLessThanOrEqual(11);

    // Sunset should be between 23:00 and 24:00 UTC (19:00-20:00 EDT)
    expect(sunset.getUTCHours()).toBeGreaterThanOrEqual(23);
    expect(sunset.getUTCHours()).toBeLessThanOrEqual(23);
  });

  it("computes sunrise and sunset for London on June 21 2026", () => {
    // London: 51.5074 N, -0.1278 W
    // Summer solstice: sunrise ~4:43 AM BST (3:43 UTC), sunset ~9:21 PM BST (20:21 UTC)
    const date = utcDate(2026, 6, 21);
    const result = computeSunTimes(date, 51.5074, -0.1278);
    expect(result).toBeDefined();

    const sunrise = new Date(result!.sunrise);
    const sunset = new Date(result!.sunset);

    // Sunrise around 3:40-4:00 UTC
    expect(sunrise.getUTCHours()).toBeGreaterThanOrEqual(3);
    expect(sunrise.getUTCHours()).toBeLessThanOrEqual(4);

    // Sunset around 20:00-21:00 UTC
    expect(sunset.getUTCHours()).toBeGreaterThanOrEqual(20);
    expect(sunset.getUTCHours()).toBeLessThanOrEqual(21);
  });

  it("computes sunrise and sunset for Sydney on Dec 21 2026", () => {
    // Sydney: -33.8688 S, 151.2093 E
    // Summer solstice in southern hemisphere: sunrise ~5:42 AM AEDT (18:42 UTC prev day)
    const date = utcDate(2026, 12, 21);
    const result = computeSunTimes(date, -33.8688, 151.2093);
    expect(result).toBeDefined();

    const sunrise = new Date(result!.sunrise);
    const sunset = new Date(result!.sunset);

    // Sunrise should be early local time (around 18:30-19:30 UTC previous day)
    expect(sunrise.getUTCHours()).toBeGreaterThanOrEqual(18);
    expect(sunrise.getUTCHours()).toBeLessThanOrEqual(20);

    // Sunset around 09:00-10:00 UTC (about 20:00 AEDT)
    expect(sunset.getUTCHours()).toBeGreaterThanOrEqual(8);
    expect(sunset.getUTCHours()).toBeLessThanOrEqual(10);
  });

  it("returns undefined for polar regions during polar day", () => {
    // Tromso, Norway: 69.6496 N, 18.9560 E — midnight sun in June
    const date = utcDate(2026, 6, 21);
    const result = computeSunTimes(date, 69.6496, 18.956);
    expect(result).toBeUndefined();
  });

  it("returns undefined for polar regions during polar night", () => {
    // Tromso: polar night in December
    const date = utcDate(2026, 12, 21);
    const result = computeSunTimes(date, 69.6496, 18.956);
    expect(result).toBeUndefined();
  });
});

describe("solarElevation", () => {
  const NY_LAT = 40.7128;
  const NY_LON = -74.006;

  it("is near zero at the computed sunrise time", () => {
    const sun = computeSunTimes(utcDate(2026, 4, 5), NY_LAT, NY_LON);
    expect(sun).toBeDefined();
    // computeSunTimes includes -0.833° refraction, so the geometric
    // elevation at "sunrise" sits slightly below zero
    const elevation = solarElevation(sun!.sunrise, NY_LAT, NY_LON);
    expect(elevation).toBeGreaterThan(-2);
    expect(elevation).toBeLessThan(0.5);
  });

  it("peaks near 90 - latitude + declination at solar noon", () => {
    // London on the June solstice: max elevation ≈ 90 - 51.5 + 23.4 ≈ 62°
    const noon = utcDate(2026, 6, 21, 12).getTime();
    const elevation = solarElevation(noon, 51.5074, -0.1278);
    expect(elevation).toBeGreaterThan(60);
    expect(elevation).toBeLessThan(64);
  });

  it("is strongly negative in the middle of the night", () => {
    // 4:00 UTC = midnight EDT in New York
    const midnight = utcDate(2026, 4, 5, 4).getTime();
    expect(solarElevation(midnight, NY_LAT, NY_LON)).toBeLessThan(-20);
  });

  it("is nearly overhead at the equator on the equinox", () => {
    const noon = utcDate(2026, 3, 20, 12).getTime();
    expect(solarElevation(noon, 0, 0)).toBeGreaterThan(85);
  });

  it("descends through the rainbow-friendly range in the late afternoon", () => {
    // New York, April 5 2026 (solar noon ≈ 16:56 UTC, elevation ≈ 55°)
    expect(solarElevation(utcDate(2026, 4, 5, 19).getTime(), NY_LAT, NY_LON)).toBeGreaterThan(42);
    const late = solarElevation(utcDate(2026, 4, 5, 21).getTime(), NY_LAT, NY_LON);
    expect(late).toBeGreaterThan(20);
    expect(late).toBeLessThan(32);
  });
});

describe("computeTimeMarkers", () => {
  it("returns midnight markers at 00:00 local time", () => {
    // Use UTC+0 equivalent location (longitude 0) so local ≈ UTC
    const start = utcDate(2026, 4, 1, 6).getTime();
    const end = utcDate(2026, 4, 4, 6).getTime();
    const markers = computeTimeMarkers(start, end, 51.5, 0);

    const midnights = markers.filter((m) => m.type === "midnight");
    // Should have midnights on Apr 2, 3, 4
    expect(midnights.length).toBe(3);
    for (const m of midnights) {
      const d = new Date(m.timeMs);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });

  it("returns noon markers at 12:00 local time", () => {
    const start = utcDate(2026, 4, 1, 6).getTime();
    const end = utcDate(2026, 4, 4, 6).getTime();
    const markers = computeTimeMarkers(start, end, 51.5, 0);

    const noons = markers.filter((m) => m.type === "noon");
    // Should have noons on Apr 1, 2, 3
    expect(noons.length).toBe(3);
    for (const m of noons) {
      const d = new Date(m.timeMs);
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });

  it("returns sunrise and sunset markers", () => {
    const start = utcDate(2026, 4, 5, 0).getTime();
    const end = utcDate(2026, 4, 6, 0).getTime();
    const markers = computeTimeMarkers(start, end, 40.7128, -74.006);

    const sunrises = markers.filter((m) => m.type === "sunrise");
    const sunsets = markers.filter((m) => m.type === "sunset");

    expect(sunrises.length).toBe(1);
    expect(sunsets.length).toBe(1);

    // Sunrise before sunset
    expect(sunrises[0]!.timeMs).toBeLessThan(sunsets[0]!.timeMs);
  });

  it("excludes markers outside the time range", () => {
    // Very short window: just 2 hours in the middle of the day
    const start = utcDate(2026, 4, 5, 14).getTime();
    const end = utcDate(2026, 4, 5, 16).getTime();
    const markers = computeTimeMarkers(start, end, 40.7128, -74.006);

    // No midnights, no noons, no sunrise/sunset in this narrow window
    expect(markers.length).toBe(0);
  });

  it("returns markers sorted by time", () => {
    const start = utcDate(2026, 4, 5, 0).getTime();
    const end = utcDate(2026, 4, 7, 0).getTime();
    const markers = computeTimeMarkers(start, end, 40.7128, -74.006);

    for (let i = 1; i < markers.length; i++) {
      expect(markers[i]!.timeMs).toBeGreaterThanOrEqual(markers[i - 1]!.timeMs);
    }
  });

  it("returns empty array when range is zero", () => {
    const t = utcDate(2026, 4, 5, 12).getTime();
    expect(computeTimeMarkers(t, t, 40, -74)).toEqual([]);
  });

  it("handles polar regions where computeSunTimes returns undefined", () => {
    // Tromso, Norway during polar night — no sunrise/sunset
    const start = utcDate(2026, 12, 20, 0).getTime();
    const end = utcDate(2026, 12, 23, 0).getTime();
    const markers = computeTimeMarkers(start, end, 69.6496, 18.956);

    // Should still have midnight and noon markers but no sunrise/sunset
    const sunrises = markers.filter((m) => m.type === "sunrise");
    const sunsets = markers.filter((m) => m.type === "sunset");
    expect(sunrises.length).toBe(0);
    expect(sunsets.length).toBe(0);

    const midnights = markers.filter((m) => m.type === "midnight");
    expect(midnights.length).toBeGreaterThan(0);
  });

  it("handles multi-day ranges with all marker types", () => {
    const start = utcDate(2026, 4, 5, 0).getTime();
    const end = utcDate(2026, 4, 8, 0).getTime();
    const markers = computeTimeMarkers(start, end, 40.7128, -74.006);

    const types = new Set(markers.map((m) => m.type));
    expect(types.has("midnight")).toBe(true);
    expect(types.has("noon")).toBe(true);
    expect(types.has("sunrise")).toBe(true);
    expect(types.has("sunset")).toBe(true);
  });
});
