import { describe, it, expect } from "vitest";
import { detectAberrations } from "./aberrations.js";
import { formatDayPart } from "./format.js";
import { solarElevation } from "./solar.js";
import type { ForecastData, ForecastPoint } from "./types.js";

/** Local-time base so day-part assertions are timezone-independent */
const BASE_TIME = new Date(2026, 2, 4, 0, 0, 0);

/** ISO timestamp for a given number of hours after the local base time */
function pointTime(hoursFromNow: number): string {
  return new Date(BASE_TIME.getTime() + hoursFromNow * 3600_000).toISOString();
}

function makePoint(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: pointTime(overrides.hoursFromNow ?? 0),
    hoursFromNow: 0,
    median: 20,
    p10: 18,
    p90: 22,
    min: 16,
    max: 24,
    ...overrides,
  };
}

function makeForecast(overrides: Partial<ForecastData> = {}): ForecastData {
  const defaultPoints = Array.from({ length: 24 }, (_, i) => makePoint({ hoursFromNow: i * 3 }));
  return {
    location: { latitude: 40, longitude: -74 },
    initTime: "2026-03-04T00:00:00.000Z",
    temperature: defaultPoints,
    precipitation: defaultPoints.map((p) => ({ ...p, median: 0, p10: 0, p90: 0, min: 0, max: 0 })),
    windSpeed: defaultPoints.map((p) => ({ ...p, median: 3, p10: 2, p90: 5, min: 1, max: 6 })),
    cloudCover: defaultPoints.map((p) => ({
      ...p,
      median: 0.5,
      p10: 0.3,
      p90: 0.7,
      min: 0.2,
      max: 0.8,
    })),
    ...overrides,
  };
}

describe("detectAberrations", () => {
  it("handles empty forecast arrays without crashing", () => {
    const forecast = makeForecast({
      temperature: [],
      precipitation: [],
      windSpeed: [],
      cloudCover: [],
    });
    expect(() => detectAberrations(forecast)).not.toThrow();
  });

  it("returns empty array when forecast is mild and steady", () => {
    const result = detectAberrations(makeForecast());
    expect(result).toEqual([]);
  });

  it("detects large temperature swings in chronological order (cold first)", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 5 : 30,
          p10: i < 12 ? 3 : 28,
          p90: i < 12 ? 7 : 32,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const swing = result.find((a) => a.message.includes("swing"));
    expect(swing).toBeDefined();
    // Median 5°C occurs first chronologically, so message should show cold→warm,
    // each endpoint annotated with when it occurs
    expect(swing!.message).toContain(`5.0°C (${formatDayPart(pointTime(0))})`);
    expect(swing!.message).toContain(`to 30.0°C (${formatDayPart(pointTime(36))})`);
  });

  it("detects large temperature swings in chronological order (warm first)", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 30 : 5,
          p10: i < 12 ? 28 : 3,
          p90: i < 12 ? 32 : 7,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const swing = result.find((a) => a.message.includes("swing"));
    expect(swing).toBeDefined();
    // Median 30°C occurs first chronologically, so message should show warm→cold
    expect(swing!.message).toContain(`30.0°C (${formatDayPart(pointTime(0))})`);
    expect(swing!.message).toContain(`to 5.0°C (${formatDayPart(pointTime(36))})`);
  });

  it("does not flag temperature swing when range is small", () => {
    const result = detectAberrations(makeForecast());
    expect(result.some((a) => a.message.includes("swing"))).toBe(false);
  });

  it("detects heavy rain possible (p90 spike) with timing of the peak", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: 0.5,
          p10: 0,
          p90: i === 10 ? 3 : 1,
          min: 0,
          max: 5,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const rain = result.find((a) => a.type === "rain");
    expect(rain).toBeDefined();
    expect(rain!.message).toContain(`Heavy rain possible ${formatDayPart(pointTime(30))}`);
  });

  it("flags a possible rainbow when rain coincides with a low, visible sun", () => {
    const forecast = makeForecast();
    // Pick a timestep where the sun is up but below the 42° rainbow limit —
    // computed from the actual timestamps so the test is timezone-independent
    const idx = forecast.precipitation.findIndex((p) => {
      const elevation = solarElevation(
        new Date(p.time).getTime(),
        forecast.location.latitude,
        forecast.location.longitude,
      );
      return elevation > 3 && elevation < 40;
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    forecast.precipitation[idx] = { ...forecast.precipitation[idx]!, median: 1, p10: 1, p90: 1 };
    forecast.cloudCover[idx] = { ...forecast.cloudCover[idx]!, median: 0.3 };

    const result = detectAberrations(forecast);
    const rainbow = result.find((a) => a.type === "rainbow");
    expect(rainbow).toBeDefined();
    expect(rainbow!.icon).toBe("\u{1F308}");
    expect(rainbow!.message).toContain("Rainbow possible");
  });

  it("does not flag a rainbow when the sky stays overcast", () => {
    const forecast = makeForecast();
    const overcast = forecast.cloudCover.map((p) => ({ ...p, median: 0.95 }));
    const rainy = forecast.precipitation.map((p) => ({ ...p, median: 1, p10: 1, p90: 1 }));
    const result = detectAberrations({ ...forecast, precipitation: rainy, cloudCover: overcast });
    expect(result.some((a) => a.type === "rainbow")).toBe(false);
  });

  it("does not flag rainbow windows that are already in the past", () => {
    // Rain and broken cloud across the past three days: rainbow conditions
    // certainly occurred, but every timestep has negative hoursFromNow
    const pastPoints = Array.from({ length: 24 }, (_, i) =>
      makePoint({ hoursFromNow: i * 3 - 72 }),
    );
    const forecast = makeForecast({
      temperature: pastPoints,
      precipitation: pastPoints.map((p) => ({ ...p, median: 1, p10: 1, p90: 1, min: 0, max: 2 })),
      windSpeed: pastPoints.map((p) => ({ ...p, median: 3, p10: 2, p90: 5, min: 1, max: 6 })),
      cloudCover: pastPoints.map((p) => ({
        ...p,
        median: 0.2,
        p10: 0.1,
        p90: 0.3,
        min: 0,
        max: 0.4,
      })),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "rainbow")).toBe(false);
  });

  it("detects persistent precipitation", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 3, p10: 1, p90: 5, min: 0, max: 7, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "rain" && a.message.includes("Persistent"))).toBe(true);
  });

  it("detects strong winds with timing of the peak", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: 8,
          p10: 6,
          p90: i === 6 ? 12 : 8,
          min: 4,
          max: 15,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const wind = result.find((a) => a.type === "danger");
    expect(wind).toBeDefined();
    expect(wind!.message).toContain(`Strong winds expected ${formatDayPart(pointTime(18))}`);
  });

  it("detects clearing skies within the forecast window", () => {
    const forecast = makeForecast({
      cloudCover: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 0.9 : 0.2,
          p10: i < 12 ? 0.8 : 0.1,
          p90: i < 12 ? 1 : 0.4,
          min: 0.1,
          max: 1,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "warm" && a.message.includes("Clearing"))).toBe(true);
  });

  it("detects increasing cloud cover within the forecast window", () => {
    const forecast = makeForecast({
      cloudCover: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 0.1 : 0.8,
          p10: i < 12 ? 0.05 : 0.7,
          p90: i < 12 ? 0.2 : 0.9,
          min: 0,
          max: 1,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "cool" && a.message.includes("Increasing"))).toBe(true);
  });

  it("flags oppressive humidity from a high dew point with timing of the peak", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i === 8 ? 23 : 12,
          p10: 10,
          p90: 24,
          min: 9,
          max: 25,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const humid = result.find((a) => a.type === "humid");
    expect(humid).toBeDefined();
    expect(humid!.message).toContain("Oppressive");
    expect(humid!.message).toContain(formatDayPart(pointTime(24)));
    expect(humid!.message).toContain("23.0°C");
  });

  it("does not flag humidity when the dew point stays comfortable", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 11, p10: 9, p90: 13, min: 8, max: 14, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "humid")).toBe(false);
  });

  it("does not flag humidity when no dew point data is present", () => {
    const result = detectAberrations(makeForecast());
    expect(result.some((a) => a.type === "humid")).toBe(false);
  });

  it("formats the dew point in imperial for humidity alerts", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 25, p10: 23, p90: 26, min: 22, max: 27, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    const humid = result.find((a) => a.type === "humid");
    expect(humid).toBeDefined();
    expect(humid!.message).toContain("°F");
  });

  it("uses imperial units when specified", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 5 : 30,
          p10: i < 12 ? 3 : 28,
          p90: i < 12 ? 7 : 32,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.message.includes("°F"))).toBe(true);
  });

  it("formats wind in mph for imperial", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 8, p10: 6, p90: 12, min: 4, max: 15, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.type === "danger" && a.message.includes("mph"))).toBe(true);
  });

  it("formats precipitation in in/hr for imperial", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 3, p10: 1, p90: 5, min: 0, max: 7, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.type === "rain" && a.message.includes("in/hr"))).toBe(true);
  });
});
