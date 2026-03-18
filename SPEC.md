# SPEC.md — 72-Hour Probabilistic Weather Forecast

## Overview

A single-page web app that displays 72-hour probabilistic weather forecasts by blending three numerical weather models (NOAA GEFS, NOAA HRRR, ECMWF IFS ENS). Users provide a location via browser geolocation or US ZIP code. The app renders four canvas-based charts showing ensemble uncertainty bands for temperature, precipitation, wind speed, and cloud cover, plus alert cards highlighting notable weather changes.

---

## Location Input

### Browser Geolocation
- "Use My Location" button triggers the browser geolocation API.
- Options: `timeout: 10000ms`, `enableHighAccuracy: false`.
- On success, coordinates are used directly. On failure, an error message is shown.
- Clears the `?zip=` URL parameter.

### ZIP Code Entry
- A text input accepts exactly 5 numeric digits (`pattern="[0-9]{5}"`, `inputmode="numeric"`, `maxlength="5"`).
- Submitted via a "Go" button or Enter key.
- Validated against regex `^\d{5}$` before any network request. Invalid input shows: "Please enter a valid 5-digit US ZIP code."
- Coordinates fetched from `https://api.zippopotam.us/us/{zip}`. Uses the first result's latitude/longitude.
- On success, the URL is updated to `?zip={zip}` via `replaceState` (no page reload).

### URL Parameter
- On page load, if `?zip=XXXXX` is present, the ZIP is auto-populated and the forecast loads immediately.
- When geolocation is used, the `?zip=` parameter is removed from the URL.

### Location Display
- After resolving coordinates, the location bar shows: `{lat}°N, {lon}°E` (or `°W` for negative longitude), both to 2 decimal places.

---

## Forecast Models

Three models are fetched in parallel. All data is sourced from dynamical.org Zarr stores.

### NOAA GEFS (Global Ensemble Forecast System)
- **Coverage:** Global, 0.25° resolution (721 × 1440 grid)
- **Ensemble:** 31 members
- **Horizon:** 72 hours at 3-hour intervals (24 timesteps)
- **Grid indexing:** `latIdx = (90 - lat) / 0.25`, `lonIdx = (lon + 180) / 0.25`
- **Variables:** `temperature_2m`, `precipitation_surface`, `wind_u_10m`, `wind_v_10m`, `total_cloud_cover_atmosphere`

### NOAA HRRR (High-Resolution Rapid Refresh)
- **Coverage:** Continental US (CONUS) only; returns `null` for locations outside bounds
- **Ensemble:** Deterministic (single member — all percentiles equal median)
- **Horizon:** 48 hours at 1-hour intervals
- **Grid:** Lambert Conformal Conic projection; lat/lon converted to grid indices via LCC projection math
- **Update frequency:** Every 6 hours (more recent init times than GEFS)

### ECMWF IFS ENS
- **Coverage:** Global, 0.25° resolution (same grid as GEFS)
- **Ensemble:** 51 members (1 control + 50 perturbed)
- **Horizon:** 72 hours at 3-hour intervals (24 timesteps)
- **Note:** Dimension order differs from GEFS — data is `[lead_time × ensemble_member]` and must be transposed during read

---

## Unit Conversions

All data is stored internally in metric units. Conversions happen at render time.

| Variable       | Zarr native         | Internal unit | Imperial display |
|----------------|---------------------|---------------|------------------|
| Temperature    | °C                  | °C            | °F = C×9/5+32    |
| Precipitation  | kg/m²/s             | mm/hr (×3600) | in/hr (÷25.4)   |
| Wind speed     | m/s (from u,v)      | m/s           | mph (×2.237)     |
| Cloud cover    | percent (0–100)     | fraction 0–1  | fraction 0–1     |

Wind speed is computed from u/v components: `sqrt(u² + v²)`.

---

## Ensemble Statistics

For each timestep, the following statistics are computed across all ensemble members:

- **Median (p50):** 50th percentile via linear interpolation
- **p10:** 10th percentile
- **p90:** 90th percentile
- **Min:** Ensemble minimum
- **Max:** Ensemble maximum

For deterministic models (HRRR), all five statistics equal the single forecast value.

---

## Forecast Blending

When multiple models are available, their outputs are blended per-variable, per-timestep using accuracy-based weights.

### Accuracy Grid
- Pre-computed verification statistics are bundled as `accuracy-grid.json` (loaded asynchronously; app works without it using equal weights).
- Grid resolution: 1° cells.
- Coverage bounds: lat 24–50, lon -130 to -65 (CONUS).
- When nearby weather stations exist in a cell, Inverse Distance Weighting (IDW) is applied from the user's location: `weight = 1/distance²`, max radius 50 km, minimum distance cap 1 km.

### Weight Computation
- `weight = 1/error²`, normalized so weights sum to 1.
- Lead time bins: 0h, 24h, 48h (each timestep rounds to nearest bin).
- If no accuracy data exists for a location, all models receive equal weight.
- Models with no accuracy entry for a given variable/lead-time receive weight 0 (unless all models lack data, then equal weights).

### Blending Strategy
1. **Median:** Weighted average of all models' medians (including deterministic HRRR).
2. **Uncertainty bands (p10, p90, min, max):** Weighted average of ensemble models only (GEFS + ECMWF), shifted so the band center aligns with the blended median. HRRR contributes to the median but not to uncertainty width.
3. **Clamping:** Precipitation, wind speed, and cloud cover are clamped to ≥ 0. Temperature is not clamped.

### Variable-to-Accuracy Mapping
- Temperature → `temperature_2m`
- Precipitation → `precipitation_surface`
- Wind speed → `temperature_2m` (proxy)
- Cloud cover → `temperature_2m` (proxy)

### Model Selection UI
- Users can toggle individual models (GEFS, HRRR, ECMWF) on/off via checkboxes
- Users can switch between "Magic Blend" (accuracy-weighted) and "Equal Blend" (equal weights)
- Per-model data is cached so toggling reblends instantly without refetching
- HRRR checkbox is auto-disabled outside CONUS
- At least one ensemble model (GEFS or ECMWF) must remain enabled
- Blend toggle is disabled when only one model is selected
- Selection persisted in `localStorage` under keys `"enabled-models"` and `"magic-blend"`

---

## Recent Weather

- 7 days of GEFS analysis data (3-hourly, ~56 timesteps) are fetched for the same location.
- Averages are computed for temperature, precipitation, wind speed, and cloud cover.
- Used to generate aberration alerts by comparing forecast vs. recent conditions.

---

## Aberration Detection

Aberrations are alert cards shown above the charts when the forecast deviates significantly from recent weather.

### Temperature Aberrations

| Condition | Type | Icon | Message |
|-----------|------|------|---------|
| Forecast avg temp > recent avg + 5°C | `warm` | ☀️ | "Significantly warmer than recent days: forecast avg X vs recent Y" |
| Forecast avg temp < recent avg − 5°C | `cool` | 🥶 | "Significantly colder than recent days: forecast avg X vs recent Y" |
| max(p90) − min(p10) > 15°C | `danger` | 🌡️ | "Large temperature swing expected: X to Y" (ordered chronologically) |

### Precipitation Aberrations

| Condition | Type | Icon | Message |
|-----------|------|------|---------|
| max(p90) > 2 mm/hr AND recent avg < 0.5 mm/hr | `rain` | 🌧️ | "Rain likely after dry conditions: up to X possible (90th percentile)" |
| avg forecast median > 2 mm/hr | `rain` | 🌧️ | "Persistent precipitation expected: avg X" |

### Wind Aberrations

| Condition | Type | Icon | Message |
|-----------|------|------|---------|
| max(p90) > 10 m/s | `danger` | 🌬️ | "Strong winds expected: gusts up to X" |

### Cloud Cover Aberrations

| Condition | Type | Icon | Message |
|-----------|------|------|---------|
| Avg cloud cover drop > 0.3 AND recent > 0.5 | `warm` | ☀️ | "Clearing skies ahead: cloud cover dropping from X% to Y%" |
| Avg cloud cover rise > 0.3 AND recent < 0.5 | `cool` | ☁️ | "Increasing cloud cover: from X% to Y%" |

All values in aberration messages respect the current unit system (°F/°C, in/hr/mm/hr, mph/m/s).

---

## Charts

Four canvas-based charts are rendered, one per variable: Temperature, Precipitation, Wind Speed, Cloud Cover.

### Chart Elements (back to front)
1. **Intensity bands** (precipitation only): Background shading at defined thresholds
2. **Min–max band:** Light fill (8% alpha of chart color)
3. **P10–P90 band:** Darker fill (20% alpha)
4. **Median line:** Solid 2px stroke
5. **Axes:** L-shaped (left + bottom), with gridlines
6. **Y-axis labels:** Values with units (or band names for precipitation)
7. **X-axis labels:** Weekday + time (e.g. "Mon", "2 PM"), max 4–6 labels
8. **"Now" marker:** Vertical white dashed line + "now" label, shown when current time falls within the chart's time range

### Chart Colors
| Variable      | Color   |
|---------------|---------|
| Temperature   | #f5a623 (orange) |
| Precipitation | #66b3ff (blue)   |
| Wind Speed    | #81c784 (green)  |
| Cloud Cover   | #b0bec5 (gray)   |

### Precipitation Intensity Bands (Metric)
| Band         | Range (mm/hr) | Opacity |
|--------------|---------------|---------|
| Drizzle      | 0 – 0.5       | 4%      |
| Light rain   | 0.5 – 2.5     | 10%     |
| Moderate     | 2.5 – 7.5     | 18%     |
| Heavy rain   | 7.5 – 50      | 28%     |

Imperial bands use the same thresholds converted via `÷ 25.4`.

### Responsive Layout
- **< 400px width (compact):** Smaller fonts (9/8px), tighter padding, max 4 x-axis labels
- **≥ 400px (normal):** Standard fonts (11/10px), max 6 x-axis labels
- Y-axis padding is wider when intensity bands are present (to fit band labels)
- Canvas height: 200px (180px on screens ≤ 600px)
- Charts re-render on window resize (debounced 250ms)

### Tooltip Interaction
- **Mouse:** Hover anywhere over the chart to show tooltip; leaves on pointer exit
- **Touch:** Press and hold to show tooltip; released on pointer up
- **Content:** Date/time of nearest datapoint, median value with unit, p10–p90 range, intensity label (if applicable)
- **Visual:** Vertical crosshair line, dot on median, dark rounded-rect tooltip box
- **Positioning:** Tooltip flips left/right and clamps vertically to stay within canvas bounds
- Canvas cursor style: `crosshair`; touch-action: `pan-y` (allows vertical scrolling)

### Skeleton Loading Animation
- While data loads, each chart shows animated sinusoidal placeholder curves (4 curves with varying amplitude, phase, and opacity)
- On data arrival, a 300ms exit animation shrinks curves to zero amplitude and fades opacity to 0
- Axes are drawn during skeleton state

---

## Unit System

- Two modes: `metric` (°C, mm/hr, m/s) and `imperial` (°F, in/hr, mph)
- Default: `imperial`
- Stored in `localStorage` under key `"unit-system"`
- Toggle buttons (°C / °F) in the header; active button styled with accent blue background
- Switching units immediately re-renders all charts and recomputes aberration messages (no re-fetch)

---

## Caching

- **Storage:** `localStorage` under key `"weather-cache"`
- **TTL:** 1 hour (3,600,000 ms)
- **Key:** `{lat.toFixed(2)},{lon.toFixed(2)}` — groups nearby requests
- **On read:** Expired entries are evicted
- **On write:** All expired entries are evicted before storing new data
- **Failures:** localStorage unavailable or full — silently ignored

### Cache-First Flow
1. If cache exists for location: show loading spinner, check if a newer init time is available from any model.
2. If cache init time is still current: render from cache immediately, then check for updates in background.
3. If cache is stale or missing: show skeleton charts and fetch progressively.

---

## Progressive Loading

When fetching fresh data (no valid cache):

1. Show skeleton chart animations on all four canvases
2. Fetch metadata from all three models in parallel
3. Display the most recent init time as soon as metadata arrives
4. For each of the four variables, fetch data from all models in parallel, blend, animate skeleton out, render chart — each variable appears as soon as its data is ready
5. Fetch recent weather in parallel with variable fetches
6. After all data arrives, compute and display aberrations, enable buttons, store cache
7. Check for newer forecast in background

---

## Background Updates

After displaying a forecast (cached or fresh), the app checks for newer model initializations:

1. Fetch latest init times from all three models in parallel (HRRR and ECMWF failures caught silently)
2. If any model has a newer init time than the displayed forecast: show "Updating forecast..." indicator (pulsing animation), re-fetch all models + recent weather, blend, re-render charts and aberrations, update cache
3. On failure: hide indicator, keep existing forecast

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Geolocation denied/timeout | Show error: "Geolocation error: {message}" |
| Invalid ZIP format | Show error: "Please enter a valid 5-digit US ZIP code." |
| ZIP not found (404) | Show error: "ZIP code {zip} not found." |
| Forecast fetch failure | Show error: "Failed to load forecast: {message}" |
| HRRR outside CONUS | Silently excluded; forecast uses GEFS + ECMWF only |
| Background update failure | Silently ignored; existing forecast preserved |
| localStorage unavailable | Cache operations silently fail |
| Accuracy grid missing | Falls back to equal model weights |

---

## UI States

The page has three mutually exclusive main states:

1. **Idle:** No loading, no error, no forecast. Buttons enabled. (Initial state, or after clearing URL parameter.)
2. **Loading:** Spinner visible OR skeleton charts visible. Buttons disabled.
3. **Forecast:** Charts, aberrations, and metadata visible. Buttons enabled.

Error can appear from any state and replaces the current main content.

---

## Page Structure

```
header
  h1: "72-Hour Probabilistic Forecast"
  location-bar: [Use My Location] or [ZIP input][Go] [location label]
  unit-toggle: [°C] [°F]

main
  loading: spinner + "Loading forecast data..."
  error: red-bordered message
  forecast:
    forecast-meta: init time label + "Updating forecast..." indicator
    model-controls: [GEFS] [HRRR] [ECMWF] checkboxes + [Magic Blend] [Equal Blend] toggle
    aberrations: list of alert cards (icon + message, colored left border)
    charts: 4 chart containers, each with:
      chart-header: variable name + legend (━ median ▓ p10-p90 ░ min-max)
      canvas

footer
  Data attribution: dynamical.org, GEFS (31-member), HRRR (48-hour), ECMWF IFS ENS (51-member)
```

---

## Visual Design

- Dark theme: `#0f1117` background, `#1a1d27` surface cards
- Max width: 960px, centered
- Responsive breakpoint at 600px (tighter spacing, smaller fonts, shorter canvases)
- Model controls: flex row on desktop (checkboxes left, blend toggle right), stacked vertically on mobile
- Aberration card colors: warm=orange, cool=light blue, rain=blue, danger=red (left border)
- Chart containers: dark surface with subtle border, 8px border radius
- Font: system-ui stack

---

## Deployment

- Built with Vite
- Deployed to Cloudflare Pages (`weather.samn.biz`)
- Configuration in `wrangler.toml`
