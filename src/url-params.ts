export type LocationParam =
  | { type: "zip"; zip: string }
  | { type: "coords"; latitude: number; longitude: number };

const COORD_DECIMALS = 4;

/**
 * Update query parameters on a URL to reflect the given location.
 * Passing null removes all location params.
 * Always clears the other location type so the URL contains at most one.
 */
export function setLocationInUrl(currentUrl: string, params: LocationParam | null): string {
  const url = new URL(currentUrl);
  url.searchParams.delete("zip");
  url.searchParams.delete("lat");
  url.searchParams.delete("lon");

  if (params?.type === "zip") {
    url.searchParams.set("zip", params.zip);
  } else if (params?.type === "coords") {
    url.searchParams.set("lat", params.latitude.toFixed(COORD_DECIMALS));
    url.searchParams.set("lon", params.longitude.toFixed(COORD_DECIMALS));
  }

  return url.toString();
}

/** Parse a location from the URL's query string. Returns null if absent or invalid. */
export function getLocationFromUrl(currentUrl: string): LocationParam | null {
  const params = new URL(currentUrl).searchParams;

  const zip = params.get("zip");
  if (zip) {
    return { type: "zip", zip };
  }

  const latStr = params.get("lat");
  const lonStr = params.get("lon");
  if (latStr === null || lonStr === null) return null;

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;

  return { type: "coords", latitude: lat, longitude: lon };
}
