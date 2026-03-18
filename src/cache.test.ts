import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCached, setCache } from "./cache.js";
import type { ModelVariableInput } from "./blend.js";
import type { ForecastData, ForecastVariable, RecentWeather } from "./types.js";

const mockForecast: ForecastData = {
  location: { latitude: 40, longitude: -74 },
  initTime: "2026-03-07T00:00:00.000Z",
  temperature: [],
  precipitation: [],
  windSpeed: [],
  cloudCover: [],
};

const mockRecent: RecentWeather = {
  avgTemperature: 20,
  avgPrecipitation: 0.1,
  avgWindSpeed: 3,
  avgCloudCover: 0.5,
};

// Stub localStorage for node environment
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() {
    return storage.size;
  },
  key: (_index: number) => null,
};

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", localStorageStub);
});

describe("setCache / getCached", () => {
  it("stores and retrieves data for a location", () => {
    setCache(40, -74, mockForecast, mockRecent);
    const result = getCached(40, -74);
    expect(result).not.toBeNull();
    expect(result!.forecast).toEqual(mockForecast);
    expect(result!.recentWeather).toEqual(mockRecent);
  });

  it("returns null for uncached location", () => {
    expect(getCached(50, 10)).toBeNull();
  });

  it("returns null for expired entries", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 49 * 60 * 60 * 1000);

    expect(getCached(40, -74)).toBeNull();

    vi.useRealTimers();
  });

  it("evicts expired entries on write", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 49 * 60 * 60 * 1000);

    setCache(50, 10, mockForecast, mockRecent);

    const raw = JSON.parse(storage.get("weather-cache")!);
    const keys = Object.keys(raw);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("50.00,10.00");

    vi.useRealTimers();
  });

  it("returns fresh entries within TTL", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 50 * 60 * 1000); // 50 minutes (within 1-hour TTL)

    expect(getCached(40, -74)).not.toBeNull();

    vi.useRealTimers();
  });

  it("handles corrupted localStorage gracefully", () => {
    storage.set("weather-cache", "not-valid-json");
    expect(getCached(40, -74)).toBeNull();
  });

  it("preserves initTime through cache roundtrip", () => {
    const forecast: ForecastData = {
      ...mockForecast,
      initTime: "2026-03-06T18:00:00.000Z",
    };
    setCache(40, -74, forecast, mockRecent);
    const result = getCached(40, -74);
    expect(result!.forecast.initTime).toBe("2026-03-06T18:00:00.000Z");
  });

  it("stores multiple locations independently", () => {
    const forecastNY: ForecastData = {
      ...mockForecast,
      location: { latitude: 40.71, longitude: -74.01 },
      initTime: "2026-03-07T00:00:00.000Z",
    };
    const forecastLA: ForecastData = {
      ...mockForecast,
      location: { latitude: 34.05, longitude: -118.24 },
      initTime: "2026-03-07T06:00:00.000Z",
    };

    setCache(40.71, -74.01, forecastNY, mockRecent);
    setCache(34.05, -118.24, forecastLA, mockRecent);

    const ny = getCached(40.71, -74.01);
    const la = getCached(34.05, -118.24);

    expect(ny!.forecast.initTime).toBe("2026-03-07T00:00:00.000Z");
    expect(la!.forecast.initTime).toBe("2026-03-07T06:00:00.000Z");
  });

  it("overwrites existing entry for the same location", () => {
    const oldForecast: ForecastData = { ...mockForecast, initTime: "2026-03-06T00:00:00.000Z" };
    const newForecast: ForecastData = { ...mockForecast, initTime: "2026-03-07T12:00:00.000Z" };

    setCache(40, -74, oldForecast, mockRecent);
    setCache(40, -74, newForecast, mockRecent);

    const result = getCached(40, -74);
    expect(result!.forecast.initTime).toBe("2026-03-07T12:00:00.000Z");
  });

  it("is still fresh at exactly the 1-hour boundary", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    // At exactly 1 hour — not yet expired (uses > not >=)
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect(getCached(40, -74)).not.toBeNull();

    vi.useRealTimers();
  });

  it("expires 1ms past the 1-hour boundary", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    expect(getCached(40, -74)).toBeNull();

    vi.useRealTimers();
  });

  it("keeps non-expired entries when evicting expired ones", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    // Advance 30 minutes — first entry still fresh
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    setCache(50, 10, mockForecast, mockRecent);

    // Advance another 35 minutes — first entry now expired (65min total), second still fresh (35min)
    vi.setSystemTime(Date.now() + 35 * 60 * 1000);
    setCache(60, 20, mockForecast, mockRecent);

    const raw = JSON.parse(storage.get("weather-cache")!);
    const keys = Object.keys(raw);
    expect(keys).toContain("50.00,10.00");
    expect(keys).toContain("60.00,20.00");
    expect(keys).not.toContain("40.00,-74.00");

    vi.useRealTimers();
  });

  it("cleans up expired entry from store on read", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 49 * 60 * 60 * 1000);

    getCached(40, -74); // should delete expired entry

    const raw = JSON.parse(storage.get("weather-cache")!);
    expect(Object.keys(raw)).toHaveLength(0);

    vi.useRealTimers();
  });

  it("rounds location keys to 2 decimal places", () => {
    setCache(40.714, -74.006, mockForecast, mockRecent);

    const raw = JSON.parse(storage.get("weather-cache")!);
    expect(Object.keys(raw)).toEqual(["40.71,-74.01"]);

    // Can retrieve with the same coordinates
    expect(getCached(40.714, -74.006)).not.toBeNull();
  });

  it("handles corrupted cache entry gracefully on write", () => {
    storage.set("weather-cache", "{{invalid}}");
    // Should not throw, should just create a fresh cache
    expect(() => setCache(40, -74, mockForecast, mockRecent)).not.toThrow();
    expect(getCached(40, -74)).not.toBeNull();
  });

  it("stores and retrieves per-model inputs", () => {
    const points = [
      {
        time: "2026-03-07T00:00:00Z",
        hoursFromNow: 0,
        median: 15,
        p10: 13,
        p90: 17,
        min: 11,
        max: 19,
      },
    ];
    const modelInputs = new Map<ForecastVariable, ModelVariableInput[]>();
    modelInputs.set("temperature", [
      { model: "NOAA GEFS", points, isEnsemble: true },
      { model: "ECMWF IFS ENS", points, isEnsemble: true },
    ]);

    setCache(40, -74, mockForecast, mockRecent, modelInputs, false);
    const result = getCached(40, -74);

    expect(result).not.toBeNull();
    expect(result!.modelInputs).not.toBeNull();
    expect(result!.modelInputs!.get("temperature")).toHaveLength(2);
    expect(result!.modelInputs!.get("temperature")![0]!.model).toBe("NOAA GEFS");
    expect(result!.hrrrAvailable).toBe(false);
  });

  it("returns null modelInputs for legacy cache entries without per-model data", () => {
    setCache(40, -74, mockForecast, mockRecent);
    const result = getCached(40, -74);

    expect(result).not.toBeNull();
    expect(result!.modelInputs).toBeNull();
    expect(result!.hrrrAvailable).toBe(true);
  });
});
