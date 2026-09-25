import * as zarr from "zarrita";
import { IcechunkStore } from "icechunk-js";
import { FORECAST_HORIZON_HOURS } from "./types.js";
import type { LatLon, ForecastPoint, ForecastVariable, ModelForecast } from "./types.js";
import { normalizeLongitude } from "./geo.js";
import { dewPointFromRelativeHumidity } from "./humidity.js";

const FORECAST_STORE_URL =
  "https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-forecast-35-day/v0.2.0.icechunk/";

/** Cached IcechunkStore instances (opened once, reused across requests) */
let forecastStorePromise: Promise<IcechunkStore> | null = null;

function getForecastStore(): Promise<IcechunkStore> {
  if (!forecastStorePromise) {
    forecastStorePromise = IcechunkStore.open(FORECAST_STORE_URL);
  }
  return forecastStorePromise;
}

/** GEFS grid resolution: 0.25 degrees */
const GRID_RESOLUTION = 0.25;

/** Latitude values: 90.0 to -90.0 in 0.25 steps (721 values) */
export function latToIndex(lat: number): number {
  const clamped = Math.max(-90, Math.min(90, lat));
  return Math.round((90 - clamped) / GRID_RESOLUTION);
}

/** Number of longitude values in the 0.25° global grid */
const NUM_LONGITUDES = 360 / GRID_RESOLUTION;

/** Longitude values: -180.0 to 179.75 in 0.25 steps (1440 values). The grid
 *  wraps around, so longitudes nearer 180° than 179.75° map to index 0. */
export function lonToIndex(lon: number): number {
  const normalized = normalizeLongitude(lon);
  return Math.round((normalized + 180) / GRID_RESOLUTION) % NUM_LONGITUDES;
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
  store: IcechunkStore,
  varName: string,
  initTimeIdx: number,
  latIdx: number,
  lonIdx: number,
  numEnsembleMembers: number,
  numSteps: number,
): Promise<number[][]> {
  const arr = await zarr.open(store.resolve(varName), { kind: "array" });

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
 * Find the index of the most recent init_time at or before `nowMs`.
 *
 * In production all stored init times are in the past, so this matches the
 * last entry. Anchoring the choice to the clock (instead of blindly taking
 * the last index) lets tests pin "now" to a fixed date and always select
 * the same archived forecast, since stores keep appending new init times.
 *
 * `initTimesSec` is sorted ascending, in seconds since epoch. If every init
 * time is after `nowMs`, the clock predates the whole archive — treat it as
 * broken and fall back to the newest init (the pre-clock-relative behavior)
 * rather than serving the oldest archived forecast.
 */
export function findLatestInitIndex(initTimesSec: number[], nowMs: number): number {
  const last = initTimesSec.length - 1;
  if (last < 0) return -1;
  if ((initTimesSec[0] ?? 0) * 1000 > nowMs) return last;
  let idx = last;
  while (idx > 0 && (initTimesSec[idx] ?? 0) * 1000 > nowMs) {
    idx--;
  }
  return idx;
}

/**
 * Find the index of the most recent init_time in the forecast store
 * relative to the current clock. init_time is stored as int64 seconds
 * since epoch.
 */
export async function getLatestInitTimeIndex(
  store: IcechunkStore,
): Promise<{ index: number; initTime: Date }> {
  const arr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const idx = findLatestInitIndex(data, Date.now());
  // Seconds since epoch -> milliseconds
  const secValue = data[idx] ?? 0;
  return { index: idx, initTime: new Date(secValue * 1000) };
}

/**
 * Get all lead_time values (as hours from init_time).
 * lead_time is stored as int64 seconds.
 */
export async function getLeadTimeHours(store: IcechunkStore): Promise<number[]> {
  const arr = await zarr.open(store.resolve("lead_time"), { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  // Seconds -> hours
  return data.map((s) => s / 3600);
}

/**
 * Number of leading lead times to fetch so the forecast reaches
 * `horizonHours` past now. Models are initialized hours before they're
 * published — GEFS and IFS only once a day — so a fixed count of lead
 * times from init falls well short of the horizon by the time it's shown.
 * Includes the first lead time at or past the horizon, so the series
 * spans it; returns every lead time if none reaches it.
 */
export function stepsToHorizon(
  leadTimeHours: number[],
  initTime: Date,
  nowMs: number,
  horizonHours: number = FORECAST_HORIZON_HOURS,
): number {
  const endLead = (nowMs - initTime.getTime()) / 3600000 + horizonHours;
  const idx = leadTimeHours.findIndex((h) => h >= endLead);
  return idx === -1 ? leadTimeHours.length : idx + 1;
}

/** Convert ensemble values at each time step into ForecastPoints.
 *  Timesteps where no member has a finite value are omitted. */
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
    // No member has data here (e.g. precipitation at lead 0, which is an
    // accumulation and so undefined at init) — skip the timestep rather
    // than report a fabricated 0
    if (values.length === 0) continue;
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
  const store = await getForecastStore();
  const { initTime } = await getLatestInitTimeIndex(store);
  return initTime.toISOString();
}

/** Metadata needed to fetch individual GEFS variables */
export interface GefsMetadata {
  store: IcechunkStore;
  initIdx: number;
  initTime: Date;
  /** Lead times (hours) to fetch, starting at lead 0 */
  leadTimeHours: number[];
  latIdx: number;
  lonIdx: number;
  numEnsemble: number;
}

/** Fetch GEFS metadata (init time, lead times, grid indices) without fetching variable data */
export async function fetchGefsMetadata(location: LatLon): Promise<GefsMetadata> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);
  const store = await getForecastStore();

  const [{ index: initIdx, initTime }, allLeadTimeHours] = await Promise.all([
    getLatestInitTimeIndex(store),
    getLeadTimeHours(store),
  ]);
  const leadTimeHours = allLeadTimeHours.slice(
    0,
    stepsToHorizon(allLeadTimeHours, initTime, Date.now()),
  );

  return { store, initIdx, initTime, leadTimeHours, latIdx, lonIdx, numEnsemble: 31 };
}

/** Fetch a single forecast variable from GEFS using pre-fetched metadata */
export async function fetchGefsVariable(
  meta: GefsMetadata,
  variable: ForecastVariable,
): Promise<ForecastPoint[]> {
  const { store, initIdx, latIdx, lonIdx, numEnsemble, leadTimeHours, initTime } = meta;
  const steps = leadTimeHours.length;

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

  if (variable === "dewPoint") {
    // GEFS reports relative humidity, not dew point — derive dew point per
    // ensemble member from temperature and relative humidity.
    const [tempData, rhData] = await Promise.all([
      fetchForecastVariable(store, "temperature_2m", initIdx, latIdx, lonIdx, numEnsemble, steps),
      fetchForecastVariable(
        store,
        "relative_humidity_2m",
        initIdx,
        latIdx,
        lonIdx,
        numEnsemble,
        steps,
      ),
    ]);
    const dewData = tempData.map((tRow, e) =>
      tRow.map((t, i) => dewPointFromRelativeHumidity(t, rhData[e]![i]!)),
    );
    return toForecastPoints(dewData, leadTimeHours, initTime);
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
  const [temperature, precipitation, ws, cloudCover, dewPoint] = await Promise.all([
    fetchGefsVariable(meta, "temperature"),
    fetchGefsVariable(meta, "precipitation"),
    fetchGefsVariable(meta, "windSpeed"),
    fetchGefsVariable(meta, "cloudCover"),
    fetchGefsVariable(meta, "dewPoint"),
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
    dewPoint,
  };
}
