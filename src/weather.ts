import * as zarr from "zarrita";
import type { LatLon, ForecastData, ForecastPoint, RecentWeather } from "./types.js";
import { normalizeLongitude } from "./geo.js";

const FORECAST_STORE_URL =
  "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

const ANALYSIS_STORE_URL =
  "https://data.dynamical.org/noaa/gefs/analysis/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

/** Number of 3-hourly steps to cover 72 hours of future forecast */
const FUTURE_STEPS = 24; // 72 / 3

/** Number of past 3-hourly steps to keep for context around "now" */
const CONTEXT_STEPS = 1;

/** Hours per forecast step */
const HOURS_PER_STEP = 3;

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
function coordToNumbers(data: unknown): number[] {
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
  leadTimeStart: number,
  numSteps: number,
): Promise<number[][]> {
  const loc = zarr.root(store).resolve(varName);
  const arr = await zarr.open(loc, { kind: "array" });

  // Fetch: specific init_time, all ensemble members, lead times from leadTimeStart, specific lat/lon
  const result = await zarr.get(arr, [
    initTimeIdx,
    zarr.slice(numEnsembleMembers),
    zarr.slice(leadTimeStart, leadTimeStart + numSteps),
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
async function getLeadTimeHours(
  store: zarr.FetchStore,
  startStep: number,
  numSteps: number,
): Promise<number[]> {
  const loc = zarr.root(store).resolve("lead_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr, [zarr.slice(startStep, startStep + numSteps)]);
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
function toForecastPoints(
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

/** Fetch just the latest forecast init time (lightweight metadata check) */
export async function fetchLatestInitTime(): Promise<string> {
  const store = new zarr.FetchStore(FORECAST_STORE_URL);
  const { initTime } = await getLatestInitTimeIndex(store);
  return initTime.toISOString();
}

/**
 * Compute the lead-time window that prioritises future hours.
 * Keeps a small number of past steps for context around "now", then fetches
 * enough future steps to cover FUTURE_STEPS worth of upcoming forecast.
 */
export function computeLeadTimeWindow(initTime: Date): { startStep: number; numSteps: number } {
  const elapsedHours = (Date.now() - initTime.getTime()) / 3_600_000;
  const elapsedSteps = Math.floor(elapsedHours / HOURS_PER_STEP);

  // Start a few steps before now for context, but never before step 0
  const startStep = Math.max(0, elapsedSteps - CONTEXT_STEPS);
  const numSteps = startStep + FUTURE_STEPS + CONTEXT_STEPS;
  return { startStep, numSteps: numSteps - startStep };
}

/** Fetch the probabilistic forecast for a location, prioritising future hours */
export async function fetchForecast(location: LatLon): Promise<ForecastData> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);

  const store = new zarr.FetchStore(FORECAST_STORE_URL);

  // Get the latest init time first so we can compute the lead-time window
  const { index: initIdx, initTime } = await getLatestInitTimeIndex(store);
  const { startStep, numSteps } = computeLeadTimeWindow(initTime);

  const leadTimeHours = await getLeadTimeHours(store, startStep, numSteps);

  const numEnsemble = 31;

  // Fetch all variables in parallel
  const [tempData, precipData, windUData, windVData, cloudData] = await Promise.all([
    fetchForecastVariable(
      store,
      "temperature_2m",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      startStep,
      numSteps,
    ),
    fetchForecastVariable(
      store,
      "precipitation_surface",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      startStep,
      numSteps,
    ),
    fetchForecastVariable(
      store,
      "wind_u_10m",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      startStep,
      numSteps,
    ),
    fetchForecastVariable(
      store,
      "wind_v_10m",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      startStep,
      numSteps,
    ),
    fetchForecastVariable(
      store,
      "total_cloud_cover_atmosphere",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      startStep,
      numSteps,
    ),
  ]);

  // temperature_2m is already in Celsius from dynamical.org
  const tempCelsius: number[][] = tempData;

  // Compute wind speed from u/v components
  const windSpeedData: number[][] = windUData.map((uRow, e) =>
    uRow.map((u, t) => windSpeed(u, windVData[e]![t]!)),
  );

  // Convert precipitation rate to mm/hr
  const precipMmHr: number[][] = precipData.map((row) => row.map(precipToMmHr));

  // Convert cloud cover from percent to fraction
  const cloudFraction: number[][] = cloudData.map((row) => row.map(cloudCoverToFraction));

  return {
    location,
    initTime: initTime.toISOString(),
    temperature: toForecastPoints(tempCelsius, leadTimeHours, initTime),
    precipitation: toForecastPoints(precipMmHr, leadTimeHours, initTime),
    windSpeed: toForecastPoints(windSpeedData, leadTimeHours, initTime),
    cloudCover: toForecastPoints(cloudFraction, leadTimeHours, initTime),
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
