import { describe, it, expect } from "vitest";
import { getLocationFromUrl, setLocationInUrl, type LocationParam } from "./url-params.js";

const BASE = "https://example.com/";

describe("setLocationInUrl + getLocationFromUrl round trip", () => {
  it("round-trips a zip code", () => {
    const next = setLocationInUrl(BASE, { type: "zip", zip: "10001" });
    expect(getLocationFromUrl(next)).toEqual({ type: "zip", zip: "10001" });
  });

  it("round-trips coordinates", () => {
    const next = setLocationInUrl(BASE, {
      type: "coords",
      latitude: 40.7484,
      longitude: -73.9967,
    });
    const loaded = getLocationFromUrl(next);
    expect(loaded?.type).toBe("coords");
    if (loaded?.type === "coords") {
      expect(loaded.latitude).toBeCloseTo(40.7484, 3);
      expect(loaded.longitude).toBeCloseTo(-73.9967, 3);
    }
  });

  it("round-trips southern/western hemisphere coordinates", () => {
    const next = setLocationInUrl(BASE, {
      type: "coords",
      latitude: -33.8688,
      longitude: 151.2093,
    });
    const loaded = getLocationFromUrl(next);
    expect(loaded?.type).toBe("coords");
    if (loaded?.type === "coords") {
      expect(loaded.latitude).toBeCloseTo(-33.8688, 3);
      expect(loaded.longitude).toBeCloseTo(151.2093, 3);
    }
  });

  it("clearing removes all location params", () => {
    const withZip = setLocationInUrl(BASE, { type: "zip", zip: "10001" });
    const cleared = setLocationInUrl(withZip, null);
    expect(getLocationFromUrl(cleared)).toBeNull();
    expect(new URL(cleared).search).toBe("");
  });

  it("setting zip clears any existing coord params", () => {
    const withCoords = setLocationInUrl(BASE, {
      type: "coords",
      latitude: 40,
      longitude: -74,
    });
    const withZip = setLocationInUrl(withCoords, { type: "zip", zip: "10001" });
    const params = new URL(withZip).searchParams;
    expect(params.has("lat")).toBe(false);
    expect(params.has("lon")).toBe(false);
    expect(params.get("zip")).toBe("10001");
  });

  it("setting coords clears any existing zip param", () => {
    const withZip = setLocationInUrl(BASE, { type: "zip", zip: "10001" });
    const withCoords = setLocationInUrl(withZip, {
      type: "coords",
      latitude: 40,
      longitude: -74,
    });
    const params = new URL(withCoords).searchParams;
    expect(params.has("zip")).toBe(false);
    expect(params.get("lat")).not.toBeNull();
    expect(params.get("lon")).not.toBeNull();
  });

  it("preserves unrelated query params", () => {
    const start = `${BASE}?theme=dark`;
    const next = setLocationInUrl(start, { type: "zip", zip: "10001" });
    expect(new URL(next).searchParams.get("theme")).toBe("dark");
    expect(new URL(next).searchParams.get("zip")).toBe("10001");
  });
});

describe("getLocationFromUrl", () => {
  it("returns null for a URL with no location params", () => {
    expect(getLocationFromUrl(BASE)).toBeNull();
  });

  it("returns null for malformed coordinates", () => {
    expect(getLocationFromUrl(`${BASE}?lat=abc&lon=def`)).toBeNull();
  });

  it("returns null for partial-numeric coordinates (parseFloat junk-tail)", () => {
    expect(getLocationFromUrl(`${BASE}?lat=40.7abc&lon=-74xyz`)).toBeNull();
    expect(getLocationFromUrl(`${BASE}?lat=40.7&lon=-74.0foo`)).toBeNull();
  });

  it("returns null when only lat is present", () => {
    expect(getLocationFromUrl(`${BASE}?lat=40.7`)).toBeNull();
  });

  it("returns null when only lon is present", () => {
    expect(getLocationFromUrl(`${BASE}?lon=-74`)).toBeNull();
  });

  it("returns null when lat is out of range", () => {
    expect(getLocationFromUrl(`${BASE}?lat=91&lon=0`)).toBeNull();
    expect(getLocationFromUrl(`${BASE}?lat=-91&lon=0`)).toBeNull();
  });

  it("returns null when lon is out of range", () => {
    expect(getLocationFromUrl(`${BASE}?lat=0&lon=181`)).toBeNull();
    expect(getLocationFromUrl(`${BASE}?lat=0&lon=-181`)).toBeNull();
  });

  it("prefers zip when both zip and coords are present", () => {
    expect(getLocationFromUrl(`${BASE}?zip=10001&lat=40&lon=-74`)).toEqual({
      type: "zip",
      zip: "10001",
    });
  });
});

describe("setLocationInUrl coordinate formatting", () => {
  it("uses a sensible fixed precision in the URL (not noisy floats)", () => {
    const next = setLocationInUrl(BASE, {
      type: "coords",
      latitude: 40.748417,
      longitude: -73.996712,
    });
    const search = new URL(next).search;
    // Should not include long floating point trails
    expect(search).not.toMatch(/\.\d{6,}/);
    // Both params should be present
    const params = new URL(next).searchParams;
    expect(params.get("lat")).toBeTruthy();
    expect(params.get("lon")).toBeTruthy();
  });
});

describe("LocationParam type", () => {
  it("accepts both shapes", () => {
    const zip: LocationParam = { type: "zip", zip: "10001" };
    const coords: LocationParam = { type: "coords", latitude: 0, longitude: 0 };
    expect(zip.type).toBe("zip");
    expect(coords.type).toBe("coords");
  });
});
