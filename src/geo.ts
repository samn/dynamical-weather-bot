import type { LatLon } from "./types.js";

// US ZIP code centroids (a small lookup table for common zips)
// For a production app, you'd use a geocoding API. This covers the approach
// of using a lightweight offline lookup.

const ZIP_API_URL = "https://api.zippopotam.us/us/";

/** Get coordinates from browser geolocation API */
export function getGeolocation(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      },
      (err) => {
        reject(new Error(`Geolocation error: ${err.message}`));
      },
      { timeout: 10000, enableHighAccuracy: false },
    );
  });
}

/** Get coordinates from a US ZIP code using a free API */
export async function zipToLatLon(zip: string): Promise<LatLon> {
  if (!/^\d{5}$/.test(zip)) {
    throw new Error("Please enter a valid 5-digit US ZIP code.");
  }
  const resp = await fetch(`${ZIP_API_URL}${zip}`);
  if (!resp.ok) {
    throw new Error(`ZIP code ${zip} not found.`);
  }
  const data: unknown = await resp.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("places" in data) ||
    !Array.isArray((data as { places: unknown }).places)
  ) {
    throw new Error(`ZIP code ${zip} not found.`);
  }
  const places = (data as { places: unknown[] }).places;
  const place = places[0];
  if (!place || typeof place !== "object" || !("latitude" in place) || !("longitude" in place)) {
    throw new Error(`ZIP code ${zip} not found.`);
  }
  const lat = parseFloat(String((place as { latitude: unknown }).latitude));
  const lon = parseFloat(String((place as { longitude: unknown }).longitude));
  if (!isFinite(lat) || !isFinite(lon)) {
    throw new Error(`Invalid coordinates for ZIP code ${zip}.`);
  }
  return { latitude: lat, longitude: lon };
}

/** Haversine distance between two points in kilometers */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

/**
 * Convert a longitude to the dynamical.org grid convention.
 * The GEFS grid uses -180 to 179.75, so standard lon should work directly.
 */
export function normalizeLongitude(lon: number): number {
  // Ensure longitude is in [-180, 180)
  let normalized = lon % 360;
  if (normalized >= 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
}
