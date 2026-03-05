import type { ForecastData, RecentWeather } from "./types.js";

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STORAGE_KEY = "weather-cache";

interface CacheEntry {
  timestamp: number;
  forecast: ForecastData;
  recentWeather: RecentWeather;
}

interface CacheStore {
  [locationKey: string]: CacheEntry;
}

function locationKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function readStore(): CacheStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CacheStore;
  } catch {
    return {};
  }
}

function writeStore(store: CacheStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

export function getCached(
  lat: number,
  lon: number,
): { forecast: ForecastData; recentWeather: RecentWeather } | null {
  const store = readStore();
  const key = locationKey(lat, lon);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete store[key];
    writeStore(store);
    return null;
  }
  return { forecast: entry.forecast, recentWeather: entry.recentWeather };
}

export function setCache(
  lat: number,
  lon: number,
  forecast: ForecastData,
  recentWeather: RecentWeather,
): void {
  const store = readStore();
  // Evict expired entries
  const now = Date.now();
  for (const key of Object.keys(store)) {
    if (now - store[key]!.timestamp > CACHE_TTL_MS) {
      delete store[key];
    }
  }
  store[locationKey(lat, lon)] = { timestamp: now, forecast, recentWeather };
  writeStore(store);
}
