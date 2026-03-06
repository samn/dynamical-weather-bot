import type { LatLon, ForecastData, Aberration } from "./types.js";
import { getGeolocation, zipToLatLon } from "./geo.js";
import { fetchForecast, fetchRecentWeather } from "./weather.js";
import { detectAberrations } from "./aberrations.js";
import { renderChart, type IntensityBand } from "./chart.js";
import { getCached, setCache } from "./cache.js";
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
const locationLabel = document.getElementById("location-label") as HTMLSpanElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const forecastEl = document.getElementById("forecast") as HTMLDivElement;
const aberrationsEl = document.getElementById("aberrations") as HTMLElement;
const metricBtn = document.getElementById("metric-btn") as HTMLButtonElement;
const imperialBtn = document.getElementById("imperial-btn") as HTMLButtonElement;

/** Store last data for re-rendering on resize and unit toggle */
let lastForecast: ForecastData | null = null;
let lastRecentWeather: import("./types.js").RecentWeather | null = null;

function setButtonsDisabled(disabled: boolean): void {
  geolocateBtn.disabled = disabled;
  zipSubmitBtn.disabled = disabled;
  zipInput.disabled = disabled;
}

function showLoading(): void {
  setButtonsDisabled(true);
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.add("hidden");
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

function renderCharts(forecast: ForecastData): void {
  const units = getUnitSystem();
  const imperial = units === "imperial";

  renderChart({
    canvas: document.getElementById("temp-chart") as HTMLCanvasElement,
    data: forecast.temperature,
    label: "Temperature",
    unit: imperial ? "\u00B0F" : "\u00B0C",
    color: "#f5a623",
    convertValue: imperial ? celsiusToFahrenheit : undefined,
    formatValue: (v) => v.toFixed(0),
  });

  renderChart({
    canvas: document.getElementById("precip-chart") as HTMLCanvasElement,
    data: forecast.precipitation,
    label: "Precipitation",
    unit: imperial ? "in/h" : "mm/h",
    color: "#66b3ff",
    convertValue: imperial ? mmhrToInhr : undefined,
    formatValue: (v) => v.toFixed(imperial ? 2 : 1),
    intensityBands: imperial ? PRECIP_BANDS_IMPERIAL : PRECIP_BANDS_METRIC,
  });

  renderChart({
    canvas: document.getElementById("wind-chart") as HTMLCanvasElement,
    data: forecast.windSpeed,
    label: "Wind Speed",
    unit: imperial ? "mph" : "m/s",
    color: "#81c784",
    convertValue: imperial ? msToMph : undefined,
    formatValue: (v) => v.toFixed(0),
  });

  renderChart({
    canvas: document.getElementById("cloud-chart") as HTMLCanvasElement,
    data: forecast.cloudCover,
    label: "Cloud Cover",
    unit: "",
    color: "#b0bec5",
    formatValue: (v) => `${(v * 100).toFixed(0)}%`,
  });
}

async function loadForecast(location: LatLon): Promise<void> {
  showLoading();
  locationLabel.textContent = `${location.latitude.toFixed(2)}\u00B0N, ${location.longitude.toFixed(2)}\u00B0${location.longitude >= 0 ? "E" : "W"}`;

  try {
    const cached = getCached(location.latitude, location.longitude);
    let forecast, recentWeather;
    if (cached) {
      forecast = cached.forecast;
      recentWeather = cached.recentWeather;
    } else {
      [forecast, recentWeather] = await Promise.all([
        fetchForecast(location),
        fetchRecentWeather(location),
      ]);
      setCache(location.latitude, location.longitude, forecast, recentWeather);
    }

    // Store for re-rendering on resize and unit toggle
    lastForecast = forecast;
    lastRecentWeather = recentWeather;

    // Detect aberrations
    const aberrations = detectAberrations(forecast, recentWeather, getUnitSystem());
    renderAberrations(aberrations);

    // Show forecast container before rendering so canvases have dimensions
    showForecast();

    // Render charts
    renderCharts(forecast);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error occurred";
    showError(`Failed to load forecast: ${message}`);
  }
}

// Event handlers
geolocateBtn.addEventListener("click", async () => {
  try {
    showLoading();
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
    showLoading();
    const location = await zipToLatLon(zip);
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

syncUnitToggle();
metricBtn.addEventListener("click", () => switchUnits("metric"));
imperialBtn.addEventListener("click", () => switchUnits("imperial"));

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
