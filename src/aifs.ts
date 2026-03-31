import * as zarr from "zarrita";
import type { LatLon, ModelForecast, ForecastPoint, ForecastVariable } from "./types.js";
import {
  latToIndex,
  lonToIndex,
  coordToNumbers,
  windSpeed,
  precipToMmHr,
  cloudCoverToFraction,
} from "./weather.js";

const AIFS_STORE_URL =
  "https://data.dynamical.org/ecmwf/aifs-single/forecast/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

/** Number of 6-hourly steps to cover 72 hours */
const STEPS_72H = 12;

/** Fetch just the latest AIFS forecast init time (lightweight metadata check) */
export async function fetchLatestAifsInitTime(): Promise<string> {
  const store = new zarr.FetchStore(AIFS_STORE_URL);
  const loc = zarr.root(store).resolve("init_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastSec = data[data.length - 1] ?? 0;
  return new Date(lastSec * 1000).toISOString();
}

/** Metadata needed to fetch individual AIFS variables */
export interface AifsMetadata {
  store: zarr.FetchStore;
  initIdx: number;
  initTime: Date;
  leadTimeHours: number[];
  latIdx: number;
  lonIdx: number;
}

/** Fetch AIFS metadata (init time, lead times, grid indices) without fetching variable data */
export async function fetchAifsMetadata(location: LatLon): Promise<AifsMetadata> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);
  const store = new zarr.FetchStore(AIFS_STORE_URL);

  const [{ index: initIdx, initTime }, leadTimeHours] = await Promise.all([
    getLatestInitTimeIndex(store),
    getLeadTimeHours(store, STEPS_72H),
  ]);

  return { store, initIdx, initTime, leadTimeHours, latIdx, lonIdx };
}

async function getLatestInitTimeIndex(
  store: zarr.FetchStore,
): Promise<{ index: number; initTime: Date }> {
  const loc = zarr.root(store).resolve("init_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastIdx = data.length - 1;
  const secValue = data[lastIdx] ?? 0;
  return { index: lastIdx, initTime: new Date(secValue * 1000) };
}

async function getLeadTimeHours(store: zarr.FetchStore, numSteps: number): Promise<number[]> {
  const loc = zarr.root(store).resolve("lead_time");
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr, [zarr.slice(numSteps)]);
  const data = coordToNumbers(result.data);
  return data.map((s) => s / 3600);
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

/** Fetch a single variable from the AIFS store.
 *  AIFS dimensions: (init_time, lead_time, latitude, longitude) */
async function fetchAifsVar(
  store: zarr.FetchStore,
  varName: string,
  initIdx: number,
  latIdx: number,
  lonIdx: number,
  numSteps: number,
): Promise<number[]> {
  const loc = zarr.root(store).resolve(varName);
  const arr = await zarr.open(loc, { kind: "array" });
  const result = await zarr.get(arr, [initIdx, zarr.slice(numSteps), latIdx, lonIdx]);
  return Array.from(result.data as Float32Array);
}

/** Fetch a single forecast variable from AIFS using pre-fetched metadata */
export async function fetchAifsVariable(
  meta: AifsMetadata,
  variable: ForecastVariable,
): Promise<ForecastPoint[]> {
  const { store, initIdx, latIdx, lonIdx, leadTimeHours, initTime } = meta;
  const steps = STEPS_72H;

  if (variable === "temperature") {
    const data = await fetchAifsVar(store, "temperature_2m", initIdx, latIdx, lonIdx, steps);
    return toPoints(data, leadTimeHours, initTime);
  }

  if (variable === "precipitation") {
    const data = await fetchAifsVar(store, "precipitation_surface", initIdx, latIdx, lonIdx, steps);
    return toPoints(data.map(precipToMmHr), leadTimeHours, initTime);
  }

  if (variable === "windSpeed") {
    const [uData, vData] = await Promise.all([
      fetchAifsVar(store, "wind_u_10m", initIdx, latIdx, lonIdx, steps),
      fetchAifsVar(store, "wind_v_10m", initIdx, latIdx, lonIdx, steps),
    ]);
    const speeds = uData.map((u, i) => windSpeed(u, vData[i]!));
    return toPoints(speeds, leadTimeHours, initTime);
  }

  // cloudCover
  const data = await fetchAifsVar(
    store,
    "total_cloud_cover_atmosphere",
    initIdx,
    latIdx,
    lonIdx,
    steps,
  );
  return toPoints(data.map(cloudCoverToFraction), leadTimeHours, initTime);
}

/** Fetch the full 72-hour deterministic ECMWF AIFS forecast for a location */
export async function fetchAifsForecast(location: LatLon): Promise<ModelForecast> {
  const meta = await fetchAifsMetadata(location);
  const [temperature, precipitation, ws, cloudCover] = await Promise.all([
    fetchAifsVariable(meta, "temperature"),
    fetchAifsVariable(meta, "precipitation"),
    fetchAifsVariable(meta, "windSpeed"),
    fetchAifsVariable(meta, "cloudCover"),
  ]);
  return {
    model: "ECMWF AIFS",
    isEnsemble: false,
    location,
    initTime: meta.initTime.toISOString(),
    temperature,
    precipitation,
    windSpeed: ws,
    cloudCover,
  };
}
