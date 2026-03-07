/** Celestial event types rendered as chart markers */
export interface CelestialEvent {
  /** ISO timestamp of the event */
  time: string;
  /** Type of event */
  type: "sunrise" | "sunset" | "moonrise";
  /** Icon/symbol to display */
  icon: string;
}

/** Degrees to radians */
function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Radians to degrees */
function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/**
 * Julian day number from a Date.
 * Uses the standard astronomical formula.
 */
function toJulianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Convert Julian day back to Date */
function jdToDate(j: number): Date {
  return new Date((j - 2440587.5) * 86400000);
}

/**
 * Compute sunrise and sunset for a given date and location using the
 * NOAA simplified solar position algorithm.
 *
 * Returns null if the sun doesn't rise or set (polar regions).
 */
function solarEvents(date: Date, lat: number, lon: number): { sunrise: Date; sunset: Date } | null {
  const jd = toJulianDay(date);
  // Julian century from J2000.0
  const T = (jd - 2451545) / 36525;

  // Solar mean anomaly (degrees)
  const M = (357.5291092 + 35999.0502909 * T) % 360;

  // Equation of centre (degrees)
  const C =
    (1.9146 - 0.004817 * T) * Math.sin(toRad(M)) +
    0.019993 * Math.sin(toRad(2 * M)) +
    0.00029 * Math.sin(toRad(3 * M));

  // Sun's ecliptic longitude
  const lambda = (M + C + 180 + 102.9372) % 360;

  // Obliquity of the ecliptic
  const epsilon = 23.4393 - 0.0000004 * T;

  // Sun's declination
  const sinDec = Math.sin(toRad(epsilon)) * Math.sin(toRad(lambda));
  const decl = toDeg(Math.asin(sinDec));

  // Hour angle for sunrise/sunset (accounting for atmospheric refraction)
  // Standard solar zenith for sunrise/sunset is 90.833 degrees
  const cosHA =
    (Math.cos(toRad(90.833)) - Math.sin(toRad(lat)) * Math.sin(toRad(decl))) /
    (Math.cos(toRad(lat)) * Math.cos(toRad(decl)));

  // No sunrise or sunset (polar day/night)
  if (cosHA < -1 || cosHA > 1) return null;

  const HA = toDeg(Math.acos(cosHA));

  // Solar transit (noon) in days from J2000.0
  const Jnoon =
    2451545 +
    0.0009 +
    (-lon / 360 + Math.round(jd - 2451545 - 0.0009 + lon / 360)) +
    0.0053 * Math.sin(toRad(M)) -
    0.0069 * Math.sin(toRad(2 * lambda));

  // Sunrise and sunset as Julian days
  const Jrise = Jnoon - HA / 360;
  const Jset = Jnoon + HA / 360;

  return { sunrise: jdToDate(Jrise), sunset: jdToDate(Jset) };
}

/**
 * Approximate moonrise time for a given date and location.
 *
 * Uses a simplified approach: compute the moon's position at midnight
 * and find when it crosses the horizon via interpolation across the day.
 */
function moonPosition(jd: number): { ra: number; dec: number } {
  const T = (jd - 2451545) / 36525;

  // Moon's mean longitude (degrees)
  const L0 = (218.3165 + 481267.8813 * T) % 360;
  // Moon's mean anomaly (degrees)
  const M = (134.9634 + 477198.8676 * T) % 360;
  // Moon's mean elongation (degrees)
  const D = (297.8502 + 445267.1115 * T) % 360;

  // Ecliptic longitude
  const lambda =
    L0 +
    6.2894 * Math.sin(toRad(M)) +
    1.274 * Math.sin(toRad(2 * D - M)) +
    0.6583 * Math.sin(toRad(2 * D)) +
    0.2136 * Math.sin(toRad(2 * M)) -
    0.1851 * Math.sin(toRad(D));

  // Ecliptic latitude
  const beta = 5.1283 * Math.sin(toRad(93.272 + 483202.0175 * T));

  // Obliquity
  const epsilon = 23.4393 - 0.0000004 * T;

  // Equatorial coordinates
  const sinLambda = Math.sin(toRad(lambda));
  const cosLambda = Math.cos(toRad(lambda));
  const sinBeta = Math.sin(toRad(beta));
  const cosBeta = Math.cos(toRad(beta));
  const sinEps = Math.sin(toRad(epsilon));
  const cosEps = Math.cos(toRad(epsilon));

  const ra = toDeg(Math.atan2(sinLambda * cosEps - (sinBeta / cosBeta) * sinEps, cosLambda));
  const dec = toDeg(Math.asin(sinBeta * cosEps + cosBeta * sinEps * sinLambda));

  return { ra, dec };
}

/**
 * Find moonrise time for a given date and location.
 * Scans the day in 10-minute increments and finds when the moon crosses
 * above the horizon (altitude goes from negative to positive).
 */
function findMoonrise(date: Date, lat: number, lon: number): Date | null {
  // Start of the UTC day
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const STEP_MS = 10 * 60 * 1000; // 10 minutes
  const STEPS = 144; // 24 hours

  let prevAlt: number | null = null;

  for (let i = 0; i <= STEPS; i++) {
    const t = new Date(dayStart.getTime() + i * STEP_MS);
    const jd = toJulianDay(t);
    const moon = moonPosition(jd);

    // Greenwich sidereal time (degrees)
    const T = (jd - 2451545) / 36525;
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T) % 360;
    const lst = (gmst + lon) % 360;

    // Hour angle
    const ha = lst - moon.ra;

    // Altitude
    const alt = toDeg(
      Math.asin(
        Math.sin(toRad(lat)) * Math.sin(toRad(moon.dec)) +
          Math.cos(toRad(lat)) * Math.cos(toRad(moon.dec)) * Math.cos(toRad(ha)),
      ),
    );

    // Moon "rises" when altitude crosses about -0.833 degrees (accounting for refraction + apparent radius)
    const threshold = -0.833;

    if (prevAlt !== null && prevAlt < threshold && alt >= threshold) {
      // Linear interpolation between previous and current step
      const fraction = (threshold - prevAlt) / (alt - prevAlt);
      const riseTime = new Date(t.getTime() - STEP_MS + fraction * STEP_MS);
      return riseTime;
    }

    prevAlt = alt;
  }

  return null;
}

/**
 * Compute all celestial events (sunrise, sunset, moonrise) that fall within
 * the given time range.
 */
export function getCelestialEvents(
  lat: number,
  lon: number,
  startTime: string,
  endTime: string,
): CelestialEvent[] {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const events: CelestialEvent[] = [];

  // Check each day that overlaps the forecast window.
  // Start one day before to catch events near the start boundary.
  const dayStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1),
  );
  const dayEndMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1);

  for (let d = new Date(dayStart); d.getTime() <= dayEndMs; d = new Date(d.getTime() + 86400000)) {
    const solar = solarEvents(d, lat, lon);
    if (solar) {
      if (solar.sunrise >= start && solar.sunrise <= end) {
        events.push({ time: solar.sunrise.toISOString(), type: "sunrise", icon: "\u2600" });
      }
      if (solar.sunset >= start && solar.sunset <= end) {
        events.push({ time: solar.sunset.toISOString(), type: "sunset", icon: "\u263D" });
      }
    }

    const moonrise = findMoonrise(d, lat, lon);
    if (moonrise && moonrise >= start && moonrise <= end) {
      events.push({ time: moonrise.toISOString(), type: "moonrise", icon: "\u263E" });
    }
  }

  // Sort by time and deduplicate (events near day boundaries)
  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return dedup(events);
}

/** Remove duplicate events that are within 30 minutes of each other */
function dedup(events: CelestialEvent[]): CelestialEvent[] {
  const result: CelestialEvent[] = [];
  for (const ev of events) {
    let last: CelestialEvent | undefined;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i]!.type === ev.type) {
        last = result[i];
        break;
      }
    }
    if (
      !last ||
      Math.abs(new Date(ev.time).getTime() - new Date(last.time).getTime()) > 30 * 60 * 1000
    ) {
      result.push(ev);
    }
  }
  return result;
}
