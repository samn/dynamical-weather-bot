import type { ForecastData, Aberration } from "./types.js";
import { type UnitSystem, formatTemp, msToMph } from "./units.js";

/** Clamp a value to [0, 1] */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Threshold for high precipitation (mm/hr) */
const PRECIP_HIGH_THRESHOLD = 2;

/** Threshold for very high wind (m/s) */
const WIND_HIGH_THRESHOLD = 10;

/** Threshold for significant cloud cover change within forecast (fraction 0-1) */
const CLOUD_CHANGE_THRESHOLD = 0.3;

/**
 * Detect notable weather aberrations based solely on the forecast data shown
 * on the charts. All aberrations reference values visible on the graphs so
 * users can see what the alert is describing.
 */
export function detectAberrations(
  forecast: ForecastData,
  units: UnitSystem = "metric",
): Aberration[] {
  const aberrations: Aberration[] = [];

  // Check for extreme temperature swings within the forecast (using median,
  // which is the most visible line on the chart)
  if (forecast.temperature.length > 0) {
    const medians = forecast.temperature.map((p) => p.median);
    const maxMedianTemp = Math.max(...medians);
    const minMedianTemp = Math.min(...medians);
    const tempRange = maxMedianTemp - minMedianTemp;
    if (tempRange > 15) {
      const minIndex = forecast.temperature.findIndex((p) => p.median === minMedianTemp);
      const maxIndex = forecast.temperature.findIndex((p) => p.median === maxMedianTemp);
      const firstTemp = minIndex <= maxIndex ? minMedianTemp : maxMedianTemp;
      const secondTemp = minIndex <= maxIndex ? maxMedianTemp : minMedianTemp;
      aberrations.push({
        type: "danger",
        icon: "\u{1F321}\u{FE0F}",
        message: `Large temperature swing expected: ${formatTemp(firstTemp, units)} to ${formatTemp(secondTemp, units)}`,
      });
    }
  }

  // Analyze precipitation
  if (forecast.precipitation.length > 0) {
    const forecastPrecip = forecast.precipitation.map((p) => p.median);
    const maxPrecipP90 = Math.max(...forecast.precipitation.map((p) => p.p90));
    const avgForecastPrecip = average(forecastPrecip);

    const imperial = units === "imperial";
    const fmtPrecip = (v: number) =>
      imperial ? `${(v / 25.4).toFixed(2)} in/hr` : `${v.toFixed(1)} mm/hr`;

    if (avgForecastPrecip > PRECIP_HIGH_THRESHOLD) {
      aberrations.push({
        type: "rain",
        icon: "\u{1F327}\u{FE0F}",
        message: `Persistent precipitation expected: avg ${fmtPrecip(avgForecastPrecip)}`,
      });
    } else if (maxPrecipP90 > PRECIP_HIGH_THRESHOLD) {
      aberrations.push({
        type: "rain",
        icon: "\u{1F327}\u{FE0F}",
        message: `Heavy rain possible: up to ${fmtPrecip(maxPrecipP90)} (90th percentile)`,
      });
    }
  }

  // Analyze wind
  if (forecast.windSpeed.length > 0) {
    const maxWindP90 = Math.max(...forecast.windSpeed.map((p) => p.p90));
    const imperial = units === "imperial";
    const fmtWind = (v: number) =>
      imperial ? `${msToMph(v).toFixed(0)} mph` : `${v.toFixed(1)} m/s`;
    if (maxWindP90 > WIND_HIGH_THRESHOLD) {
      aberrations.push({
        type: "danger",
        icon: "\u{1F32C}\u{FE0F}",
        message: `Strong winds expected: gusts up to ${fmtWind(maxWindP90)}`,
      });
    }
  }

  // Analyze cloud cover trends within the forecast window
  if (forecast.cloudCover.length >= 4) {
    const half = Math.floor(forecast.cloudCover.length / 2);
    const earlyCloud = clamp01(average(forecast.cloudCover.slice(0, half).map((p) => p.median)));
    const lateCloud = clamp01(average(forecast.cloudCover.slice(half).map((p) => p.median)));
    const cloudDiff = lateCloud - earlyCloud;

    if (cloudDiff < -CLOUD_CHANGE_THRESHOLD) {
      aberrations.push({
        type: "warm",
        icon: "\u{2600}\u{FE0F}",
        message: `Clearing skies ahead: cloud cover dropping from ${(earlyCloud * 100).toFixed(0)}% to ${(lateCloud * 100).toFixed(0)}%`,
      });
    } else if (cloudDiff > CLOUD_CHANGE_THRESHOLD) {
      aberrations.push({
        type: "cool",
        icon: "\u{2601}\u{FE0F}",
        message: `Increasing cloud cover: from ${(earlyCloud * 100).toFixed(0)}% to ${(lateCloud * 100).toFixed(0)}%`,
      });
    }
  }

  return aberrations;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
