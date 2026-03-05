export type UnitSystem = "metric" | "imperial";

const STORAGE_KEY = "unit-system";

export function getUnitSystem(): UnitSystem {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "metric" ? "metric" : "imperial";
}

export function setUnitSystem(system: UnitSystem): void {
  localStorage.setItem(STORAGE_KEY, system);
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

export function mmhrToInhr(mm: number): number {
  return mm / 25.4;
}

export function msToMph(ms: number): number {
  return ms * 2.237;
}

export function formatTemp(c: number, system: UnitSystem): string {
  if (system === "imperial") return `${celsiusToFahrenheit(c).toFixed(0)}\u00B0F`;
  return `${c.toFixed(1)}\u00B0C`;
}
