/**
 * Benchmark: Zarr FetchStore vs Icechunk for GEFS forecast data.
 *
 * Fetches temperature_2m for a sample point (New York City area)
 * using both approaches and compares latency.
 *
 * Usage: npx tsx scripts/benchmark-icechunk.ts
 */

import { ProxyAgent, setGlobalDispatcher } from "undici";
import * as zarr from "zarrita";
import { IcechunkStore } from "icechunk-js";

// Configure Node.js fetch to use the HTTP proxy if set
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Using proxy: ${proxyUrl.replace(/jwt_[^@]+/, "jwt_***")}\n`);
}

const ZARR_URL =
  "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr?email=weather-forecast-app@dynamical-weather-bot.pages.dev";

const ICECHUNK_URL =
  "https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-forecast-35-day/v0.2.0.icechunk/";

// NYC area: ~40.7N, -74.0W
const LAT = 40.7;
const LON = -74.0;

const GRID_RES = 0.25;
const LAT_IDX = Math.round((90 - LAT) / GRID_RES); // ~197
// Zarr store uses -180..180
const LON_IDX_ZARR = Math.round((LON + 180) / GRID_RES); // ~424
// Icechunk store uses 0..360
const LON_IDX_ICE = Math.round(((((LON % 360) + 360) % 360) / GRID_RES)); // ~1144

const NUM_ENSEMBLE = 31;
const NUM_STEPS = 24; // 72h at 3h intervals

function coordToNumbers(data: unknown): number[] {
  if (data instanceof BigInt64Array) return Array.from(data, (v) => Number(v));
  if (data instanceof Float64Array || data instanceof Float32Array || data instanceof Int32Array)
    return Array.from(data);
  if (Array.isArray(data)) return data.map(Number);
  return [];
}

async function benchmarkZarr(): Promise<{ metadataMs: number; dataMs: number; totalMs: number }> {
  const t0 = performance.now();

  const store = new zarr.FetchStore(ZARR_URL);

  // Fetch metadata (init_time + lead_time)
  const initLoc = zarr.root(store).resolve("init_time");
  const initArr = await zarr.open(initLoc, { kind: "array" });
  const initResult = await zarr.get(initArr);
  const initData = coordToNumbers(initResult.data);
  const initIdx = initData.length - 1;

  const leadLoc = zarr.root(store).resolve("lead_time");
  const leadArr = await zarr.open(leadLoc, { kind: "array" });
  await zarr.get(leadArr, [zarr.slice(NUM_STEPS)]);

  const t1 = performance.now();
  const metadataMs = t1 - t0;

  // Fetch temperature data
  const tempLoc = zarr.root(store).resolve("temperature_2m");
  const tempArr = await zarr.open(tempLoc, { kind: "array" });
  const result = await zarr.get(tempArr, [
    initIdx,
    zarr.slice(NUM_ENSEMBLE),
    zarr.slice(NUM_STEPS),
    LAT_IDX,
    LON_IDX_ZARR,
  ]);

  const t2 = performance.now();
  const dataMs = t2 - t1;

  const rawData = result.data as Float32Array;
  console.log(`  Zarr: got ${rawData.length} values (expected ${NUM_ENSEMBLE * NUM_STEPS})`);
  console.log(
    `  Sample values: ${Array.from(rawData.slice(0, 5)).map((v) => v.toFixed(2)).join(", ")}`,
  );

  return { metadataMs, dataMs, totalMs: t2 - t0 };
}

async function benchmarkIcechunk(): Promise<{
  metadataMs: number;
  dataMs: number;
  totalMs: number;
}> {
  const t0 = performance.now();

  const store = await IcechunkStore.open(ICECHUNK_URL);

  // Fetch metadata (init_time + lead_time)
  const initArr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const initResult = await zarr.get(initArr);
  const initData = coordToNumbers(initResult.data);
  const initIdx = initData.length - 1;

  const leadArr = await zarr.open(store.resolve("lead_time"), { kind: "array" });
  await zarr.get(leadArr, [zarr.slice(NUM_STEPS)]);

  const t1 = performance.now();
  const metadataMs = t1 - t0;

  // Fetch temperature data
  const tempArr = await zarr.open(store.resolve("temperature_2m"), { kind: "array" });
  const result = await zarr.get(tempArr, [
    initIdx,
    zarr.slice(NUM_ENSEMBLE),
    zarr.slice(NUM_STEPS),
    LAT_IDX,
    LON_IDX_ICE,
  ]);

  const t2 = performance.now();
  const dataMs = t2 - t1;

  const rawData = result.data as Float32Array;
  console.log(`  Icechunk: got ${rawData.length} values (expected ${NUM_ENSEMBLE * NUM_STEPS})`);
  console.log(
    `  Sample values: ${Array.from(rawData.slice(0, 5)).map((v) => v.toFixed(2)).join(", ")}`,
  );

  return { metadataMs, dataMs, totalMs: t2 - t0 };
}

async function benchmarkIcechunkCached(): Promise<{
  metadataMs: number;
  dataMs: number;
  totalMs: number;
}> {
  // Pre-open the store (simulates having it cached)
  const store = await IcechunkStore.open(ICECHUNK_URL);

  const t0 = performance.now();

  // Fetch metadata (init_time + lead_time)
  const initArr = await zarr.open(store.resolve("init_time"), { kind: "array" });
  const initResult = await zarr.get(initArr);
  const initData = coordToNumbers(initResult.data);
  const initIdx = initData.length - 1;

  const leadArr = await zarr.open(store.resolve("lead_time"), { kind: "array" });
  await zarr.get(leadArr, [zarr.slice(NUM_STEPS)]);

  const t1 = performance.now();
  const metadataMs = t1 - t0;

  // Fetch temperature data
  const tempArr = await zarr.open(store.resolve("temperature_2m"), { kind: "array" });
  const result = await zarr.get(tempArr, [
    initIdx,
    zarr.slice(NUM_ENSEMBLE),
    zarr.slice(NUM_STEPS),
    LAT_IDX,
    LON_IDX_ICE,
  ]);

  const t2 = performance.now();
  const dataMs = t2 - t1;

  const rawData = result.data as Float32Array;
  console.log(`  Icechunk (cached store): got ${rawData.length} values`);
  console.log(
    `  Sample values: ${Array.from(rawData.slice(0, 5)).map((v) => v.toFixed(2)).join(", ")}`,
  );

  return { metadataMs, dataMs, totalMs: t2 - t0 };
}

type BenchResult = { metadataMs: number; dataMs: number; totalMs: number };

async function runBench(
  name: string,
  fn: () => Promise<BenchResult>,
  runs: number,
): Promise<BenchResult[]> {
  console.log(`--- ${name} ---`);
  const results: BenchResult[] = [];
  for (let i = 0; i < runs; i++) {
    console.log(`Run ${i + 1}:`);
    try {
      const r = await fn();
      console.log(
        `  Metadata: ${r.metadataMs.toFixed(0)}ms | Data: ${r.dataMs.toFixed(0)}ms | Total: ${r.totalMs.toFixed(0)}ms\n`,
      );
      results.push(r);
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  return results;
}

function avgOf(results: BenchResult[], key: keyof BenchResult): number {
  return results.length > 0 ? results.reduce((a, r) => a + r[key], 0) / results.length : NaN;
}

async function main() {
  console.log("=== GEFS Forecast Benchmark: Zarr vs Icechunk ===");
  console.log(`Location: ${LAT}°N, ${LON}°E (NYC area)`);
  console.log(`Grid: lat_idx=${LAT_IDX}, zarr_lon_idx=${LON_IDX_ZARR}, ice_lon_idx=${LON_IDX_ICE}`);
  console.log(`Fetching: temperature_2m, ${NUM_ENSEMBLE} members x ${NUM_STEPS} steps\n`);

  const NUM_RUNS = 3;

  const zarrResults = await runBench("Zarr FetchStore", benchmarkZarr, NUM_RUNS);
  const iceResults = await runBench("Icechunk (cold open)", benchmarkIcechunk, NUM_RUNS);
  const iceCachedResults = await runBench(
    "Icechunk (cached store)",
    benchmarkIcechunkCached,
    NUM_RUNS,
  );

  console.log("=== SUMMARY (averages) ===");
  for (const [name, results] of [
    ["Zarr FetchStore", zarrResults],
    ["Icechunk (cold)", iceResults],
    ["Icechunk (cached)", iceCachedResults],
  ] as const) {
    if (results.length === 0) {
      console.log(`${name.padEnd(25)} FAILED (all runs)`);
    } else {
      console.log(
        `${name.padEnd(25)} metadata=${avgOf(results, "metadataMs").toFixed(0)}ms  data=${avgOf(results, "dataMs").toFixed(0)}ms  total=${avgOf(results, "totalMs").toFixed(0)}ms`,
      );
    }
  }

  if (zarrResults.length > 0 && iceResults.length > 0) {
    const ratio = avgOf(iceResults, "totalMs") / avgOf(zarrResults, "totalMs");
    console.log(
      `\nIcechunk cold vs Zarr: ${((ratio - 1) * 100).toFixed(1)}% ${ratio < 1 ? "faster" : "slower"}`,
    );
  }
  if (zarrResults.length > 0 && iceCachedResults.length > 0) {
    const ratio = avgOf(iceCachedResults, "totalMs") / avgOf(zarrResults, "totalMs");
    console.log(
      `Icechunk cached vs Zarr: ${((ratio - 1) * 100).toFixed(1)}% ${ratio < 1 ? "faster" : "slower"}`,
    );
  }
}

main().catch(console.error);
