import { describe, it, expect } from "vitest";
import { detectRainbowWindows } from "./rainbow.js";
import type { ForecastPoint, LatLon } from "./types.js";

// New York. On 2026-04-05 solar noon is ≈16:56 UTC (elevation ≈55°); the sun
// drops below 42° a little after 19:00 UTC and sets at ≈23:23 UTC. These
// tests use absolute UTC timestamps so they are timezone-independent.
const NYC: LatLon = { latitude: 40.7128, longitude: -74.006 };

function point(iso: string, median: number, hoursFromNow = 0): ForecastPoint {
  return {
    time: new Date(iso).toISOString(),
    hoursFromNow,
    median,
    p10: median,
    p90: median,
    min: median,
    max: median,
  };
}

function series(entries: Array<[string, number]>): ForecastPoint[] {
  return entries.map(([iso, median]) => point(iso, median));
}

describe("detectRainbowWindows", () => {
  it("detects a sun shower with the sun low in the sky", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([
        ["2026-04-05T20:00:00Z", 0],
        ["2026-04-05T21:00:00Z", 1.2],
      ]),
      cloudCover: series([
        ["2026-04-05T20:00:00Z", 0.4],
        ["2026-04-05T21:00:00Z", 0.4],
      ]),
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]!.startTime).toBe("2026-04-05T21:00:00.000Z");
    expect(windows[0]!.startMs).toBe(windows[0]!.endMs);
  });

  it("detects the timestep right after rain ends when the sky clears", () => {
    // Overcast while raining, then dry and mostly clear an hour later —
    // the lingering droplets plus fresh sunlight make the classic rainbow
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([
        ["2026-04-05T20:00:00Z", 1.5],
        ["2026-04-05T21:00:00Z", 0],
      ]),
      cloudCover: series([
        ["2026-04-05T20:00:00Z", 0.95],
        ["2026-04-05T21:00:00Z", 0.2],
      ]),
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]!.startTime).toBe("2026-04-05T21:00:00.000Z");
  });

  it("merges consecutive qualifying timesteps into one window", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([
        ["2026-04-05T20:00:00Z", 1],
        ["2026-04-05T21:00:00Z", 1],
        ["2026-04-05T22:00:00Z", 1],
      ]),
      cloudCover: series([
        ["2026-04-05T20:00:00Z", 0.3],
        ["2026-04-05T21:00:00Z", 0.3],
        ["2026-04-05T22:00:00Z", 0.3],
      ]),
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]!.startMs).toBe(new Date("2026-04-05T20:00:00Z").getTime());
    expect(windows[0]!.endMs).toBe(new Date("2026-04-05T22:00:00Z").getTime());
  });

  it("splits non-consecutive qualifying timesteps into separate windows", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([
        ["2026-04-05T20:00:00Z", 1],
        ["2026-04-05T21:00:00Z", 0],
        ["2026-04-05T22:00:00Z", 1],
      ]),
      cloudCover: series([
        ["2026-04-05T20:00:00Z", 0.3],
        // Fully overcast in the middle breaks the window even though
        // droplets from the 20:00 rain would still be around
        ["2026-04-05T21:00:00Z", 0.9],
        ["2026-04-05T22:00:00Z", 0.3],
      ]),
    });

    expect(windows).toHaveLength(2);
  });

  it("returns nothing when the sky is overcast", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([["2026-04-05T21:00:00Z", 2]]),
      cloudCover: series([["2026-04-05T21:00:00Z", 0.85]]),
    });
    expect(windows).toEqual([]);
  });

  it("returns nothing at night", () => {
    // 03:00 UTC = 11 PM in New York
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([["2026-04-05T03:00:00Z", 2]]),
      cloudCover: series([["2026-04-05T03:00:00Z", 0.1]]),
    });
    expect(windows).toEqual([]);
  });

  it("returns nothing when the sun is above 42 degrees", () => {
    // Midday near the summer solstice: sun ≈73° above the horizon, so the
    // whole rainbow arc would be below the horizon
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([["2026-06-21T17:00:00Z", 2]]),
      cloudCover: series([["2026-06-21T17:00:00Z", 0.2]]),
    });
    expect(windows).toEqual([]);
  });

  it("returns nothing without rain", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([["2026-04-05T21:00:00Z", 0.05]]),
      cloudCover: series([["2026-04-05T21:00:00Z", 0.2]]),
    });
    expect(windows).toEqual([]);
  });

  it("skips timesteps with no matching cloud cover data", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: series([["2026-04-05T21:00:00Z", 2]]),
      cloudCover: [],
    });
    expect(windows).toEqual([]);
  });

  it("carries the hoursFromNow of the window's first timestep", () => {
    const windows = detectRainbowWindows({
      location: NYC,
      precipitation: [point("2026-04-05T21:00:00Z", 1.2, 12)],
      cloudCover: [point("2026-04-05T21:00:00Z", 0.4)],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.hoursFromNow).toBe(12);
  });
});
