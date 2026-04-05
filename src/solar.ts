/**
 * Solar position calculations for sunrise and sunset times.
 * Based on NOAA solar calculator equations.
 */

/** A time marker to display on the chart */
export interface TimeMarker {
  /** Timestamp in milliseconds */
  timeMs: number;
  /** Type of marker */
  type: "midnight" | "noon" | "sunrise" | "sunset";
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MS_PER_DAY = 86400000;

/** Julian day number from a Date */
function toJulianDay(date: Date): number {
  return date.getTime() / MS_PER_DAY + 2440587.5;
}

/** Julian century from J2000.0 */
function julianCentury(jd: number): number {
  return (jd - 2451545) / 36525;
}

/** Geometric mean longitude of the sun (degrees) */
function sunMeanLongitude(t: number): number {
  return (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
}

/** Geometric mean anomaly of the sun (degrees) */
function sunMeanAnomaly(t: number): number {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

/** Eccentricity of earth's orbit */
function eccentricity(t: number): number {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

/** Sun's equation of center (degrees) */
function sunEquationOfCenter(t: number): number {
  const m = sunMeanAnomaly(t) * DEG_TO_RAD;
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  );
}

/** Sun's true longitude (degrees) */
function sunTrueLongitude(t: number): number {
  return sunMeanLongitude(t) + sunEquationOfCenter(t);
}

/** Apparent longitude of the sun (degrees) */
function sunApparentLongitude(t: number): number {
  const omega = 125.04 - 1934.136 * t;
  return sunTrueLongitude(t) - 0.00569 - 0.00478 * Math.sin(omega * DEG_TO_RAD);
}

/** Mean obliquity of the ecliptic (degrees) */
function meanObliquity(t: number): number {
  return 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
}

/** Corrected obliquity of the ecliptic (degrees) */
function obliquityCorrection(t: number): number {
  const omega = 125.04 - 1934.136 * t;
  return meanObliquity(t) + 0.00256 * Math.cos(omega * DEG_TO_RAD);
}

/** Solar declination (degrees) */
function solarDeclination(t: number): number {
  const apparentLon = sunApparentLongitude(t) * DEG_TO_RAD;
  const obliq = obliquityCorrection(t) * DEG_TO_RAD;
  return Math.asin(Math.sin(obliq) * Math.sin(apparentLon)) * RAD_TO_DEG;
}

/** Equation of time (minutes) */
function equationOfTime(t: number): number {
  const obliq = obliquityCorrection(t) * DEG_TO_RAD;
  const l0 = sunMeanLongitude(t) * DEG_TO_RAD;
  const e = eccentricity(t);
  const m = sunMeanAnomaly(t) * DEG_TO_RAD;

  const y = Math.tan(obliq / 2) ** 2;
  return (
    4 *
    RAD_TO_DEG *
    (y * Math.sin(2 * l0) -
      2 * e * Math.sin(m) +
      4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * e * e * Math.sin(2 * m))
  );
}

/**
 * Hour angle for sunrise/sunset (degrees).
 * Returns undefined if the sun never rises or sets (polar conditions).
 * Uses standard atmospheric refraction of -0.833 degrees.
 */
function sunriseHourAngle(latitude: number, declination: number): number | undefined {
  const lat = latitude * DEG_TO_RAD;
  const dec = declination * DEG_TO_RAD;
  const zenith = 90.833 * DEG_TO_RAD; // standard refraction

  const cosHA =
    (Math.cos(zenith) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));

  if (cosHA > 1 || cosHA < -1) return undefined; // polar day/night
  return Math.acos(cosHA) * RAD_TO_DEG;
}

/**
 * Compute sunrise and sunset times for a given date and location.
 * Returns times in milliseconds (UTC), or undefined if the sun doesn't
 * rise or set at that location on that date (polar day/night).
 */
export function computeSunTimes(
  date: Date,
  latitude: number,
  longitude: number,
): { sunrise: number; sunset: number } | undefined {
  const jd = toJulianDay(date);
  const t = julianCentury(jd);

  const eqTime = equationOfTime(t);
  const decl = solarDeclination(t);
  const ha = sunriseHourAngle(latitude, decl);

  if (ha === undefined) return undefined;

  // Solar noon in minutes from midnight UTC
  const solarNoonMin = 720 - 4 * longitude - eqTime;

  const sunriseMin = solarNoonMin - ha * 4;
  const sunsetMin = solarNoonMin + ha * 4;

  // Convert to ms from start of the UTC day
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  return {
    sunrise: dayStart + sunriseMin * 60000,
    sunset: dayStart + sunsetMin * 60000,
  };
}

/**
 * Compute all time markers (midnight, noon, sunrise, sunset) that fall
 * within the given time range.
 */
export function computeTimeMarkers(
  startMs: number,
  endMs: number,
  latitude: number,
  longitude: number,
): TimeMarker[] {
  if (endMs <= startMs) return [];

  const markers: TimeMarker[] = [];

  // Approximate local offset from longitude (hours)
  // This gives us "solar" local time to find midnights and noons
  // We use actual UTC midnight/noon since the chart displays local time
  // via the browser's timezone. For midnight/noon we iterate UTC days
  // and place markers at 00:00 and 12:00 UTC of each day.
  // Actually, we want local midnight/noon. Since we don't know the user's
  // timezone in a pure function, we use solar time (longitude-based).
  const offsetMs = (longitude / 15) * 3600000;

  // Find the first local midnight before or at startMs
  const localStart = startMs + offsetMs;
  const dayMs = 86400000;
  const firstLocalMidnight = Math.floor(localStart / dayMs) * dayMs;

  // Iterate days, placing midnight and noon markers
  for (let localMid = firstLocalMidnight; localMid < endMs + offsetMs + dayMs; localMid += dayMs) {
    const utcMidnight = localMid - offsetMs;
    if (utcMidnight > startMs && utcMidnight < endMs) {
      markers.push({ timeMs: utcMidnight, type: "midnight" });
    }

    const utcNoon = localMid + dayMs / 2 - offsetMs;
    if (utcNoon > startMs && utcNoon < endMs) {
      markers.push({ timeMs: utcNoon, type: "noon" });
    }
  }

  // Compute sunrise/sunset for each day in the range
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);

  // Start from a day before to catch sun events that straddle the range
  const firstDay = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() - 1),
  );
  const lastDay = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() + 1),
  );

  for (let d = firstDay.getTime(); d <= lastDay.getTime(); d += dayMs) {
    const day = new Date(d);
    const sun = computeSunTimes(day, latitude, longitude);
    if (!sun) continue;

    if (sun.sunrise > startMs && sun.sunrise < endMs) {
      markers.push({ timeMs: sun.sunrise, type: "sunrise" });
    }
    if (sun.sunset > startMs && sun.sunset < endMs) {
      markers.push({ timeMs: sun.sunset, type: "sunset" });
    }
  }

  markers.sort((a, b) => a.timeMs - b.timeMs);
  return markers;
}
