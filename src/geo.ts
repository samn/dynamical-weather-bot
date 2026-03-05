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
  const record = data as { places: Array<{ latitude: string; longitude: string }> };
  const place = record.places[0];
  if (!place) {
    throw new Error(`ZIP code ${zip} not found.`);
  }
  return {
    latitude: parseFloat(place.latitude),
    longitude: parseFloat(place.longitude),
  };
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
