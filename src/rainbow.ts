/**
 * Rainbow condition detection.
 *
 * A rainbow is visible from the ground when all of the following hold:
 *
 * 1. Water droplets are in the air — it is raining at the location, or rain
 *    has just ended (droplets linger and showers move off nearby).
 * 2. Direct sunlight reaches those droplets — the sky can't be fully
 *    overcast; there must be breaks in the cloud for the sun to shine
 *    through (the classic "sun shower" setup).
 * 3. The sun is above the horizon (daylight).
 * 4. The sun is low enough in the sky. A primary rainbow forms a circle of
 *    ~42° angular radius centred on the antisolar point, so when the sun is
 *    higher than ~42° above the horizon the entire arc lies below the
 *    horizon and cannot be seen from ground level. This is why rainbows
 *    appear in the morning or late afternoon, never around a summer midday.
 *
 * A fifth condition — the observer standing between the sun and the rain —
 * depends on geometry that a single-point forecast can't resolve, so rain
 * at the forecast location is used as the proxy for nearby droplets.
 */

import type { ForecastData } from "./types.js";
import { solarElevation } from "./solar.js";

/** Maximum solar elevation (degrees) at which a primary rainbow's arc is
 *  still above the horizon for a ground-level observer */
export const MAX_RAINBOW_SUN_ELEVATION = 42;

/** Minimum median rain rate (mm/hr) that counts as droplets in the air */
export const RAINBOW_RAIN_THRESHOLD = 0.1;

/** Maximum median cloud cover fraction that still allows direct sunlight
 *  to break through and illuminate the rain */
export const RAINBOW_MAX_CLOUD_COVER = 0.7;

/** A contiguous stretch of forecast timesteps where a rainbow is possible */
export interface RainbowWindow {
  /** ISO timestamp of the first qualifying timestep */
  startTime: string;
  /** Milliseconds timestamp of the first qualifying timestep */
  startMs: number;
  /** Milliseconds timestamp of the last qualifying timestep */
  endMs: number;
  /** Hours from now of the first qualifying timestep */
  hoursFromNow: number;
}

/**
 * Scan a forecast for timesteps where rainbow conditions are met: rain
 * falling now or in the previous timestep, cloud cover broken enough for
 * direct sun, and the sun above the horizon but no higher than 42°.
 * Consecutive qualifying timesteps are merged into a single window.
 */
export function detectRainbowWindows(
  forecast: Pick<ForecastData, "location" | "precipitation" | "cloudCover">,
): RainbowWindow[] {
  const { location, precipitation, cloudCover } = forecast;

  // Cloud cover lives on the same timesteps as precipitation, but look it
  // up by timestamp so partially loaded or misaligned series stay safe
  const cloudByTime = new Map<string, number>();
  for (const p of cloudCover) cloudByTime.set(p.time, p.median);

  const windows: RainbowWindow[] = [];
  let prevQualified = false;

  for (let i = 0; i < precipitation.length; i++) {
    const point = precipitation[i]!;

    const rainingNow = point.median >= RAINBOW_RAIN_THRESHOLD;
    const rainJustEnded = i > 0 && precipitation[i - 1]!.median >= RAINBOW_RAIN_THRESHOLD;
    const droplets = rainingNow || rainJustEnded;

    const cloud = cloudByTime.get(point.time);
    const sunlight = cloud !== undefined && cloud <= RAINBOW_MAX_CLOUD_COVER;

    const timeMs = new Date(point.time).getTime();
    const elevation = solarElevation(timeMs, location.latitude, location.longitude);
    const sunLowEnough = elevation > 0 && elevation <= MAX_RAINBOW_SUN_ELEVATION;

    const qualifies = droplets && sunlight && sunLowEnough;
    if (qualifies) {
      if (prevQualified) {
        windows[windows.length - 1]!.endMs = timeMs;
      } else {
        windows.push({
          startTime: point.time,
          startMs: timeMs,
          endMs: timeMs,
          hoursFromNow: point.hoursFromNow,
        });
      }
    }
    prevQualified = qualifies;
  }

  return windows;
}
