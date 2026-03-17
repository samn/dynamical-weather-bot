import type {
  ModelId,
  ModelForecast,
  AccuracyGrid,
  NearbyStation,
  ForecastData,
  ForecastPoint,
  ForecastVariable,
  LatLon,
} from "./types.js";
import { haversineKm } from "./geo.js";

/** Max distance (km) for per-station IDW at runtime */
const MAX_STATION_RADIUS_KM = 50;

/** Minimum distance cap (km) to avoid division-by-zero in IDW */
const MIN_STATION_DISTANCE_KM = 1;

/**
 * Look up accuracy metrics for a location from the grid.
 * When nearby stations are available, uses IDW weighting from the user's
 * actual location so the closest station's metrics dominate.
 * Returns accuracy data per model, or undefined if outside grid coverage.
 */
export function lookupAccuracy(
  location: LatLon,
  grid: AccuracyGrid,
): Record<string, Record<string, Record<string, number>>> | undefined {
  const cellLat = Math.floor(location.latitude / grid.gridResolution) * grid.gridResolution;
  const cellLon = Math.floor(location.longitude / grid.gridResolution) * grid.gridResolution;
  const key = `${cellLat.toFixed(1)},${cellLon.toFixed(1)}`;
  const cell = grid.cells[key];
  if (!cell) return undefined;

  if (!cell.nearbyStations || cell.nearbyStations.length === 0) {
    return cell.metrics;
  }

  // Compute actual distance from user location to each station
  const withDistance = cell.nearbyStations
    .map((s) => ({
      station: s,
      distance: haversineKm(location.latitude, location.longitude, s.latitude, s.longitude),
    }))
    .filter((s) => s.distance <= MAX_STATION_RADIUS_KM);

  if (withDistance.length === 0) {
    return cell.metrics;
  }

  return blendStationMetrics(withDistance);
}

/** IDW-blend metrics across multiple stations weighted by distance from user */
function blendStationMetrics(
  stations: Array<{ station: NearbyStation; distance: number }>,
): Record<string, Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, Record<string, number>>> = {};
  const weightSums: Record<string, Record<string, Record<string, number>>> = {};

  for (const { station, distance } of stations) {
    const w = 1 / Math.pow(Math.max(distance, MIN_STATION_DISTANCE_KM), 2);

    for (const [model, vars] of Object.entries(station.metrics)) {
      if (!result[model]) result[model] = {};
      if (!weightSums[model]) weightSums[model] = {};

      for (const [varName, leads] of Object.entries(vars)) {
        if (!result[model]![varName]) result[model]![varName] = {};
        if (!weightSums[model]![varName]) weightSums[model]![varName] = {};

        for (const [lead, val] of Object.entries(leads)) {
          result[model]![varName]![lead] = (result[model]![varName]![lead] ?? 0) + w * val;
          weightSums[model]![varName]![lead] = (weightSums[model]![varName]![lead] ?? 0) + w;
        }
      }
    }
  }

  // Normalize
  for (const [model, vars] of Object.entries(result)) {
    for (const [varName, leads] of Object.entries(vars)) {
      for (const lead of Object.keys(leads)) {
        const ws = weightSums[model]?.[varName]?.[lead];
        if (ws && ws > 0) {
          result[model]![varName]![lead] = result[model]![varName]![lead]! / ws;
        }
      }
    }
  }

  return result;
}

/**
 * Compute accuracy-based weights for a set of models at a given variable and lead time.
 * Weight = 1 / error², normalized to sum to 1.
 */
export function computeWeights(
  models: ModelId[],
  variable: string,
  leadTimeHours: number,
  accuracy: Record<string, Record<string, Record<string, number>>> | undefined,
): Map<ModelId, number> {
  const weights = new Map<ModelId, number>();

  if (!accuracy) {
    // No accuracy data: equal weights for all models
    const w = 1 / models.length;
    for (const m of models) weights.set(m, w);
    return weights;
  }

  // Find the nearest lead time bin
  const leadKey = String(findNearestLeadBin(leadTimeHours));

  let totalWeight = 0;
  const rawWeights: Array<[ModelId, number]> = [];

  for (const model of models) {
    const error = accuracy[model]?.[variable]?.[leadKey];
    if (error !== undefined && error > 0) {
      const w = 1 / (error * error);
      rawWeights.push([model, w]);
      totalWeight += w;
    }
  }

  // If no models have accuracy data, fall back to equal weights
  if (totalWeight === 0) {
    const w = 1 / models.length;
    for (const m of models) weights.set(m, w);
    return weights;
  }

  // Normalize
  for (const [model, w] of rawWeights) {
    weights.set(model, w / totalWeight);
  }

  // Models with no accuracy data get weight 0
  for (const m of models) {
    if (!weights.has(m)) weights.set(m, 0);
  }

  return weights;
}

/** Find the nearest standard lead time bin (0, 24, 48) */
function findNearestLeadBin(hours: number): number {
  const bins = [0, 24, 48];
  let best = bins[0]!;
  let bestDist = Math.abs(hours - best);
  for (const b of bins) {
    const d = Math.abs(hours - b);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/** Variable names used in accuracy grid */
const VARIABLE_KEYS: Record<string, string> = {
  temperature: "temperature_2m",
  precipitation: "precipitation_surface",
  windSpeed: "temperature_2m", // use temperature accuracy as proxy for wind
  cloudCover: "temperature_2m", // use temperature accuracy as proxy for cloud
};

/** Input for blending a single variable from one model */
export interface ModelVariableInput {
  model: ModelId;
  points: ForecastPoint[];
  isEnsemble: boolean;
}

/**
 * Blend multiple model forecasts using accuracy-weighted averaging.
 *
 * Strategy:
 * - Blended median = weighted average of all model medians
 * - Uncertainty bands = weighted average of ensemble models' bands, shifted to center on blended median
 * - Beyond shorter models' ranges, remaining models pass through
 */
export function blendForecasts(forecasts: ModelForecast[], grid: AccuracyGrid): ForecastData {
  const ensembleModels = forecasts.filter((f) => f.isEnsemble);
  if (ensembleModels.length === 0) throw new Error("At least one ensemble model is required");

  const base = ensembleModels[0]!;
  const accuracy = lookupAccuracy(base.location, grid);
  const latestInitTime = forecasts.reduce(
    (latest, f) => (f.initTime > latest ? f.initTime : latest),
    forecasts[0]!.initTime,
  );

  const variables: ForecastVariable[] = ["temperature", "precipitation", "windSpeed", "cloudCover"];
  const result: Partial<Record<ForecastVariable, ForecastPoint[]>> = {};
  for (const varKey of variables) {
    const inputs: ModelVariableInput[] = forecasts.map((f) => ({
      model: f.model,
      points: f[varKey],
      isEnsemble: f.isEnsemble,
    }));
    result[varKey] = blendVariable(varKey, inputs, accuracy, CLAMP_MIN[varKey]);
  }

  return {
    location: base.location,
    initTime: latestInitTime,
    temperature: result.temperature!,
    precipitation: result.precipitation!,
    windSpeed: result.windSpeed!,
    cloudCover: result.cloudCover!,
  };
}

/** Clamp minimums for variables that cannot be negative */
const CLAMP_MIN: Partial<Record<ForecastVariable, number>> = {
  precipitation: 0,
  windSpeed: 0,
  cloudCover: 0,
};

/**
 * Blend a single forecast variable from multiple models.
 * Use this for progressive per-variable rendering.
 */
export function blendSingleVariable(
  varKey: ForecastVariable,
  inputs: ModelVariableInput[],
  location: LatLon,
  grid: AccuracyGrid,
): ForecastPoint[] {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return inputs[0]!.points;
  const accuracy = lookupAccuracy(location, grid);
  return blendVariable(varKey, inputs, accuracy, CLAMP_MIN[varKey]);
}

/**
 * Blend a single variable across N models.
 *
 * For each timestep:
 * 1. Collect matching points from all models (by rounded hoursFromNow)
 * 2. Compute accuracy weights for available models
 * 3. Blended median = weighted average of all model medians
 * 4. Blended bands = weighted average of ensemble models' bands,
 *    shifted so center aligns with blended median
 */
function blendVariable(
  varKey: string,
  inputs: ModelVariableInput[],
  accuracy: Record<string, Record<string, Record<string, number>>> | undefined,
  clampMin?: number,
): ForecastPoint[] {
  const accuracyVarKey = VARIABLE_KEYS[varKey] ?? "temperature_2m";

  // Use first ensemble model as base for timestep iteration
  const baseInput = inputs.find((i) => i.isEnsemble) ?? inputs[0]!;

  // Build lookup maps: model -> hour -> point
  const pointsByModel = new Map<ModelId, Map<number, ForecastPoint>>();
  for (const input of inputs) {
    const byHour = new Map<number, ForecastPoint>();
    for (const pt of input.points) {
      byHour.set(Math.round(pt.hoursFromNow), pt);
    }
    pointsByModel.set(input.model, byHour);
  }

  const ensembleModelIds = new Set(inputs.filter((i) => i.isEnsemble).map((i) => i.model));
  const clamp = (v: number) => (clampMin !== undefined ? Math.max(clampMin, v) : v);

  return baseInput.points.map((basePt) => {
    const hour = Math.round(basePt.hoursFromNow);

    // Collect available models at this timestep
    const available: Array<{ model: ModelId; point: ForecastPoint }> = [];
    for (const input of inputs) {
      const pt = pointsByModel.get(input.model)?.get(hour);
      if (pt) available.push({ model: input.model, point: pt });
    }

    if (available.length <= 1) return basePt;

    // Compute weights for all available models
    const weights = computeWeights(
      available.map((a) => a.model),
      accuracyVarKey,
      Math.max(0, basePt.hoursFromNow),
      accuracy,
    );

    // Blended median from ALL models
    let blendedMedian = 0;
    for (const { model, point } of available) {
      blendedMedian += (weights.get(model) ?? 0) * point.median;
    }

    // Blended uncertainty from ENSEMBLE models only
    const ensembleAvailable = available.filter((a) => ensembleModelIds.has(a.model));
    let ensembleWeightSum = 0;
    for (const { model } of ensembleAvailable) {
      ensembleWeightSum += weights.get(model) ?? 0;
    }

    let blendedP10 = 0;
    let blendedP90 = 0;
    let blendedMin = 0;
    let blendedMax = 0;
    let ensembleCenter = 0;
    for (const { model, point } of ensembleAvailable) {
      const w =
        ensembleWeightSum > 0
          ? (weights.get(model) ?? 0) / ensembleWeightSum
          : 1 / ensembleAvailable.length;
      blendedP10 += w * point.p10;
      blendedP90 += w * point.p90;
      blendedMin += w * point.min;
      blendedMax += w * point.max;
      ensembleCenter += w * point.median;
    }

    // Shift blended bands so they center on the blended median
    // (which includes deterministic model contributions)
    const offset = blendedMedian - ensembleCenter;

    return {
      time: basePt.time,
      hoursFromNow: basePt.hoursFromNow,
      median: clamp(blendedMedian),
      p10: clamp(blendedP10 + offset),
      p90: clamp(blendedP90 + offset),
      min: clamp(blendedMin + offset),
      max: clamp(blendedMax + offset),
    };
  });
}
