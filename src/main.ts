import type { LatLon, ForecastData, ForecastVariable, Aberration, AccuracyGrid } from "./types.js";
import { getGeolocation, zipToLatLon } from "./geo.js";
import {
  fetchGefsForecast,
  fetchGefsMetadata,
  fetchGefsVariable,
  fetchRecentWeather,
  fetchLatestInitTime,
} from "./weather.js";
import {
  fetchHrrrForecast,
  fetchHrrrMetadata,
  fetchHrrrVariable,
  fetchLatestHrrrInitTime,
} from "./hrrr.js";
import {
  fetchEcmwfForecast,
  fetchEcmwfMetadata,
  fetchEcmwfVariable,
  fetchLatestEcmwfInitTime,
} from "./ecmwf.js";
import {
  fetchAifsForecast,
  fetchAifsMetadata,
  fetchAifsVariable,
  fetchLatestAifsInitTime,
} from "./aifs.js";
import type { ModelId } from "./types.js";
import {
  blendSingleVariable,
  computeCommonTimeRange,
  computeWeights,
  lookupAccuracy,
  type ModelVariableInput,
} from "./blend.js";
import {
  getEnabledModels,
  setEnabledModels,
  getMagicBlend,
  setMagicBlend,
} from "./model-selection.js";
import { detectAberrations } from "./aberrations.js";
import {
  renderChart,
  renderChartSkeleton,
  stopChartSkeleton,
  type IntensityBand,
} from "./chart.js";
import { getCached, setCache } from "./cache.js";
import { formatInitTime } from "./format.js";
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
const zipSubmitBtn = zipForm.querySelector("button[type=submit]") as HTMLButtonElement;
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
const modelGefsCheckbox = document.getElementById("model-gefs") as HTMLInputElement;
const modelHrrrCheckbox = document.getElementById("model-hrrr") as HTMLInputElement;
const modelEcmwfCheckbox = document.getElementById("model-ecmwf") as HTMLInputElement;
const modelAifsCheckbox = document.getElementById("model-aifs") as HTMLInputElement;
const magicBlendBtn = document.getElementById("magic-blend-btn") as HTMLButtonElement;
const equalBlendBtn = document.getElementById("equal-blend-btn") as HTMLButtonElement;
const infoToggle = document.getElementById("info-toggle") as HTMLAnchorElement;
const infoPanel = document.getElementById("info-panel") as HTMLDivElement;
const blendWeightsInfo = document.getElementById("blend-weights-info") as HTMLParagraphElement;

/** Load bundled accuracy grid data, or return empty grid if not available */
function loadAccuracyGrid(): AccuracyGrid {
  try {
    // Bundled by Vite at build time via JSON import
    // Falls back to empty grid if not yet generated
    return _accuracyGrid;
  } catch {
    return {
      gridResolution: 0.5,
      bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
      cells: {},
    };
  }
}

let _accuracyGrid: AccuracyGrid = {
  gridResolution: 0.5,
  bounds: { minLat: 24, maxLat: 50, minLon: -130, maxLon: -65 },
  cells: {},
};

// Attempt to load accuracy grid asynchronously
try {
  import("./generated/accuracy-grid.json").then(
    (mod) => {
      _accuracyGrid = mod.default as AccuracyGrid;
    },
    () => {
      // Grid not generated yet — will use empty grid (GEFS-only weights)
    },
  );
} catch {
  // Static import analysis may fail — that's fine
}

/** Store last data for re-rendering on resize and unit toggle */
let lastForecast: ForecastData | null = null;
let lastRecentWeather: import("./types.js").RecentWeather | null = null;

/** Cached per-model inputs for reblending without refetch */
let cachedModelInputs: Map<ForecastVariable, ModelVariableInput[]> | null = null;
let cachedLocation: LatLon | null = null;
let cachedInitTime: string | null = null;
let hrrrAvailable = true;

/** Fixed time range [startMs, endMs] computed from all models so x-axis stays stable */
let cachedTimeRange: [number, number] | undefined;

/** Last selected zip code for display */
let lastZip: string | null = null;

/** Whether user has selected a location (even if forecast hasn't loaded yet) */
let hasSelectedLocation = false;

function setButtonsDisabled(disabled: boolean): void {
  geolocateBtn.disabled = disabled;
  zipSubmitBtn.disabled = disabled;
  zipInput.disabled = disabled;
}

/** Hide location selection, show location display */
function showLocationDisplay(): void {
  locationBar.classList.add("hidden");
  locationDisplay.classList.remove("hidden");
  locationResetBtn.classList.remove("hidden");
  locationBackBtn.classList.add("hidden");
}

function showLoading(): void {
  setButtonsDisabled(true);
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.add("hidden");
  forecastMetaBar.classList.remove("hidden");
}

function showError(msg: string): void {
  setButtonsDisabled(false);
  loadingEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
  errorEl.textContent = msg;
  forecastEl.classList.add("hidden");
}

function showForecast(): void {
  setButtonsDisabled(false);
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

/** Canvas ID for each forecast variable */
const VARIABLE_CANVAS: Record<ForecastVariable, string> = {
  temperature: "temp-chart",
  precipitation: "precip-chart",
  windSpeed: "wind-chart",
  cloudCover: "cloud-chart",
};

/** Build chart render options (excluding canvas and data) for a variable */
function chartOptsForVariable(variable: ForecastVariable): {
  label: string;
  unit: string;
  color: string;
  convertValue?: (v: number) => number;
  formatValue: (v: number) => string;
  intensityBands?: IntensityBand[];
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
      };
    case "cloudCover":
      return {
        label: "Cloud Cover",
        unit: "",
        color: "#b0bec5",
        formatValue: (v) => `${(v * 100).toFixed(0)}%`,
      };
  }
}

/** Render a single variable's chart */
function renderVariableChart(
  variable: ForecastVariable,
  data: import("./types.js").ForecastPoint[],
): void {
  const canvas = document.getElementById(VARIABLE_CANVAS[variable]) as HTMLCanvasElement;
  renderChart({ canvas, data, timeRange: cachedTimeRange, ...chartOptsForVariable(variable) });
}

function renderCharts(forecast: ForecastData): void {
  const variables: ForecastVariable[] = ["temperature", "precipitation", "windSpeed", "cloudCover"];
  for (const v of variables) {
    renderVariableChart(v, forecast[v]);
  }
}

/** Filter cached inputs by enabled models and reblend.
 *  Works incrementally — renders whatever variables are available,
 *  skipping aberrations if recent weather hasn't loaded yet. */
function reblendAndRender(): void {
  if (!cachedModelInputs || !cachedLocation || !cachedInitTime) return;

  const enabledModels = getEnabledModels();
  const useMagic = getMagicBlend();
  const grid = loadAccuracyGrid();
  const variables: ForecastVariable[] = ["temperature", "precipitation", "windSpeed", "cloudCover"];
  const results: Partial<Record<ForecastVariable, import("./types.js").ForecastPoint[]>> = {};

  for (const varKey of variables) {
    const allInputs = cachedModelInputs.get(varKey);
    if (!allInputs) continue;
    const filtered = allInputs.filter((i) => enabledModels.has(i.model));
    if (filtered.length === 0) continue;
    results[varKey] = blendSingleVariable(varKey, filtered, cachedLocation, grid, useMagic);
  }

  const forecast: ForecastData = {
    location: cachedLocation,
    initTime: cachedInitTime,
    temperature: results.temperature ?? [],
    precipitation: results.precipitation ?? [],
    windSpeed: results.windSpeed ?? [],
    cloudCover: results.cloudCover ?? [],
  };

  lastForecast = forecast;
  if (lastRecentWeather) {
    const aberrations = detectAberrations(forecast, lastRecentWeather, getUnitSystem());
    renderAberrations(aberrations);
  }
  // Only re-render charts that have data
  for (const v of variables) {
    if (forecast[v].length > 0) {
      renderVariableChart(v, forecast[v]);
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

  // HRRR availability
  const hrrrLabel = modelHrrrCheckbox.closest(".model-checkbox") as HTMLElement | null;
  if (hrrrLabel) {
    hrrrLabel.classList.toggle("unavailable", !hrrrAvailable);
  }
  if (!hrrrAvailable) {
    modelHrrrCheckbox.checked = false;
  }

  // Blend toggle state
  const magic = getMagicBlend();
  magicBlendBtn.classList.toggle("active", magic);
  equalBlendBtn.classList.toggle("active", !magic);

  // Disable blend toggle when only one model is selected
  const enabledCount = [...enabled].filter((m) => m !== "NOAA HRRR" || hrrrAvailable).length;
  const disableBlend = enabledCount <= 1;
  magicBlendBtn.disabled = disableBlend;
  equalBlendBtn.disabled = disableBlend;
}

/**
 * Fetch the most recent init_time across both GEFS and HRRR stores.
 * GEFS 35-day product updates daily (00Z), HRRR updates every 6 hours,
 * so HRRR will typically have the most recent init_time.
 */
async function fetchLatestAnyInitTime(): Promise<string> {
  const [gefsInit, hrrrInit, ecmwfInit, aifsInit] = await Promise.all([
    fetchLatestInitTime(),
    fetchLatestHrrrInitTime().catch(() => ""),
    fetchLatestEcmwfInitTime().catch(() => ""),
    fetchLatestAifsInitTime().catch(() => ""),
  ]);
  return [gefsInit, hrrrInit, ecmwfInit, aifsInit].reduce((a, b) => (b > a ? b : a));
}

async function checkForNewerForecast(
  location: LatLon,
  knownInitTime: string,
  forceRefetch = false,
): Promise<void> {
  try {
    const latestInitTime = await fetchLatestAnyInitTime();
    const isNewer = latestInitTime > knownInitTime;
    if (!forceRefetch && !isNewer) return;

    if (isNewer) {
      updatingIndicator.classList.remove("hidden");
    }

    const [gefsForecast, hrrrForecast, ecmwfForecast, aifsForecast, recentWeather] =
      await Promise.all([
        fetchGefsForecast(location),
        fetchHrrrForecast(location),
        fetchEcmwfForecast(location),
        fetchAifsForecast(location),
        fetchRecentWeather(location),
      ]);

    // Update cached per-model inputs
    hrrrAvailable = hrrrForecast !== null;
    const modelForecasts = [gefsForecast, ecmwfForecast, aifsForecast];
    if (hrrrForecast) modelForecasts.push(hrrrForecast);

    const variables: ForecastVariable[] = [
      "temperature",
      "precipitation",
      "windSpeed",
      "cloudCover",
    ];
    const newCache = new Map<ForecastVariable, ModelVariableInput[]>();
    for (const varKey of variables) {
      const inputs: ModelVariableInput[] = modelForecasts.map((f) => ({
        model: f.model,
        points: f[varKey],
        isEnsemble: f.isEnsemble,
      }));
      newCache.set(varKey, inputs);
    }

    const latestInit = modelForecasts.reduce(
      (latest, f) => (f.initTime > latest ? f.initTime : latest),
      modelForecasts[0]!.initTime,
    );
    cachedModelInputs = newCache;
    cachedLocation = location;
    cachedInitTime = latestInit;
    lastRecentWeather = recentWeather;
    const firstVar = newCache.values().next().value;
    cachedTimeRange = firstVar ? computeCommonTimeRange(firstVar) : undefined;

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
        recentWeather,
        cachedModelInputs ?? undefined,
        hrrrAvailable,
      );
    }
  } catch {
    // Background refresh failed — keep showing existing data
    updatingIndicator.classList.add("hidden");
  }
}

/** Show forecast container with skeleton charts for progressive loading */
function showSkeletonCharts(): void {
  setButtonsDisabled(true);
  loadingEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.remove("hidden");
  forecastMetaBar.classList.remove("hidden");
  aberrationsEl.innerHTML = "";
  initTimeLabel.textContent = "";

  const variables: ForecastVariable[] = ["temperature", "precipitation", "windSpeed", "cloudCover"];
  for (const v of variables) {
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
  const models: ModelId[] = ["NOAA GEFS", "ECMWF IFS ENS", "ECMWF AIFS"];
  if (hrrrAvailable) models.push("NOAA HRRR");

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
  hasSelectedLocation = true;
  updateLocationLabel(location);
  showLocationDisplay();

  // Clear stale aberrations immediately on location switch
  aberrationsEl.innerHTML = "";
  lastRecentWeather = null;

  try {
    // Check cache first — if valid, render immediately without skeletons
    const cached = getCached(location.latitude, location.longitude);
    let useCache = false;
    if (cached) {
      showLoading();
      try {
        const latestInitTime = await fetchLatestAnyInitTime();
        useCache = latestInitTime <= cached.forecast.initTime;
      } catch {
        useCache = true;
      }
    }

    if (useCache && cached) {
      lastForecast = cached.forecast;
      lastRecentWeather = cached.recentWeather;
      cachedLocation = location;
      cachedInitTime = cached.forecast.initTime;

      // Restore per-model inputs so controls work immediately
      if (cached.modelInputs) {
        cachedModelInputs = cached.modelInputs;
        hrrrAvailable = cached.hrrrAvailable;
        // Compute time range from the first cached variable
        const firstVar = cachedModelInputs.values().next().value;
        cachedTimeRange = firstVar ? computeCommonTimeRange(firstVar) : undefined;
      }

      initTimeLabel.textContent = formatInitTime(cached.forecast.initTime);
      const aberrations = detectAberrations(cached.forecast, cached.recentWeather, getUnitSystem());
      renderAberrations(aberrations);
      showForecast();
      modelControlsEl.classList.remove("hidden");
      syncModelControls();
      renderCharts(cached.forecast);
      updateBlendWeightsDisplay();
      checkForNewerForecast(location, cached.forecast.initTime, true);
      return;
    }

    // No cache — show skeleton charts and progressively load data
    showSkeletonCharts();

    // Fetch metadata for all models in parallel
    const [gefsMeta, hrrrMeta, ecmwfMeta, aifsMeta] = await Promise.all([
      fetchGefsMetadata(location),
      fetchHrrrMetadata(location),
      fetchEcmwfMetadata(location),
      fetchAifsMetadata(location),
    ]);

    // Show init time as soon as metadata is available
    const initTimes = [
      gefsMeta.initTime.toISOString(),
      hrrrMeta?.initTime.toISOString() ?? "",
      ecmwfMeta.initTime.toISOString(),
      aifsMeta.initTime.toISOString(),
    ];
    const latestInitTime = initTimes.reduce((a, b) => (b > a ? b : a));
    initTimeLabel.textContent = formatInitTime(latestInitTime);

    // Track HRRR availability and update model controls
    hrrrAvailable = hrrrMeta !== null;
    syncModelControls();
    modelControlsEl.classList.remove("hidden");

    // Initialize cache state before variable fetches so controls work
    // incrementally as each variable loads
    cachedModelInputs = new Map<ForecastVariable, ModelVariableInput[]>();
    cachedLocation = location;
    cachedInitTime = latestInitTime;
    cachedTimeRange = undefined;

    // Kick off all variable fetches + recent weather in parallel
    const grid = loadAccuracyGrid();
    const enabledModels = getEnabledModels();
    const useMagic = getMagicBlend();
    const variables: ForecastVariable[] = [
      "temperature",
      "precipitation",
      "windSpeed",
      "cloudCover",
    ];
    const results: Partial<Record<ForecastVariable, import("./types.js").ForecastPoint[]>> = {};

    const variablePromises = variables.map(async (variable) => {
      const [gefsPoints, hrrrPoints, ecmwfPoints, aifsPoints] = await Promise.all([
        fetchGefsVariable(gefsMeta, variable),
        hrrrMeta ? fetchHrrrVariable(hrrrMeta, variable) : Promise.resolve(null),
        fetchEcmwfVariable(ecmwfMeta, variable),
        fetchAifsVariable(aifsMeta, variable),
      ]);

      // Cache ALL model inputs — update incrementally so controls work
      // on already-loaded variables while others are still fetching
      const allInputs: ModelVariableInput[] = [
        { model: "NOAA GEFS", points: gefsPoints, isEnsemble: true },
        { model: "ECMWF IFS ENS", points: ecmwfPoints, isEnsemble: true },
        { model: "ECMWF AIFS", points: aifsPoints, isEnsemble: false },
      ];
      if (hrrrPoints) {
        allInputs.push({ model: "NOAA HRRR", points: hrrrPoints, isEnsemble: false });
      }
      cachedModelInputs!.set(variable, allInputs);

      // Compute common time range from first variable (all variables share the same
      // time steps per model, so the first one is representative)
      if (!cachedTimeRange) {
        cachedTimeRange = computeCommonTimeRange(allInputs);
      }

      // Blend only enabled models for display
      const filtered = allInputs.filter((i) => enabledModels.has(i.model));
      const toBlend = filtered.length > 0 ? filtered : allInputs;
      const blended = blendSingleVariable(variable, toBlend, location, grid, useMagic);
      results[variable] = blended;

      // Animate skeleton out, then render real chart
      const canvas = document.getElementById(VARIABLE_CANVAS[variable]) as HTMLCanvasElement;
      await stopChartSkeleton(canvas);
      renderVariableChart(variable, blended);
    });

    const recentWeatherPromise = fetchRecentWeather(location);

    const [recentWeather] = await Promise.all([recentWeatherPromise, ...variablePromises]);

    // Build complete ForecastData
    const forecast: ForecastData = {
      location,
      initTime: latestInitTime,
      temperature: results.temperature!,
      precipitation: results.precipitation!,
      windSpeed: results.windSpeed!,
      cloudCover: results.cloudCover!,
    };

    lastForecast = forecast;
    lastRecentWeather = recentWeather;
    setCache(
      location.latitude,
      location.longitude,
      forecast,
      recentWeather,
      cachedModelInputs ?? undefined,
      hrrrAvailable,
    );

    // Aberrations render after all data is available
    const aberrations = detectAberrations(forecast, recentWeather, getUnitSystem());
    renderAberrations(aberrations);
    setButtonsDisabled(false);
    updateBlendWeightsDisplay();

    checkForNewerForecast(location, forecast.initTime);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error occurred";
    showError(`Failed to load forecast: ${message}`);
  }
}

/** Update the URL query parameter for zip code without reloading */
function setZipInUrl(zip: string | null): void {
  const url = new URL(window.location.href);
  if (zip) {
    url.searchParams.set("zip", zip);
  } else {
    url.searchParams.delete("zip");
  }
  window.history.replaceState(null, "", url.toString());
}

/** Read zip code from the current URL query parameters */
function getZipFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("zip");
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
  try {
    lastZip = null;
    showLoading();
    setZipInUrl(null);
    const location = await getGeolocation();
    await loadForecast(location);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not get location";
    showError(message);
  }
});

zipForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const zip = zipInput.value.trim();
  try {
    lastZip = zip;
    showLoading();
    const location = await zipToLatLon(zip);
    setZipInUrl(zip);
    await loadForecast(location);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid ZIP code";
    showError(message);
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
  if (lastForecast && lastRecentWeather && !forecastEl.classList.contains("hidden")) {
    renderAberrations(detectAberrations(lastForecast, lastRecentWeather, system));
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
    if (lastForecast && !forecastEl.classList.contains("hidden")) {
      renderCharts(lastForecast);
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

magicBlendBtn.addEventListener("click", () => {
  setMagicBlend(true);
  syncModelControls();
  reblendAndRender();
});

equalBlendBtn.addEventListener("click", () => {
  setMagicBlend(false);
  syncModelControls();
  reblendAndRender();
});

// On load: if a zip code is in the URL, use it automatically
const initialZip = getZipFromUrl();
if (initialZip) {
  lastZip = initialZip;
  zipInput.value = initialZip;
  zipToLatLon(initialZip).then(
    (location) => loadForecast(location),
    (err) => {
      const message = err instanceof Error ? err.message : "Invalid ZIP code";
      showError(message);
    },
  );
}
