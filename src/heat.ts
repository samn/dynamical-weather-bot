import type { ForecastPoint } from "./types.js";
import { heatIndex, indexByHour, relativeHumidityFromDewPoint } from "./humidity.js";

/**
 * Wet-bulb temperature (°C) from air temperature (°C) and relative humidity
 * (%), using Stull's (2011) empirical approximation of the psychrometric
 * relation. Accurate to within a few tenths of a degree over the range that
 * matters for heat safety.
 *
 * The wet-bulb temperature is the lowest temperature reachable by
 * evaporative cooling, so it is the physical limit on how much sweating can
 * cool a body. Unlike the heat index it is defined without reference to
 * human physiology, which makes it the standard measure for "is this heat
 * survivable" thresholds.
 *
 * Stull's fit is defined for relative humidities of 5-99%; inputs are
 * clamped to that range (very dry air is far from any warning threshold, so
 * the clamp never affects a warning).
 */
export function wetBulbTemperature(tempC: number, rhPct: number): number {
  const rh = Math.max(5, Math.min(99, rhPct));
  return (
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/** Shared shape of a heat risk band */
interface HeatBand {
  /** Whether this band is severe enough to warrant a user-facing warning */
  warn: boolean;
  label: string;
  icon: string;
  /** Short guidance appended to the warning message */
  advice: string;
}

/** Wet-bulb risk levels, ordered from harmless to lethal */
export type WetBulbLevel = "safe" | "elevated" | "dangerous" | "extreme" | "unsurvivable";

/** A wet-bulb risk assessment for a single wet-bulb temperature */
export interface WetBulbRisk extends HeatBand {
  level: WetBulbLevel;
}

/**
 * Wet-bulb bands keyed by their inclusive lower bound (°C). 35°C is the
 * theoretical limit of human thermoregulation — a body at rest in the shade
 * can no longer shed metabolic heat — while sustained labour becomes
 * dangerous well below that, which is why the warning bar sits at 28°C.
 */
const WET_BULB_BANDS: Array<{ min: number } & WetBulbRisk> = [
  {
    min: 35,
    level: "unsurvivable",
    warn: true,
    label: "Unsurvivable wet-bulb heat",
    icon: "\u{2620}\u{FE0F}",
    advice: "the body cannot shed heat even at rest; air conditioning is essential",
  },
  {
    min: 32,
    level: "extreme",
    warn: true,
    label: "Extreme wet-bulb heat",
    icon: "\u{1F975}",
    advice: "even brief exertion is dangerous; stay in cooled air",
  },
  {
    min: 28,
    level: "dangerous",
    warn: true,
    label: "Dangerous wet-bulb heat",
    icon: "\u{1F975}",
    advice: "sweat barely evaporates; avoid sustained outdoor work",
  },
  {
    min: 25,
    level: "elevated",
    warn: false,
    label: "Elevated wet-bulb heat",
    icon: "\u{1F4A6}",
    advice: "take breaks during heavy exertion",
  },
  {
    min: -Infinity,
    level: "safe",
    warn: false,
    label: "Safe wet-bulb heat",
    icon: "\u{1F4A6}",
    advice: "",
  },
];

/** Classify a wet-bulb temperature (°C) into a heat-stress risk band. */
export function wetBulbRisk(wetBulbC: number): WetBulbRisk {
  const band = WET_BULB_BANDS.find((b) => wetBulbC >= b.min)!;
  return {
    level: band.level,
    warn: band.warn,
    label: band.label,
    icon: band.icon,
    advice: band.advice,
  };
}

/** NWS heat index risk levels, ordered from mild to lethal */
export type HeatIndexLevel = "none" | "caution" | "extreme-caution" | "danger" | "extreme-danger";

/** A heat-index risk assessment for a single apparent temperature */
export interface HeatIndexRisk extends HeatBand {
  level: HeatIndexLevel;
}

/**
 * NWS heat index bands keyed by their inclusive lower bound (°C). The bounds
 * are the National Weather Service's published categories, converted from
 * °F: 80, 90, 103 and 125°F. Only "Danger" and above are worth interrupting
 * the user for — an "extreme caution" heat index is an ordinary summer
 * afternoon across much of the world.
 */
const HEAT_INDEX_BANDS: Array<{ min: number } & HeatIndexRisk> = [
  {
    min: 51.7,
    level: "extreme-danger",
    warn: true,
    label: "Extreme heat danger",
    icon: "\u{1F525}",
    advice: "heat stroke is imminent with any exposure",
  },
  {
    min: 39.4,
    level: "danger",
    warn: true,
    label: "Extreme heat",
    icon: "\u{1F525}",
    advice: "heat exhaustion likely with prolonged exposure or exertion",
  },
  {
    min: 32.2,
    level: "extreme-caution",
    warn: false,
    label: "Heat caution",
    icon: "\u{1F321}\u{FE0F}",
    advice: "heat cramps possible with prolonged exertion",
  },
  {
    min: 26.7,
    level: "caution",
    warn: false,
    label: "Mild heat",
    icon: "\u{1F321}\u{FE0F}",
    advice: "fatigue possible with prolonged exposure",
  },
  {
    min: -Infinity,
    level: "none",
    warn: false,
    label: "No heat risk",
    icon: "\u{1F321}\u{FE0F}",
    advice: "",
  },
];

/** Classify an NWS heat index (°C) into its risk band. */
export function heatIndexRisk(heatIndexC: number): HeatIndexRisk {
  const band = HEAT_INDEX_BANDS.find((b) => heatIndexC >= b.min)!;
  return {
    level: band.level,
    warn: band.warn,
    label: band.label,
    icon: band.icon,
    advice: band.advice,
  };
}

/** Heat metrics for a single forecast timestep */
export interface HeatPoint {
  /** ISO timestamp, copied from the temperature series */
  time: string;
  /** Hours from now (negative for timesteps already past) */
  hoursFromNow: number;
  /** Ensemble median air temperature (°C) */
  tempC: number;
  /** Ensemble median dew point (°C) */
  dewPointC: number;
  /** Relative humidity (%) implied by the median temperature and dew point */
  relativeHumidity: number;
  /** NWS heat index (°C) at the median temperature */
  heatIndexC: number;
  /** Wet-bulb temperature (°C) at the median temperature */
  wetBulbC: number;
  /** Heat index (°C) at the 90th-percentile temperature */
  heatIndexP90C: number;
  /** Wet-bulb temperature (°C) at the 90th-percentile temperature */
  wetBulbP90C: number;
}

/**
 * Build a heat-metric series aligned to the temperature series.
 *
 * Both metrics need humidity, so timesteps without a matching dew point
 * (matched by rounded hoursFromNow, as in `computeFeelsLike`) are dropped.
 *
 * The p90 variants raise the air temperature to the 90th percentile while
 * holding the dew point at its median — that is the physically consistent
 * reading of "the warmest ensemble members"; pairing the p90 temperature
 * with a p90 dew point would compound two independent upper bounds. The p90
 * metrics are floored at their median counterparts as a guard against the
 * small non-monotonicity at the heat index's 80°F escalation threshold, so
 * "up to <p90>" is always a true upper bound.
 */
export function computeHeatSeries(
  temperature: ForecastPoint[],
  dewPoint: ForecastPoint[] | undefined,
): HeatPoint[] {
  if (!dewPoint || dewPoint.length === 0) return [];
  const dewByHour = indexByHour(dewPoint);

  const points: HeatPoint[] = [];
  for (const t of temperature) {
    const dp = dewByHour.get(Math.round(t.hoursFromNow));
    if (!dp) continue;
    const rh = relativeHumidityFromDewPoint(t.median, dp.median);
    const rhP90 = relativeHumidityFromDewPoint(t.p90, dp.median);
    const heatIndexC = heatIndex(t.median, rh);
    const wetBulbC = wetBulbTemperature(t.median, rh);
    points.push({
      time: t.time,
      hoursFromNow: t.hoursFromNow,
      tempC: t.median,
      dewPointC: dp.median,
      relativeHumidity: rh,
      heatIndexC,
      wetBulbC,
      heatIndexP90C: Math.max(heatIndexC, heatIndex(t.p90, rhP90)),
      wetBulbP90C: Math.max(wetBulbC, wetBulbTemperature(t.p90, rhP90)),
    });
  }
  return points;
}
