import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCached, setCache } from "./cache.js";
import type { ForecastData, RecentWeather } from "./types.js";

const mockForecast: ForecastData = {
  location: { latitude: 40, longitude: -74 },
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
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);

    expect(getCached(40, -74)).toBeNull();

    vi.useRealTimers();
  });

  it("evicts expired entries on write", () => {
    setCache(40, -74, mockForecast, mockRecent);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);

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
    vi.setSystemTime(Date.now() + 29 * 60 * 1000);

    expect(getCached(40, -74)).not.toBeNull();

    vi.useRealTimers();
  });

  it("handles corrupted localStorage gracefully", () => {
    storage.set("weather-cache", "not-valid-json");
    expect(getCached(40, -74)).toBeNull();
  });
});
