import * as zarr from "zarrita";
import { IcechunkStore } from "icechunk-js";
import proj4 from "proj4";
import type { LatLon, ModelForecast, ForecastPoint, ForecastVariable } from "./types.js";
import { windSpeed, precipToMmHr, cloudCoverToFraction } from "./weather.js";

const HRRR_STORE_URL =
  "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk/";

/** Cached IcechunkStore instance */
let storePromise: Promise<IcechunkStore> | null = null;

function getStore(): Promise<IcechunkStore> {
  if (!storePromise) {
    storePromise = IcechunkStore.open(HRRR_STORE_URL);
  }
  return storePromise;
}

/** Maximum number of hourly steps in HRRR 48-hour forecast */
const MAX_STEPS = 48;

/** Fetch just the latest HRRR forecast init time (lightweight metadata check) */
export async function fetchLatestHrrrInitTime(): Promise<string> {
  const store = await getStore();
  const arr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastSec = data[data.length - 1] ?? 0;
  return new Date(lastSec * 1000).toISOString();
}

/**
 * HRRR uses Lambert Conformal Conic projection.
 * These are the well-known HRRR projection parameters.
 */
const HRRR_PROJ = proj4(
  "EPSG:4326",
  "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +x_0=0 +y_0=0 +R=6371229 +units=m +no_defs",
);

/**
 * Convert geographic coordinates to HRRR grid indices.
 * Returns null if the point is outside the HRRR grid.
 */
export function geoToHrrrIndex(
  lat: number,
  lon: number,
  xCoords: number[],
  yCoords: number[],
): { xIdx: number; yIdx: number } | null {
  const [x, y] = HRRR_PROJ.forward([lon, lat]);
  if (x === undefined || y === undefined) return null;

  // Find nearest indices using regular grid spacing
  const x0 = xCoords[0];
  const y0 = yCoords[0];
  const x1 = xCoords[1];
  const y1 = yCoords[1];
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;

  const xStep = x1 - x0;
  const yStep = y1 - y0;
  if (xStep === 0 || yStep === 0) return null;

  const xIdx = Math.round((x - x0) / xStep);
  const yIdx = Math.round((y - y0) / yStep);

  // Bounds check
  if (xIdx < 0 || xIdx >= xCoords.length || yIdx < 0 || yIdx >= yCoords.length) {
    return null;
  }

  return { xIdx, yIdx };
}

/** Read a coordinate array as numbers from the Zarr store */
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

/** Metadata needed to fetch individual HRRR variables */
export interface HrrrMetadata {
  store: IcechunkStore;
  initTimeIdx: number;
  initTime: Date;
  leadTimeHours: number[];
  numSteps: number;
  xIdx: number;
  yIdx: number;
}

/** Fetch HRRR metadata. Returns null if location is outside CONUS. */
export async function fetchHrrrMetadata(location: LatLon): Promise<HrrrMetadata | null> {
  const store = await getStore();

  const [xResult, yResult, initTimeResult, leadTimeResult] = await Promise.all([
    zarr.get(await zarr.open(store.resolve("x"), { kind: "array" })),
    zarr.get(await zarr.open(store.resolve("y"), { kind: "array" })),
    zarr.get(await zarr.open(store.resolve("init_time"), { kind: "array" })),
    zarr.get(await zarr.open(store.resolve("lead_time"), { kind: "array" })),
  ]);

  const xCoords = coordToNumbers(xResult.data);
  const yCoords = coordToNumbers(yResult.data);

  const idx = geoToHrrrIndex(location.latitude, location.longitude, xCoords, yCoords);
  if (!idx) return null;

  const initTimes = coordToNumbers(initTimeResult.data);
  const initTimeIdx = initTimes.length - 1;
  const initTimeSec = initTimes[initTimeIdx] ?? 0;
  const initTime = new Date(initTimeSec * 1000);

  const leadTimesRaw = coordToNumbers(leadTimeResult.data);
  const numSteps = Math.min(leadTimesRaw.length, MAX_STEPS);
  const leadTimeHours = leadTimesRaw.slice(0, numSteps).map((s) => s / 3600);

  return {
    store,
    initTimeIdx,
    initTime,
    leadTimeHours,
    numSteps,
    xIdx: idx.xIdx,
    yIdx: idx.yIdx,
  };
}

/** Convert raw values to ForecastPoints (deterministic — all percentiles equal the value) */
function toPoints(values: number[], leadTimeHours: number[], initTime: Date): ForecastPoint[] {
  const now = Date.now();
  return values.map((val, t) => {
    const hours = leadTimeHours[t] ?? t;
    const time = new Date(initTime.getTime() + hours * 3600 * 1000);
    return {
      time: time.toISOString(),
      hoursFromNow: (time.getTime() - now) / 3600000,
      median: val,
      p10: val,
      p90: val,
      min: val,
      max: val,
    };
  });
}

/** Fetch a single variable from the HRRR store */
async function fetchHrrrVar(meta: HrrrMetadata, varName: string): Promise<number[]> {
  const arr = await zarr.open(meta.store.resolve(varName), { kind: "array" });
  const result = await zarr.get(arr, [
    meta.initTimeIdx,
    zarr.slice(meta.numSteps),
    meta.yIdx,
    meta.xIdx,
  ]);
  return Array.from(result.data as Float32Array);
}

/** Fetch a single forecast variable from HRRR using pre-fetched metadata */
export async function fetchHrrrVariable(
  meta: HrrrMetadata,
  variable: ForecastVariable,
): Promise<ForecastPoint[]> {
  const { leadTimeHours, initTime } = meta;

  if (variable === "temperature") {
    const data = await fetchHrrrVar(meta, "temperature_2m");
    return toPoints(data, leadTimeHours, initTime);
  }

  if (variable === "precipitation") {
    const data = await fetchHrrrVar(meta, "precipitation_surface");
    return toPoints(data.map(precipToMmHr), leadTimeHours, initTime);
  }

  if (variable === "windSpeed") {
    const [uData, vData] = await Promise.all([
      fetchHrrrVar(meta, "wind_u_10m"),
      fetchHrrrVar(meta, "wind_v_10m"),
    ]);
    const speeds = uData.map((u, i) => windSpeed(u, vData[i]!));
    return toPoints(speeds, leadTimeHours, initTime);
  }

  // cloudCover
  const data = await fetchHrrrVar(meta, "total_cloud_cover_atmosphere");
  return toPoints(data.map(cloudCoverToFraction), leadTimeHours, initTime);
}

/**
 * Fetch HRRR forecast data for a location.
 * Returns null if the location is outside CONUS (HRRR coverage area).
 */
export async function fetchHrrrForecast(location: LatLon): Promise<ModelForecast | null> {
  const meta = await fetchHrrrMetadata(location);
  if (!meta) return null;

  const [temperature, precipitation, ws, cloudCover] = await Promise.all([
    fetchHrrrVariable(meta, "temperature"),
    fetchHrrrVariable(meta, "precipitation"),
    fetchHrrrVariable(meta, "windSpeed"),
    fetchHrrrVariable(meta, "cloudCover"),
  ]);

  return {
    model: "NOAA HRRR",
    isEnsemble: false,
    location,
    initTime: meta.initTime.toISOString(),
    temperature,
    precipitation,
    windSpeed: ws,
    cloudCover,
  };
}
