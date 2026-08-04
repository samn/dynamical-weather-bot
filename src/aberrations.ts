import type { ForecastData, ForecastPoint, Aberration } from "./types.js";
import { formatDayPart } from "./format.js";
import { detectRainbowWindows } from "./rainbow.js";
import { type UnitSystem, formatTemp, msToMph } from "./units.js";
import { humidityIndex } from "./humidity.js";
import { computeHeatSeries, heatIndexRisk, wetBulbRisk, type HeatPoint } from "./heat.js";

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

/** Length of the forecast horizon the app promises, in hours */
const FORECAST_HORIZON_HOURS = 72;

/**
 * The window of time an alert may talk about: from now until the end of the
 * forecast on screen, as `[startMs, endMs]`.
 *
 * Both bounds matter. Models are initialized hours before the page loads and
 * blending unions their timesteps, so a blended series can start well before
 * "now" — a model initialized last night carries last night's weather. It can
 * also run past the right edge of the charts, since the charts stop at the
 * earliest end shared by every model fetched (`computeCommonTimeRange`) —
 * HRRR only runs 48 hours out, so it pins the window short. Either
 * way the alert would be about weather the user can no longer act on or
 * cannot see.
 *
 * Timestamps are compared against the wall clock rather than each point's
 * `hoursFromNow`, which is frozen at fetch time and goes stale for cached
 * forecasts and long-lived tabs.
 */
function displayedWindow(displayRange: [number, number] | undefined): [number, number] {
  const now = Date.now();
  return [
    Math.max(now, displayRange?.[0] ?? -Infinity),
    Math.min(displayRange?.[1] ?? Infinity, now + FORECAST_HORIZON_HOURS * 60 * 60 * 1000),
  ];
}

/** Narrow every series of a forecast to the timesteps in `[start, end]` */
function withinDisplayedForecast(
  forecast: ForecastData,
  [start, end]: [number, number],
): ForecastData {
  const inWindow = (points: ForecastPoint[]): ForecastPoint[] =>
    points.filter((p) => {
      const t = new Date(p.time).getTime();
      return t >= start && t <= end;
    });

  return {
    ...forecast,
    temperature: inWindow(forecast.temperature),
    precipitation: inWindow(forecast.precipitation),
    windSpeed: inWindow(forecast.windSpeed),
    cloudCover: inWindow(forecast.cloudCover),
    dewPoint: forecast.dewPoint ? inWindow(forecast.dewPoint) : undefined,
  };
}

/**
 * Detect notable weather aberrations based solely on the forecast data shown
 * on the charts. All aberrations reference values visible on the graphs so
 * users can see what the alert is describing.
 *
 * `displayRange` is the `[startMs, endMs]` window the charts are drawn over.
 * Alerts are confined to the upcoming part of it — never about weather that
 * has already happened, and never about timesteps past the right edge of the
 * charts.
 */
export function detectAberrations(
  fullForecast: ForecastData,
  units: UnitSystem = "metric",
  displayRange?: [number, number],
): Aberration[] {
  const window = displayedWindow(displayRange);
  const forecast = withinDisplayedForecast(fullForecast, window);
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
      const firstIndex = Math.min(minIndex, maxIndex);
      const secondIndex = Math.max(minIndex, maxIndex);
      const firstTemp = minIndex <= maxIndex ? minMedianTemp : maxMedianTemp;
      const secondTemp = minIndex <= maxIndex ? maxMedianTemp : minMedianTemp;
      const firstWhen = formatDayPart(forecast.temperature[firstIndex]!.time);
      const secondWhen = formatDayPart(forecast.temperature[secondIndex]!.time);
      aberrations.push({
        type: "danger",
        icon: "\u{1F321}\u{FE0F}",
        message: `Large temperature swing expected: ${formatTemp(firstTemp, units)} (${firstWhen}) to ${formatTemp(secondTemp, units)} (${secondWhen})`,
      });
    }
  }

  // Heat hazards, listed before the softer alerts because they are the only
  // safety-critical ones: the NWS heat index (how hot the air feels to a
  // body) and the wet-bulb temperature (whether sweating can still cool that
  // body at all). Both need humidity, so both are skipped when the forecast
  // has no dew point series.
  aberrations.push(...detectHeatHazards(forecast, units));

  // Highlight humidity anomalies from the forecast dew point. Dew point is
  // the best single-number proxy for how muggy the air feels, so we flag
  // when it peaks into an oppressive/miserable comfort band.
  if (forecast.dewPoint && forecast.dewPoint.length > 0) {
    const dewMedians = forecast.dewPoint.map((p) => p.median);
    const maxDew = Math.max(...dewMedians);
    const index = humidityIndex(maxDew);
    if (index.level === "oppressive" || index.level === "miserable") {
      const peak = forecast.dewPoint.find((p) => p.median === maxDew)!;
      aberrations.push({
        type: "humid",
        icon: index.icon,
        message: `${index.label} humidity ${formatDayPart(peak.time)}: dew point up to ${formatTemp(maxDew, units)}`,
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
      const peak = forecast.precipitation.find((p) => p.p90 === maxPrecipP90)!;
      aberrations.push({
        type: "rain",
        icon: "\u{1F327}\u{FE0F}",
        message: `Heavy rain possible ${formatDayPart(peak.time)}: up to ${fmtPrecip(maxPrecipP90)} (90th percentile)`,
      });
    }
  }

  // Rainbow conditions: sunlit rain with the sun above the horizon but no
  // higher than 42° (see rainbow.ts for the physics).
  //
  // Scanned over the full series, not the narrowed one: a timestep qualifies
  // partly on the *previous* timestep's rain ("droplets linger"), so clipping
  // the series at the window start would blind the first timestep to rain
  // that just ended and silently drop the alert — while the rainbow icons on
  // the precipitation chart, which are detected from the full forecast, still
  // showed it. Windows are instead kept when they overlap the window, which
  // also catches one already under way.
  const [windowStart, windowEnd] = window;
  const rainbowWindow = detectRainbowWindows(fullForecast).find(
    (w) => w.endMs >= windowStart && w.startMs <= windowEnd,
  );
  if (rainbowWindow) {
    // A window that is already under way opened before the alert window did,
    // and every timestep in it qualifies, so name one that hasn't passed
    const when = Math.max(rainbowWindow.startMs, windowStart);
    aberrations.push({
      type: "rainbow",
      icon: "\u{1F308}",
      message: `Rainbow possible ${formatDayPart(new Date(when))}: rain with sun breaking through low in the sky`,
    });
  }

  // Analyze wind
  if (forecast.windSpeed.length > 0) {
    const maxWindP90 = Math.max(...forecast.windSpeed.map((p) => p.p90));
    const imperial = units === "imperial";
    const fmtWind = (v: number) =>
      imperial ? `${msToMph(v).toFixed(0)} mph` : `${v.toFixed(1)} m/s`;
    if (maxWindP90 > WIND_HIGH_THRESHOLD) {
      const peak = forecast.windSpeed.find((p) => p.p90 === maxWindP90)!;
      aberrations.push({
        type: "danger",
        icon: "\u{1F32C}\u{FE0F}",
        message: `Strong winds expected ${formatDayPart(peak.time)}: gusts up to ${fmtWind(maxWindP90)}`,
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

/**
 * Warnings for extreme heat and dangerous wet-bulb temperatures.
 *
 * Each hazard is reported at most once, from its peak in the forecast. When
 * the ensemble median already crosses a warning band the alert is stated
 * plainly; when only the 90th-percentile temperature crosses it the alert is
 * hedged as "possible", matching how the heavy-rain and wind alerts talk
 * about the upper tail of the ensemble.
 *
 * Takes a forecast already narrowed to the displayed window, so the peaks it
 * reports are upcoming and on screen.
 */
function detectHeatHazards(forecast: ForecastData, units: UnitSystem): Aberration[] {
  const heat = computeHeatSeries(forecast.temperature, forecast.dewPoint);
  if (heat.length === 0) return [];

  const aberrations: Aberration[] = [];
  const context = (p: HeatPoint) =>
    `(air ${formatTemp(p.tempC, units)}, dew point ${formatTemp(p.dewPointC, units)})`;

  // Wet bulb leads: it is the more severe hazard, and it can be dangerous at
  // air temperatures that look unremarkable on the temperature chart.
  const wetBulbPeak = maxBy(heat, (p) => p.wetBulbC);
  const wetBulb = wetBulbRisk(wetBulbPeak.wetBulbC);
  if (wetBulb.warn) {
    aberrations.push({
      type: "heat",
      icon: wetBulb.icon,
      message: `${wetBulb.label} ${formatDayPart(wetBulbPeak.time)}: wet bulb ${formatTemp(wetBulbPeak.wetBulbC, units)} ${context(wetBulbPeak)} — ${wetBulb.advice}`,
    });
  } else {
    const peak = maxBy(heat, (p) => p.wetBulbP90C);
    const risk = wetBulbRisk(peak.wetBulbP90C);
    if (risk.warn) {
      aberrations.push({
        type: "heat",
        icon: risk.icon,
        message: `${risk.label} possible ${formatDayPart(peak.time)}: wet bulb up to ${formatTemp(peak.wetBulbP90C, units)} in the warmest ensemble members — ${risk.advice}`,
      });
    }
  }

  const heatIndexPeak = maxBy(heat, (p) => p.heatIndexC);
  const heatIndex = heatIndexRisk(heatIndexPeak.heatIndexC);
  if (heatIndex.warn) {
    aberrations.push({
      type: "heat",
      icon: heatIndex.icon,
      message: `${heatIndex.label} ${formatDayPart(heatIndexPeak.time)}: heat index ${formatTemp(heatIndexPeak.heatIndexC, units)} ${context(heatIndexPeak)} — ${heatIndex.advice}`,
    });
  } else {
    const peak = maxBy(heat, (p) => p.heatIndexP90C);
    const risk = heatIndexRisk(peak.heatIndexP90C);
    if (risk.warn) {
      aberrations.push({
        type: "heat",
        icon: risk.icon,
        message: `${risk.label} possible ${formatDayPart(peak.time)}: heat index up to ${formatTemp(peak.heatIndexP90C, units)} in the warmest ensemble members — ${risk.advice}`,
      });
    }
  }

  return aberrations;
}

/** The element of a non-empty list with the largest score */
function maxBy<T>(items: T[], score: (item: T) => number): T {
  return items.reduce((best, item) => (score(item) > score(best) ? item : best), items[0]!);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
