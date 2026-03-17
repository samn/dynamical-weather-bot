import * as zarr from "zarrita";
import type {
  LatLon,
  ForecastPoint,
  ForecastVariable,
  ModelForecast,
  RecentWeather,
} from "./types.js";
import { normalizeLongitude } from "./geo.js";

const FORECAST_STORE_URL =
  "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

const ANALYSIS_STORE_URL =
  "https://data.dynamical.org/noaa/gefs/analysis/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

/** Number of 3-hourly steps to cover 72 hours */
const STEPS_72H = 24; // 72 / 3

/** Number of recent days to use for aberration comparison */
const RECENT_DAYS = 7;

/** GEFS grid resolution: 0.25 degrees */
const GRID_RESOLUTION = 0.25;

/** Latitude values: 90.0 to -90.0 in 0.25 steps (721 values) */
export function latToIndex(lat: number): number {
  const clamped = Math.max(-90, Math.min(90, lat));
  return Math.round((90 - clamped) / GRID_RESOLUTION);
}

/** Longitude values: -180.0 to 179.75 in 0.25 steps (1440 values) */
export function lonToIndex(lon: number): number {
  const normalized = normalizeLongitude(lon);
  return Math.round((normalized + 180) / GRID_RESOLUTION);
}

/**
 * Compute percentile from a sorted array.
 * Uses linear interpolation between adjacent values.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const loVal = sorted[lo]!;
  const hiVal = sorted[hi]!;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/** Compute wind speed from u and v components */
export function windSpeed(u: number, v: number): number {
  return Math.sqrt(u * u + v * v);
}

/** Convert precipitation rate from kg/m^2/s to mm/hr */
export function precipToMmHr(kgPerM2PerS: number): number {
  return Math.max(0, kgPerM2PerS * 3600);
}

/** Convert cloud cover from percent (0-100) to fraction (0-1) */
export function cloudCoverToFraction(pct: number): number {
  return Math.max(0, Math.min(1, pct / 100));
}

/** Compute the mean of an array, ignoring non-finite values */
function avg(arr: number[]): number {
  const valid = arr.filter(isFinite);
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

/**
 * Read a coordinate array as numbers.
 * Handles both Int64 (BigInt64Array) and Float64 typed arrays.
 */
export function coordToNumbers(data: unknown): number[] {
  if (data instanceof BigInt64Array) {
    return Array.from(data, (v) => Number(v));
  }
  if (data instanceof Float64Array || data instanceof Float32Array || data instanceof Int32Array) {
    return Array.from(data);
  }
  if (Array.isArray(data)) {
    return data.map(Number);
  }
  return [];
}

/**
 * Fetch a single variable's forecast data for a specific grid point.
 * Returns an array of values: [ensemble_member][lead_time_step]
 *
 * Dimensions: (init_time, ensemble_member, lead_time, latitude, longitude)
 */
async function fetchForecastVariable(
  store: zarr.FetchStore,
  varName: string,
  initTimeIdx: number,
  latIdx: number,
  lonIdx: number,
  numEnsembleMembers: number,
  numSteps: number,
): Promise<number[][]> {
  const loc = zarr.root(store).resolve(varName);
  const arr = await zarr.open(loc, { kind: "array" });

  // Fetch: specific init_time, all ensemble members, first numSteps lead times, specific lat/lon
  const result = await zarr.get(arr, [
    initTimeIdx,
    zarr.slice(numEnsembleMembers),
    zarr.slice(numSteps),
    latIdx,
    lonIdx,
  ]);

  const rawData = result.data as Float32Array;
  // Shape is [numEnsembleMembers, numSteps]
  const data: number[][] = [];
  for (let e = 0; e < numEnsembleMembers; e++) {
    const row: number[] = [];
    for (let t = 0; t < numSteps; t++) {
      row.push(rawData[e * numSteps + t] ?? 0);
    }
    data.push(row);
  }
  return data;
}

/**
 * Fetch recent analysis data for aberration comparison.
 * Analysis dimensions: (time, latitude, longitude)
 */
async function fetchAnalysisVariable(
  store: zarr.FetchStore,
  varName: string,
  latIdx: number,
  lonIdx: number,
  startTimeIdx: number,
  numSteps: number,
): Promise<number[]> {
  const loc = zarr.root(store).resolve(varName);
  const arr = await zarr.open(loc, { kind: "array" });

  const result = await zarr.get(arr, [
    zarr.slice(startTimeIdx, startTimeIdx + numSteps),
    latIdx,
    lonIdx,
  ]);

  return Array.from(result.data as Float32Array);
}

/**
 * Find the index of the most recent init_time in the forecast store.
 * init_time is stored as int64 seconds since epoch.
 */
async function getLatestInitTimeIndex(
  store: zarr.FetchStore,
): Promise<{ index: number; initTime: Date }> {
  const loc = zarr.root(store).resolve("init_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastIdx = data.length - 1;
  // Seconds since epoch -> milliseconds
  const secValue = data[lastIdx] ?? 0;
  return { index: lastIdx, initTime: new Date(secValue * 1000) };
}

/**
 * Get the lead_time values (as hours from init_time).
 * lead_time is stored as int64 seconds.
 */
async function getLeadTimeHours(store: zarr.FetchStore, numSteps: number): Promise<number[]> {
  const loc = zarr.root(store).resolve("lead_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr, [zarr.slice(numSteps)]);
  const data = coordToNumbers(result.data);
  // Seconds -> hours
  return data.map((s) => s / 3600);
}

/**
 * Get recent analysis time indices for comparison.
 * Returns { startIdx, numSteps } for the last N days of analysis data.
 */
async function getAnalysisTimeRange(
  store: zarr.FetchStore,
  daysBack: number,
): Promise<{ startIdx: number; numSteps: number }> {
  const loc = zarr.root(store).resolve("time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const totalSteps = data.length;

  // Analysis is 3-hourly, so N days = N * 8 steps
  const stepsNeeded = daysBack * 8;
  const startIdx = Math.max(0, totalSteps - stepsNeeded);
  const numSteps = totalSteps - startIdx;

  return { startIdx, numSteps };
}

/** Convert ensemble values at each time step into ForecastPoints */
export function toForecastPoints(
  ensembleData: number[][],
  leadTimeHours: number[],
  initTime: Date,
): ForecastPoint[] {
  const now = Date.now();
  const numSteps = leadTimeHours.length;
  const points: ForecastPoint[] = [];

  for (let t = 0; t < numSteps; t++) {
    const values: number[] = [];
    for (const memberData of ensembleData) {
      const val = memberData[t];
      if (val !== undefined && isFinite(val)) {
        values.push(val);
      }
    }
    values.sort((a, b) => a - b);

    const hours = leadTimeHours[t] ?? t * 3;
    const time = new Date(initTime.getTime() + hours * 3600 * 1000);

    points.push({
      time: time.toISOString(),
      hoursFromNow: (time.getTime() - now) / 3600000,
      median: percentile(values, 50),
      p10: percentile(values, 10),
      p90: percentile(values, 90),
      min: values[0] ?? 0,
      max: values[values.length - 1] ?? 0,
    });
  }

  return points;
}

/** Fetch just the latest GEFS forecast init time (lightweight metadata check) */
export async function fetchLatestInitTime(): Promise<string> {
  const store = new zarr.FetchStore(FORECAST_STORE_URL);
  const { initTime } = await getLatestInitTimeIndex(store);
  return initTime.toISOString();
}

/** Metadata needed to fetch individual GEFS variables */
export interface GefsMetadata {
  store: zarr.FetchStore;
  initIdx: number;
  initTime: Date;
  leadTimeHours: number[];
  latIdx: number;
  lonIdx: number;
  numEnsemble: number;
}

/** Fetch GEFS metadata (init time, lead times, grid indices) without fetching variable data */
export async function fetchGefsMetadata(location: LatLon): Promise<GefsMetadata> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);
  const store = new zarr.FetchStore(FORECAST_STORE_URL);

  const [{ index: initIdx, initTime }, leadTimeHours] = await Promise.all([
    getLatestInitTimeIndex(store),
    getLeadTimeHours(store, STEPS_72H),
  ]);

  return { store, initIdx, initTime, leadTimeHours, latIdx, lonIdx, numEnsemble: 31 };
}

/** Fetch a single forecast variable from GEFS using pre-fetched metadata */
export async function fetchGefsVariable(
  meta: GefsMetadata,
  variable: ForecastVariable,
): Promise<ForecastPoint[]> {
  const { store, initIdx, latIdx, lonIdx, numEnsemble, leadTimeHours, initTime } = meta;
  const steps = STEPS_72H;

  if (variable === "temperature") {
    const data = await fetchForecastVariable(
      store,
      "temperature_2m",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      steps,
    );
    return toForecastPoints(data, leadTimeHours, initTime);
  }

  if (variable === "precipitation") {
    const data = await fetchForecastVariable(
      store,
      "precipitation_surface",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      steps,
    );
    return toForecastPoints(
      data.map((row) => row.map(precipToMmHr)),
      leadTimeHours,
      initTime,
    );
  }

  if (variable === "windSpeed") {
    const [uData, vData] = await Promise.all([
      fetchForecastVariable(store, "wind_u_10m", initIdx, latIdx, lonIdx, numEnsemble, steps),
      fetchForecastVariable(store, "wind_v_10m", initIdx, latIdx, lonIdx, numEnsemble, steps),
    ]);
    const speedData = uData.map((uRow, e) => uRow.map((u, t) => windSpeed(u, vData[e]![t]!)));
    return toForecastPoints(speedData, leadTimeHours, initTime);
  }

  // cloudCover
  const data = await fetchForecastVariable(
    store,
    "total_cloud_cover_atmosphere",
    initIdx,
    latIdx,
    lonIdx,
    numEnsemble,
    steps,
  );
  return toForecastPoints(
    data.map((row) => row.map(cloudCoverToFraction)),
    leadTimeHours,
    initTime,
  );
}

/** Fetch the full 72-hour probabilistic GEFS forecast for a location */
export async function fetchGefsForecast(location: LatLon): Promise<ModelForecast> {
  const meta = await fetchGefsMetadata(location);
  const [temperature, precipitation, ws, cloudCover] = await Promise.all([
    fetchGefsVariable(meta, "temperature"),
    fetchGefsVariable(meta, "precipitation"),
    fetchGefsVariable(meta, "windSpeed"),
    fetchGefsVariable(meta, "cloudCover"),
  ]);
  return {
    model: "NOAA GEFS",
    isEnsemble: true,
    location,
    initTime: meta.initTime.toISOString(),
    temperature,
    precipitation,
    windSpeed: ws,
    cloudCover,
  };
}

/** Fetch recent weather from analysis for aberration comparison */
export async function fetchRecentWeather(location: LatLon): Promise<RecentWeather> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);

  const store = new zarr.FetchStore(ANALYSIS_STORE_URL);
  const { startIdx, numSteps } = await getAnalysisTimeRange(store, RECENT_DAYS);

  const [tempData, precipData, windUData, windVData, cloudData] = await Promise.all([
    fetchAnalysisVariable(store, "temperature_2m", latIdx, lonIdx, startIdx, numSteps),
    fetchAnalysisVariable(store, "precipitation_surface", latIdx, lonIdx, startIdx, numSteps),
    fetchAnalysisVariable(store, "wind_u_10m", latIdx, lonIdx, startIdx, numSteps),
    fetchAnalysisVariable(store, "wind_v_10m", latIdx, lonIdx, startIdx, numSteps),
    fetchAnalysisVariable(
      store,
      "total_cloud_cover_atmosphere",
      latIdx,
      lonIdx,
      startIdx,
      numSteps,
    ),
  ]);

  const windSpeeds = windUData.map((u, i) => windSpeed(u, windVData[i]!));

  return {
    avgTemperature: avg(tempData),
    avgPrecipitation: avg(precipData.map(precipToMmHr)),
    avgWindSpeed: avg(windSpeeds),
    avgCloudCover: avg(cloudData.map(cloudCoverToFraction)),
  };
}
