import { describe, it, expect } from "vitest";
import { detectAberrations } from "./aberrations.js";
import type { ForecastData, ForecastPoint, RecentWeather } from "./types.js";

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

function makeRecent(overrides: Partial<RecentWeather> = {}): RecentWeather {
  return {
    avgTemperature: 20,
    avgPrecipitation: 0,
    avgWindSpeed: 3,
    avgCloudCover: 0.5,
    ...overrides,
  };
}

describe("detectAberrations", () => {
  it("returns empty array when forecast matches recent weather", () => {
    const result = detectAberrations(makeForecast(), makeRecent());
    expect(result).toEqual([]);
  });

  it("detects significantly warmer temperatures", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 28, p10: 26, p90: 30, min: 24, max: 32, hoursFromNow: i * 3 }),
      ),
    });
    const recent = makeRecent({ avgTemperature: 20 });
    const result = detectAberrations(forecast, recent);
    expect(result.some((a) => a.type === "warm")).toBe(true);
  });

  it("detects significantly colder temperatures", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: i * 3 }),
      ),
    });
    const recent = makeRecent({ avgTemperature: 20 });
    const result = detectAberrations(forecast, recent);
    expect(result.some((a) => a.type === "cool")).toBe(true);
  });

  it("detects rain after dry conditions", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 1, p10: 0.5, p90: 3, min: 0, max: 5, hoursFromNow: i * 3 }),
      ),
    });
    const recent = makeRecent({ avgPrecipitation: 0.1 });
    const result = detectAberrations(forecast, recent);
    expect(result.some((a) => a.type === "rain")).toBe(true);
  });

  it("detects strong winds", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 8, p10: 6, p90: 12, min: 4, max: 15, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, makeRecent());
    expect(result.some((a) => a.type === "danger")).toBe(true);
  });

  it("detects clearing skies after cloudy period", () => {
    const forecast = makeForecast({
      cloudCover: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 0.1, p10: 0.05, p90: 0.2, min: 0, max: 0.3, hoursFromNow: i * 3 }),
      ),
    });
    const recent = makeRecent({ avgCloudCover: 0.7 });
    const result = detectAberrations(forecast, recent);
    expect(result.some((a) => a.type === "warm")).toBe(true);
    expect(result.some((a) => a.message.includes("Clearing"))).toBe(true);
  });

  it("detects large temperature swings", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: 20,
          p10: i < 12 ? 5 : 25,
          p90: i < 12 ? 10 : 30,
          min: 5,
          max: 30,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast, makeRecent());
    expect(result.some((a) => a.message.includes("swing"))).toBe(true);
  });
});
