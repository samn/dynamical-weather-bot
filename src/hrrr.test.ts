import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("icechunk-js", () => ({
  IcechunkStore: { open: vi.fn() },
}));
vi.mock("zarrita", () => ({
  open: vi.fn(),
  get: vi.fn(),
  slice: vi.fn(),
}));

import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import { geoToHrrrIndex, fetchLatestHrrrInitTime } from "./hrrr.js";

/**
 * Approximate HRRR grid coordinate arrays for testing.
 * HRRR is ~3km resolution on a Lambert Conformal Conic projection.
 * We generate a small grid centered around the CONUS for testing purposes.
 */
function makeTestCoords(): { x: number[]; y: number[] } {
  // Grid with 3km spacing (3000m), ~1800 points in x, ~1060 in y
  // Origin roughly at the SW corner of the HRRR domain
  const xStart = -2697920;
  const yStart = -1588612;
  const step = 3000;
  const xCount = 1800;
  const yCount = 1060;

  const x = Array.from({ length: xCount }, (_, i) => xStart + i * step);
  const y = Array.from({ length: yCount }, (_, i) => yStart + i * step);

  return { x, y };
}

describe("geoToHrrrIndex", () => {
  const { x, y } = makeTestCoords();

  it("returns valid indices for a CONUS point (Chicago)", () => {
    const result = geoToHrrrIndex(41.88, -87.63, x, y);
    expect(result).not.toBeNull();
    expect(result!.xIdx).toBeGreaterThanOrEqual(0);
    expect(result!.xIdx).toBeLessThan(x.length);
    expect(result!.yIdx).toBeGreaterThanOrEqual(0);
    expect(result!.yIdx).toBeLessThan(y.length);
  });

  it("returns valid indices for a CONUS point (Denver)", () => {
    const result = geoToHrrrIndex(39.74, -104.99, x, y);
    expect(result).not.toBeNull();
    expect(result!.xIdx).toBeGreaterThanOrEqual(0);
    expect(result!.yIdx).toBeGreaterThanOrEqual(0);
  });

  it("returns null for London (outside CONUS)", () => {
    const result = geoToHrrrIndex(51.51, -0.13, x, y);
    expect(result).toBeNull();
  });

  it("returns null for Honolulu (outside CONUS)", () => {
    const result = geoToHrrrIndex(21.31, -157.86, x, y);
    expect(result).toBeNull();
  });

  it("returns null for empty coordinate arrays", () => {
    const result = geoToHrrrIndex(40, -90, [], []);
    expect(result).toBeNull();
  });

  it("returns null for single-element coordinate arrays", () => {
    const result = geoToHrrrIndex(40, -90, [0], [0]);
    expect(result).toBeNull();
  });
});

describe("fetchLatestHrrrInitTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a fresh store on each call so newly published forecasts are seen", async () => {
    // `IcechunkStore.open` pins the read session to the snapshot that is the
    // tip of `main` at open time. Reusing one cached store would freeze us on
    // that snapshot, so a newer HRRR forecast published later in the session
    // would never appear. A fresh open each call is what guarantees freshness.
    let latestSec = 1_700_000_000;
    vi.mocked(IcechunkStore.open).mockImplementation(
      async () => ({ resolve: () => ({}) }) as unknown as IcechunkStore,
    );
    vi.mocked(zarr.open).mockResolvedValue({} as never);
    vi.mocked(zarr.get).mockImplementation(
      async () => ({ data: new BigInt64Array([BigInt(latestSec)]) }) as never,
    );

    const first = await fetchLatestHrrrInitTime();
    expect(first).toBe(new Date(1_700_000_000 * 1000).toISOString());

    // A newer HRRR forecast is published one hour later.
    latestSec = 1_700_003_600;
    const second = await fetchLatestHrrrInitTime();
    expect(second).toBe(new Date(1_700_003_600 * 1000).toISOString());

    // Each call re-opens the store — no stale pinned snapshot.
    expect(vi.mocked(IcechunkStore.open)).toHaveBeenCalledTimes(2);
  });
});
