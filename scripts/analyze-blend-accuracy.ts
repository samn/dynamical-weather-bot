/**
 * Analysis script: downloads the verification statistics parquet and
 * compares "magic blend" accuracy to individual models.
 *
 * Usage: npx tsx scripts/analyze-blend-accuracy.ts
 */

import { parquetRead } from "hyparquet";
import { parseStationsCsv, parseParquetRow, type Station, type StatRow } from "./accuracy-grid-utils.js";

const STATS_URL = "https://assets.dynamical.org/scorecard/statistics.parquet";
const STATIONS_URL = "https://assets.dynamical.org/scorecard/stations.csv";

/** 90-day window in nanoseconds */
const WINDOW_90D = 7776000000000000;

const MODELS = ["NOAA GEFS", "NOAA HRRR", "ECMWF IFS ENS", "ECMWF AIFS Single"] as const;
const VARIABLES = ["temperature_2m", "precipitation_surface"] as const;

interface StationModelMetric {
  station_id: string;
  model: string;
  variable: string;
  lead_hours: number;
  rmse: number;
  rmse_bc: number | undefined;
  mae: number;
  mae_bc: number | undefined;
  count: number;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  console.log(`Fetching ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.text();
}

function leadTimeToHours(leadTimeVal: number): number | undefined {
  let hours: number;
  if (Math.abs(leadTimeVal) > 1e12) {
    hours = Math.round(leadTimeVal / 3.6e12); // nanoseconds
  } else if (Math.abs(leadTimeVal) > 1e6) {
    hours = Math.round(leadTimeVal / 3.6e9); // microseconds
  } else {
    hours = Math.round(leadTimeVal / 3600); // seconds
  }
  if (hours < 0 || hours > 72) return undefined;
  return hours;
}

function leadTimeToBin(hours: number): number {
  const bins = [0, 24, 48];
  return bins.reduce((best, b) => (Math.abs(hours - b) < Math.abs(hours - best) ? b : best), bins[0]!);
}

async function main() {
  const [parquetBuf, stationsCsv] = await Promise.all([fetchBuffer(STATS_URL), fetchText(STATIONS_URL)]);

  const stations = parseStationsCsv(stationsCsv);
  console.log(`Loaded ${stations.size} stations\n`);

  // Parse ALL rows from parquet (not just filtered ones)
  const allRows: StatRow[] = [];
  await parquetRead({
    file: parquetBuf,
    onComplete: (data: unknown[][]) => {
      for (const row of data) {
        if (!Array.isArray(row)) continue;
        const parsed = parseParquetRow(row);
        if (parsed) allRows.push(parsed);
      }
    },
  });

  console.log(`Total parquet rows: ${allRows.length}`);

  // Show all unique models and metrics in the data
  const uniqueModels = new Set(allRows.map((r) => r.model));
  const uniqueMetrics = new Set(allRows.map((r) => r.metric));
  const uniqueVars = new Set(allRows.map((r) => r.variable));
  const uniqueWindows = new Set(allRows.map((r) => r.window));

  console.log(`\nUnique models: ${[...uniqueModels].sort().join(", ")}`);
  console.log(`Unique metrics: ${[...uniqueMetrics].sort().join(", ")}`);
  console.log(`Unique variables: ${[...uniqueVars].sort().join(", ")}`);
  console.log(`Unique windows: ${[...uniqueWindows].sort().join(", ")}`);

  // Filter to relevant rows
  const modelSet = new Set<string>(MODELS);
  const varSet = new Set<string>(VARIABLES);
  const targetMetrics = new Set(["RMSE", "RMSE_bc", "MAE", "MAE_bc"]);

  const filtered = allRows.filter((r) => {
    if (!modelSet.has(r.model)) return false;
    if (!varSet.has(r.variable)) return false;
    if (!targetMetrics.has(r.metric)) return false;
    // Check window
    if (r.window !== WINDOW_90D && r.window !== 7776000 && r.window !== 7776000000) return false;
    if (!isFinite(r.value) || r.value <= 0) return false;
    return true;
  });

  console.log(`\nFiltered to ${filtered.length} relevant rows`);

  // Organize by station → model → variable → lead_hours → metric → value
  type MetricMap = Record<string, number>; // metric name → value
  type LeadMap = Record<number, MetricMap>;
  type VarMap = Record<string, LeadMap>;
  type ModelMap = Record<string, VarMap>;
  const stationData = new Map<string, ModelMap>();

  for (const r of filtered) {
    const hours = leadTimeToHours(r.lead_time);
    if (hours === undefined) continue;

    let modelMap = stationData.get(r.station_id);
    if (!modelMap) {
      modelMap = {};
      stationData.set(r.station_id, modelMap);
    }
    if (!modelMap[r.model]) modelMap[r.model] = {};
    if (!modelMap[r.model]![r.variable]) modelMap[r.model]![r.variable] = {};
    if (!modelMap[r.model]![r.variable]![hours]) modelMap[r.model]![r.variable]![hours] = {};
    modelMap[r.model]![r.variable]![hours]![r.metric] = r.value;
  }

  console.log(`${stationData.size} stations with filtered data\n`);

  // --- ANALYSIS 1: Per-model aggregate accuracy ---
  console.log("=" .repeat(80));
  console.log("ANALYSIS 1: Per-model aggregate accuracy (bias-corrected RMSE/MAE where available)");
  console.log("=" .repeat(80));

  for (const variable of VARIABLES) {
    const metricType = variable === "temperature_2m" ? "RMSE" : "MAE";
    const bcMetricType = `${metricType}_bc`;

    console.log(`\n--- ${variable} (${metricType}) ---`);

    for (const leadBin of [0, 24, 48]) {
      console.log(`\n  Lead time bin: ${leadBin}h`);

      for (const model of MODELS) {
        let totalError = 0;
        let totalErrorBc = 0;
        let count = 0;
        let countBc = 0;

        for (const [_stationId, modelMap] of stationData) {
          const varData = modelMap[model]?.[variable];
          if (!varData) continue;

          // Find lead times in this bin (within 6h)
          for (const [lt, metrics] of Object.entries(varData)) {
            const ltNum = Number(lt);
            if (Math.abs(ltNum - leadBin) > 6) continue;

            const rawVal = metrics[metricType];
            const bcVal = metrics[bcMetricType];

            if (rawVal !== undefined && rawVal > 0) {
              totalError += rawVal;
              count++;
            }
            if (bcVal !== undefined && bcVal > 0) {
              totalErrorBc += bcVal;
              countBc++;
            }
          }
        }

        const avgError = count > 0 ? totalError / count : NaN;
        const avgErrorBc = countBc > 0 ? totalErrorBc / countBc : NaN;
        console.log(
          `    ${model.padEnd(20)} raw=${avgError.toFixed(4)} (n=${count})  bc=${avgErrorBc.toFixed(4)} (n=${countBc})`,
        );
      }
    }
  }

  // --- ANALYSIS 2: Simulated blend vs individual models ---
  console.log("\n" + "=" .repeat(80));
  console.log("ANALYSIS 2: Simulated blend accuracy vs individual models");
  console.log("For each station, compute the accuracy-weighted blend error");
  console.log("=" .repeat(80));

  // For each station+variable+lead, compute what the blend weight would produce
  // The blend uses weights = 1/error^2, so the expected blended error
  // can be estimated as the weighted combination of individual errors

  for (const variable of VARIABLES) {
    const metricType = variable === "temperature_2m" ? "RMSE" : "MAE";
    const bcMetricType = `${metricType}_bc`;

    console.log(`\n--- ${variable} ---`);

    for (const leadBin of [0, 24, 48]) {
      // For each station, compute blend error estimate
      let blendSum = 0;
      let equalBlendSum = 0;
      let bestModelSum = 0;
      let worstModelSum = 0;
      const modelSums: Record<string, { total: number; count: number }> = {};
      let stationCount = 0;

      for (const [_stationId, modelMap] of stationData) {
        // Get the best available metric for each model at this station/variable/lead
        const modelErrors: Array<{ model: string; error: number }> = [];

        for (const model of MODELS) {
          const varData = modelMap[model]?.[variable];
          if (!varData) continue;

          // Average across lead times in this bin
          let sum = 0;
          let cnt = 0;
          for (const [lt, metrics] of Object.entries(varData)) {
            if (Math.abs(Number(lt) - leadBin) > 6) continue;
            // Prefer bias-corrected
            const val = metrics[bcMetricType] ?? metrics[metricType];
            if (val !== undefined && val > 0) {
              sum += val;
              cnt++;
            }
          }
          if (cnt > 0) {
            modelErrors.push({ model, error: sum / cnt });
          }
        }

        if (modelErrors.length < 2) continue; // Need at least 2 models to compare blend

        // Compute accuracy-weighted blend error estimate
        // Weight = 1/error^2, blend error ≈ sum(w_i * error_i) / sum(w_i)
        let weightSum = 0;
        let weightedErrorSum = 0;
        let equalWeightedErrorSum = 0;

        for (const { error } of modelErrors) {
          const w = 1 / (error * error);
          weightedErrorSum += w * error;
          weightSum += w;
          equalWeightedErrorSum += error;
        }

        const blendError = weightedErrorSum / weightSum;
        const equalBlendError = equalWeightedErrorSum / modelErrors.length;
        const bestError = Math.min(...modelErrors.map((m) => m.error));
        const worstError = Math.max(...modelErrors.map((m) => m.error));

        blendSum += blendError;
        equalBlendSum += equalBlendError;
        bestModelSum += bestError;
        worstModelSum += worstError;
        stationCount++;

        for (const { model, error } of modelErrors) {
          if (!modelSums[model]) modelSums[model] = { total: 0, count: 0 };
          modelSums[model]!.total += error;
          modelSums[model]!.count++;
        }
      }

      if (stationCount === 0) {
        console.log(`\n  Lead ${leadBin}h: No stations with >=2 models`);
        continue;
      }

      console.log(`\n  Lead ${leadBin}h (${stationCount} stations with >=2 models):`);
      console.log(`    Magic Blend (1/err²):  ${(blendSum / stationCount).toFixed(4)}`);
      console.log(`    Equal Blend:           ${(equalBlendSum / stationCount).toFixed(4)}`);
      console.log(`    Best single model:     ${(bestModelSum / stationCount).toFixed(4)}`);
      console.log(`    Worst single model:    ${(worstModelSum / stationCount).toFixed(4)}`);

      for (const model of MODELS) {
        const ms = modelSums[model];
        if (ms && ms.count > 0) {
          console.log(`    ${model.padEnd(22)} ${(ms.total / ms.count).toFixed(4)} (n=${ms.count})`);
        }
      }
    }
  }

  // --- ANALYSIS 3: Station-level comparison - how often does blend beat best model? ---
  console.log("\n" + "=" .repeat(80));
  console.log("ANALYSIS 3: How often does the blend beat the best individual model?");
  console.log("=" .repeat(80));

  for (const variable of VARIABLES) {
    const metricType = variable === "temperature_2m" ? "RMSE" : "MAE";
    const bcMetricType = `${metricType}_bc`;

    console.log(`\n--- ${variable} ---`);

    for (const leadBin of [0, 24, 48]) {
      let blendBeatsBest = 0;
      let blendBeatsWorst = 0;
      let total = 0;
      let blendBeatsEachModel: Record<string, { beats: number; total: number }> = {};
      let magicBeatEqual = 0;

      // Track how much better/worse
      let magicVsBestDelta = 0;
      let magicVsEqualDelta = 0;

      for (const [_stationId, modelMap] of stationData) {
        const modelErrors: Array<{ model: string; error: number }> = [];

        for (const model of MODELS) {
          const varData = modelMap[model]?.[variable];
          if (!varData) continue;
          let sum = 0;
          let cnt = 0;
          for (const [lt, metrics] of Object.entries(varData)) {
            if (Math.abs(Number(lt) - leadBin) > 6) continue;
            const val = metrics[bcMetricType] ?? metrics[metricType];
            if (val !== undefined && val > 0) {
              sum += val;
              cnt++;
            }
          }
          if (cnt > 0) modelErrors.push({ model, error: sum / cnt });
        }

        if (modelErrors.length < 2) continue;

        let weightSum = 0;
        let weightedErrorSum = 0;
        let equalSum = 0;

        for (const { error } of modelErrors) {
          const w = 1 / (error * error);
          weightedErrorSum += w * error;
          weightSum += w;
          equalSum += error;
        }

        const blendError = weightedErrorSum / weightSum;
        const equalBlendError = equalSum / modelErrors.length;
        const bestError = Math.min(...modelErrors.map((m) => m.error));

        total++;
        if (blendError <= bestError) blendBeatsBest++;
        if (blendError < equalBlendError) magicBeatEqual++;
        magicVsBestDelta += blendError - bestError;
        magicVsEqualDelta += blendError - equalBlendError;

        for (const { model, error } of modelErrors) {
          if (!blendBeatsEachModel[model]) blendBeatsEachModel[model] = { beats: 0, total: 0 };
          blendBeatsEachModel[model]!.total++;
          if (blendError <= error) blendBeatsEachModel[model]!.beats++;
        }
      }

      console.log(`\n  Lead ${leadBin}h (${total} stations):`);
      console.log(`    Blend <= best model:   ${blendBeatsBest}/${total} (${((blendBeatsBest / total) * 100).toFixed(1)}%)`);
      console.log(`    Magic > equal blend:   ${magicBeatEqual}/${total} (${((magicBeatEqual / total) * 100).toFixed(1)}%)`);
      console.log(`    Avg delta vs best:     ${(magicVsBestDelta / total).toFixed(4)} (positive = blend worse)`);
      console.log(`    Avg delta vs equal:    ${(magicVsEqualDelta / total).toFixed(4)} (negative = magic better)`);

      for (const model of MODELS) {
        const m = blendBeatsEachModel[model];
        if (m && m.total > 0) {
          console.log(`    Blend <= ${model.padEnd(20)} ${m.beats}/${m.total} (${((m.beats / m.total) * 100).toFixed(1)}%)`);
        }
      }
    }
  }

  // --- ANALYSIS 4: Lead-time interpolation analysis ---
  console.log("\n" + "=" .repeat(80));
  console.log("ANALYSIS 4: Model skill degradation by lead time (all available lead times)");
  console.log("=" .repeat(80));

  for (const variable of VARIABLES) {
    const metricType = variable === "temperature_2m" ? "RMSE" : "MAE";
    const bcMetricType = `${metricType}_bc`;

    console.log(`\n--- ${variable} ---`);

    // Collect errors by model and lead hour
    const byModelLead: Record<string, Record<number, { sum: number; count: number }>> = {};

    for (const [_stationId, modelMap] of stationData) {
      for (const model of MODELS) {
        const varData = modelMap[model]?.[variable];
        if (!varData) continue;

        if (!byModelLead[model]) byModelLead[model] = {};

        for (const [lt, metrics] of Object.entries(varData)) {
          const hours = Number(lt);
          const val = metrics[bcMetricType] ?? metrics[metricType];
          if (val === undefined || val <= 0) continue;

          if (!byModelLead[model]![hours]) byModelLead[model]![hours] = { sum: 0, count: 0 };
          byModelLead[model]![hours]!.sum += val;
          byModelLead[model]![hours]!.count++;
        }
      }
    }

    // Get all lead hours
    const allHours = new Set<number>();
    for (const leads of Object.values(byModelLead)) {
      for (const h of Object.keys(leads)) allHours.add(Number(h));
    }

    const sortedHours = [...allHours].sort((a, b) => a - b);

    // Print header
    const header = "  Hour  " + MODELS.map((m) => m.substring(0, 16).padEnd(18)).join("");
    console.log(header);
    console.log("  " + "-".repeat(header.length));

    for (const h of sortedHours) {
      let line = `  ${String(h).padStart(4)}  `;
      for (const model of MODELS) {
        const d = byModelLead[model]?.[h];
        if (d && d.count > 0) {
          line += `${(d.sum / d.count).toFixed(4)} (${String(d.count).padStart(4)})  `;
        } else {
          line += "      -           ";
        }
      }
      console.log(line);
    }
  }

  // --- ANALYSIS 5: Variable coverage gaps ---
  console.log("\n" + "=" .repeat(80));
  console.log("ANALYSIS 5: Variable coverage - which models have data for which variables?");
  console.log("=" .repeat(80));

  const allVarsInData = new Set<string>();
  const modelVarCounts: Record<string, Record<string, number>> = {};
  for (const [_sid, modelMap] of stationData) {
    for (const [model, vars] of Object.entries(modelMap)) {
      if (!modelVarCounts[model]) modelVarCounts[model] = {};
      for (const v of Object.keys(vars)) {
        allVarsInData.add(v);
        modelVarCounts[model]![v] = (modelVarCounts[model]![v] ?? 0) + 1;
      }
    }
  }

  for (const v of [...allVarsInData].sort()) {
    console.log(`\n  ${v}:`);
    for (const model of [...uniqueModels].sort()) {
      const cnt = modelVarCounts[model]?.[v] ?? 0;
      if (cnt > 0) console.log(`    ${model.padEnd(22)} ${cnt} stations`);
    }
  }

  // --- ANALYSIS 6: Regional variation - which model is best where? ---
  console.log("\n" + "=" .repeat(80));
  console.log("ANALYSIS 6: Regional analysis - best model by region (temperature_2m, 24h)");
  console.log("=" .repeat(80));

  const regions: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }> = {
    "Pacific NW": { minLat: 42, maxLat: 50, minLon: -125, maxLon: -116 },
    "Southwest": { minLat: 31, maxLat: 37, minLon: -118, maxLon: -103 },
    "Great Plains": { minLat: 35, maxLat: 49, minLon: -104, maxLon: -95 },
    "Midwest": { minLat: 37, maxLat: 49, minLon: -95, maxLon: -82 },
    "Southeast": { minLat: 25, maxLat: 37, minLon: -91, maxLon: -75 },
    "Northeast": { minLat: 37, maxLat: 47, minLon: -82, maxLon: -67 },
  };

  for (const [regionName, bounds] of Object.entries(regions)) {
    const modelErrors: Record<string, { sum: number; count: number }> = {};

    for (const [stationId, modelMap] of stationData) {
      const station = stations.get(stationId);
      if (!station) continue;
      if (
        station.latitude < bounds.minLat || station.latitude > bounds.maxLat ||
        station.longitude < bounds.minLon || station.longitude > bounds.maxLon
      ) continue;

      for (const model of MODELS) {
        const varData = modelMap[model]?.["temperature_2m"];
        if (!varData) continue;

        for (const [lt, metrics] of Object.entries(varData)) {
          if (Math.abs(Number(lt) - 24) > 6) continue;
          const val = metrics["RMSE_bc"] ?? metrics["RMSE"];
          if (val === undefined || val <= 0) continue;

          if (!modelErrors[model]) modelErrors[model] = { sum: 0, count: 0 };
          modelErrors[model]!.sum += val;
          modelErrors[model]!.count++;
        }
      }
    }

    console.log(`\n  ${regionName}:`);
    const sorted = Object.entries(modelErrors)
      .filter(([_, d]) => d.count > 0)
      .map(([model, d]) => ({ model, avg: d.sum / d.count, count: d.count }))
      .sort((a, b) => a.avg - b.avg);

    for (const { model, avg, count } of sorted) {
      console.log(`    ${model.padEnd(22)} ${avg.toFixed(4)} (n=${count})`);
    }
  }
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
