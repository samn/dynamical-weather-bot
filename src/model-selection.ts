import type { ModelId } from "./types.js";

const MODELS_KEY = "enabled-models";
const BLEND_KEY = "magic-blend";
const VIEW_KEY = "view-mode";

const ALL_MODELS: ModelId[] = ["NOAA GEFS", "NOAA HRRR", "ECMWF IFS ENS", "ECMWF AIFS"];

export function getEnabledModels(): Set<ModelId> {
  const stored = localStorage.getItem(MODELS_KEY);
  if (!stored) return new Set(ALL_MODELS);
  try {
    const parsed = JSON.parse(stored) as ModelId[];
    const valid = parsed.filter((m) => ALL_MODELS.includes(m));
    return valid.length > 0 ? new Set(valid) : new Set(ALL_MODELS);
  } catch {
    return new Set(ALL_MODELS);
  }
}

export function setEnabledModels(models: Set<ModelId>): void {
  localStorage.setItem(MODELS_KEY, JSON.stringify([...models]));
}

export function getMagicBlend(): boolean {
  return localStorage.getItem(BLEND_KEY) !== "false";
}

export function setMagicBlend(enabled: boolean): void {
  localStorage.setItem(BLEND_KEY, String(enabled));
}

export type ViewMode = "blended" | "per-model";

export function getViewMode(): ViewMode {
  return localStorage.getItem(VIEW_KEY) === "per-model" ? "per-model" : "blended";
}

export function setViewMode(mode: ViewMode): void {
  localStorage.setItem(VIEW_KEY, mode);
}
