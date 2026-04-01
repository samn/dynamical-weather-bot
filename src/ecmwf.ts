import * as zarr from "zarrita";
import { IcechunkStore } from "icechunk-js";
import type { LatLon, ModelForecast, ForecastPoint, ForecastVariable } from "./types.js";
import {
  latToIndex,
  lonToIndex,
  coordToNumbers,
  toForecastPoints,
  windSpeed,
  precipToMmHr,
  cloudCoverToFraction,
} from "./weather.js";

const ECMWF_STORE_URL =
  "https://dynamical-ecmwf-ifs-ens.s3.us-west-2.amazonaws.com/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk/";

/** Cached IcechunkStore instance */
let storePromise: Promise<IcechunkStore> | null = null;

function getStore(): Promise<IcechunkStore> {
  if (!storePromise) {
    storePromise = IcechunkStore.open(ECMWF_STORE_URL);
  }
  return storePromise;
}

/** Number of 3-hourly steps to cover 72 hours */
const STEPS_72H = 24;

/** Number of ECMWF IFS ENS ensemble members (1 control + 50 perturbed) */
const NUM_ENSEMBLE = 51;

/** Fetch just the latest ECMWF forecast init time (lightweight metadata check) */
export async function fetchLatestEcmwfInitTime(): Promise<string> {
  const store = await getStore();
  const arr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastSec = data[data.length - 1] ?? 0;
  return new Date(lastSec * 1000).toISOString();
}

/** Metadata needed to fetch individual ECMWF variables */
export interface EcmwfMetadata {
  store: IcechunkStore;
  initIdx: number;
  initTime: Date;
  leadTimeHours: number[];
  latIdx: number;
  lonIdx: number;
  numEnsemble: number;
}

/** Fetch ECMWF metadata (init time, lead times, grid indices) without fetching variable data */
export async function fetchEcmwfMetadata(location: LatLon): Promise<EcmwfMetadata> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);
  const store = await getStore();

  const [{ index: initIdx, initTime }, leadTimeHours] = await Promise.all([
    getLatestInitTimeIndex(store),
    getLeadTimeHours(store, STEPS_72H),
  ]);

  return { store, initIdx, initTime, leadTimeHours, latIdx, lonIdx, numEnsemble: NUM_ENSEMBLE };
}

async function getLatestInitTimeIndex(
  store: IcechunkStore,
): Promise<{ index: number; initTime: Date }> {
  const arr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const result = await zarr.get(arr);
  const data = coordToNumbers(result.data);
  const lastIdx = data.length - 1;
  const secValue = data[lastIdx] ?? 0;
  return { index: lastIdx, initTime: new Date(secValue * 1000) };
}

async function getLeadTimeHours(store: IcechunkStore, numSteps: number): Promise<number[]> {
  const arr = await zarr.open(store.resolve("lead_time"), { kind: "array" });
  const result = await zarr.get(arr, [zarr.slice(numSteps)]);
  const data = coordToNumbers(result.data);
  return data.map((s) => s / 3600);
}

/**
 * Fetch a single variable's forecast data for a specific grid point.
 * Returns an array of values: [ensemble_member][lead_time_step]
 *
 * ECMWF dimensions: (init_time, lead_time, ensemble_member, latitude, longitude)
 * Note: lead_time and ensemble_member are swapped compared to GEFS.
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

  // ECMWF: (init_time, lead_time, ensemble_member, latitude, longitude)
  const result = await zarr.get(arr, [
    initTimeIdx,
    zarr.slice(numSteps),
    zarr.slice(numEnsembleMembers),
    latIdx,
    lonIdx,
  ]);

  const rawData = result.data as Float32Array;
  // Shape is [numSteps, numEnsembleMembers] — transpose to [numEnsemble][numSteps]
  const data: number[][] = [];
  for (let e = 0; e < numEnsembleMembers; e++) {
    const row: number[] = [];
    for (let t = 0; t < numSteps; t++) {
      row.push(rawData[t * numEnsembleMembers + e] ?? 0);
    }
    data.push(row);
  }
  return data;
}

/** Fetch a single forecast variable from ECMWF using pre-fetched metadata */
export async function fetchEcmwfVariable(
  meta: EcmwfMetadata,
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

/** Fetch the full 72-hour probabilistic ECMWF IFS ENS forecast for a location */
export async function fetchEcmwfForecast(location: LatLon): Promise<ModelForecast> {
  const meta = await fetchEcmwfMetadata(location);
  const [temperature, precipitation, ws, cloudCover] = await Promise.all([
    fetchEcmwfVariable(meta, "temperature"),
    fetchEcmwfVariable(meta, "precipitation"),
    fetchEcmwfVariable(meta, "windSpeed"),
    fetchEcmwfVariable(meta, "cloudCover"),
  ]);
  return {
    model: "ECMWF IFS ENS",
    isEnsemble: true,
    location,
    initTime: meta.initTime.toISOString(),
    temperature,
    precipitation,
    windSpeed: ws,
    cloudCover,
  };
}
