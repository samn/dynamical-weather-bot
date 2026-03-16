import type {
  ModelId,
  ModelForecast,
  AccuracyGrid,
  AccuracyCell,
  ForecastData,
  ForecastPoint,
  LatLon,
} from "./types.js";

/**
 * Look up accuracy metrics for a location from the grid.
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

  // If the cell has nearby stations and one is very close, blend its metrics
  if (cell.nearbyStations && cell.nearbyStations.length > 0) {
    const closest = cell.nearbyStations[0]!;
    if (closest.distance < 25) {
      return blendCellWithStation(cell, closest);
    }
  }

  return cell.metrics;
}

/** Blend grid cell average with a nearby station's metrics (50/50 for close stations) */
function blendCellWithStation(
  cell: AccuracyCell,
  station: { metrics: Record<string, Record<string, Record<string, number>>> },
): Record<string, Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, Record<string, number>>> = {};

  // Collect all model keys from both sources
  const models = new Set([...Object.keys(cell.metrics), ...Object.keys(station.metrics)]);

  for (const model of models) {
    result[model] = {};
    const cellVars = cell.metrics[model] ?? {};
    const stationVars = station.metrics[model] ?? {};
    const variables = new Set([...Object.keys(cellVars), ...Object.keys(stationVars)]);

    for (const varName of variables) {
      result[model]![varName] = {};
      const cellLeads = cellVars[varName] ?? {};
      const stationLeads = stationVars[varName] ?? {};
      const leads = new Set([...Object.keys(cellLeads), ...Object.keys(stationLeads)]);

      for (const lead of leads) {
        const cv = cellLeads[lead];
        const sv = stationLeads[lead];
        if (cv !== undefined && sv !== undefined) {
          result[model]![varName]![lead] = (cv + sv) / 2;
        } else {
          result[model]![varName]![lead] = cv ?? sv ?? 0;
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

/**
 * Blend multiple model forecasts using accuracy-weighted averaging.
 *
 * Strategy:
 * - Blended median = weighted average of model medians
 * - Uncertainty bands come from GEFS (the only ensemble model), shifted to center on blended median
 * - Beyond HRRR's 48hr range, GEFS data passes through unchanged
 */
export function blendForecasts(forecasts: ModelForecast[], grid: AccuracyGrid): ForecastData {
  // Must have at least GEFS
  const gefs = forecasts.find((f) => f.model === "NOAA GEFS");
  if (!gefs) throw new Error("GEFS forecast is required for blending");

  const hrrr = forecasts.find((f) => f.model === "NOAA HRRR");

  // Single model — no blending needed
  if (!hrrr) {
    return {
      location: gefs.location,
      initTime: gefs.initTime,
      temperature: gefs.temperature,
      precipitation: gefs.precipitation,
      windSpeed: gefs.windSpeed,
      cloudCover: gefs.cloudCover,
    };
  }

  const accuracy = lookupAccuracy(gefs.location, grid);
  const models: ModelId[] = ["NOAA GEFS", "NOAA HRRR"];

  // Use the most recent init_time from any model (HRRR updates more frequently than GEFS)
  const latestInitTime = hrrr.initTime > gefs.initTime ? hrrr.initTime : gefs.initTime;

  return {
    location: gefs.location,
    initTime: latestInitTime,
    temperature: blendVariable("temperature", gefs.temperature, hrrr.temperature, models, accuracy),
    precipitation: blendVariable(
      "precipitation",
      gefs.precipitation,
      hrrr.precipitation,
      models,
      accuracy,
      0,
    ),
    windSpeed: blendVariable("windSpeed", gefs.windSpeed, hrrr.windSpeed, models, accuracy, 0),
    cloudCover: blendVariable("cloudCover", gefs.cloudCover, hrrr.cloudCover, models, accuracy, 0),
  };
}

/**
 * Blend a single variable across models.
 * HRRR data is sampled at GEFS's 3-hourly timesteps.
 */
function blendVariable(
  varKey: string,
  gefsPoints: ForecastPoint[],
  hrrrPoints: ForecastPoint[],
  models: ModelId[],
  accuracy: Record<string, Record<string, Record<string, number>>> | undefined,
  clampMin?: number,
): ForecastPoint[] {
  const accuracyVarKey = VARIABLE_KEYS[varKey] ?? "temperature_2m";

  // Build a lookup of HRRR points by their rounded hoursFromNow for matching
  const hrrrByHour = new Map<number, ForecastPoint>();
  for (const pt of hrrrPoints) {
    hrrrByHour.set(Math.round(pt.hoursFromNow), pt);
  }

  return gefsPoints.map((gefsPt) => {
    // Find matching HRRR point (within 1 hour tolerance)
    const gefsHour = Math.round(gefsPt.hoursFromNow);
    const hrrrPt = hrrrByHour.get(gefsHour);

    // No HRRR data at this timestep — pass through GEFS
    if (!hrrrPt) return gefsPt;

    // Compute weights for this lead time
    const weights = computeWeights(
      models,
      accuracyVarKey,
      Math.max(0, gefsPt.hoursFromNow),
      accuracy,
    );
    const gefsWeight = weights.get("NOAA GEFS") ?? 1;
    const hrrrWeight = weights.get("NOAA HRRR") ?? 0;

    // Blended median
    const blendedMedian = gefsWeight * gefsPt.median + hrrrWeight * hrrrPt.median;

    // Shift GEFS uncertainty bands to center on blended median
    const offset = blendedMedian - gefsPt.median;

    const clamp = (v: number) => (clampMin !== undefined ? Math.max(clampMin, v) : v);

    return {
      time: gefsPt.time,
      hoursFromNow: gefsPt.hoursFromNow,
      median: clamp(blendedMedian),
      p10: clamp(gefsPt.p10 + offset),
      p90: clamp(gefsPt.p90 + offset),
      min: clamp(gefsPt.min + offset),
      max: clamp(gefsPt.max + offset),
    };
  });
}
