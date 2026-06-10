import { describe, it, expect } from "vitest";
import { formatDayPart, formatInitTime } from "./format.js";

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

// Construct dates in local time so day-part boundaries are
// timezone-independent; derive the expected weekday the same way
// formatDayPart does so the assertion is locale-independent.
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });

describe("formatDayPart", () => {
  it("labels pre-dawn hours as 'early <day>'", () => {
    const d = new Date(2026, 2, 4, 2, 0, 0);
    expect(formatDayPart(d)).toBe(`early ${weekday(d)}`);
  });

  it("labels 5 AM to noon as morning", () => {
    const d = new Date(2026, 2, 4, 9, 0, 0);
    expect(formatDayPart(d)).toBe(`${weekday(d)} morning`);
  });

  it("labels noon to 5 PM as afternoon", () => {
    const d = new Date(2026, 2, 4, 13, 30, 0);
    expect(formatDayPart(d)).toBe(`${weekday(d)} afternoon`);
  });

  it("labels 5 PM to 9 PM as evening", () => {
    const d = new Date(2026, 2, 4, 18, 0, 0);
    expect(formatDayPart(d)).toBe(`${weekday(d)} evening`);
  });

  it("labels 9 PM onward as night", () => {
    const d = new Date(2026, 2, 4, 22, 0, 0);
    expect(formatDayPart(d)).toBe(`${weekday(d)} night`);
  });

  it("accepts an ISO string", () => {
    const d = new Date(2026, 2, 4, 9, 0, 0);
    expect(formatDayPart(d.toISOString())).toBe(`${weekday(d)} morning`);
  });
});
