/** Hours past "now" the app forecasts (and fetches enough lead times to cover) */
export const FORECAST_HORIZON_HOURS = 72;

/** Lead time bins in the accuracy grid, keyed by their start (hours). The
 *  scorecard scores whole days of lead time: bin 0 covers leads 0–24h, bin
 *  24 covers 24–48h, and so on. Leads reach ~100h: 72h past now on a
 *  once-daily run that may be over a day old. */
export const LEAD_BINS = [0, 24, 48, 72, 96];

/** Width of each accuracy-grid lead time bin (hours) */
export const LEAD_BIN_WIDTH_HOURS = 24;

/** Geographic coordinates */
export interface LatLon {
  latitude: number;
  longitude: number;
}

/** A single hourly forecast time step with ensemble statistics */
export interface ForecastPoint {
  /** ISO timestamp */
  time: string;
  /** Hours from now */
  hoursFromNow: number;
  /** Median (p50) value */
  median: number;
  /** 10th percentile */
  p10: number;
  /** 90th percentile */
  p90: number;
  /** Minimum across ensemble */
  min: number;
  /** Maximum across ensemble */
  max: number;
}

/** All forecast variables for a location */
export interface ForecastData {
  location: LatLon;
  /** ISO timestamp of the forecast model initialization time */
  initTime: string;
  /** Temperature in degrees C */
  temperature: ForecastPoint[];
  /** Precipitation rate in mm/hr */
  precipitation: ForecastPoint[];
  /** Wind speed in m/s */
  windSpeed: ForecastPoint[];
  /** Cloud cover fraction 0-1 */
  cloudCover: ForecastPoint[];
  /** Dew point in degrees C (optional — used for humidity/feels-like) */
  dewPoint?: ForecastPoint[];
}

/** Supported forecast model identifiers */
export type ModelId = "NOAA GEFS" | "NOAA HRRR" | "ECMWF IFS ENS" | "ECMWF AIFS";

/** Forecast output from a single model */
export interface ModelForecast {
  model: ModelId;
  /** Whether this model provides ensemble-based uncertainty bands */
  isEnsemble: boolean;
  location: LatLon;
  initTime: string;
  temperature: ForecastPoint[];
  precipitation: ForecastPoint[];
  windSpeed: ForecastPoint[];
  cloudCover: ForecastPoint[];
  /** Dew point in degrees C (optional — used for humidity/feels-like) */
  dewPoint?: ForecastPoint[];
}

/** Accuracy grid built from verification statistics */
export interface AccuracyGrid {
  gridResolution: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  cells: Record<string, AccuracyCell>;
}

/** A weather station with its verification metrics */
export interface NearbyStation {
  id: string;
  latitude: number;
  longitude: number;
  /** model → variable → lead bin start hours → error metric (RMSE_bc or MAE) */
  metrics: Record<string, Record<string, Record<string, number>>>;
  /** model → variable → lead bin start hours → signed bias (forecast - observed) */
  biases?: Record<string, Record<string, Record<string, number>>>;
}

/** A single cell in the accuracy grid */
export interface AccuracyCell {
  stationCount: number;
  /** model → variable → lead bin start hours → error metric (RMSE_bc or MAE) */
  metrics: Record<string, Record<string, Record<string, number>>>;
  /** model → variable → lead bin start hours → signed bias (forecast - observed) */
  biases?: Record<string, Record<string, Record<string, number>>>;
  nearbyStations?: NearbyStation[];
}

/** The forecast variable keys */
export type ForecastVariable =
  | "temperature"
  | "precipitation"
  | "windSpeed"
  | "cloudCover"
  | "dewPoint";

/** Forecast variables that have their own chart in the grid (excludes
 *  dew point, which is surfaced via the temperature chart) */
export type GridVariable = "temperature" | "precipitation" | "windSpeed" | "cloudCover";

/** A weather aberration to highlight to the user */
export interface Aberration {
  type: "warm" | "cool" | "rain" | "danger" | "rainbow" | "humid" | "heat";
  icon: string;
  message: string;
}
