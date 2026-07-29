import type { ForecastPoint } from "./types.js";
import { celsiusToFahrenheit } from "./units.js";

/** Magnus-Tetens coefficients (over water) */
const MAGNUS_B = 17.625;
const MAGNUS_C = 243.04;

/**
 * Dew point (°C) from air temperature (°C) and relative humidity (%),
 * using the Magnus-Tetens approximation. GEFS reports relative humidity
 * rather than dew point, so we derive dew point from it.
 */
export function dewPointFromRelativeHumidity(tempC: number, rhPct: number): number {
  const rh = Math.max(1e-6, Math.min(100, rhPct)) / 100;
  const gamma = Math.log(rh) + (MAGNUS_B * tempC) / (MAGNUS_C + tempC);
  return (MAGNUS_C * gamma) / (MAGNUS_B - gamma);
}

/**
 * Relative humidity (%) from air temperature (°C) and dew point (°C).
 * Inverse of {@link dewPointFromRelativeHumidity}; used to feed the
 * heat-index formula, which is defined in terms of relative humidity.
 */
export function relativeHumidityFromDewPoint(tempC: number, dewPointC: number): number {
  const gammaDew = (MAGNUS_B * dewPointC) / (MAGNUS_C + dewPointC);
  const gammaTemp = (MAGNUS_B * tempC) / (MAGNUS_C + tempC);
  return 100 * Math.exp(gammaDew - gammaTemp);
}

/**
 * NWS heat index (apparent temperature, °C) from air temperature (°C) and
 * relative humidity (%), using the Rothfusz regression with the standard
 * low/high-humidity adjustments. Inputs are converted to °F internally.
 */
export function heatIndex(tempC: number, rhPct: number): number {
  const t = celsiusToFahrenheit(tempC);
  const r = rhPct;

  // Simple formula first; only escalate to the full regression when it
  // indicates a heat index at or above 80°F (per the NWS procedure).
  const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + r * 0.094);
  if ((simple + t) / 2 < 80) {
    return fahrenheitToCelsius(simple);
  }

  let hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * r -
    0.22475541 * t * r -
    0.00683783 * t * t -
    0.05481717 * r * r +
    0.00122874 * t * t * r +
    0.00085282 * t * r * r -
    0.00000199 * t * t * r * r;

  if (r < 13 && t >= 80 && t <= 112) {
    hi -= ((13 - r) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  } else if (r > 85 && t >= 80 && t <= 87) {
    hi += ((r - 85) / 10) * ((87 - t) / 5);
  }

  return fahrenheitToCelsius(hi);
}

/**
 * NWS wind chill (apparent temperature, °C) from air temperature (°C) and
 * wind speed (m/s). Inputs are converted to °F and mph internally.
 */
export function windChill(tempC: number, windMs: number): number {
  const t = celsiusToFahrenheit(tempC);
  const v = windMs * 2.23694; // m/s → mph
  const vp = Math.pow(v, 0.16);
  const wc = 35.74 + 0.6215 * t - 35.75 * vp + 0.4275 * t * vp;
  return fahrenheitToCelsius(wc);
}

/** Air temperature at/above which the heat index is meaningful (26.7°C ≈ 80°F) */
const HEAT_THRESHOLD_C = 26.7;
/** Air temperature at/below which wind chill is meaningful (10°C ≈ 50°F) */
const CHILL_THRESHOLD_C = 10;
/** Wind speed above which wind chill is meaningful (~3 mph) */
const CHILL_WIND_MIN_MS = 1.34;

/**
 * Apparent "feels like" temperature (°C) combining the heat index (hot and
 * humid) and wind chill (cold and windy), falling back to the actual air
 * temperature in mild conditions.
 */
export function feelsLike(tempC: number, dewPointC: number, windMs: number): number {
  if (tempC >= HEAT_THRESHOLD_C) {
    return heatIndex(tempC, relativeHumidityFromDewPoint(tempC, dewPointC));
  }
  if (tempC <= CHILL_THRESHOLD_C && windMs > CHILL_WIND_MIN_MS) {
    return windChill(tempC, windMs);
  }
  return tempC;
}

/** Dew-point comfort level — the humidity index shown to the user */
export type HumidityLevel = "dry" | "comfortable" | "sticky" | "humid" | "oppressive" | "miserable";

/** A humidity index reading derived from the dew point */
export interface HumidityIndex {
  level: HumidityLevel;
  label: string;
  icon: string;
}

/** Ordered comfort bands keyed by their inclusive lower dew-point bound (°C) */
const HUMIDITY_BANDS: Array<{ min: number; level: HumidityLevel; label: string; icon: string }> = [
  { min: 24, level: "miserable", label: "Miserable", icon: "\u{1FAE0}" },
  { min: 21, level: "oppressive", label: "Oppressive", icon: "\u{1F975}" },
  { min: 18, level: "humid", label: "Humid", icon: "\u{1F4A6}" },
  { min: 16, level: "sticky", label: "Sticky", icon: "\u{1F613}" },
  { min: 10, level: "comfortable", label: "Comfortable", icon: "\u{1F642}" },
  { min: -Infinity, level: "dry", label: "Dry", icon: "\u{1F3DC}\u{FE0F}" },
];

/**
 * Classify a dew point (°C) into a human comfort level. Dew point is the
 * best single-number proxy for how humid the air feels, independent of
 * temperature.
 */
export function humidityIndex(dewPointC: number): HumidityIndex {
  const band = HUMIDITY_BANDS.find((b) => dewPointC >= b.min)!;
  return { level: band.level, label: band.label, icon: band.icon };
}

/**
 * Build a "feels like" forecast series aligned to the temperature series.
 *
 * Each temperature quantile (min, p10, median, p90, max) is mapped through
 * {@link feelsLike} at the *median* dew point and wind speed for that
 * timestep (matched by rounded hoursFromNow). Holding humidity and wind
 * fixed keeps the transform monotonic in temperature, so the quantile band
 * stays ordered — pairing each temperature quantile with the same-named
 * wind quantile would not, since wind chill decreases with wind speed and
 * the wind distribution is not rank-correlated with temperature, which can
 * invert the shaded band (p10 > p90) or push the median outside it. The
 * mapped values are sorted as a final guard against the small
 * non-monotonicity at the heat-index/wind-chill thresholds.
 *
 * When a matching dew point or wind value is unavailable, the raw
 * temperature statistic is passed through unchanged so the chart still
 * renders.
 */
export function computeFeelsLike(
  temperature: ForecastPoint[],
  dewPoint: ForecastPoint[],
  windSpeed: ForecastPoint[],
): ForecastPoint[] {
  const dewByHour = indexByHour(dewPoint);
  const windByHour = indexByHour(windSpeed);

  return temperature.map((t) => {
    const hour = Math.round(t.hoursFromNow);
    const dp = dewByHour.get(hour);
    const wind = windByHour.get(hour);
    if (!dp || !wind) return { ...t };
    const apparent = (v: number) => feelsLike(v, dp.median, wind.median);
    const sorted = [t.min, t.p10, t.median, t.p90, t.max].map(apparent);
    sorted.sort((a, b) => a - b);
    return {
      time: t.time,
      hoursFromNow: t.hoursFromNow,
      min: sorted[0]!,
      p10: sorted[1]!,
      median: sorted[2]!,
      p90: sorted[3]!,
      max: sorted[4]!,
    };
  });
}

function indexByHour(points: ForecastPoint[]): Map<number, ForecastPoint> {
  const byHour = new Map<number, ForecastPoint>();
  for (const p of points) byHour.set(Math.round(p.hoursFromNow), p);
  return byHour;
}

function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}
