import * as zarr from "zarrita";
import { IcechunkStore } from "icechunk-js";
import type { LatLon, ForecastPoint, ForecastVariable } from "./types.js";
import {
  latToIndex,
  lonToIndex,
  getLatestInitTimeIndex,
  getLeadTimeHours,
  stepsToHorizon,
  toForecastPoints,
  windSpeed,
  precipToMmHr,
  cloudCoverToFraction,
} from "./weather.js";

const AIFS_STORE_URL =
  "https://dynamical-ecmwf-aifs-ens.s3.us-west-2.amazonaws.com/ecmwf-aifs-ens-forecast/v0.1.0.icechunk/";

/** Cached IcechunkStore instance */
let storePromise: Promise<IcechunkStore> | null = null;

function getStore(): Promise<IcechunkStore> {
  if (!storePromise) {
    storePromise = IcechunkStore.open(AIFS_STORE_URL);
  }
  return storePromise;
}

/** Number of ECMWF AIFS ENS ensemble members (1 control + 50 perturbed) */
const NUM_ENSEMBLE = 51;

/** Fetch just the latest AIFS forecast init time (lightweight metadata check) */
export async function fetchLatestAifsInitTime(): Promise<string> {
  const store = await getStore();
  const { initTime } = await getLatestInitTimeIndex(store);
  return initTime.toISOString();
}

/** Metadata needed to fetch individual AIFS variables */
export interface AifsMetadata {
  store: IcechunkStore;
  initIdx: number;
  initTime: Date;
  /** Lead times (hours) to fetch, starting at lead 0 */
  leadTimeHours: number[];
  latIdx: number;
  lonIdx: number;
  numEnsemble: number;
}

/** Fetch AIFS metadata (init time, lead times, grid indices) without fetching variable data */
export async function fetchAifsMetadata(location: LatLon): Promise<AifsMetadata> {
  const latIdx = latToIndex(location.latitude);
  const lonIdx = lonToIndex(location.longitude);
  const store = await getStore();

  const [{ index: initIdx, initTime }, allLeadTimeHours] = await Promise.all([
    getLatestInitTimeIndex(store),
    getLeadTimeHours(store),
  ]);
  const leadTimeHours = allLeadTimeHours.slice(
    0,
    stepsToHorizon(allLeadTimeHours, initTime, Date.now()),
  );

  return { store, initIdx, initTime, leadTimeHours, latIdx, lonIdx, numEnsemble: NUM_ENSEMBLE };
}

/**
 * Fetch a single variable's forecast data for a specific grid point.
 * Returns an array of values: [ensemble_member][lead_time_step]
 *
 * AIFS ENS dimensions: (init_time, lead_time, ensemble_member, latitude, longitude)
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

/** Fetch a single forecast variable from AIFS using pre-fetched metadata */
export async function fetchAifsVariable(
  meta: AifsMetadata,
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
    const data = await fetchForecastVariable(
      store,
      "dew_point_temperature_2m",
      initIdx,
      latIdx,
      lonIdx,
      numEnsemble,
      steps,
    );
    return toForecastPoints(data, leadTimeHours, initTime);
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
