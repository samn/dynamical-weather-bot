/** Pure utility functions for the accuracy grid build, extracted for testability. */

/** Lead time bins we care about (hours) */
export const LEAD_BINS = [0, 24, 48];

/** Grid resolution in degrees */
export const GRID_RES = 0.5;

export interface Station {
  id: string;
  latitude: number;
  longitude: number;
}

export interface StatRow {
  station_id: string;
  model: string;
  variable: string;
  metric: string;
  window: number;
  lead_time: number;
  value: number;
}

export function snapToGrid(val: number): number {
  return Math.floor(val / GRID_RES) * GRID_RES;
}

export function parseStationsCsv(csv: string): Map<string, Station> {
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
export function leadTimeToHourBin(leadTimeVal: number): number | undefined {
  let hours: number;
  if (Math.abs(leadTimeVal) > 1e12) {
    hours = Math.round(leadTimeVal / 3.6e12); // nanoseconds to hours
  } else if (Math.abs(leadTimeVal) > 1e6) {
    hours = Math.round(leadTimeVal / 3.6e9); // microseconds to hours
  } else {
    hours = Math.round(leadTimeVal / 3600); // seconds to hours
  }
  const bin = LEAD_BINS.reduce(
    (best, b) => (Math.abs(hours - b) < Math.abs(hours - best) ? b : best),
    LEAD_BINS[0]!,
  );
  if (Math.abs(hours - bin) <= 6) return bin;
  return undefined;
}

/** Parse a parquet row array into a StatRow */
export function parseParquetRow(row: unknown[]): StatRow | undefined {
  if (row.length < 8) return undefined;
  // Parquet columns: station_id(0), model(1), variable(2), lead_time(3),
  // value(4), metric(5), count(6), window(7), min_valid(8), max_valid(9)
  return {
    station_id: String(row[0]),
    model: String(row[1]),
    variable: String(row[2]),
    lead_time: Number(row[3]),
    value: Number(row[4]),
    metric: String(row[5]),
    window: Number(row[7]),
  };
}
