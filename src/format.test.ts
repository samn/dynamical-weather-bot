import { describe, it, expect } from "vitest";
import { formatInitTime } from "./format.js";

describe("formatInitTime", () => {
  it("includes 'Forecast initialized' prefix", () => {
    const result = formatInitTime("2026-03-07T12:00:00.000Z");
    expect(result).toMatch(/^Forecast initialized /);
  });

  it("formats a valid ISO string without throwing", () => {
    expect(() => formatInitTime("2026-01-15T06:00:00.000Z")).not.toThrow();
    const result = formatInitTime("2026-01-15T06:00:00.000Z");
    expect(result.length).toBeGreaterThan("Forecast initialized ".length);
  });

  it("includes the month abbreviation", () => {
    const result = formatInitTime("2026-03-07T12:00:00.000Z");
    expect(result).toContain("Mar");
  });

  it("includes the day number", () => {
    const result = formatInitTime("2026-03-07T12:00:00.000Z");
    expect(result).toContain("7");
  });

  it("handles midnight UTC", () => {
    const result = formatInitTime("2026-03-07T00:00:00.000Z");
    expect(result).toMatch(/^Forecast initialized /);
  });

  it("handles different months correctly", () => {
    expect(formatInitTime("2026-12-25T18:00:00.000Z")).toContain("Dec");
    expect(formatInitTime("2026-06-15T06:00:00.000Z")).toContain("Jun");
  });
});
