import type { ForecastData, ForecastVariable, RecentWeather } from "./types.js";
import type { ModelVariableInput } from "./blend.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const STORAGE_KEY = "weather-cache";

/** Serializable per-model inputs keyed by forecast variable */
type SerializedModelInputs = Record<string, ModelVariableInput[]>;

interface CacheEntry {
  timestamp: number;
  forecast: ForecastData;
  recentWeather: RecentWeather;
  /** Per-model inputs for each variable, enabling immediate reblending */
  modelInputs?: SerializedModelInputs;
  hrrrAvailable?: boolean;
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

export interface CachedData {
  forecast: ForecastData;
  recentWeather: RecentWeather;
  modelInputs: Map<ForecastVariable, ModelVariableInput[]> | null;
  hrrrAvailable: boolean;
}

export function getCached(lat: number, lon: number): CachedData | null {
  const store = readStore();
  const key = locationKey(lat, lon);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete store[key];
    writeStore(store);
    return null;
  }
  let modelInputs: Map<ForecastVariable, ModelVariableInput[]> | null = null;
  if (entry.modelInputs) {
    modelInputs = new Map<ForecastVariable, ModelVariableInput[]>();
    for (const [varKey, inputs] of Object.entries(entry.modelInputs)) {
      modelInputs.set(varKey as ForecastVariable, inputs);
    }
  }
  return {
    forecast: entry.forecast,
    recentWeather: entry.recentWeather,
    modelInputs,
    hrrrAvailable: entry.hrrrAvailable ?? true,
  };
}

export function setCache(
  lat: number,
  lon: number,
  forecast: ForecastData,
  recentWeather: RecentWeather,
  modelInputs?: Map<ForecastVariable, ModelVariableInput[]>,
  hrrrAvailable?: boolean,
): void {
  const store = readStore();
  // Evict expired entries
  const now = Date.now();
  for (const key of Object.keys(store)) {
    if (now - store[key]!.timestamp > CACHE_TTL_MS) {
      delete store[key];
    }
  }
  let serializedInputs: SerializedModelInputs | undefined;
  if (modelInputs) {
    serializedInputs = {};
    for (const [varKey, inputs] of modelInputs) {
      serializedInputs[varKey] = inputs;
    }
  }
  store[locationKey(lat, lon)] = {
    timestamp: now,
    forecast,
    recentWeather,
    modelInputs: serializedInputs,
    hrrrAvailable,
  };
  writeStore(store);
}
