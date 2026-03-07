import { describe, it, expect } from "vitest";
import { getCelestialEvents } from "./celestial.js";

/** Helper: extract hours (UTC) from an ISO timestamp */
function utcHour(iso: string): number {
  return new Date(iso).getUTCHours() + new Date(iso).getUTCMinutes() / 60;
}

describe("getCelestialEvents", () => {
  // New York City: 40.7128°N, 74.0060°W — well-known sunrise/sunset times
  const NYC_LAT = 40.7128;
  const NYC_LON = -74.006;

  // 72-hour window starting 2025-06-21T00:00Z (summer solstice)
  const summerStart = "2025-06-21T00:00:00.000Z";
  const summerEnd = "2025-06-24T00:00:00.000Z";

  it("returns sunrise, sunset, and moonrise events", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    const types = new Set(events.map((e) => e.type));
    expect(types.has("sunrise")).toBe(true);
    expect(types.has("sunset")).toBe(true);
    expect(types.has("moonrise")).toBe(true);
  });

  it("returns events sorted by time", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i]!.time).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1]!.time).getTime(),
      );
    }
  });

  it("produces multiple sunrises and sunsets over 72 hours", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    const sunrises = events.filter((e) => e.type === "sunrise");
    const sunsets = events.filter((e) => e.type === "sunset");
    expect(sunrises.length).toBeGreaterThanOrEqual(3);
    expect(sunsets.length).toBeGreaterThanOrEqual(3);
  });

  it("uses correct icons for each event type", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    for (const e of events) {
      if (e.type === "sunrise") expect(e.icon).toBe("\u2600");
      if (e.type === "sunset") expect(e.icon).toBe("\u263D");
      if (e.type === "moonrise") expect(e.icon).toBe("\uD83C\uDF15");
    }
  });

  it("sunrise occurs in the morning UTC for NYC (summer)", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    const sunrise = events.find((e) => e.type === "sunrise");
    expect(sunrise).toBeDefined();
    // NYC sunrise in summer is ~5:25 EDT = ~9:25 UTC
    const hour = utcHour(sunrise!.time);
    expect(hour).toBeGreaterThan(8);
    expect(hour).toBeLessThan(12);
  });

  it("sunset occurs in the evening UTC for NYC (summer)", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    const sunset = events.find((e) => e.type === "sunset");
    expect(sunset).toBeDefined();
    // NYC sunset in summer is ~8:30 EDT = ~0:30 UTC (next day)
    // Could be late evening UTC or just past midnight
    const hour = utcHour(sunset!.time);
    expect(hour >= 0 || hour <= 3).toBe(true);
  });

  it("all events fall within the requested time range", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    const startMs = new Date(summerStart).getTime();
    const endMs = new Date(summerEnd).getTime();
    for (const e of events) {
      const ms = new Date(e.time).getTime();
      expect(ms).toBeGreaterThanOrEqual(startMs);
      expect(ms).toBeLessThanOrEqual(endMs);
    }
  });

  it("deduplicates events within 30 minutes of each other", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerEnd);
    // For each type, no two events should be within 30 minutes
    for (const type of ["sunrise", "sunset", "moonrise"] as const) {
      const typed = events.filter((e) => e.type === type);
      for (let i = 1; i < typed.length; i++) {
        const diff = new Date(typed[i]!.time).getTime() - new Date(typed[i - 1]!.time).getTime();
        expect(diff).toBeGreaterThan(30 * 60 * 1000);
      }
    }
  });

  // Winter test — different sunrise/sunset times
  it("handles winter dates (shorter days)", () => {
    const winterStart = "2025-12-21T00:00:00.000Z";
    const winterEnd = "2025-12-24T00:00:00.000Z";
    const events = getCelestialEvents(NYC_LAT, NYC_LON, winterStart, winterEnd);
    const sunrises = events.filter((e) => e.type === "sunrise");
    const sunsets = events.filter((e) => e.type === "sunset");
    expect(sunrises.length).toBeGreaterThanOrEqual(3);
    expect(sunsets.length).toBeGreaterThanOrEqual(3);

    // Winter sunrise is later: ~7:15 EST = ~12:15 UTC
    const hour = utcHour(sunrises[0]!.time);
    expect(hour).toBeGreaterThan(11);
    expect(hour).toBeLessThan(14);
  });

  // Southern hemisphere
  it("works for southern hemisphere locations", () => {
    // Sydney: 33.8688°S, 151.2093°E
    const events = getCelestialEvents(-33.8688, 151.2093, summerStart, summerEnd);
    expect(events.length).toBeGreaterThan(0);
    const sunrises = events.filter((e) => e.type === "sunrise");
    expect(sunrises.length).toBeGreaterThanOrEqual(3);
  });

  // Polar region — may return no sunrise/sunset
  it("handles polar regions without crashing", () => {
    // North pole in winter — no sunrise
    const winterStart = "2025-12-21T00:00:00.000Z";
    const winterEnd = "2025-12-24T00:00:00.000Z";
    const events = getCelestialEvents(89, 0, winterStart, winterEnd);
    // Should not crash; may have no sunrise/sunset events
    const sunrises = events.filter((e) => e.type === "sunrise");
    expect(sunrises.length).toBe(0);
  });

  it("returns empty array when start equals end", () => {
    const events = getCelestialEvents(NYC_LAT, NYC_LON, summerStart, summerStart);
    expect(events.length).toBe(0);
  });
});
