import { describe, it, expect } from "vitest";
import { detectAberrations } from "./aberrations.js";
import type { ForecastData, ForecastPoint } from "./types.js";

function makePoint(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: "2026-03-04T00:00:00.000Z",
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
    // Median 5°C occurs first chronologically, so message should show cold→warm
    expect(swing!.message).toMatch(/5\.0°C to 30\.0°C/);
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
    expect(swing!.message).toMatch(/30\.0°C to 5\.0°C/);
  });

  it("does not flag temperature swing when range is small", () => {
    const result = detectAberrations(makeForecast());
    expect(result.some((a) => a.message.includes("swing"))).toBe(false);
  });

  it("detects heavy rain possible (p90 spike)", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 0.5, p10: 0, p90: 3, min: 0, max: 5, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "rain")).toBe(true);
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

  it("detects strong winds", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 8, p10: 6, p90: 12, min: 4, max: 15, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "danger")).toBe(true);
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
