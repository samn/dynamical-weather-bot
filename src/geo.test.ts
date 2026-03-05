import { describe, it, expect, vi } from "vitest";
import { normalizeLongitude, zipToLatLon } from "./geo.js";

describe("normalizeLongitude", () => {
  it("keeps values in range unchanged", () => {
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(90)).toBe(90);
    expect(normalizeLongitude(-90)).toBe(-90);
    expect(normalizeLongitude(179)).toBe(179);
    expect(normalizeLongitude(-180)).toBe(-180);
  });

  it("wraps values above 180", () => {
    expect(normalizeLongitude(181)).toBeCloseTo(-179, 5);
    expect(normalizeLongitude(270)).toBeCloseTo(-90, 5);
    expect(normalizeLongitude(360)).toBeCloseTo(0, 5);
  });

  it("wraps values below -180", () => {
    expect(normalizeLongitude(-181)).toBeCloseTo(179, 5);
    expect(normalizeLongitude(-270)).toBeCloseTo(90, 5);
    expect(normalizeLongitude(-360)).toBeCloseTo(0, 5);
  });
});

describe("zipToLatLon", () => {
  it("rejects invalid ZIP formats", async () => {
    await expect(zipToLatLon("123")).rejects.toThrow("valid 5-digit");
    await expect(zipToLatLon("abcde")).rejects.toThrow("valid 5-digit");
    await expect(zipToLatLon("")).rejects.toThrow("valid 5-digit");
    await expect(zipToLatLon("123456")).rejects.toThrow("valid 5-digit");
  });

  it("parses a valid API response", async () => {
    const mockResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          places: [{ latitude: "40.7128", longitude: "-74.006" }],
        }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await zipToLatLon("10001");
    expect(result.latitude).toBeCloseTo(40.7128, 4);
    expect(result.longitude).toBeCloseTo(-74.006, 4);

    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(zipToLatLon("99999")).rejects.toThrow("not found");

    vi.unstubAllGlobals();
  });

  it("throws on malformed response data", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ places: [] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(zipToLatLon("00000")).rejects.toThrow("not found");

    vi.unstubAllGlobals();
  });

  it("throws on response missing places array", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ other: "data" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(zipToLatLon("00000")).rejects.toThrow("not found");

    vi.unstubAllGlobals();
  });

  it("throws on non-finite coordinates", async () => {
    const mockResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          places: [{ latitude: "not-a-number", longitude: "also-bad" }],
        }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(zipToLatLon("00000")).rejects.toThrow("Invalid coordinates");

    vi.unstubAllGlobals();
  });
});
