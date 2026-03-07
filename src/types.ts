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
}

/** Recent weather statistics for aberration comparison */
export interface RecentWeather {
  /** Average temperature over recent days */
  avgTemperature: number;
  /** Average precipitation rate */
  avgPrecipitation: number;
  /** Average wind speed */
  avgWindSpeed: number;
  /** Average cloud cover */
  avgCloudCover: number;
}

/** A weather aberration to highlight to the user */
export interface Aberration {
  type: "warm" | "cool" | "rain" | "danger";
  icon: string;
  message: string;
}
