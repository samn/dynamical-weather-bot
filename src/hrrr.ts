import * as zarr from "zarrita";
import proj4 from "proj4";
import type { LatLon, ModelForecast, ForecastPoint } from "./types.js";
import { windSpeed, precipToMmHr, cloudCoverToFraction } from "./weather.js";

const HRRR_STORE_URL =
  "https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

/** Maximum number of hourly steps in HRRR 48-hour forecast */
const MAX_STEPS = 48;

/** Fetch just the latest HRRR forecast init time (lightweight metadata check) */
export async function fetchLatestHrrrInitTime(): Promise<string> {
  const store = new zarr.FetchStore(HRRR_STORE_URL);
  const root = zarr.root(store);
  const arr = await zarr.open(root.resolve("init_time"), { kind: "array" });
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

/**
 * Fetch HRRR forecast data for a location.
 * Returns null if the location is outside CONUS (HRRR coverage area).
 *
 * HRRR Zarr dimensions: [init_time, lead_time, y, x] — no ensemble dimension.
 */
export async function fetchHrrrForecast(location: LatLon): Promise<ModelForecast | null> {
  const store = new zarr.FetchStore(HRRR_STORE_URL);
  const root = zarr.root(store);

  // Read projection coordinates and metadata in parallel
  const [xResult, yResult, initTimeResult, leadTimeResult] = await Promise.all([
    zarr.get(await zarr.open(root.resolve("x"), { kind: "array" })),
    zarr.get(await zarr.open(root.resolve("y"), { kind: "array" })),
    zarr.get(await zarr.open(root.resolve("init_time"), { kind: "array" })),
    zarr.get(await zarr.open(root.resolve("lead_time"), { kind: "array" })),
  ]);

  const xCoords = coordToNumbers(xResult.data);
  const yCoords = coordToNumbers(yResult.data);

  // Check if the location falls within the HRRR grid
  const idx = geoToHrrrIndex(location.latitude, location.longitude, xCoords, yCoords);
  if (!idx) return null;

  const { xIdx, yIdx } = idx;

  // Get init time
  const initTimes = coordToNumbers(initTimeResult.data);
  const initTimeIdx = initTimes.length - 1;
  const initTimeSec = initTimes[initTimeIdx] ?? 0;
  const initTime = new Date(initTimeSec * 1000);

  // Get lead times in hours
  const leadTimesRaw = coordToNumbers(leadTimeResult.data);
  const numSteps = Math.min(leadTimesRaw.length, MAX_STEPS);
  const leadTimeHours = leadTimesRaw.slice(0, numSteps).map((s) => s / 3600);

  // Fetch all variables in parallel
  const fetchVar = async (varName: string): Promise<number[]> => {
    const loc = root.resolve(varName);
    const arr = await zarr.open(loc, { kind: "array" });
    const result = await zarr.get(arr, [initTimeIdx, zarr.slice(numSteps), yIdx, xIdx]);
    return Array.from(result.data as Float32Array);
  };

  const [tempData, precipData, windUData, windVData, cloudData] = await Promise.all([
    fetchVar("temperature_2m"),
    fetchVar("precipitation_surface"),
    fetchVar("wind_u_10m"),
    fetchVar("wind_v_10m"),
    fetchVar("total_cloud_cover_atmosphere"),
  ]);

  const now = Date.now();

  const toPoints = (values: number[]): ForecastPoint[] =>
    values.map((val, t) => {
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

  // Unit conversions
  const windSpeeds = windUData.map((u, i) => windSpeed(u, windVData[i]!));
  const precipMmHr = precipData.map(precipToMmHr);
  const cloudFraction = cloudData.map(cloudCoverToFraction);

  return {
    model: "NOAA HRRR",
    location,
    initTime: initTime.toISOString(),
    temperature: toPoints(tempData),
    precipitation: toPoints(precipMmHr),
    windSpeed: toPoints(windSpeeds),
    cloudCover: toPoints(cloudFraction),
  };
}
