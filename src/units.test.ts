import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  celsiusToFahrenheit,
  mmhrToInhr,
  msToMph,
  formatTemp,
  getUnitSystem,
  setUnitSystem,
} from "./units.js";

// Stub localStorage for node environment
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

describe("celsiusToFahrenheit", () => {
  it("converts 0°C to 32°F", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
  });

  it("converts 100°C to 212°F", () => {
    expect(celsiusToFahrenheit(100)).toBe(212);
  });

  it("converts -40°C to -40°F", () => {
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });
});

describe("mmhrToInhr", () => {
  it("converts 25.4 mm/hr to 1 in/hr", () => {
    expect(mmhrToInhr(25.4)).toBeCloseTo(1, 5);
  });

  it("converts 0 to 0", () => {
    expect(mmhrToInhr(0)).toBe(0);
  });
});

describe("msToMph", () => {
  it("converts 1 m/s to ~2.237 mph", () => {
    expect(msToMph(1)).toBeCloseTo(2.237, 3);
  });

  it("converts 0 to 0", () => {
    expect(msToMph(0)).toBe(0);
  });
});

describe("formatTemp", () => {
  it("formats metric as °C with one decimal", () => {
    expect(formatTemp(20.5, "metric")).toBe("20.5°C");
  });

  it("formats imperial as °F with no decimal", () => {
    expect(formatTemp(0, "imperial")).toBe("32°F");
  });

  it("formats negative metric", () => {
    expect(formatTemp(-10, "metric")).toBe("-10.0°C");
  });

  it("formats negative imperial", () => {
    expect(formatTemp(-40, "imperial")).toBe("-40°F");
  });
});

describe("getUnitSystem", () => {
  it("defaults to imperial when nothing stored", () => {
    expect(getUnitSystem()).toBe("imperial");
  });

  it("returns metric when stored", () => {
    storage.set("unit-system", "metric");
    expect(getUnitSystem()).toBe("metric");
  });

  it("returns imperial for unknown values", () => {
    storage.set("unit-system", "garbage");
    expect(getUnitSystem()).toBe("imperial");
  });
});

describe("setUnitSystem", () => {
  it("persists metric", () => {
    setUnitSystem("metric");
    expect(storage.get("unit-system")).toBe("metric");
  });

  it("persists imperial", () => {
    setUnitSystem("imperial");
    expect(storage.get("unit-system")).toBe("imperial");
  });
});
