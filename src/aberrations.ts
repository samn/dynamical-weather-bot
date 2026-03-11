import type { ForecastData, RecentWeather, Aberration } from "./types.js";
import { type UnitSystem, formatTemp, msToMph } from "./units.js";

/**
 * Threshold for temperature aberration (degrees C).
 * If the median forecast temperature is this many degrees above/below recent average,
 * it's flagged as an aberration.
 */
const TEMP_THRESHOLD = 5;

/** Threshold for high precipitation (mm/hr) */
const PRECIP_HIGH_THRESHOLD = 2;

/** Threshold for very high wind (m/s) */
const WIND_HIGH_THRESHOLD = 10;

/** Threshold for significant cloud cover change (fraction 0-1) */
const CLOUD_CHANGE_THRESHOLD = 0.3;

/**
 * Detect notable weather aberrations by comparing the forecast to recent conditions.
 * Returns a list of user-facing alerts sorted by severity.
 */
export function detectAberrations(
  forecast: ForecastData,
  recent: RecentWeather,
  units: UnitSystem = "metric",
): Aberration[] {
  const aberrations: Aberration[] = [];

  // Analyze temperature
  const forecastTemps = forecast.temperature.map((p) => p.median);
  const avgForecastTemp = average(forecastTemps);
  const maxForecastTemp = Math.max(...forecast.temperature.map((p) => p.p90));
  const minForecastTemp = Math.min(...forecast.temperature.map((p) => p.p10));
  const tempDiff = avgForecastTemp - recent.avgTemperature;

  if (tempDiff > TEMP_THRESHOLD) {
    aberrations.push({
      type: "warm",
      icon: "\u{2600}\u{FE0F}",
      message: `Significantly warmer than recent days: forecast avg ${formatTemp(avgForecastTemp, units)} vs recent ${formatTemp(recent.avgTemperature, units)}`,
    });
  } else if (tempDiff < -TEMP_THRESHOLD) {
    aberrations.push({
      type: "cool",
      icon: "\u{1F976}",
      message: `Significantly colder than recent days: forecast avg ${formatTemp(avgForecastTemp, units)} vs recent ${formatTemp(recent.avgTemperature, units)}`,
    });
  }

  // Check for extreme temperature swings within the forecast
  const tempRange = maxForecastTemp - minForecastTemp;
  if (tempRange > 15) {
    const minIndex = forecast.temperature.findIndex((p) => p.p10 === minForecastTemp);
    const maxIndex = forecast.temperature.findIndex((p) => p.p90 === maxForecastTemp);
    const firstTemp = minIndex <= maxIndex ? minForecastTemp : maxForecastTemp;
    const secondTemp = minIndex <= maxIndex ? maxForecastTemp : minForecastTemp;
    aberrations.push({
      type: "danger",
      icon: "\u{1F321}\u{FE0F}",
      message: `Large temperature swing expected: ${formatTemp(firstTemp, units)} to ${formatTemp(secondTemp, units)}`,
    });
  }

  // Analyze precipitation
  const forecastPrecip = forecast.precipitation.map((p) => p.median);
  const maxPrecipP90 = Math.max(...forecast.precipitation.map((p) => p.p90));
  const avgForecastPrecip = average(forecastPrecip);

  const imperial = units === "imperial";
  const fmtPrecip = (v: number) =>
    imperial ? `${(v / 25.4).toFixed(2)} in/hr` : `${v.toFixed(1)} mm/hr`;
  const fmtWind = (v: number) =>
    imperial ? `${msToMph(v).toFixed(0)} mph` : `${v.toFixed(1)} m/s`;

  if (maxPrecipP90 > PRECIP_HIGH_THRESHOLD && recent.avgPrecipitation < 0.5) {
    aberrations.push({
      type: "rain",
      icon: "\u{1F327}\u{FE0F}",
      message: `Rain likely after dry conditions: up to ${fmtPrecip(maxPrecipP90)} possible (90th percentile)`,
    });
  } else if (avgForecastPrecip > PRECIP_HIGH_THRESHOLD) {
    aberrations.push({
      type: "rain",
      icon: "\u{1F327}\u{FE0F}",
      message: `Persistent precipitation expected: avg ${fmtPrecip(avgForecastPrecip)}`,
    });
  }

  // Analyze wind
  const maxWindP90 = Math.max(...forecast.windSpeed.map((p) => p.p90));
  if (maxWindP90 > WIND_HIGH_THRESHOLD) {
    aberrations.push({
      type: "danger",
      icon: "\u{1F32C}\u{FE0F}",
      message: `Strong winds expected: gusts up to ${fmtWind(maxWindP90)}`,
    });
  }

  // Analyze cloud cover changes
  const avgForecastCloud = average(forecast.cloudCover.map((p) => p.median));
  const cloudDiff = avgForecastCloud - recent.avgCloudCover;

  if (cloudDiff < -CLOUD_CHANGE_THRESHOLD && recent.avgCloudCover > 0.5) {
    aberrations.push({
      type: "warm",
      icon: "\u{2600}\u{FE0F}",
      message: `Clearing skies ahead: cloud cover dropping from ${(recent.avgCloudCover * 100).toFixed(0)}% to ${(avgForecastCloud * 100).toFixed(0)}%`,
    });
  } else if (cloudDiff > CLOUD_CHANGE_THRESHOLD && recent.avgCloudCover < 0.5) {
    aberrations.push({
      type: "cool",
      icon: "\u{2601}\u{FE0F}",
      message: `Increasing cloud cover: from ${(recent.avgCloudCover * 100).toFixed(0)}% to ${(avgForecastCloud * 100).toFixed(0)}%`,
    });
  }

  return aberrations;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
