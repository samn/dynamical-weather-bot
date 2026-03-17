/**
 * Build-time script: fetches verification statistics from dynamical.org
 * and produces a compact accuracy grid JSON for the app to bundle.
 *
 * Usage: npm run generate:accuracy
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parquetRead } from "hyparquet";
import { haversineKm } from "../src/geo.js";
import {
  GRID_RES,
  snapToGrid,
  parseStationsCsv,
  leadTimeToHourBin,
  parseParquetRow,
  type Station,
  type StatRow,
} from "./accuracy-grid-utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "generated");
const OUT_PATH = join(OUT_DIR, "accuracy-grid.json");

const STATS_URL = "https://sa.dynamical.org/statistics.parquet";
const STATIONS_URL = "https://sa.dynamical.org/stations.csv";

/** 90-day window in nanoseconds (dynamical uses int64 nanoseconds) */
const WINDOW_90D = 7776000000000000;

/** CONUS bounding box */
const BOUNDS = { minLat: 24.0, maxLat: 50.0, minLon: -130.0, maxLon: -65.0 };

/** Max radius in km for IDW interpolation */
const MAX_RADIUS_KM = 200;

/** Minimum distance cap for IDW to avoid division issues */
const MIN_DISTANCE_KM = 10;

/** Variables of interest and their preferred metric */
const VARIABLE_METRICS: Record<string, string> = {
  temperature_2m: "RMSE",
  precipitation_surface: "MAE",
};

interface GridCell {
  stationCount: number;
  metrics: Record<string, Record<string, Record<string, number>>>;
  nearbyStations?: Array<{
    id: string;
    latitude: number;
    longitude: number;
    metrics: Record<string, Record<string, Record<string, number>>>;
  }>;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  console.log(`Fetching ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  console.log(`Fetching ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.text();
}

async function main() {
  const [parquetBuf, stationsCsv] = await Promise.all([fetchBuffer(STATS_URL), fetchText(STATIONS_URL)]);

  const stations = parseStationsCsv(stationsCsv);
  console.log(`Loaded ${stations.size} stations`);

  // Parse parquet
  const rows: StatRow[] = [];
  await parquetRead({
    file: parquetBuf,
    onComplete: (data: unknown[][]) => {
      for (const row of data) {
        if (!Array.isArray(row)) continue;
        const parsed = parseParquetRow(row);
        if (parsed) rows.push(parsed);
      }
    },
  });

  console.log(`Parsed ${rows.length} statistic rows`);

  // Filter to relevant rows
  const models = new Set(["NOAA GEFS", "NOAA HRRR"]);
  const filtered = rows.filter((r) => {
    if (!models.has(r.model)) return false;
    const expectedMetric = VARIABLE_METRICS[r.variable];
    if (!expectedMetric || r.metric !== expectedMetric) return false;
    // Check window (allow some tolerance for different representations)
    if (r.window !== WINDOW_90D && r.window !== 7776000 && r.window !== 7776000000) return false;
    return isFinite(r.value) && r.value > 0;
  });

  console.log(`Filtered to ${filtered.length} relevant rows`);

  // Group by station
  type StationMetrics = Record<string, Record<string, Record<string, number>>>; // model → variable → leadHours → value
  const stationMetrics = new Map<string, StationMetrics>();

  for (const r of filtered) {
    const hourBin = leadTimeToHourBin(r.lead_time);
    if (hourBin === undefined) continue;

    let sm = stationMetrics.get(r.station_id);
    if (!sm) {
      sm = {};
      stationMetrics.set(r.station_id, sm);
    }
    if (!sm[r.model]) sm[r.model] = {};
    if (!sm[r.model]![r.variable]) sm[r.model]![r.variable] = {};
    sm[r.model]![r.variable]![String(hourBin)] = r.value;
  }

  console.log(`${stationMetrics.size} stations have relevant metrics`);

  // Build grid
  const cells: Record<string, GridCell> = {};

  // Precompute CONUS stations with positions
  const conusStations: Array<{ station: Station; metrics: StationMetrics }> = [];
  for (const [id, metrics] of stationMetrics) {
    const station = stations.get(id);
    if (!station) continue;
    if (
      station.latitude < BOUNDS.minLat ||
      station.latitude > BOUNDS.maxLat ||
      station.longitude < BOUNDS.minLon ||
      station.longitude > BOUNDS.maxLon
    )
      continue;
    conusStations.push({ station, metrics });
  }

  console.log(`${conusStations.length} CONUS stations with metrics`);

  for (let lat = BOUNDS.minLat; lat <= BOUNDS.maxLat; lat += GRID_RES) {
    for (let lon = BOUNDS.minLon; lon <= BOUNDS.maxLon; lon += GRID_RES) {
      const cellLat = snapToGrid(lat);
      const cellLon = snapToGrid(lon);
      const centerLat = cellLat + GRID_RES / 2;
      const centerLon = cellLon + GRID_RES / 2;

      // Find nearby stations within radius
      const nearby: Array<{ station: Station; distance: number; metrics: StationMetrics }> = [];
      for (const s of conusStations) {
        const d = haversineKm(centerLat, centerLon, s.station.latitude, s.station.longitude);
        if (d <= MAX_RADIUS_KM) {
          nearby.push({ station: s.station, distance: d, metrics: s.metrics });
        }
      }

      if (nearby.length === 0) continue;

      // IDW-weighted average of metrics
      const cellMetrics: Record<string, Record<string, Record<string, number>>> = {};
      const weightSums: Record<string, Record<string, Record<string, number>>> = {};

      for (const n of nearby) {
        const w = 1 / Math.pow(Math.max(n.distance, MIN_DISTANCE_KM), 2);
        for (const [model, vars] of Object.entries(n.metrics)) {
          if (!cellMetrics[model]) cellMetrics[model] = {};
          if (!weightSums[model]) weightSums[model] = {};
          for (const [varName, leads] of Object.entries(vars)) {
            if (!cellMetrics[model]![varName]) cellMetrics[model]![varName] = {};
            if (!weightSums[model]![varName]) weightSums[model]![varName] = {};
            for (const [lead, val] of Object.entries(leads)) {
              cellMetrics[model]![varName]![lead] = (cellMetrics[model]![varName]![lead] ?? 0) + w * val;
              weightSums[model]![varName]![lead] = (weightSums[model]![varName]![lead] ?? 0) + w;
            }
          }
        }
      }

      // Normalize by weight sums
      for (const [model, vars] of Object.entries(cellMetrics)) {
        for (const [varName, leads] of Object.entries(vars)) {
          for (const lead of Object.keys(leads)) {
            const ws = weightSums[model]?.[varName]?.[lead];
            if (ws && ws > 0) {
              cellMetrics[model]![varName]![lead] = Math.round((cellMetrics[model]![varName]![lead]! / ws) * 1000) / 1000;
            }
          }
        }
      }

      const key = `${cellLat.toFixed(1)},${cellLon.toFixed(1)}`;
      const cell: GridCell = {
        stationCount: nearby.length,
        metrics: cellMetrics,
      };

      // For cells with enough stations, store the nearest with their coordinates
      if (nearby.length >= 3) {
        nearby.sort((a, b) => a.distance - b.distance);
        cell.nearbyStations = nearby.slice(0, 10).map((n) => ({
          id: n.station.id,
          latitude: n.station.latitude,
          longitude: n.station.longitude,
          metrics: n.metrics,
        }));
      }

      cells[key] = cell;
    }
  }

  const cellCount = Object.keys(cells).length;
  console.log(`Built ${cellCount} grid cells`);

  const grid = {
    gridResolution: GRID_RES,
    bounds: BOUNDS,
    cells,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(grid));
  const sizeMb = (readFileSync(OUT_PATH).length / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_PATH} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error("Build accuracy grid failed:", err);
  process.exit(1);
});
