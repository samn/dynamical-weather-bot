import type { LatLon, Aberration } from "./types.js";
import { getGeolocation, zipToLatLon } from "./geo.js";
import { fetchForecast, fetchRecentWeather } from "./weather.js";
import { detectAberrations } from "./aberrations.js";
import { renderChart } from "./chart.js";

// DOM elements
const geolocateBtn = document.getElementById("geolocate-btn") as HTMLButtonElement;
const zipForm = document.getElementById("zip-form") as HTMLFormElement;
const zipInput = document.getElementById("zip-input") as HTMLInputElement;
const locationLabel = document.getElementById("location-label") as HTMLSpanElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const forecastEl = document.getElementById("forecast") as HTMLDivElement;
const aberrationsEl = document.getElementById("aberrations") as HTMLElement;

function showLoading(): void {
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  forecastEl.classList.add("hidden");
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
    card.innerHTML = `<span class="aberration-icon">${ab.icon}</span><span>${ab.message}</span>`;
    aberrationsEl.appendChild(card);
  }
}

async function loadForecast(location: LatLon): Promise<void> {
  showLoading();
  locationLabel.textContent = `${location.latitude.toFixed(2)}\u00B0N, ${location.longitude.toFixed(2)}\u00B0${location.longitude >= 0 ? "E" : "W"}`;

  try {
    // Fetch forecast and recent weather in parallel
    const [forecast, recentWeather] = await Promise.all([
      fetchForecast(location),
      fetchRecentWeather(location),
    ]);

    // Detect aberrations
    const aberrations = detectAberrations(forecast, recentWeather);
    renderAberrations(aberrations);

    // Render charts
    renderChart({
      canvas: document.getElementById("temp-chart") as HTMLCanvasElement,
      data: forecast.temperature,
      label: "Temperature",
      unit: "\u00B0C",
      color: "#f5a623",
      formatValue: (v) => v.toFixed(0),
    });

    renderChart({
      canvas: document.getElementById("precip-chart") as HTMLCanvasElement,
      data: forecast.precipitation,
      label: "Precipitation",
      unit: "mm/h",
      color: "#66b3ff",
      formatValue: (v) => v.toFixed(1),
    });

    renderChart({
      canvas: document.getElementById("wind-chart") as HTMLCanvasElement,
      data: forecast.windSpeed,
      label: "Wind Speed",
      unit: "m/s",
      color: "#81c784",
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

    showForecast();
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

// Resize handler for charts
let resizeTimer: ReturnType<typeof setTimeout>;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Re-render charts if forecast is visible
    if (!forecastEl.classList.contains("hidden")) {
      const canvases = forecastEl.querySelectorAll("canvas");
      for (const canvas of canvases) {
        // Trigger a resize event on each canvas (charts will need to be re-rendered)
        canvas.dispatchEvent(new Event("resize"));
      }
    }
  }, 250);
});
