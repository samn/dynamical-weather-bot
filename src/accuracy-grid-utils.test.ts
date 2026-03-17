import { describe, it, expect } from "vitest";
import {
  snapToGrid,
  parseStationsCsv,
  leadTimeToHourBin,
  parseParquetRow,
} from "../scripts/accuracy-grid-utils.js";

describe("snapToGrid", () => {
  it("snaps to lower grid boundary", () => {
    expect(snapToGrid(40.3)).toBe(40.0);
    expect(snapToGrid(40.7)).toBe(40.0);
  });

  it("handles exact grid values", () => {
    expect(snapToGrid(40.0)).toBe(40.0);
    expect(snapToGrid(41.0)).toBe(41.0);
  });

  it("handles negative values", () => {
    expect(snapToGrid(-89.8)).toBe(-90.0);
    expect(snapToGrid(-89.3)).toBe(-90.0);
  });
});

describe("parseStationsCsv", () => {
  it("parses valid CSV", () => {
    const csv = "station_id,latitude,longitude\nKORD,41.978,-87.904\nKSFO,37.619,-122.375\n";
    const stations = parseStationsCsv(csv);
    expect(stations.size).toBe(2);
    expect(stations.get("KORD")).toEqual({ id: "KORD", latitude: 41.978, longitude: -87.904 });
    expect(stations.get("KSFO")).toEqual({ id: "KSFO", latitude: 37.619, longitude: -122.375 });
  });

  it("handles columns in any order", () => {
    const csv = "longitude,station_id,latitude\n-87.904,KORD,41.978\n";
    const stations = parseStationsCsv(csv);
    expect(stations.get("KORD")).toEqual({ id: "KORD", latitude: 41.978, longitude: -87.904 });
  });

  it("skips rows with invalid coordinates", () => {
    const csv = "station_id,latitude,longitude\nGOOD,40.0,-90.0\nBAD,abc,xyz\n";
    const stations = parseStationsCsv(csv);
    expect(stations.size).toBe(1);
    expect(stations.has("GOOD")).toBe(true);
  });

  it("throws on missing required columns", () => {
    const csv = "id,lat,lon\nKORD,41.978,-87.904\n";
    expect(() => parseStationsCsv(csv)).toThrow("missing required columns");
  });
});

describe("leadTimeToHourBin", () => {
  it("converts nanoseconds to hour bins", () => {
    // 0 hours = 0 nanoseconds
    expect(leadTimeToHourBin(0)).toBe(0);
    // 24 hours = 86400000000000 nanoseconds
    expect(leadTimeToHourBin(86400000000000)).toBe(24);
    // 48 hours = 172800000000000 nanoseconds
    expect(leadTimeToHourBin(172800000000000)).toBe(48);
  });

  it("snaps to nearest bin within tolerance", () => {
    // 20 hours in nanoseconds → snaps to 24
    expect(leadTimeToHourBin(20 * 3.6e12)).toBe(24);
    // 6 hours in nanoseconds → snaps to 0
    expect(leadTimeToHourBin(6 * 3.6e12)).toBe(0);
  });

  it("returns undefined for lead times far from any bin", () => {
    // 36 hours — equidistant from 24 and 48, but within tolerance of both
    // Actually 36 is 12 away from both, > 6 tolerance
    expect(leadTimeToHourBin(36 * 3.6e12)).toBeUndefined();
    // 100 hours
    expect(leadTimeToHourBin(100 * 3.6e12)).toBeUndefined();
  });

  it("handles seconds input", () => {
    // 0 seconds → 0 hours → bin 0
    expect(leadTimeToHourBin(0)).toBe(0);
    // 86400 seconds = 24 hours → bin 24
    expect(leadTimeToHourBin(86400)).toBe(24);
  });
});

describe("parseParquetRow", () => {
  it("parses a valid row", () => {
    const row = [
      "KORD",
      "NOAA GEFS",
      "temperature_2m",
      0n,
      2.5,
      "RMSE",
      1000,
      7776000000000000n,
      null,
      null,
    ];
    const result = parseParquetRow(row);
    expect(result).toEqual({
      station_id: "KORD",
      model: "NOAA GEFS",
      variable: "temperature_2m",
      lead_time: 0,
      value: 2.5,
      metric: "RMSE",
      window: 7776000000000000,
    });
  });

  it("returns undefined for short rows", () => {
    expect(parseParquetRow(["a", "b", "c"])).toBeUndefined();
  });

  it("converts BigInt lead_time and window to numbers", () => {
    const row = [
      "S1",
      "NOAA HRRR",
      "precipitation_surface",
      86400000000000n,
      1.2,
      "MAE",
      500,
      7776000000000000n,
      null,
      null,
    ];
    const result = parseParquetRow(row);
    expect(result?.lead_time).toBe(86400000000000);
    expect(result?.window).toBe(7776000000000000);
  });
});
