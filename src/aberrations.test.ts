import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectAberrations } from "./aberrations.js";
import { formatDayPart } from "./format.js";
import { solarElevation } from "./solar.js";
import type { ForecastData, ForecastPoint } from "./types.js";

/** Local-time base so day-part assertions are timezone-independent. Alerts
 *  are confined to the upcoming forecast, so the clock is pinned here too and
 *  `hoursFromNow` in these fixtures is genuinely hours from "now". */
const BASE_TIME = new Date(2026, 2, 4, 0, 0, 0);

/** ISO timestamp for a given number of hours after the local base time */
function pointTime(hoursFromNow: number): string {
  return new Date(BASE_TIME.getTime() + hoursFromNow * 3600_000).toISOString();
}

function makePoint(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: pointTime(overrides.hoursFromNow ?? 0),
    hoursFromNow: 0,
    median: 20,
    p10: 18,
    p90: 22,
    min: 16,
    max: 24,
    ...overrides,
  };
}

function makeForecast(overrides: Partial<ForecastData> = {}): ForecastData {
  const defaultPoints = Array.from({ length: 24 }, (_, i) => makePoint({ hoursFromNow: i * 3 }));
  return {
    location: { latitude: 40, longitude: -74 },
    initTime: "2026-03-04T00:00:00.000Z",
    temperature: defaultPoints,
    precipitation: defaultPoints.map((p) => ({ ...p, median: 0, p10: 0, p90: 0, min: 0, max: 0 })),
    windSpeed: defaultPoints.map((p) => ({ ...p, median: 3, p10: 2, p90: 5, min: 1, max: 6 })),
    cloudCover: defaultPoints.map((p) => ({
      ...p,
      median: 0.5,
      p10: 0.3,
      p90: 0.7,
      min: 0.2,
      max: 0.8,
    })),
    ...overrides,
  };
}

describe("detectAberrations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles empty forecast arrays without crashing", () => {
    const forecast = makeForecast({
      temperature: [],
      precipitation: [],
      windSpeed: [],
      cloudCover: [],
    });
    expect(() => detectAberrations(forecast)).not.toThrow();
  });

  it("returns empty array when forecast is mild and steady", () => {
    const result = detectAberrations(makeForecast());
    expect(result).toEqual([]);
  });

  describe("displayed forecast window", () => {
    /** A forecast whose only notable weather is an oppressive dew point at
     *  one timestep, placed `hours` from now */
    function makeSpikeForecast(hours: number): ForecastData {
      const comfortable = Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 10, p10: 8, p90: 12, min: 6, max: 14, hoursFromNow: i * 3 }),
      );
      const spike = makePoint({
        median: 25,
        p10: 23,
        p90: 26,
        min: 22,
        max: 27,
        hoursFromNow: hours,
      });
      return makeForecast({
        dewPoint: [
          ...comfortable.filter((p) => p.hoursFromNow < hours),
          spike,
          ...comfortable.filter((p) => p.hoursFromNow > hours),
        ],
      });
    }

    it("ignores timesteps before now, which blended models carry from earlier init times", () => {
      // A model initialized last night contributes a muggy evening that has
      // already happened — off the left of the charts, and over with.
      const result = detectAberrations(makeSpikeForecast(-28));
      expect(result.some((a) => a.type === "humid")).toBe(false);
    });

    it("ignores timesteps past the end of the displayed range", () => {
      const forecast = makeSpikeForecast(60);
      // Charts stop at +36h (the earliest end shared by the enabled models)
      const displayed = detectAberrations(forecast, "metric", [
        BASE_TIME.getTime(),
        BASE_TIME.getTime() + 36 * 3600_000,
      ]);
      expect(displayed.some((a) => a.type === "humid")).toBe(false);

      // Same forecast charted all the way out: now it is on screen
      const full = detectAberrations(forecast, "metric", [
        BASE_TIME.getTime(),
        BASE_TIME.getTime() + 72 * 3600_000,
      ]);
      expect(full.some((a) => a.type === "humid")).toBe(true);
    });

    it("never looks past 72 hours out when no displayed range is given", () => {
      expect(detectAberrations(makeSpikeForecast(90)).some((a) => a.type === "humid")).toBe(false);
      expect(detectAberrations(makeSpikeForecast(60)).some((a) => a.type === "humid")).toBe(true);
    });

    it("measures temperature swings only across the displayed window", () => {
      // Bitterly cold before the window opens, mild throughout it
      const forecast = makeForecast({
        temperature: Array.from({ length: 32 }, (_, i) =>
          makePoint({
            median: i < 8 ? -5 : 20,
            p10: i < 8 ? -7 : 18,
            p90: i < 8 ? -3 : 22,
            min: -8,
            max: 24,
            hoursFromNow: (i - 8) * 3,
          }),
        ),
      });
      expect(detectAberrations(forecast).some((a) => a.message.includes("swing"))).toBe(false);
    });
  });

  it("detects large temperature swings in chronological order (cold first)", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 5 : 30,
          p10: i < 12 ? 3 : 28,
          p90: i < 12 ? 7 : 32,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const swing = result.find((a) => a.message.includes("swing"));
    expect(swing).toBeDefined();
    // Median 5°C occurs first chronologically, so message should show cold→warm,
    // each endpoint annotated with when it occurs
    expect(swing!.message).toContain(`5.0°C (${formatDayPart(pointTime(0))})`);
    expect(swing!.message).toContain(`to 30.0°C (${formatDayPart(pointTime(36))})`);
  });

  it("detects large temperature swings in chronological order (warm first)", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 30 : 5,
          p10: i < 12 ? 28 : 3,
          p90: i < 12 ? 32 : 7,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const swing = result.find((a) => a.message.includes("swing"));
    expect(swing).toBeDefined();
    // Median 30°C occurs first chronologically, so message should show warm→cold
    expect(swing!.message).toContain(`30.0°C (${formatDayPart(pointTime(0))})`);
    expect(swing!.message).toContain(`to 5.0°C (${formatDayPart(pointTime(36))})`);
  });

  it("does not flag temperature swing when range is small", () => {
    const result = detectAberrations(makeForecast());
    expect(result.some((a) => a.message.includes("swing"))).toBe(false);
  });

  it("detects heavy rain possible (p90 spike) with timing of the peak", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: 0.5,
          p10: 0,
          p90: i === 10 ? 3 : 1,
          min: 0,
          max: 5,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const rain = result.find((a) => a.type === "rain");
    expect(rain).toBeDefined();
    expect(rain!.message).toContain(`Heavy rain possible ${formatDayPart(pointTime(30))}`);
  });

  it("flags a possible rainbow when rain coincides with a low, visible sun", () => {
    const forecast = makeForecast();
    // Pick a timestep where the sun is up but below the 42° rainbow limit —
    // computed from the actual timestamps so the test is timezone-independent
    const idx = forecast.precipitation.findIndex((p) => {
      const elevation = solarElevation(
        new Date(p.time).getTime(),
        forecast.location.latitude,
        forecast.location.longitude,
      );
      return elevation > 3 && elevation < 40;
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    forecast.precipitation[idx] = { ...forecast.precipitation[idx]!, median: 1, p10: 1, p90: 1 };
    forecast.cloudCover[idx] = { ...forecast.cloudCover[idx]!, median: 0.3 };

    const result = detectAberrations(forecast);
    const rainbow = result.find((a) => a.type === "rainbow");
    expect(rainbow).toBeDefined();
    expect(rainbow!.icon).toBe("\u{1F308}");
    expect(rainbow!.message).toContain("Rainbow possible");
  });

  it("does not flag a rainbow when the sky stays overcast", () => {
    const forecast = makeForecast();
    const overcast = forecast.cloudCover.map((p) => ({ ...p, median: 0.95 }));
    const rainy = forecast.precipitation.map((p) => ({ ...p, median: 1, p10: 1, p90: 1 }));
    const result = detectAberrations({ ...forecast, precipitation: rainy, cloudCover: overcast });
    expect(result.some((a) => a.type === "rainbow")).toBe(false);
  });

  it("does not flag rainbow windows that are already in the past", () => {
    // Rain and broken cloud across the past three days: rainbow conditions
    // certainly occurred, but every timestep has negative hoursFromNow
    const pastPoints = Array.from({ length: 24 }, (_, i) =>
      makePoint({ hoursFromNow: i * 3 - 72 }),
    );
    const forecast = makeForecast({
      temperature: pastPoints,
      precipitation: pastPoints.map((p) => ({ ...p, median: 1, p10: 1, p90: 1, min: 0, max: 2 })),
      windSpeed: pastPoints.map((p) => ({ ...p, median: 3, p10: 2, p90: 5, min: 1, max: 6 })),
      cloudCover: pastPoints.map((p) => ({
        ...p,
        median: 0.2,
        p10: 0.1,
        p90: 0.3,
        min: 0,
        max: 0.4,
      })),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "rainbow")).toBe(false);
  });

  it("detects persistent precipitation", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 3, p10: 1, p90: 5, min: 0, max: 7, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "rain" && a.message.includes("Persistent"))).toBe(true);
  });

  it("detects strong winds with timing of the peak", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: 8,
          p10: 6,
          p90: i === 6 ? 12 : 8,
          min: 4,
          max: 15,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const wind = result.find((a) => a.type === "danger");
    expect(wind).toBeDefined();
    expect(wind!.message).toContain(`Strong winds expected ${formatDayPart(pointTime(18))}`);
  });

  it("detects clearing skies within the forecast window", () => {
    const forecast = makeForecast({
      cloudCover: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 0.9 : 0.2,
          p10: i < 12 ? 0.8 : 0.1,
          p90: i < 12 ? 1 : 0.4,
          min: 0.1,
          max: 1,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "warm" && a.message.includes("Clearing"))).toBe(true);
  });

  it("detects increasing cloud cover within the forecast window", () => {
    const forecast = makeForecast({
      cloudCover: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 0.1 : 0.8,
          p10: i < 12 ? 0.05 : 0.7,
          p90: i < 12 ? 0.2 : 0.9,
          min: 0,
          max: 1,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "cool" && a.message.includes("Increasing"))).toBe(true);
  });

  it("flags oppressive humidity from a high dew point with timing of the peak", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i === 8 ? 23 : 12,
          p10: 10,
          p90: 24,
          min: 9,
          max: 25,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast);
    const humid = result.find((a) => a.type === "humid");
    expect(humid).toBeDefined();
    expect(humid!.message).toContain("Oppressive");
    expect(humid!.message).toContain(formatDayPart(pointTime(24)));
    expect(humid!.message).toContain("23.0°C");
  });

  it("does not flag humidity when the dew point stays comfortable", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 11, p10: 9, p90: 13, min: 8, max: 14, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast);
    expect(result.some((a) => a.type === "humid")).toBe(false);
  });

  it("does not flag humidity when no dew point data is present", () => {
    const result = detectAberrations(makeForecast());
    expect(result.some((a) => a.type === "humid")).toBe(false);
  });

  it("formats the dew point in imperial for humidity alerts", () => {
    const forecast = makeForecast({
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 25, p10: 23, p90: 26, min: 22, max: 27, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    const humid = result.find((a) => a.type === "humid");
    expect(humid).toBeDefined();
    expect(humid!.message).toContain("°F");
  });

  /**
   * Build a forecast whose temperature and dew point are flat except for a
   * single hot, muggy timestep, so heat alerts have an unambiguous peak.
   */
  function makeHeatForecast(opts: {
    tempC: number;
    dewPointC: number;
    /** 90th-percentile temperature at the peak (defaults to the median) */
    tempP90C?: number;
    /** Index of the peak timestep within the 24-step series */
    peakIndex?: number;
    /** Offset applied to every hoursFromNow, for testing past peaks */
    hoursOffset?: number;
  }): ForecastData {
    const peakIndex = opts.peakIndex ?? 8;
    const offset = opts.hoursOffset ?? 0;
    return makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i === peakIndex ? opts.tempC : 20,
          p90: i === peakIndex ? (opts.tempP90C ?? opts.tempC) : 22,
          p10: 18,
          min: 16,
          max: 40,
          hoursFromNow: i * 3 + offset,
        }),
      ),
      dewPoint: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i === peakIndex ? opts.dewPointC : 10,
          p10: 8,
          p90: 12,
          min: 6,
          max: 26,
          hoursFromNow: i * 3 + offset,
        }),
      ),
    });
  }

  it("warns about extreme heat when the median heat index reaches the danger band", () => {
    // 38°C air with a 24°C dew point ≈ 108°F heat index (NWS "Danger")
    const result = detectAberrations(makeHeatForecast({ tempC: 38, dewPointC: 24 }));
    const heat = result.find((a) => a.type === "heat" && a.message.includes("heat index"));
    expect(heat).toBeDefined();
    expect(heat!.message).toContain("Extreme heat");
    expect(heat!.message).toContain(formatDayPart(pointTime(24)));
    expect(heat!.message).toContain("air 38.0°C");
    expect(heat!.message).toContain("dew point 24.0°C");
  });

  it("escalates to extreme danger at a heat index above 51.7°C", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 45, dewPointC: 30 }));
    const heat = result.find((a) => a.type === "heat" && a.message.includes("heat index"));
    expect(heat).toBeDefined();
    expect(heat!.message).toContain("Extreme heat danger");
  });

  it("hedges extreme heat as possible when only the warmest members reach it", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 32, dewPointC: 24, tempP90C: 39 }));
    const heat = result.find((a) => a.type === "heat" && a.message.includes("heat index"));
    expect(heat).toBeDefined();
    expect(heat!.message).toContain("Extreme heat possible");
    expect(heat!.message).toContain("in the warmest ensemble members");
  });

  it("warns about dangerous wet-bulb temperatures", () => {
    // 33°C air with a 28°C dew point gives a wet bulb near 29°C
    const result = detectAberrations(makeHeatForecast({ tempC: 33, dewPointC: 28 }));
    const wetBulb = result.find((a) => a.type === "heat" && a.message.includes("wet bulb"));
    expect(wetBulb).toBeDefined();
    expect(wetBulb!.message).toContain("Dangerous wet-bulb heat");
    expect(wetBulb!.message).toContain(formatDayPart(pointTime(24)));
  });

  it("escalates the wet-bulb warning past the 35°C survivability limit", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 42, dewPointC: 38 }));
    const wetBulb = result.find((a) => a.type === "heat" && a.message.includes("wet bulb"));
    expect(wetBulb).toBeDefined();
    expect(wetBulb!.message).toContain("Unsurvivable wet-bulb heat");
  });

  it("hedges the wet-bulb warning when only the warmest members reach it", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 29, dewPointC: 27, tempP90C: 34 }));
    const wetBulb = result.find((a) => a.type === "heat" && a.message.includes("wet bulb"));
    expect(wetBulb).toBeDefined();
    expect(wetBulb!.message).toContain("possible");
    expect(wetBulb!.message).toContain("in the warmest ensemble members");
  });

  it("does not warn about heat in a mild forecast", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 24, dewPointC: 14 }));
    expect(result.some((a) => a.type === "heat")).toBe(false);
  });

  it("does not warn about heat at an ordinary warm summer peak", () => {
    // 31°C with a 20°C dew point is "extreme caution" on the NWS scale — hot,
    // but not a reason to interrupt the user
    const result = detectAberrations(makeHeatForecast({ tempC: 31, dewPointC: 20 }));
    expect(result.some((a) => a.type === "heat")).toBe(false);
  });

  it("does not warn about heat without a dew point series", () => {
    const forecast = makeHeatForecast({ tempC: 40, dewPointC: 28 });
    const result = detectAberrations({ ...forecast, dewPoint: undefined });
    expect(result.some((a) => a.type === "heat")).toBe(false);
  });

  it("does not warn about a heat peak that has already passed", () => {
    const result = detectAberrations(
      makeHeatForecast({ tempC: 42, dewPointC: 30, peakIndex: 4, hoursOffset: -72 }),
    );
    expect(result.some((a) => a.type === "heat")).toBe(false);
  });

  it("formats heat warnings in imperial units", () => {
    const result = detectAberrations(makeHeatForecast({ tempC: 40, dewPointC: 28 }), "imperial");
    const heat = result.filter((a) => a.type === "heat");
    expect(heat.length).toBeGreaterThan(0);
    for (const alert of heat) {
      expect(alert.message).toContain("°F");
      expect(alert.message).not.toContain("°C");
    }
  });

  it("uses imperial units when specified", () => {
    const forecast = makeForecast({
      temperature: Array.from({ length: 24 }, (_, i) =>
        makePoint({
          median: i < 12 ? 5 : 30,
          p10: i < 12 ? 3 : 28,
          p90: i < 12 ? 7 : 32,
          min: 3,
          max: 32,
          hoursFromNow: i * 3,
        }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.message.includes("°F"))).toBe(true);
  });

  it("formats wind in mph for imperial", () => {
    const forecast = makeForecast({
      windSpeed: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 8, p10: 6, p90: 12, min: 4, max: 15, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.type === "danger" && a.message.includes("mph"))).toBe(true);
  });

  it("formats precipitation in in/hr for imperial", () => {
    const forecast = makeForecast({
      precipitation: Array.from({ length: 24 }, (_, i) =>
        makePoint({ median: 3, p10: 1, p90: 5, min: 0, max: 7, hoursFromNow: i * 3 }),
      ),
    });
    const result = detectAberrations(forecast, "imperial");
    expect(result.some((a) => a.type === "rain" && a.message.includes("in/hr"))).toBe(true);
  });
});
