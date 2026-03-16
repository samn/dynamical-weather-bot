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

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "generated");
const OUT_PATH = join(OUT_DIR, "accuracy-grid.json");

const STATS_URL = "https://sa.dynamical.org/statistics.parquet";
const STATIONS_URL = "https://sa.dynamical.org/stations.csv";

/** 90-day window in microseconds (dynamical uses int64 microseconds) */
const WINDOW_90D = 7776000000000000;

/** Grid resolution in degrees */
const GRID_RES = 0.5;

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

/** Lead time bins we care about (hours) */
const LEAD_BINS = [0, 24, 48];

interface Station {
  id: string;
  latitude: number;
  longitude: number;
}

interface StatRow {
  station_id: string;
  model: string;
  variable: string;
  metric: string;
  window: number;
  lead_time: number;
  value: number;
}

interface GridCell {
  stationCount: number;
  metrics: Record<string, Record<string, Record<string, number>>>;
  nearbyStations?: Array<{
    id: string;
    distance: number;
    metrics: Record<string, Record<string, Record<string, number>>>;
  }>;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function snapToGrid(val: number): number {
  return Math.floor(val / GRID_RES) * GRID_RES;
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

function parseStationsCsv(csv: string): Map<string, Station> {
  const stations = new Map<string, Station>();
  const lines = csv.trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const idIdx = header.indexOf("station_id");
  const latIdx = header.indexOf("latitude");
  const lonIdx = header.indexOf("longitude");
  if (idIdx < 0 || latIdx < 0 || lonIdx < 0) {
    throw new Error(`stations.csv missing required columns. Header: ${header.join(",")}`);
  }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]?.split(",");
    if (!cols) continue;
    const id = cols[idIdx];
    const lat = parseFloat(cols[latIdx] ?? "");
    const lon = parseFloat(cols[lonIdx] ?? "");
    if (id && isFinite(lat) && isFinite(lon)) {
      stations.set(id, { id, latitude: lat, longitude: lon });
    }
  }
  return stations;
}

/** Convert lead_time (seconds or nanoseconds) to the nearest lead bin in hours */
function leadTimeToHourBin(leadTimeVal: number): number | undefined {
  // lead_time is in nanoseconds in some datasets, seconds in others
  // Try to detect: if > 1e12, it's likely nanoseconds
  let hours: number;
  if (Math.abs(leadTimeVal) > 1e12) {
    hours = Math.round(leadTimeVal / 3.6e12); // nanoseconds to hours
  } else if (Math.abs(leadTimeVal) > 1e6) {
    hours = Math.round(leadTimeVal / 3.6e9); // microseconds to hours
  } else {
    hours = Math.round(leadTimeVal / 3600); // seconds to hours
  }
  // Snap to nearest bin
  const bin = LEAD_BINS.reduce((best, b) => (Math.abs(hours - b) < Math.abs(hours - best) ? b : best), LEAD_BINS[0]!);
  if (Math.abs(hours - bin) <= 6) return bin;
  return undefined;
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
      // data is array of rows, each row is array of column values
      // We need to find column ordering from the schema
      for (const row of data) {
        if (!Array.isArray(row) || row.length < 7) continue;
        // Columns: station_id, model, variable, metric, window, lead_time, value
        // (We'll try to match by parsing the structure)
        rows.push({
          station_id: String(row[0]),
          model: String(row[1]),
          variable: String(row[2]),
          metric: String(row[3]),
          window: Number(row[4]),
          lead_time: Number(row[5]),
          value: Number(row[6]),
        });
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

      // For dense cells, store 3 nearest stations
      if (nearby.length >= 5) {
        nearby.sort((a, b) => a.distance - b.distance);
        cell.nearbyStations = nearby.slice(0, 3).map((n) => ({
          id: n.station.id,
          distance: Math.round(n.distance * 10) / 10,
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
