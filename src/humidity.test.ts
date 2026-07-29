import { describe, it, expect } from "vitest";
import {
  dewPointFromRelativeHumidity,
  relativeHumidityFromDewPoint,
  heatIndex,
  windChill,
  feelsLike,
  humidityIndex,
  computeFeelsLike,
} from "./humidity.js";
import type { ForecastPoint } from "./types.js";

function makePoint(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    time: "2026-07-29T00:00:00.000Z",
    hoursFromNow: 0,
    median: 20,
    p10: 18,
    p90: 22,
    min: 16,
    max: 24,
    ...overrides,
  };
}

describe("dewPointFromRelativeHumidity", () => {
  it("returns the air temperature at 100% relative humidity", () => {
    expect(dewPointFromRelativeHumidity(20, 100)).toBeCloseTo(20, 3);
    expect(dewPointFromRelativeHumidity(5, 100)).toBeCloseTo(5, 3);
  });

  it("computes a lower dew point as air dries out", () => {
    expect(dewPointFromRelativeHumidity(20, 50)).toBeCloseTo(9.26, 1);
    expect(dewPointFromRelativeHumidity(30, 35)).toBeCloseTo(12.88, 1);
  });

  it("is always at or below the air temperature", () => {
    for (const rh of [10, 40, 70, 99]) {
      expect(dewPointFromRelativeHumidity(25, rh)).toBeLessThanOrEqual(25);
    }
  });
});

describe("relativeHumidityFromDewPoint", () => {
  it("is 100% when dew point equals temperature", () => {
    expect(relativeHumidityFromDewPoint(20, 20)).toBeCloseTo(100, 3);
  });

  it("round-trips with dewPointFromRelativeHumidity", () => {
    const dp = dewPointFromRelativeHumidity(22, 45);
    expect(relativeHumidityFromDewPoint(22, dp)).toBeCloseTo(45, 2);
  });
});

describe("heatIndex", () => {
  it("matches the NWS regression for hot, humid conditions", () => {
    // 35°C (95°F) at 50% RH → ~40.7°C (105°F)
    expect(heatIndex(35, 50)).toBeCloseTo(40.7, 0);
  });

  it("feels hotter than the air temperature when hot and humid", () => {
    expect(heatIndex(32, 70)).toBeGreaterThan(32);
  });

  it("uses the simple formula for mild conditions (heat index below 80°F)", () => {
    // 24°C (75.2°F) at 40% RH stays below the regression threshold
    const hi = heatIndex(24, 40);
    expect(hi).toBeCloseTo(23.5, 1);
  });

  it("applies the low-humidity adjustment for hot, dry air", () => {
    // 38°C (100.4°F) at 10% RH triggers the r<13 correction
    const adjusted = heatIndex(38, 10);
    expect(adjusted).toBeGreaterThan(30);
    expect(adjusted).toBeLessThan(40);
  });

  it("applies the high-humidity adjustment near 85°F", () => {
    // 29°C (84.2°F) at 90% RH triggers the r>85 correction
    expect(heatIndex(29, 90)).toBeGreaterThan(29);
  });
});

describe("windChill", () => {
  it("matches the NWS wind chill formula", () => {
    // 0°C, 10 m/s (~22 mph) → ~-7°C
    expect(windChill(0, 10)).toBeCloseTo(-7.03, 0);
  });

  it("feels colder than the air temperature in wind", () => {
    expect(windChill(-5, 8)).toBeLessThan(-5);
  });
});

describe("feelsLike", () => {
  it("uses heat index when hot and humid", () => {
    const dp = dewPointFromRelativeHumidity(35, 50);
    expect(feelsLike(35, dp, 1)).toBeCloseTo(heatIndex(35, 50), 5);
  });

  it("applies heat index for hot conditions regardless of wind", () => {
    const dp = dewPointFromRelativeHumidity(30, 60);
    expect(feelsLike(30, dp, 6)).toBeCloseTo(heatIndex(30, 60), 5);
  });

  it("uses wind chill when cold and windy", () => {
    expect(feelsLike(0, -3, 10)).toBeCloseTo(windChill(0, 10), 5);
  });

  it("returns the actual temperature in mild conditions", () => {
    expect(feelsLike(18, 10, 2)).toBe(18);
  });

  it("returns the actual temperature when cold but wind is light", () => {
    expect(feelsLike(5, 0, 0.5)).toBe(5);
  });
});

describe("humidityIndex", () => {
  it("classifies dew point into comfort levels", () => {
    expect(humidityIndex(5).level).toBe("dry");
    expect(humidityIndex(12).level).toBe("comfortable");
    expect(humidityIndex(17).level).toBe("sticky");
    expect(humidityIndex(19).level).toBe("humid");
    expect(humidityIndex(22).level).toBe("oppressive");
    expect(humidityIndex(25).level).toBe("miserable");
  });

  it("uses inclusive lower boundaries", () => {
    expect(humidityIndex(10).level).toBe("comfortable");
    expect(humidityIndex(16).level).toBe("sticky");
    expect(humidityIndex(18).level).toBe("humid");
    expect(humidityIndex(21).level).toBe("oppressive");
    expect(humidityIndex(24).level).toBe("miserable");
  });

  it("provides a non-empty label and icon for every level", () => {
    for (const dp of [5, 12, 17, 19, 22, 25]) {
      const idx = humidityIndex(dp);
      expect(idx.label.length).toBeGreaterThan(0);
      expect(idx.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("computeFeelsLike", () => {
  const temperature = [
    makePoint({ hoursFromNow: 0, median: 35, p10: 33, p90: 37, min: 32, max: 38 }),
    makePoint({ hoursFromNow: 3, median: 30, p10: 28, p90: 32, min: 27, max: 33 }),
  ];
  const dewPoint = [
    makePoint({ hoursFromNow: 0, median: 24, p10: 22, p90: 26, min: 21, max: 27 }),
    makePoint({ hoursFromNow: 3, median: 20, p10: 18, p90: 22, min: 17, max: 23 }),
  ];
  const windSpeed = [
    makePoint({ hoursFromNow: 0, median: 2, p10: 1, p90: 3, min: 0, max: 4 }),
    makePoint({ hoursFromNow: 3, median: 2, p10: 1, p90: 3, min: 0, max: 4 }),
  ];

  it("produces one output point per temperature point, preserving time", () => {
    const result = computeFeelsLike(temperature, dewPoint, windSpeed);
    expect(result).toHaveLength(2);
    expect(result[0]!.time).toBe(temperature[0]!.time);
    expect(result[0]!.hoursFromNow).toBe(0);
  });

  it("transforms each statistic through feelsLike using aligned dew point and wind", () => {
    const result = computeFeelsLike(temperature, dewPoint, windSpeed);
    expect(result[0]!.median).toBeCloseTo(feelsLike(35, 24, 2), 5);
    expect(result[0]!.p90).toBeCloseTo(feelsLike(37, 26, 3), 5);
    expect(result[0]!.min).toBeCloseTo(feelsLike(32, 21, 0), 5);
  });

  it("aligns by hoursFromNow regardless of array order", () => {
    const reversedDew = dewPoint.map((_, i) => dewPoint[dewPoint.length - 1 - i]!);
    const reversedWind = windSpeed.map((_, i) => windSpeed[windSpeed.length - 1 - i]!);
    const result = computeFeelsLike(temperature, reversedDew, reversedWind);
    expect(result[1]!.median).toBeCloseTo(feelsLike(30, 20, 2), 5);
  });

  it("falls back to the raw temperature when dew point or wind is missing", () => {
    const result = computeFeelsLike(temperature, [], []);
    expect(result[0]!.median).toBe(35);
    expect(result[1]!.median).toBe(30);
  });
});
