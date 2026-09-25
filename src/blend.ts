import type {
  ModelId,
  ModelForecast,
  AccuracyGrid,
  ForecastData,
  ForecastPoint,
  ForecastVariable,
  LatLon,
} from "./types.js";
import { FORECAST_HORIZON_HOURS } from "./types.js";
import { haversineKm } from "./geo.js";

/** Max distance (km) for per-station IDW at runtime */
const MAX_STATION_RADIUS_KM = 50;

/** Minimum distance cap (km) to avoid division-by-zero in IDW */
const MIN_STATION_DISTANCE_KM = 1;

/**
 * Regularization strength: blends accuracy-based weights toward equal weights.
 * 0 = pure accuracy weighting, 1 = equal weights.
 * Prevents overfitting to noisy error estimates at stations with limited data.
 */
const REGULARIZATION_STRENGTH = 0.15;

/**
 * Standard lead time bins available in the accuracy grid (hours).
 * Used for interpolation between bins.
 */
const LEAD_BINS = [0, 24, 48, 72];

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

  return blendStationMetrics(
    withDistance.map((s) => ({ metrics: s.station.metrics, distance: s.distance })),
  );
}

/**
 * Look up per-model bias values for a location from the grid.
 * Returns bias data (model → variable → lead → bias), or undefined if unavailable.
 */
export function lookupBiases(
  location: LatLon,
  grid: AccuracyGrid,
): Record<string, Record<string, Record<string, number>>> | undefined {
  const cellLat = Math.floor(location.latitude / grid.gridResolution) * grid.gridResolution;
  const cellLon = Math.floor(location.longitude / grid.gridResolution) * grid.gridResolution;
  const key = `${cellLat.toFixed(1)},${cellLon.toFixed(1)}`;
  const cell = grid.cells[key];
  if (!cell?.biases) return undefined;

  if (!cell.nearbyStations || cell.nearbyStations.length === 0) {
    return cell.biases;
  }

  const withDistance = cell.nearbyStations
    .filter((s) => s.biases !== undefined)
    .map((s) => ({
      metrics: s.biases!,
      distance: haversineKm(location.latitude, location.longitude, s.latitude, s.longitude),
    }))
    .filter((s) => s.distance <= MAX_STATION_RADIUS_KM);

  if (withDistance.length === 0) {
    return cell.biases;
  }

  return blendStationMetrics(withDistance);
}

/** IDW-blend metrics across multiple stations weighted by distance from user */
function blendStationMetrics(
  stations: Array<{
    metrics: Record<string, Record<string, Record<string, number>>>;
    distance: number;
  }>,
): Record<string, Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, Record<string, number>>> = {};
  const weightSums: Record<string, Record<string, Record<string, number>>> = {};

  for (const { metrics, distance } of stations) {
    const w = 1 / Math.pow(Math.max(distance, MIN_STATION_DISTANCE_KM), 2);

    for (const [model, vars] of Object.entries(metrics)) {
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
 * Interpolate an error metric between the two nearest lead time bins.
 * Falls back to the nearest available bin if only one side is available.
 */
function interpolateError(
  hours: number,
  modelAccuracy: Record<string, Record<string, number>> | undefined,
  variable: string,
): number | undefined {
  const varData = modelAccuracy?.[variable];
  if (!varData) return undefined;

  // Find the two surrounding bins
  let lower: number | undefined;
  let upper: number | undefined;
  for (const b of LEAD_BINS) {
    if (b <= hours) lower = b;
    if (b >= hours && upper === undefined) upper = b;
  }

  if (lower === undefined && upper === undefined) return undefined;

  const lowerVal = lower !== undefined ? varData[String(lower)] : undefined;
  const upperVal = upper !== undefined ? varData[String(upper)] : undefined;

  if (lowerVal === undefined && upperVal === undefined) return undefined;
  if (lowerVal === undefined) return upperVal;
  if (upperVal === undefined) return lowerVal;
  if (lower === upper) return lowerVal;

  // Linear interpolation
  const t = (hours - lower!) / (upper! - lower!);
  return lowerVal + t * (upperVal - lowerVal);
}

/**
 * Interpolate a bias value between the two nearest lead time bins.
 */
function interpolateBias(
  hours: number,
  modelBiases: Record<string, Record<string, number>> | undefined,
  variable: string,
): number {
  if (!modelBiases) return 0;
  const val = interpolateError(hours, modelBiases, variable);
  return val ?? 0;
}

/**
 * Compute accuracy-based weights for a set of models at a given variable and lead time.
 * Weight = 1 / error², normalized to sum to 1, then regularized toward equal weights.
 *
 * `leadTimeHours` is either one lead time shared by every model or each
 * model's own lead time — models initialized at different times reach the
 * same valid time at different leads, and their skill depends on the lead.
 */
export function computeWeights(
  models: ModelId[],
  variable: string,
  leadTimeHours: number | ReadonlyMap<ModelId, number>,
  accuracy: Record<string, Record<string, Record<string, number>>> | undefined,
): Map<ModelId, number> {
  const leadFor = (model: ModelId): number =>
    typeof leadTimeHours === "number" ? leadTimeHours : (leadTimeHours.get(model) ?? 0);
  const weights = new Map<ModelId, number>();

  if (!accuracy) {
    // No accuracy data: equal weights for all models
    const w = 1 / models.length;
    for (const m of models) weights.set(m, w);
    return weights;
  }

  let totalWeight = 0;
  const rawWeights: Array<[ModelId, number]> = [];

  for (const model of models) {
    const error = interpolateError(leadFor(model), accuracy[model], variable);
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

  // Regularize toward equal weights to reduce noise from limited station data
  if (REGULARIZATION_STRENGTH > 0 && weights.size > 1) {
    const modelsWithWeight = rawWeights.length;
    if (modelsWithWeight > 1) {
      const equalW = 1 / modelsWithWeight;
      for (const [model, w] of rawWeights) {
        weights.set(
          model,
          (1 - REGULARIZATION_STRENGTH) * (w / totalWeight) + REGULARIZATION_STRENGTH * equalW,
        );
      }
    }
  }

  return weights;
}

/**
 * Accuracy-grid variable whose skill metric weights each forecast variable.
 * Wind, cloud cover and dew point have no scorecard metrics yet, so
 * temperature skill stands in as a proxy for overall model skill.
 */
const WEIGHT_KEYS: Record<ForecastVariable, string> = {
  temperature: "temperature_2m",
  precipitation: "precipitation_surface",
  windSpeed: "temperature_2m",
  cloudCover: "temperature_2m",
  dewPoint: "temperature_2m",
};

/**
 * Accuracy-grid variable whose bias debiases each forecast variable.
 *
 * Unlike skill weights, a bias can't stand in for another variable: it is
 * an offset in its own variable's units, so subtracting a temperature bias
 * (°C) from wind speed or cloud cover corrupts them. Precipitation is left
 * uncorrected too — it is bounded at zero, so an additive correction would
 * add phantom drizzle to every dry hour.
 */
const BIAS_KEYS: Partial<Record<ForecastVariable, string>> = {
  temperature: "temperature_2m",
};

/** Largest gap between a model's timesteps that is interpolated across to
 *  line it up with the base model's timesteps (e.g. 6-hourly AIFS onto
 *  3-hourly GEFS) */
const MAX_INTERPOLATION_GAP_MS = 6 * 60 * 60 * 1000;

/** Input for blending a single variable from one model */
export interface ModelVariableInput {
  model: ModelId;
  points: ForecastPoint[];
  isEnsemble: boolean;
  /** ISO init time of the model run the points came from. Used to compute
   *  each point's lead time for accuracy weighting; absent in caches
   *  written before it was recorded. */
  initTime?: string;
}

/**
 * The time range [startMs, endMs] the charts are drawn over, computed from
 * every variable's per-model inputs.
 *
 * - Only `enabled` models count (all of them if none of the enabled models
 *   has data), so disabling a short-range model lets the charts extend.
 * - Each model spans from its earliest to its latest point across all
 *   variables — a model's precipitation starts a step late, since it is
 *   undefined at lead 0, and that must not push the chart start back.
 * - Start: the latest model start, where every model has begun.
 * - End: the earliest end among ensemble models, capped at the forecast
 *   horizon. The deterministic HRRR only runs 48h; past its end the
 *   ensembles carry the blend on alone.
 *
 * Returns undefined when there is no data or no overlap.
 */
export function computeDisplayRange(
  inputsByVariable: Iterable<ModelVariableInput[]>,
  enabled: ReadonlySet<ModelId> | undefined,
  nowMs: number,
  horizonHours: number = FORECAST_HORIZON_HOURS,
): [number, number] | undefined {
  const spans = new Map<ModelId, { start: number; end: number; isEnsemble: boolean }>();
  for (const inputs of inputsByVariable) {
    for (const input of inputs) {
      for (const pt of input.points) {
        const t = new Date(pt.time).getTime();
        const span = spans.get(input.model);
        if (!span) {
          spans.set(input.model, { start: t, end: t, isEnsemble: input.isEnsemble });
        } else {
          span.start = Math.min(span.start, t);
          span.end = Math.max(span.end, t);
        }
      }
    }
  }

  let models = [...spans.entries()];
  if (enabled && models.some(([m]) => enabled.has(m))) {
    models = models.filter(([m]) => enabled.has(m));
  }
  if (models.length === 0) return undefined;

  const start = Math.max(...models.map(([, s]) => s.start));
  const ensembles = models.filter(([, s]) => s.isEnsemble);
  const endModels = ensembles.length > 0 ? ensembles : models;
  const end = Math.min(...endModels.map(([, s]) => s.end), nowMs + horizonHours * 60 * 60 * 1000);
  return start < end ? [start, end] : undefined;
}

/**
 * Blend multiple model forecasts using accuracy-weighted averaging.
 *
 * Strategy:
 * - Blended median = weighted average of bias-corrected model medians
 * - Uncertainty bands = weighted average of ensemble models' bands, shifted to center on blended median
 * - Beyond shorter models' ranges, remaining models pass through
 */
export function blendForecasts(forecasts: ModelForecast[], grid: AccuracyGrid): ForecastData {
  const ensembleModels = forecasts.filter((f) => f.isEnsemble);
  if (ensembleModels.length === 0) throw new Error("At least one ensemble model is required");

  const base = ensembleModels[0]!;
  const accuracy = lookupAccuracy(base.location, grid);
  const biases = lookupBiases(base.location, grid);
  const latestInitTime = forecasts.reduce(
    (latest, f) => (f.initTime > latest ? f.initTime : latest),
    forecasts[0]!.initTime,
  );

  const variables: ForecastVariable[] = [
    "temperature",
    "precipitation",
    "windSpeed",
    "cloudCover",
    "dewPoint",
  ];
  const result: Partial<Record<ForecastVariable, ForecastPoint[]>> = {};
  for (const varKey of variables) {
    const inputs: ModelVariableInput[] = forecasts.map((f) => ({
      model: f.model,
      points: f[varKey] ?? [],
      isEnsemble: f.isEnsemble,
      initTime: f.initTime,
    }));
    result[varKey] = blendVariable(
      varKey,
      inputs,
      accuracy,
      biases,
      CLAMP_MIN[varKey],
      CLAMP_MAX[varKey],
    );
  }

  return {
    location: base.location,
    initTime: latestInitTime,
    temperature: result.temperature!,
    precipitation: result.precipitation!,
    windSpeed: result.windSpeed!,
    cloudCover: result.cloudCover!,
    dewPoint: result.dewPoint!,
  };
}

/** Clamp minimums for variables that cannot be negative */
const CLAMP_MIN: Partial<Record<ForecastVariable, number>> = {
  precipitation: 0,
  windSpeed: 0,
  cloudCover: 0,
};

/** Clamp maximums for variables with a physical upper bound */
const CLAMP_MAX: Partial<Record<ForecastVariable, number>> = {
  cloudCover: 1,
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
  useAccuracy: boolean = true,
): ForecastPoint[] {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return inputs[0]!.points;
  const accuracy = useAccuracy ? lookupAccuracy(location, grid) : undefined;
  const biases = useAccuracy ? lookupBiases(location, grid) : undefined;
  return blendVariable(varKey, inputs, accuracy, biases, CLAMP_MIN[varKey], CLAMP_MAX[varKey]);
}

/** A forecast point with its parsed valid time */
interface TimedPoint {
  timeMs: number;
  point: ForecastPoint;
}

/** Sort a series by valid time for {@link sampleAt} */
function toTimedSeries(points: ForecastPoint[]): TimedPoint[] {
  const series = points.map((point) => ({ timeMs: new Date(point.time).getTime(), point }));
  series.sort((a, b) => a.timeMs - b.timeMs);
  return series;
}

/**
 * A model's forecast at `timeMs`: its own point when it has one, otherwise
 * a linear interpolation between the neighbouring points when they are at
 * most {@link MAX_INTERPOLATION_GAP_MS} apart. Interpolating lets a coarser
 * model (6-hourly AIFS) contribute at every step of a finer base model
 * (3-hourly GEFS) instead of dropping in and out of the blend every other
 * step, which made the blended line zigzag.
 */
function sampleAt(series: TimedPoint[], timeMs: number): ForecastPoint | undefined {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const after = series[lo];
  if (after?.timeMs === timeMs) return after.point;
  const before = series[lo - 1];
  if (!before || !after || after.timeMs - before.timeMs > MAX_INTERPOLATION_GAP_MS) {
    return undefined;
  }
  const f = (timeMs - before.timeMs) / (after.timeMs - before.timeMs);
  const lerp = (a: number, b: number) => a + (b - a) * f;
  const a = before.point;
  const b = after.point;
  return {
    time: new Date(timeMs).toISOString(),
    hoursFromNow: lerp(a.hoursFromNow, b.hoursFromNow),
    median: lerp(a.median, b.median),
    p10: lerp(a.p10, b.p10),
    p90: lerp(a.p90, b.p90),
    min: lerp(a.min, b.min),
    max: lerp(a.max, b.max),
  };
}

/**
 * Blend a single variable across N models.
 *
 * For each timestep of the base (first ensemble) model:
 * 1. Sample every model at that valid time (interpolating coarser models)
 * 2. Compute accuracy weights from each model's own lead time, with
 *    lead-time interpolation and regularization
 * 3. Subtract per-model bias before blending (bias correction), for
 *    variables that have a bias of their own
 * 4. Blended median = weighted average of bias-corrected model medians
 * 5. Blended bands = weighted average of ensemble models' bands,
 *    shifted so center aligns with blended median
 */
function blendVariable(
  varKey: ForecastVariable,
  inputs: ModelVariableInput[],
  accuracy: Record<string, Record<string, Record<string, number>>> | undefined,
  biases: Record<string, Record<string, Record<string, number>>> | undefined,
  clampMin?: number,
  clampMax?: number,
): ForecastPoint[] {
  const weightKey = WEIGHT_KEYS[varKey];
  const biasKey = BIAS_KEYS[varKey];

  // Use first ensemble model as base for timestep iteration
  const baseInput = inputs.find((i) => i.isEnsemble) ?? inputs[0]!;

  const seriesByModel = new Map<ModelId, TimedPoint[]>();
  const initMsByModel = new Map<ModelId, number>();
  for (const input of inputs) {
    seriesByModel.set(input.model, toTimedSeries(input.points));
    if (input.initTime) initMsByModel.set(input.model, new Date(input.initTime).getTime());
  }

  const ensembleModelIds = new Set(inputs.filter((i) => i.isEnsemble).map((i) => i.model));
  const clamp = (v: number) => {
    let r = v;
    if (clampMin !== undefined) r = Math.max(clampMin, r);
    if (clampMax !== undefined) r = Math.min(clampMax, r);
    return r;
  };

  return baseInput.points.map((basePt) => {
    const timeMs = new Date(basePt.time).getTime();

    // Collect available models at this timestep
    const available: Array<{ model: ModelId; point: ForecastPoint }> = [];
    for (const input of inputs) {
      const pt =
        input === baseInput ? basePt : sampleAt(seriesByModel.get(input.model) ?? [], timeMs);
      if (pt) available.push({ model: input.model, point: pt });
    }

    if (available.length <= 1) return basePt;

    // Each model's lead time at this valid time. Caches from before init
    // times were recorded fall back to hours from now.
    const leadHours = new Map<ModelId, number>();
    for (const { model } of available) {
      const initMs = initMsByModel.get(model);
      const lead =
        initMs !== undefined ? (timeMs - initMs) / (60 * 60 * 1000) : basePt.hoursFromNow;
      leadHours.set(model, Math.max(0, lead));
    }

    // Compute weights with lead-time interpolation and regularization
    const weights = computeWeights(
      available.map((a) => a.model),
      weightKey,
      leadHours,
      accuracy,
    );

    // Compute per-model bias corrections
    const modelBias = new Map<ModelId, number>();
    for (const { model } of available) {
      const bias =
        biases && biasKey ? interpolateBias(leadHours.get(model) ?? 0, biases[model], biasKey) : 0;
      modelBias.set(model, bias);
    }

    // Blended median from ALL models (with bias correction)
    let blendedMedian = 0;
    for (const { model, point } of available) {
      const bias = modelBias.get(model) ?? 0;
      blendedMedian += (weights.get(model) ?? 0) * (point.median - bias);
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
      const bias = modelBias.get(model) ?? 0;
      blendedP10 += w * (point.p10 - bias);
      blendedP90 += w * (point.p90 - bias);
      blendedMin += w * (point.min - bias);
      blendedMax += w * (point.max - bias);
      ensembleCenter += w * (point.median - bias);
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
