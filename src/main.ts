import type {
  LatLon,
  ForecastData,
  ForecastPoint,
  ForecastVariable,
  GridVariable,
  Aberration,
  AccuracyGrid,
} from "./types.js";
import { getGeolocation, zipToLatLon } from "./geo.js";
import { fetchGefsMetadata, fetchGefsVariable, fetchLatestInitTime } from "./weather.js";
import { fetchHrrrMetadata, fetchHrrrVariable, fetchLatestHrrrInitTime } from "./hrrr.js";
import { fetchEcmwfMetadata, fetchEcmwfVariable, fetchLatestEcmwfInitTime } from "./ecmwf.js";
import { fetchAifsMetadata, fetchAifsVariable, fetchLatestAifsInitTime } from "./aifs.js";
import type { ModelId } from "./types.js";
import {
  blendSingleVariable,
  computeDisplayRange,
  computeWeights,
  lookupAccuracy,
  type ModelVariableInput,
} from "./blend.js";
import {
  getEnabledModels,
  setEnabledModels,
  getMagicBlend,
  setMagicBlend,
  getViewMode,
  setViewMode,
} from "./model-selection.js";
import { detectAberrations } from "./aberrations.js";
import { detectRainbowWindows } from "./rainbow.js";
import {
  renderChart,
  renderChartSkeleton,
  stopChartSkeleton,
  type IntensityBand,
  type ChartOverlaySeries,
  type ChartContextSeries,
} from "./chart.js";
import { computeFeelsLike } from "./humidity.js";
import { getCached, setCache } from "./cache.js";
import { readStorage, writeStorage } from "./storage.js";
import { formatInitTime } from "./format.js";
import { getLocationFromUrl, setLocationInUrl } from "./url-params.js";
import {
  type UnitSystem,
  getUnitSystem,
  setUnitSystem,
  celsiusToFahrenheit,
  mmhrToInhr,
  msToMph,
} from "./units.js";

// DOM elements
const geolocateBtn = document.getElementById("geolocate-btn") as HTMLButtonElement;
const zipForm = document.getElementById("zip-form") as HTMLFormElement;
const zipInput = document.getElementById("zip-input") as HTMLInputElement;

const locationBar = document.getElementById("location-bar") as HTMLDivElement;
const locationDisplay = document.getElementById("location-display") as HTMLDivElement;
const locationResetBtn = document.getElementById("location-reset-btn") as HTMLButtonElement;
const locationBackBtn = document.getElementById("location-back-btn") as HTMLButtonElement;
const locationLabel = document.getElementById("location-label") as HTMLSpanElement;
const forecastMetaBar = document.getElementById("forecast-meta-bar") as HTMLDivElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const forecastEl = document.getElementById("forecast") as HTMLDivElement;
const aberrationsEl = document.getElementById("aberrations") as HTMLElement;
const initTimeLabel = document.getElementById("init-time-label") as HTMLSpanElement;
const updatingIndicator = document.getElementById("updating-indicator") as HTMLSpanElement;
const metricBtn = document.getElementById("metric-btn") as HTMLSpanElement;
const imperialBtn = document.getElementById("imperial-btn") as HTMLSpanElement;
const modelControlsEl = document.getElementById("model-controls") as HTMLDivElement;
const selectAllModels = document.getElementById("select-all-models") as HTMLSpanElement;
const modelGefsCheckbox = document.getElementById("model-gefs") as HTMLInputElement;
const modelHrrrCheckbox = document.getElementById("model-hrrr") as HTMLInputElement;
const modelEcmwfCheckbox = document.getElementById("model-ecmwf") as HTMLInputElement;
const modelAifsCheckbox = document.getElementById("model-aifs") as HTMLInputElement;
const blendToggle = document.getElementById("blend-toggle") as HTMLDivElement;
const magicBlendBtn = document.getElementById("magic-blend-btn") as HTMLButtonElement;
const equalBlendBtn = document.getElementById("equal-blend-btn") as HTMLButtonElement;
const blendedViewBtn = document.getElementById("blended-view-btn") as HTMLButtonElement;
const perModelViewBtn = document.getElementById("per-model-view-btn") as HTMLButtonElement;
const infoToggle = document.getElementById("info-toggle") as HTMLAnchorElement;
const infoPanel = document.getElementById("info-panel") as HTMLDivElement;
const blendWeightsInfo = document.getElementById("blend-weights-info") as HTMLParagraphElement;
const loadStatusEl = document.getElementById("load-status") as HTMLDivElement;
const loadStatusModelsEl = document.getElementById("load-status-models") as HTMLSpanElement;
const chartLegendEl = document.getElementById("chart-legend") as HTMLDivElement;
const tempActualBtn = document.getElementById("temp-actual-btn") as HTMLSpanElement;
const tempFeelsBtn = document.getElementById("temp-feels-btn") as HTMLSpanElement;
const showDewpointCheckbox = document.getElementById("show-dewpoint") as HTMLInputElement;

/** Temperature chart display mode: actual air temperature or "feels like" */
type TempMode = "actual" | "feels-like";
const TEMP_MODE_KEY = "temp-mode";
const SHOW_DEWPOINT_KEY = "show-dewpoint";
/** Colour of the dew point context line on the temperature chart */
const DEWPOINT_COLOR = "#4dd0e1";

function getTempMode(): TempMode {
  return readStorage(TEMP_MODE_KEY) === "feels-like" ? "feels-like" : "actual";
}
function setTempMode(mode: TempMode): void {
  writeStorage(TEMP_MODE_KEY, mode);
}
function getShowDewPoint(): boolean {
  return readStorage(SHOW_DEWPOINT_KEY) === "true";
}
function setShowDewPoint(show: boolean): void {
  writeStorage(SHOW_DEWPOINT_KEY, String(show));
}

/** Accuracy grid used for Magic Blend weights. Starts empty (equal weights)
 *  until the bundled grid, loaded as a separate chunk, arrives. */
let accuracyGridState: AccuracyGrid = {
  gridResolution: 1,
  bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
  cells: {},
};

import("./generated/accuracy-grid.json").then(
  (mod) => {
    accuracyGridState = mod.default as AccuracyGrid;
  },
  () => {
    // Grid chunk failed to load — keep the empty grid (equal weights)
  },
);

function loadAccuracyGrid(): AccuracyGrid {
  return accuracyGridState;
}

/** Store last data for re-rendering on resize and unit toggle */
let lastForecast: ForecastData | null = null;

/** Cached per-model inputs for reblending without refetch */
let cachedModelInputs: Map<ForecastVariable, ModelVariableInput[]> | null = null;
let cachedLocation: LatLon | null = null;
let cachedInitTime: string | null = null;

/** Every model, in the fixed order inputs are blended in */
const ALL_MODELS: ModelId[] = ["NOAA GEFS", "ECMWF IFS ENS", "ECMWF AIFS", "NOAA HRRR"];

/** Models with no data for the current location: outside their coverage
 *  (HRRR outside CONUS) or their data store failed */
let unavailableModels = new Set<ModelId>();

/** Models with data for the current location */
function availableModels(): ModelId[] {
  return ALL_MODELS.filter((m) => !unavailableModels.has(m));
}

/**
 * The inputs to show for a variable: the enabled models' inputs, or every
 * model's when none of the enabled models has data — e.g. only HRRR is
 * selected and the location is outside its coverage, or its store failed.
 */
function selectInputs(
  inputs: ModelVariableInput[],
  enabled: ReadonlySet<ModelId>,
): ModelVariableInput[] {
  const filtered = inputs.filter((i) => enabled.has(i.model));
  return filtered.length > 0 ? filtered : inputs;
}

/** Fixed time range [startMs, endMs] computed from all models so x-axis stays stable */
let cachedTimeRange: [number, number] | undefined;

/** Timestamps (window midpoints) where rainbow conditions are possible,
 *  shown as icons on the precipitation chart */
let cachedRainbowTimes: number[] = [];

/** Recompute rainbow marker times from a fully blended forecast */
function updateRainbowTimes(forecast: ForecastData): void {
  cachedRainbowTimes = detectRainbowWindows(forecast).map((w) => (w.startMs + w.endMs) / 2);
}

/** Recompute the chart time range from every variable's inputs, for the
 *  currently enabled models */
function updateCachedTimeRange(inputs: Map<ForecastVariable, ModelVariableInput[]>): void {
  cachedTimeRange = computeDisplayRange(inputs.values(), getEnabledModels(), Date.now());
}

/** Last selected zip code for display */
let lastZip: string | null = null;

/** Whether user has selected a location (even if forecast hasn't loaded yet) */
let hasSelectedLocation = false;

/**
 * Monotonic id assigned to each `loadForecast` call. In-flight loads
 * compare their captured id against this; if a newer load has started,
 * they bail without touching cache or DOM. Zarr fetches themselves can't
 * be aborted, so we just ignore stale results.
 */
let currentLoadId = 0;

/** Hide location selection, show location display */
function showLocationDisplay(): void {
  locationBar.classList.add("hidden");
  locationDisplay.classList.remove("hidden");
  locationResetBtn.classList.remove("hidden");
  locationBackBtn.classList.add("hidden");
}

function showLoading(): void {
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.add("hidden");
  forecastMetaBar.classList.remove("hidden");
}

function showError(msg: string): void {
  loadingEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
  errorEl.textContent = msg;
  forecastEl.classList.add("hidden");
}

function showForecast(): void {
  loadingEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.remove("hidden");
}

function renderAberrations(aberrations: Aberration[]): void {
  aberrationsEl.innerHTML = "";
  for (const ab of aberrations) {
    const card = document.createElement("div");
    card.className = `aberration-card ${ab.type}`;
    const icon = document.createElement("span");
    icon.className = "aberration-icon";
    icon.textContent = ab.icon;
    const msg = document.createElement("span");
    msg.textContent = ab.message;
    card.appendChild(icon);
    card.appendChild(msg);
    aberrationsEl.appendChild(card);
  }
}

/** Precipitation intensity bands in mm/h (metric) */
const PRECIP_BANDS_METRIC: IntensityBand[] = [
  { min: 0, max: 0.5, label: "Drizzle", color: "rgba(102,179,255,0.04)" },
  { min: 0.5, max: 2.5, label: "Light rain", color: "rgba(102,179,255,0.10)" },
  { min: 2.5, max: 7.5, label: "Moderate", color: "rgba(102,179,255,0.18)" },
  { min: 7.5, max: 50, label: "Heavy rain", color: "rgba(102,179,255,0.28)" },
];

/** Precipitation intensity bands in in/h (imperial) */
const PRECIP_BANDS_IMPERIAL: IntensityBand[] = [
  { min: 0, max: mmhrToInhr(0.5), label: "Drizzle", color: "rgba(102,179,255,0.04)" },
  {
    min: mmhrToInhr(0.5),
    max: mmhrToInhr(2.5),
    label: "Light rain",
    color: "rgba(102,179,255,0.10)",
  },
  {
    min: mmhrToInhr(2.5),
    max: mmhrToInhr(7.5),
    label: "Moderate",
    color: "rgba(102,179,255,0.18)",
  },
  {
    min: mmhrToInhr(7.5),
    max: mmhrToInhr(50),
    label: "Heavy rain",
    color: "rgba(102,179,255,0.28)",
  },
];

/** Per-model colors — Wong colorblind-safe palette (Nature Methods, 2011) */
const MODEL_COLORS: Record<ModelId, string> = {
  "NOAA GEFS": "#E69F00",
  "NOAA HRRR": "#56B4E9",
  "ECMWF IFS ENS": "#009E73",
  "ECMWF AIFS": "#CC79A7",
};

const MODEL_SHORT_NAMES: Record<ModelId, string> = {
  "NOAA GEFS": "GEFS",
  "NOAA HRRR": "HRRR",
  "ECMWF IFS ENS": "IFS",
  "ECMWF AIFS": "AIFS",
};

/** Canvas ID for each charted (grid) variable */
const VARIABLE_CANVAS: Record<GridVariable, string> = {
  temperature: "temp-chart",
  precipitation: "precip-chart",
  windSpeed: "wind-chart",
  cloudCover: "cloud-chart",
};

/** The grid (charted) variables, in display order */
const GRID_VARIABLES: GridVariable[] = ["temperature", "precipitation", "windSpeed", "cloudCover"];

/** Build chart render options (excluding canvas and data) for a variable */
function chartOptsForVariable(variable: GridVariable): {
  label: string;
  unit: string;
  color: string;
  convertValue?: (v: number) => number;
  formatValue: (v: number) => string;
  intensityBands?: IntensityBand[];
  yClampMin?: number;
  yClampMax?: number;
  showDailyExtremes?: boolean;
} {
  const imperial = getUnitSystem() === "imperial";
  switch (variable) {
    case "temperature":
      return {
        label: "Temperature",
        unit: imperial ? "\u00B0F" : "\u00B0C",
        color: "#f5a623",
        convertValue: imperial ? celsiusToFahrenheit : undefined,
        formatValue: (v) => v.toFixed(0),
        showDailyExtremes: true,
      };
    case "precipitation":
      return {
        label: "Precipitation",
        unit: imperial ? "in/h" : "mm/h",
        color: "#66b3ff",
        convertValue: imperial ? mmhrToInhr : undefined,
        formatValue: (v) => v.toFixed(imperial ? 2 : 1),
        intensityBands: imperial ? PRECIP_BANDS_IMPERIAL : PRECIP_BANDS_METRIC,
      };
    case "windSpeed":
      return {
        label: "Wind Speed",
        unit: imperial ? "mph" : "m/s",
        color: "#81c784",
        convertValue: imperial ? msToMph : undefined,
        formatValue: (v) => v.toFixed(0),
        yClampMin: 0,
      };
    case "cloudCover":
      return {
        label: "Cloud Cover",
        unit: "",
        color: "#b0bec5",
        formatValue: (v) => `${(v * 100).toFixed(0)}%`,
        yClampMin: 0,
        yClampMax: 1,
      };
  }
}

/** Render a single variable's chart.
 *
 * When `tempForecast` is supplied for the temperature chart (blended,
 * single-series view), the "feels like" toggle and the dew point context
 * overlay are applied using its dew point and wind series. */
function renderVariableChart(
  variable: GridVariable,
  data: ForecastPoint[],
  overlaySeries?: ChartOverlaySeries[],
  tempForecast?: ForecastData,
): void {
  const canvas = document.getElementById(VARIABLE_CANVAS[variable]) as HTMLCanvasElement;
  const opts = chartOptsForVariable(variable);

  let chartData = data;
  let contextSeries: ChartContextSeries | undefined;
  let label = opts.label;

  // Temperature chart: apply feels-like transform / dew point overlay when a
  // forecast with dew point is available and we're not in per-model overlay mode.
  if (variable === "temperature" && !overlaySeries && tempForecast) {
    const dewPoint = tempForecast.dewPoint ?? [];
    const feelsLike = getTempMode() === "feels-like";
    if (feelsLike && dewPoint.length > 0) {
      chartData = computeFeelsLike(tempForecast.temperature, dewPoint, tempForecast.windSpeed);
      label = "Feels Like";
    }
    if (getShowDewPoint() && dewPoint.length > 0) {
      contextSeries = { data: dewPoint, color: DEWPOINT_COLOR, label: "Dew point", dashed: true };
    }
  }

  // Show the unit in the chart title so it's visible even when compact
  // mode drops units from the y-axis tick labels
  const title = canvas.closest(".chart-container")?.querySelector("h2");
  if (title) {
    title.textContent = opts.unit ? `${label} (${opts.unit})` : label;
  }

  renderChart({
    canvas,
    data: chartData,
    timeRange: cachedTimeRange,
    latitude: cachedLocation?.latitude,
    longitude: cachedLocation?.longitude,
    overlaySeries,
    contextSeries,
    rainbowTimes: variable === "precipitation" ? cachedRainbowTimes : undefined,
    ...opts,
    label,
  });
}

function renderCharts(forecast: ForecastData): void {
  updateRainbowTimes(forecast);
  for (const v of GRID_VARIABLES) {
    renderVariableChart(v, forecast[v], undefined, forecast);
  }
}

/** Variables blended when building a full forecast — the grid charts plus
 *  dew point, which feeds the temperature chart, feels-like, and aberrations. */
const BLEND_VARIABLES: ForecastVariable[] = [...GRID_VARIABLES, "dewPoint"];

/** Blend the enabled models for every variable into a full ForecastData. */
function blendForecastData(
  location: LatLon,
  initTime: string,
  enabledModels: Set<ModelId>,
  useMagic: boolean,
  grid: AccuracyGrid,
): ForecastData {
  const results: Partial<Record<ForecastVariable, ForecastPoint[]>> = {};
  for (const varKey of BLEND_VARIABLES) {
    const allInputs = cachedModelInputs!.get(varKey);
    if (!allInputs || allInputs.length === 0) continue;
    const inputs = selectInputs(allInputs, enabledModels);
    results[varKey] = blendSingleVariable(varKey, inputs, location, grid, useMagic);
  }
  return {
    location,
    initTime,
    temperature: results.temperature ?? [],
    precipitation: results.precipitation ?? [],
    windSpeed: results.windSpeed ?? [],
    cloudCover: results.cloudCover ?? [],
    dewPoint: results.dewPoint ?? [],
  };
}

/** Filter cached inputs by enabled models and reblend.
 *  Works incrementally — renders whatever variables are available,
 *  skipping aberrations if recent weather hasn't loaded yet. */
function reblendAndRender(): void {
  if (!cachedModelInputs || !cachedLocation || !cachedInitTime) return;

  const enabledModels = getEnabledModels();
  const viewMode = getViewMode();
  const useMagic = getMagicBlend();
  const grid = loadAccuracyGrid();
  // The enabled models (and the clock) decide how far the charts extend
  updateCachedTimeRange(cachedModelInputs);

  // The blended forecast drives aberrations, rainbow markers, and (in
  // per-model view too) the dew point / feels-like series on the temp chart.
  const forecast = blendForecastData(cachedLocation, cachedInitTime, enabledModels, useMagic, grid);
  lastForecast = forecast;
  updateRainbowTimes(forecast);

  if (viewMode === "per-model") {
    // Per-model (unaggregated) view: show each model's quantiles overlaid
    for (const varKey of GRID_VARIABLES) {
      const allInputs = cachedModelInputs.get(varKey);
      if (!allInputs || allInputs.length === 0) continue;
      const filtered = selectInputs(allInputs, enabledModels);

      const overlays: ChartOverlaySeries[] = filtered.map((input) => ({
        data: input.points,
        color: MODEL_COLORS[input.model],
        label: MODEL_SHORT_NAMES[input.model],
      }));

      // Use the first model's data as the primary (for axes/crosshair)
      renderVariableChart(varKey, filtered[0]!.points, overlays);
    }

    renderAberrations(detectAberrations(forecast, getUnitSystem(), cachedTimeRange));
    return;
  }

  // Blended (aggregated) view
  renderAberrations(detectAberrations(forecast, getUnitSystem(), cachedTimeRange));
  // Only re-render charts that have data
  for (const v of GRID_VARIABLES) {
    if (forecast[v].length > 0) {
      renderVariableChart(v, forecast[v], undefined, forecast);
    }
  }
}

/** Sync model checkbox UI with state */
function syncModelControls(): void {
  const enabled = getEnabledModels();
  modelGefsCheckbox.checked = enabled.has("NOAA GEFS");
  modelHrrrCheckbox.checked = enabled.has("NOAA HRRR");
  modelEcmwfCheckbox.checked = enabled.has("ECMWF IFS ENS");
  modelAifsCheckbox.checked = enabled.has("ECMWF AIFS");

  // Mark models without data here (outside coverage or failed) and show
  // them unchecked
  const checkboxes: Array<[HTMLInputElement, ModelId]> = [
    [modelGefsCheckbox, "NOAA GEFS"],
    [modelHrrrCheckbox, "NOAA HRRR"],
    [modelEcmwfCheckbox, "ECMWF IFS ENS"],
    [modelAifsCheckbox, "ECMWF AIFS"],
  ];
  for (const [checkbox, model] of checkboxes) {
    const unavailable = unavailableModels.has(model);
    const label = checkbox.closest(".model-checkbox") as HTMLElement | null;
    label?.classList.toggle("unavailable", unavailable);
    if (unavailable) checkbox.checked = false;
  }

  // Select-all glyph state
  const allSelected = availableModels().every((m) => enabled.has(m));
  selectAllModels.textContent = allSelected ? "\u2611" : "\u2610";

  // View toggle state
  const viewMode = getViewMode();
  blendedViewBtn.classList.toggle("active", viewMode === "blended");
  perModelViewBtn.classList.toggle("active", viewMode === "per-model");

  // Hide blend toggle in per-model mode (blending doesn't apply)
  blendToggle.classList.toggle("hidden", viewMode === "per-model");

  // Swap the shared chart legend to its per-model explanation
  chartLegendEl.classList.toggle("per-model", viewMode === "per-model");

  // Color model labels in per-model mode so they serve as a legend
  for (const [checkbox, model] of checkboxes) {
    const labelSpan = checkbox.parentElement?.querySelector("span");
    if (labelSpan) {
      labelSpan.style.color = viewMode === "per-model" ? MODEL_COLORS[model] : "";
    }
  }

  // Blend toggle state
  const magic = getMagicBlend();
  magicBlendBtn.classList.toggle("active", magic);
  equalBlendBtn.classList.toggle("active", !magic);

  // Dim blend toggle when only one model is selected (still clickable)
  const enabledCount = [...enabled].filter((m) => !unavailableModels.has(m)).length;
  const blendInactive = enabledCount <= 1;
  magicBlendBtn.classList.toggle("inactive", blendInactive);
  equalBlendBtn.classList.toggle("inactive", blendInactive);
}

/** One model's data for the current location, ready to fetch variables */
interface ModelSource {
  model: ModelId;
  isEnsemble: boolean;
  /** ISO init time of the run being fetched */
  initTime: string;
  fetchVariable: (variable: ForecastVariable) => Promise<ForecastPoint[]>;
}

/**
 * Open every model's store for `location`, in blend order. Each model is
 * independent: one whose store fails, or that doesn't cover the location
 * (HRRR outside CONUS), is left out rather than failing the others.
 */
async function openModelSources(location: LatLon): Promise<ModelSource[]> {
  const [gefs, ecmwf, aifs, hrrr] = await Promise.all([
    fetchGefsMetadata(location).catch(() => null),
    fetchEcmwfMetadata(location).catch(() => null),
    fetchAifsMetadata(location).catch(() => null),
    fetchHrrrMetadata(location).catch(() => null),
  ]);
  const sources: ModelSource[] = [];
  if (gefs) {
    sources.push({
      model: "NOAA GEFS",
      isEnsemble: true,
      initTime: gefs.initTime.toISOString(),
      fetchVariable: (v) => fetchGefsVariable(gefs, v),
    });
  }
  if (ecmwf) {
    sources.push({
      model: "ECMWF IFS ENS",
      isEnsemble: true,
      initTime: ecmwf.initTime.toISOString(),
      fetchVariable: (v) => fetchEcmwfVariable(ecmwf, v),
    });
  }
  if (aifs) {
    sources.push({
      model: "ECMWF AIFS",
      isEnsemble: true,
      initTime: aifs.initTime.toISOString(),
      fetchVariable: (v) => fetchAifsVariable(aifs, v),
    });
  }
  if (hrrr) {
    sources.push({
      model: "NOAA HRRR",
      isEnsemble: false,
      initTime: hrrr.initTime.toISOString(),
      fetchVariable: (v) => fetchHrrrVariable(hrrr, v),
    });
  }
  return sources;
}

/** Models with data in any variable of `inputs` */
function modelsWithData(inputs: Map<ForecastVariable, ModelVariableInput[]>): Set<ModelId> {
  const models = new Set<ModelId>();
  for (const varInputs of inputs.values()) {
    for (const input of varInputs) models.add(input.model);
  }
  return models;
}

/**
 * Fetch the most recent init_time across every model's store. Stores that
 * can't be reached are ignored; returns "" if none can be.
 */
async function fetchLatestAnyInitTime(): Promise<string> {
  const initTimes = await Promise.all([
    fetchLatestInitTime().catch(() => ""),
    fetchLatestHrrrInitTime().catch(() => ""),
    fetchLatestEcmwfInitTime().catch(() => ""),
    fetchLatestAifsInitTime().catch(() => ""),
  ]);
  return initTimes.reduce((a, b) => (b > a ? b : a));
}

async function checkForNewerForecast(
  location: LatLon,
  knownInitTime: string,
  forceRefetch: boolean,
  loadId: number,
): Promise<void> {
  try {
    const latestInitTime = await fetchLatestAnyInitTime();
    if (loadId !== currentLoadId) return;
    const isNewer = latestInitTime > knownInitTime;
    if (!forceRefetch && !isNewer) return;

    if (isNewer) {
      updatingIndicator.classList.remove("hidden");
    }

    const sources = await openModelSources(location);
    const newCache = new Map<ForecastVariable, ModelVariableInput[]>();
    await Promise.all(
      BLEND_VARIABLES.map(async (varKey) => {
        const inputs = await Promise.all(
          sources.map(async (src): Promise<ModelVariableInput | null> => {
            const points = await src.fetchVariable(varKey).catch(() => null);
            if (!points) return null;
            return { model: src.model, points, isEnsemble: src.isEnsemble, initTime: src.initTime };
          }),
        );
        newCache.set(
          varKey,
          inputs.filter((i) => i !== null),
        );
      }),
    );
    // Bail if a newer load has started. Don't touch the indicator here —
    // a concurrent newer load may have already taken ownership of it.
    if (loadId !== currentLoadId) return;

    // Keep what we already have for any model whose refresh failed
    const previous = cachedLocation === location ? cachedModelInputs : null;
    for (const varKey of BLEND_VARIABLES) {
      const inputs = newCache.get(varKey)!;
      for (const old of previous?.get(varKey) ?? []) {
        if (!inputs.some((i) => i.model === old.model)) inputs.push(old);
      }
      inputs.sort((a, b) => ALL_MODELS.indexOf(a.model) - ALL_MODELS.indexOf(b.model));
    }
    const withData = modelsWithData(newCache);
    if (withData.size === 0) throw new Error("No forecast data could be refreshed");

    const latestInit = [...newCache.values()]
      .flat()
      .map((i) => i.initTime ?? "")
      .reduce((a, b) => (b > a ? b : a), knownInitTime);
    cachedModelInputs = newCache;
    cachedLocation = location;
    cachedInitTime = latestInit;
    unavailableModels = new Set(ALL_MODELS.filter((m) => !withData.has(m)));
    updateCachedTimeRange(newCache);

    if (isNewer) {
      initTimeLabel.textContent = formatInitTime(latestInit);
      updatingIndicator.classList.add("hidden");
    }
    modelControlsEl.classList.remove("hidden");
    syncModelControls();
    reblendAndRender();
    updateBlendWeightsDisplay();

    // Cache the full blend and per-model data for offline use
    if (lastForecast) {
      setCache(
        location.latitude,
        location.longitude,
        lastForecast,
        cachedModelInputs,
        unavailableModels,
      );
    }
  } catch {
    // Background refresh failed — keep showing existing data
    updatingIndicator.classList.add("hidden");
  }
}

/** Number of variables each model must deliver before its chip is "done" */
const VARIABLE_COUNT = 4;

/** Per-model count of loaded variables for the first-load progress chips */
let modelLoadCounts = new Map<ModelId, number>();

/** Show the first-load status line with one pending chip per model */
function initLoadProgress(models: ModelId[]): void {
  modelLoadCounts = new Map(models.map((m) => [m, 0]));
  loadStatusModelsEl.innerHTML = "";
  for (const m of models) {
    const chip = document.createElement("span");
    chip.className = "model-chip";
    chip.dataset.model = m;
    chip.textContent = MODEL_SHORT_NAMES[m];
    loadStatusModelsEl.appendChild(chip);
  }
  loadStatusEl.classList.remove("hidden");
}

function loadProgressChip(model: ModelId): HTMLElement | null {
  return loadStatusModelsEl.querySelector(`[data-model="${model}"]`);
}

function hideLoadProgressIfComplete(): void {
  const allDone = [...modelLoadCounts.values()].every((c) => c >= VARIABLE_COUNT);
  if (allDone) loadStatusEl.classList.add("hidden");
}

/** Record one loaded variable for a model; mark its chip done at 4/4 */
function markModelVariableLoaded(model: ModelId): void {
  const count = (modelLoadCounts.get(model) ?? 0) + 1;
  modelLoadCounts.set(model, count);
  if (count >= VARIABLE_COUNT) {
    loadProgressChip(model)?.classList.add("done");
  }
  hideLoadProgressIfComplete();
}

/** Mark a model's chip unavailable so it doesn't block completion */
function markModelUnavailable(model: ModelId): void {
  modelLoadCounts.set(model, VARIABLE_COUNT);
  loadProgressChip(model)?.classList.add("unavailable");
  hideLoadProgressIfComplete();
}

function hideLoadProgress(): void {
  loadStatusEl.classList.add("hidden");
}

/** Show forecast container with skeleton charts for progressive loading */
function showSkeletonCharts(): void {
  loadingEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.remove("hidden");
  forecastMetaBar.classList.remove("hidden");
  aberrationsEl.innerHTML = "";
  initTimeLabel.textContent = "";
  initLoadProgress(["NOAA GEFS", "NOAA HRRR", "ECMWF IFS ENS", "ECMWF AIFS"]);

  for (const v of GRID_VARIABLES) {
    const canvas = document.getElementById(VARIABLE_CANVAS[v]) as HTMLCanvasElement;
    renderChartSkeleton(canvas);
  }
}

/** Update the location label text */
function updateLocationLabel(location: LatLon): void {
  const latStr = `${location.latitude.toFixed(2)}\u00B0${location.latitude >= 0 ? "N" : "S"}`;
  const lonStr = `${Math.abs(location.longitude).toFixed(2)}\u00B0${location.longitude >= 0 ? "E" : "W"}`;

  if (lastZip) {
    locationLabel.textContent = `${lastZip} \u2014 ${latStr}, ${lonStr}`;
  } else {
    locationLabel.textContent = `${latStr}, ${lonStr}`;
  }
}

/** Update blend weights display in the info panel */
function updateBlendWeightsDisplay(): void {
  if (!cachedLocation || !cachedModelInputs) {
    blendWeightsInfo.textContent = "";
    return;
  }

  const grid = loadAccuracyGrid();
  const accuracy = lookupAccuracy(cachedLocation, grid);
  // The models actually in the temperature blend
  const models = selectInputs(cachedModelInputs.get("temperature") ?? [], getEnabledModels()).map(
    (i) => i.model,
  );
  if (models.length === 0) {
    blendWeightsInfo.textContent = "";
    return;
  }

  // Show weights for temperature at lead time 0 (representative)
  const weights = computeWeights(models, "temperature_2m", 0, accuracy);

  const parts: string[] = [];
  for (const [model, weight] of weights) {
    const shortName = model.replace("NOAA ", "").replace("ECMWF ", "");
    parts.push(`${shortName}: ${(weight * 100).toFixed(0)}%`);
  }
  blendWeightsInfo.textContent = `Magic Blend weights (temperature, near-term): ${parts.join(", ")}`;
}

async function loadForecast(location: LatLon): Promise<void> {
  const loadId = ++currentLoadId;
  hasSelectedLocation = true;
  updateLocationLabel(location);
  showLocationDisplay();

  // Clear stale aberrations, rainbow markers, the previous location's
  // chart time range, and any in-progress "Updating forecast…" indicator
  // from a prior load so they can't bleed into the new one.
  aberrationsEl.innerHTML = "";
  cachedRainbowTimes = [];
  cachedTimeRange = undefined;
  updatingIndicator.classList.add("hidden");

  try {
    // A cached forecast renders straight away; a background refresh then
    // replaces it (showing "Updating forecast…" if a newer run is out)
    const cached = getCached(location.latitude, location.longitude);
    if (cached) {
      hideLoadProgress();
      lastForecast = cached.forecast;
      cachedLocation = location;
      cachedInitTime = cached.forecast.initTime;
      // Entries from before per-model inputs were cached can't be
      // reblended; don't leave the previous location's inputs behind
      cachedModelInputs = cached.modelInputs;
      unavailableModels = new Set(cached.unavailableModels);
      if (cachedModelInputs) updateCachedTimeRange(cachedModelInputs);

      initTimeLabel.textContent = formatInitTime(cached.forecast.initTime);
      renderAberrations(detectAberrations(cached.forecast, getUnitSystem(), cachedTimeRange));
      forecastMetaBar.classList.remove("hidden");
      showForecast();
      modelControlsEl.classList.remove("hidden");
      syncModelControls();
      renderCharts(cached.forecast);
      updateBlendWeightsDisplay();
      checkForNewerForecast(location, cached.forecast.initTime, true, loadId);
      return;
    }

    // No cache — show skeleton charts and progressively load data
    showSkeletonCharts();

    const sources = await openModelSources(location);
    if (loadId !== currentLoadId) return;
    if (sources.length === 0) throw new Error("No forecast data source could be reached");

    // Show init time as soon as metadata is available
    const latestInitTime = sources.map((src) => src.initTime).reduce((a, b) => (b > a ? b : a));
    initTimeLabel.textContent = formatInitTime(latestInitTime);

    // Track model availability and update model controls
    unavailableModels = new Set(ALL_MODELS.filter((m) => !sources.some((src) => src.model === m)));
    for (const m of unavailableModels) markModelUnavailable(m);
    syncModelControls();
    modelControlsEl.classList.remove("hidden");

    // Initialize cache state before variable fetches so controls work
    // incrementally as each variable loads
    cachedModelInputs = new Map<ForecastVariable, ModelVariableInput[]>();
    cachedLocation = location;
    cachedInitTime = latestInitTime;
    cachedTimeRange = undefined;

    const grid = loadAccuracyGrid();
    const enabledModels = getEnabledModels();
    const useMagic = getMagicBlend();
    const results: Partial<Record<ForecastVariable, ForecastPoint[]>> = {};

    // Fetch every variable from every model in parallel. Charted variables
    // render as soon as the first model's data arrives, then re-blend and
    // re-render as each remaining model lands. Dew point has no chart of
    // its own — it feeds the temperature chart's feels-like/overlay and the
    // humidity aberration — so it neither renders nor counts toward the
    // progress chips.
    await Promise.all(
      BLEND_VARIABLES.map(async (variable) => {
        const charted = variable !== "dewPoint";
        const canvas = charted
          ? (document.getElementById(VARIABLE_CANVAS[variable]) as HTMLCanvasElement)
          : null;
        const arrived = new Map<ModelId, ModelVariableInput>();
        let skeletonGone: Promise<void> | null = null;

        await Promise.all(
          sources.map(async (src) => {
            // One model failing one variable must not abort the whole load
            const points = await src.fetchVariable(variable).catch(() => null);
            if (loadId !== currentLoadId) return;

            if (points) {
              arrived.set(src.model, {
                model: src.model,
                points,
                isEnsemble: src.isEnsemble,
                initTime: src.initTime,
              });
              // Keep a fixed model order regardless of arrival order so
              // blending stays deterministic and matches later reblends.
              // Cache incrementally so controls work on already-loaded
              // variables while others are still fetching.
              const inputs = ALL_MODELS.filter((m) => arrived.has(m)).map((m) => arrived.get(m)!);
              cachedModelInputs!.set(variable, inputs);
              updateCachedTimeRange(cachedModelInputs!);

              const toBlend = selectInputs(inputs, enabledModels);
              const blended = blendSingleVariable(variable, toBlend, location, grid, useMagic);
              results[variable] = blended;

              if (canvas && variable !== "dewPoint") {
                skeletonGone ??= stopChartSkeleton(canvas);
                await skeletonGone;
                if (loadId !== currentLoadId) return;
                renderVariableChart(variable, blended);
              }
            }
            if (charted) markModelVariableLoaded(src.model);
          }),
        );
      }),
    );
    if (loadId !== currentLoadId) return;
    hideLoadProgress();

    if (GRID_VARIABLES.every((v) => !results[v])) {
      throw new Error("No forecast data could be loaded");
    }
    // A variable no model delivered keeps an empty chart, not a skeleton
    for (const v of GRID_VARIABLES) {
      if (!results[v]) {
        void stopChartSkeleton(document.getElementById(VARIABLE_CANVAS[v]) as HTMLCanvasElement);
      }
    }
    // Models whose store opened but delivered no variables are unavailable too
    const withData = modelsWithData(cachedModelInputs);
    unavailableModels = new Set(ALL_MODELS.filter((m) => !withData.has(m)));
    syncModelControls();

    // Build complete ForecastData
    const forecast: ForecastData = {
      location,
      initTime: latestInitTime,
      temperature: results.temperature ?? [],
      precipitation: results.precipitation ?? [],
      windSpeed: results.windSpeed ?? [],
      cloudCover: results.cloudCover ?? [],
      dewPoint: results.dewPoint ?? [],
    };

    lastForecast = forecast;
    setCache(location.latitude, location.longitude, forecast, cachedModelInputs, unavailableModels);

    // Re-render everything now that all data is in: rainbow markers need
    // precipitation and cloud cover together, the per-variable renders
    // during progressive loading may have used a provisional common time
    // range (computed before every model had arrived), and the user may
    // have toggled models or the view mode mid-load — reblendAndRender
    // reads the current selection state rather than the snapshot this
    // load started with.
    reblendAndRender();
    updateBlendWeightsDisplay();

    checkForNewerForecast(location, forecast.initTime, false, loadId);
  } catch (err) {
    if (loadId !== currentLoadId) return;
    const message = err instanceof Error ? err.message : "Unknown error occurred";
    showError(`Failed to load forecast: ${message}`);
  }
}

/**
 * Monotonic id for each location request (geolocation, ZIP lookup, or URL
 * restore). Resolving a location is async and `loadForecast` only guards
 * what happens after it starts, so a slow ZIP lookup could otherwise land
 * after a newer choice and replace it.
 */
let currentLocationRequestId = 0;

/** Update the URL to reflect the current location selection (zip, coords, or none). */
function setUrlLocation(params: import("./url-params.js").LocationParam | null): void {
  const next = setLocationInUrl(window.location.href, params);
  window.history.replaceState(null, "", next);
}

// When location selection is shown and user had a previous location, show back button
function showLocationSelectionWithBack(): void {
  locationBar.classList.remove("hidden");
  locationDisplay.classList.add("hidden");
  // Show back button in location display so user can cancel
  if (hasSelectedLocation) {
    locationDisplay.classList.remove("hidden");
    locationResetBtn.classList.add("hidden");
    locationBackBtn.classList.remove("hidden");
  }
}

// Location reset/back button handlers
locationResetBtn.addEventListener("click", () => {
  // Show location selection, hide forecast, show back button if there was data
  forecastEl.classList.add("hidden");
  forecastMetaBar.classList.add("hidden");
  modelControlsEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  loadingEl.classList.add("hidden");
  // The user dismissed this location — don't keep it in the URL so a
  // share/reload doesn't restore it.
  setUrlLocation(null);
  lastZip = null;
  zipInput.value = "";
  showLocationSelectionWithBack();
});

locationBackBtn.addEventListener("click", () => {
  // Go back to previously selected location's forecast
  showLocationDisplay();
  forecastMetaBar.classList.remove("hidden");
  if (lastForecast) {
    forecastEl.classList.remove("hidden");
    modelControlsEl.classList.remove("hidden");
  }
});

// Event handlers
geolocateBtn.addEventListener("click", async () => {
  // Clear any stale prior selection up-front so a denied/cancelled
  // geolocation prompt doesn't leave a previous ?zip=/?lat= in the URL.
  const requestId = ++currentLocationRequestId;
  lastZip = null;
  zipInput.value = "";
  setUrlLocation(null);
  showLoading();
  try {
    const location = await getGeolocation();
    if (requestId !== currentLocationRequestId) return;
    setUrlLocation({
      type: "coords",
      latitude: location.latitude,
      longitude: location.longitude,
    });
    await loadForecast(location);
  } catch (err) {
    if (requestId !== currentLocationRequestId) return;
    const message = err instanceof Error ? err.message : "Could not get location";
    showError(message);
  }
});

zipForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const zip = zipInput.value.trim();
  const requestId = ++currentLocationRequestId;
  // Clear any stale prior selection up-front (same rationale as the
  // geolocate handler).
  setUrlLocation(null);
  showLoading();
  try {
    lastZip = zip;
    const location = await zipToLatLon(zip);
    if (requestId !== currentLocationRequestId) return;
    setUrlLocation({ type: "zip", zip });
    await loadForecast(location);
  } catch (err) {
    if (requestId !== currentLocationRequestId) return;
    const message = err instanceof Error ? err.message : "Invalid ZIP code";
    showError(message);
  }
});

// Auto-submit when a valid 5-digit zip code is entered
zipInput.addEventListener("input", () => {
  const value = zipInput.value.trim();
  if (/^\d{5}$/.test(value)) {
    zipForm.requestSubmit();
  }
});

// Unit toggle
function syncUnitToggle(): void {
  const system = getUnitSystem();
  metricBtn.classList.toggle("active", system === "metric");
  imperialBtn.classList.toggle("active", system === "imperial");
}

function switchUnits(system: UnitSystem): void {
  setUnitSystem(system);
  syncUnitToggle();
  if (lastForecast && !forecastEl.classList.contains("hidden")) {
    renderAberrations(detectAberrations(lastForecast, system, cachedTimeRange));
    renderCharts(lastForecast);
  }
}

function toggleUnits(): void {
  const current = getUnitSystem();
  switchUnits(current === "imperial" ? "metric" : "imperial");
}

syncUnitToggle();
syncModelControls();
metricBtn.addEventListener("click", toggleUnits);
imperialBtn.addEventListener("click", toggleUnits);

// Temperature chart controls: actual/feels-like toggle + dew point overlay
function syncTempControls(): void {
  const feels = getTempMode() === "feels-like";
  tempActualBtn.classList.toggle("active", !feels);
  tempFeelsBtn.classList.toggle("active", feels);
  showDewpointCheckbox.checked = getShowDewPoint();
}

/** Re-render just the temperature chart to reflect the current toggles. */
function rerenderTemperature(): void {
  if (!lastForecast || forecastEl.classList.contains("hidden")) return;
  if (getViewMode() === "per-model") {
    // Feels-like / dew point overlays don't apply to the per-model view;
    // reblend so the chart stays consistent with the current state.
    reblendAndRender();
  } else {
    renderVariableChart("temperature", lastForecast.temperature, undefined, lastForecast);
  }
}

// Temp mode toggle — either button flips between actual / feels-like,
// matching the blend and view toggles.
function toggleTempMode(): void {
  setTempMode(getTempMode() === "feels-like" ? "actual" : "feels-like");
  syncTempControls();
  rerenderTemperature();
}

syncTempControls();
for (const btn of [tempActualBtn, tempFeelsBtn]) {
  btn.addEventListener("click", toggleTempMode);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleTempMode();
    }
  });
}
showDewpointCheckbox.addEventListener("change", () => {
  setShowDewPoint(showDewpointCheckbox.checked);
  rerenderTemperature();
});

// Info panel toggle
infoToggle.addEventListener("click", (e) => {
  e.preventDefault();
  infoPanel.classList.toggle("hidden");
});

// Resize handler for charts
let resizeTimer: ReturnType<typeof setTimeout>;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!forecastEl.classList.contains("hidden")) {
      reblendAndRender();
    }
  }, 250);
});

// Model selection controls
function handleModelCheckboxChange(model: ModelId, checkbox: HTMLInputElement): void {
  const enabled = getEnabledModels();
  if (checkbox.checked) {
    enabled.add(model);
  } else {
    // Prevent deselecting all models — must keep at least one
    if (enabled.size <= 1) {
      checkbox.checked = true;
      return;
    }
    enabled.delete(model);
  }
  setEnabledModels(enabled);
  syncModelControls();
  reblendAndRender();
}

modelGefsCheckbox.addEventListener("change", () =>
  handleModelCheckboxChange("NOAA GEFS", modelGefsCheckbox),
);
modelHrrrCheckbox.addEventListener("change", () =>
  handleModelCheckboxChange("NOAA HRRR", modelHrrrCheckbox),
);
modelEcmwfCheckbox.addEventListener("change", () =>
  handleModelCheckboxChange("ECMWF IFS ENS", modelEcmwfCheckbox),
);
modelAifsCheckbox.addEventListener("change", () =>
  handleModelCheckboxChange("ECMWF AIFS", modelAifsCheckbox),
);

// Select-all glyph: re-enable all available models
selectAllModels.addEventListener("click", () => {
  const enabled = new Set<ModelId>(availableModels());
  setEnabledModels(enabled);
  syncModelControls();
  reblendAndRender();
});
selectAllModels.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    selectAllModels.click();
  }
});

// Long-press (hold) on a model label to isolate that single source
function setupLongPress(label: HTMLElement, model: ModelId): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = false;

  label.addEventListener("pointerdown", () => {
    longPressTriggered = false;
    timer = setTimeout(() => {
      longPressTriggered = true;
      // Clear any text selection that started during the hold
      window.getSelection()?.removeAllRanges();
      const current = getEnabledModels();
      if (current.size === 1 && current.has(model)) {
        // Already isolated on this model — restore all sources
        setEnabledModels(new Set<ModelId>(availableModels()));
      } else {
        setEnabledModels(new Set<ModelId>([model]));
      }
      syncModelControls();
      reblendAndRender();
    }, 400);
  });

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  label.addEventListener("pointerup", cancelTimer);
  label.addEventListener("pointercancel", cancelTimer);

  // Prevent the normal checkbox toggle when long press was triggered
  label.addEventListener(
    "click",
    (e) => {
      if (longPressTriggered) {
        e.preventDefault();
        e.stopPropagation();
        longPressTriggered = false;
      }
    },
    true,
  );
}

const gefsLabel = modelGefsCheckbox.closest(".model-checkbox") as HTMLElement;
const hrrrLabel = modelHrrrCheckbox.closest(".model-checkbox") as HTMLElement;
const ecmwfLabel = modelEcmwfCheckbox.closest(".model-checkbox") as HTMLElement;
const aifsLabel = modelAifsCheckbox.closest(".model-checkbox") as HTMLElement;
setupLongPress(gefsLabel, "NOAA GEFS");
setupLongPress(hrrrLabel, "NOAA HRRR");
setupLongPress(ecmwfLabel, "ECMWF IFS ENS");
setupLongPress(aifsLabel, "ECMWF AIFS");

// View toggle — either button flips between blended / per-model
function toggleViewMode(): void {
  setViewMode(getViewMode() === "blended" ? "per-model" : "blended");
  syncModelControls();
  reblendAndRender();
}
blendedViewBtn.addEventListener("click", toggleViewMode);
perModelViewBtn.addEventListener("click", toggleViewMode);

// Blend toggle — either button flips between magic / equal.
// When only one model is selected, first click enables all sources.
function toggleBlendMode(): void {
  const enabledCount = [...getEnabledModels()].filter((m) => !unavailableModels.has(m)).length;
  if (enabledCount <= 1) {
    setEnabledModels(new Set<ModelId>(availableModels()));
  } else {
    setMagicBlend(!getMagicBlend());
  }
  syncModelControls();
  reblendAndRender();
}
magicBlendBtn.addEventListener("click", toggleBlendMode);
equalBlendBtn.addEventListener("click", toggleBlendMode);

// On load: restore the location from URL params if present.
const initialLocation = getLocationFromUrl(window.location.href);
if (initialLocation?.type === "zip") {
  const requestId = ++currentLocationRequestId;
  lastZip = initialLocation.zip;
  zipInput.value = initialLocation.zip;
  zipToLatLon(initialLocation.zip).then(
    (location) => {
      if (requestId === currentLocationRequestId) return loadForecast(location);
    },
    (err) => {
      if (requestId !== currentLocationRequestId) return;
      const message = err instanceof Error ? err.message : "Invalid ZIP code";
      showError(message);
    },
  );
} else if (initialLocation?.type === "coords") {
  ++currentLocationRequestId;
  lastZip = null;
  zipInput.value = "";
  loadForecast({
    latitude: initialLocation.latitude,
    longitude: initialLocation.longitude,
  }).catch((err) => {
    const message = err instanceof Error ? err.message : "Could not load forecast";
    showError(message);
  });
}
