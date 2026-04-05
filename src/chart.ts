import type { ForecastPoint } from "./types.js";
import type { TimeMarker } from "./solar.js";
import { computeTimeMarkers } from "./solar.js";

/** A horizontal band drawn behind the chart to indicate intensity levels */
export interface IntensityBand {
  /** Lower bound of the band (display units) */
  min: number;
  /** Upper bound of the band (display units) */
  max: number;
  /** Label shown on the y-axis */
  label: string;
  /** Background fill colour (use a semi-transparent value) */
  color: string;
}

interface ChartOptions {
  canvas: HTMLCanvasElement;
  data: ForecastPoint[];
  label: string;
  unit: string;
  color: string;
  /** Convert metric value to display unit (e.g. C→F) */
  convertValue?: (v: number) => number;
  /** Format value for display */
  formatValue?: (v: number) => string;
  /** Optional intensity bands drawn as background shading with y-axis labels */
  intensityBands?: IntensityBand[];
  /** Fixed time range [startMs, endMs] for x-axis. When set, the x-axis
   *  always spans this range regardless of the data points present. */
  timeRange?: [number, number];
  /** Location latitude for sunrise/sunset markers */
  latitude?: number;
  /** Location longitude for sunrise/sunset markers */
  longitude?: number;
}

interface ChartState {
  data: ConvertedPoint[];
  unit: string;
  color: string;
  formatValue: (v: number) => string;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
  displayWidth: number;
  displayHeight: number;
  yMin: number;
  yMax: number;
  compact: boolean;
  fontSize: number;
  smallFontSize: number;
  intensityBands?: IntensityBand[];
  timeToX: (ms: number) => number;
  /** Saved image of the fully rendered chart (before any tooltip overlay) */
  baseImage: ImageData;
}

interface ConvertedPoint extends ForecastPoint {
  timeMs: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

/** Returns the display label for a time marker type */
export function timeMarkerLabel(type: TimeMarker["type"]): string {
  switch (type) {
    case "midnight":
      return "12 AM";
    case "noon":
      return "12 PM";
    case "sunrise":
      return "Sunrise";
    case "sunset":
      return "Sunset";
  }
}

/** Draw a sun icon (circle with rays) at the given center point */
function drawSunIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const r = size * 0.35;
  const rayLen = size * 0.2;
  const rayStart = r + size * 0.08;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = size * 0.1;
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * rayStart, cy + Math.sin(angle) * rayStart);
    ctx.lineTo(
      cx + Math.cos(angle) * (rayStart + rayLen),
      cy + Math.sin(angle) * (rayStart + rayLen),
    );
    ctx.stroke();
  }
}

/** Draw a crescent moon icon at the given center point */
function drawMoonIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const r = size * 0.4;
  // Outer circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Cut out an inner circle offset to the right to make a crescent
  const saved = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx + r * 0.55, cy - r * 0.15, r * 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = saved;
}

/** Draw a half-sun on the horizon for sunrise/sunset */
function drawHorizonSunIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rising: boolean,
): void {
  const r = size * 0.3;
  const horizonY = cy + r * 0.1;

  // Draw rays above horizon
  const rayLen = size * 0.18;
  const rayStart = r + size * 0.06;
  ctx.lineWidth = size * 0.08;
  const rayCount = 5;
  for (let i = 0; i < rayCount; i++) {
    const angle = -Math.PI + (i * Math.PI) / (rayCount - 1);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * rayStart, horizonY + Math.sin(angle) * rayStart);
    ctx.lineTo(
      cx + Math.cos(angle) * (rayStart + rayLen),
      horizonY + Math.sin(angle) * (rayStart + rayLen),
    );
    ctx.stroke();
  }

  // Half sun (upper semicircle)
  ctx.beginPath();
  ctx.arc(cx, horizonY, r, -Math.PI, 0);
  ctx.fill();

  // Horizon line
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.45, horizonY);
  ctx.lineTo(cx + size * 0.45, horizonY);
  ctx.stroke();

  // Small arrow indicating direction
  const arrowX = rising ? cx + size * 0.3 : cx - size * 0.3;
  const arrowDir = rising ? -1 : 1; // rising: arrow points up
  ctx.beginPath();
  ctx.moveTo(arrowX, horizonY - size * 0.2);
  ctx.lineTo(arrowX - size * 0.08, horizonY - size * 0.2 - arrowDir * size * 0.12);
  ctx.lineTo(arrowX + size * 0.08, horizonY - size * 0.2 - arrowDir * size * 0.12);
  ctx.closePath();
  ctx.fill();
}

/** Marker style configuration */
const MARKER_STYLES: Record<TimeMarker["type"], { color: string; lineColor: string }> = {
  midnight: { color: "#6b7394", lineColor: "#6b739420" },
  noon: { color: "#f5c842", lineColor: "#f5c84215" },
  sunrise: { color: "#f5a050", lineColor: "#f5a05015" },
  sunset: { color: "#e07040", lineColor: "#e0704015" },
};

/** Draw a time marker icon for the given type */
function drawMarkerIcon(
  ctx: CanvasRenderingContext2D,
  type: TimeMarker["type"],
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.save();
  ctx.fillStyle = MARKER_STYLES[type].color;
  ctx.strokeStyle = MARKER_STYLES[type].color;

  switch (type) {
    case "midnight":
      drawMoonIcon(ctx, cx, cy, size);
      break;
    case "noon":
      drawSunIcon(ctx, cx, cy, size);
      break;
    case "sunrise":
      drawHorizonSunIcon(ctx, cx, cy, size, true);
      break;
    case "sunset":
      drawHorizonSunIcon(ctx, cx, cy, size, false);
      break;
  }

  ctx.restore();
}

const NICE_HOUR_INTERVALS = [3, 6, 12, 24];
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Compute x-axis label timestamps snapped to consistent clock-hour boundaries.
 * Labels are placed at multiples of a "nice" hour interval (3, 6, 12, or 24h)
 * so they remain stable regardless of how many data points exist.
 */
export function computeXLabelTimes(
  firstTimeMs: number,
  lastTimeMs: number,
  maxLabels: number,
): number[] {
  const totalHours = (lastTimeMs - firstTimeMs) / MS_PER_HOUR;
  if (totalHours <= 0 || maxLabels <= 0) return [];

  const rawInterval = totalHours / maxLabels;
  const hourInterval =
    NICE_HOUR_INTERVALS.find((h) => h >= rawInterval) ?? Math.ceil(rawInterval / 24) * 24;

  // Round up to the next clock-hour boundary in local time
  const first = new Date(firstTimeMs);
  const firstLocalHour = first.getHours();
  const nextBoundaryHour = Math.ceil((firstLocalHour + 1) / hourInterval) * hourInterval;
  const start = new Date(first);
  start.setHours(nextBoundaryHour, 0, 0, 0);
  // If rounding landed before or at the first data point, advance one interval
  if (start.getTime() <= firstTimeMs) {
    start.setTime(start.getTime() + hourInterval * MS_PER_HOUR);
  }

  const labels: number[] = [];
  for (let t = start.getTime(); t < lastTimeMs; t += hourInterval * MS_PER_HOUR) {
    labels.push(t);
  }
  return labels;
}

const chartStates = new WeakMap<HTMLCanvasElement, ChartState>();
const listenersAttached = new WeakSet<HTMLCanvasElement>();

/** Active skeleton animation state, keyed by canvas */
const skeletonAnimations = new WeakMap<HTMLCanvasElement, { stop: boolean }>();

/** Sine curve parameters for skeleton animation */
const SKELETON_CURVES = [
  { amplitudeScale: 1.0, phaseOffset: 0, opacity: 0.25 },
  { amplitudeScale: 0.7, phaseOffset: 0.8, opacity: 0.18 },
  { amplitudeScale: 1.2, phaseOffset: 1.6, opacity: 0.12 },
  { amplitudeScale: 0.85, phaseOffset: 2.4, opacity: 0.15 },
];

interface SkeletonLayout {
  displayWidth: number;
  displayHeight: number;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
}

function getSkeletonLayout(canvas: HTMLCanvasElement): SkeletonLayout {
  const rect = canvas.getBoundingClientRect();
  const displayWidth = rect.width;
  const displayHeight = rect.height;
  const compact = displayWidth < 400;
  const padding = {
    top: 10,
    right: compact ? 8 : 16,
    bottom: compact ? 28 : 32,
    left: compact ? 40 : 50,
  };
  return {
    displayWidth,
    displayHeight,
    padding,
    chartWidth: displayWidth - padding.left - padding.right,
    chartHeight: displayHeight - padding.top - padding.bottom,
  };
}

function drawSkeletonAxes(ctx: CanvasRenderingContext2D, layout: SkeletonLayout): void {
  const { padding, chartWidth, chartHeight } = layout;

  ctx.strokeStyle = "#2a2d3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  const gridLines = 4;
  for (let i = 1; i < gridLines; i++) {
    const y = padding.top + (i / gridLines) * chartHeight;
    ctx.strokeStyle = "#1a1d2720";
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }
}

function drawSkeletonCurves(
  ctx: CanvasRenderingContext2D,
  layout: SkeletonLayout,
  time: number,
  amplitudeFactor: number,
  globalOpacity: number,
): void {
  const { padding, chartWidth, chartHeight } = layout;
  const baselineY = padding.top + chartHeight * 0.5;
  const amplitude = chartHeight * 0.2 * amplitudeFactor;
  const frequency = (2.5 * Math.PI) / chartWidth;
  const phaseSpeed = 0.8;

  for (const curve of SKELETON_CURVES) {
    const curveAmplitude = amplitude * curve.amplitudeScale;
    const phase = time * phaseSpeed + curve.phaseOffset;
    const alpha = curve.opacity * globalOpacity;

    ctx.strokeStyle = `rgba(139, 143, 163, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px <= chartWidth; px += 2) {
      const x = padding.left + px;
      const y = baselineY - Math.sin(px * frequency + phase) * curveAmplitude;
      if (px === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/**
 * Start a skeleton loading animation on a canvas.
 * Draws axes and animated sinusoidal placeholder curves.
 */
export function renderChartSkeleton(canvas: HTMLCanvasElement): void {
  // Stop any existing skeleton animation on this canvas
  const existing = skeletonAnimations.get(canvas);
  if (existing) existing.stop = true;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) return;
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const state = { stop: false };
  skeletonAnimations.set(canvas, state);

  const layout = getSkeletonLayout(canvas);
  let startTime: number | undefined;

  function frame(timestamp: number): void {
    if (state.stop) return;
    if (startTime === undefined) startTime = timestamp;
    const elapsed = (timestamp - startTime) / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layout.displayWidth, layout.displayHeight);
    drawSkeletonAxes(ctx, layout);
    drawSkeletonCurves(ctx, layout, elapsed, 1, 1);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

/**
 * Transition a skeleton chart out by shrinking curves to the x-axis and fading.
 * Returns a promise that resolves when the exit animation is complete.
 */
export function stopChartSkeleton(canvas: HTMLCanvasElement): Promise<void> {
  const existing = skeletonAnimations.get(canvas);
  if (!existing) return Promise.resolve();

  // Stop the idle animation loop
  existing.stop = true;

  const dpr = window.devicePixelRatio || 1;
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) return Promise.resolve();
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const layout = getSkeletonLayout(canvas);
  const exitDuration = 300;

  return new Promise((resolve) => {
    const exitStart = performance.now();
    // Capture the phase time so the curves continue smoothly
    const phaseTime = (exitStart - (performance.timeOrigin || exitStart)) / 1000;

    function exitFrame(timestamp: number): void {
      const elapsed = timestamp - exitStart;
      const progress = Math.min(1, elapsed / exitDuration);
      // Ease out
      const eased = 1 - (1 - progress) * (1 - progress);

      const amplitudeFactor = 1 - eased;
      const globalOpacity = 1 - eased;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, layout.displayWidth, layout.displayHeight);
      drawSkeletonAxes(ctx, layout);
      drawSkeletonCurves(ctx, layout, phaseTime, amplitudeFactor, globalOpacity);

      if (progress < 1) {
        requestAnimationFrame(exitFrame);
      } else {
        skeletonAnimations.delete(canvas);
        resolve();
      }
    }

    requestAnimationFrame(exitFrame);
  });
}

/**
 * Render a probabilistic forecast chart on a canvas element.
 * Shows:
 * - P10-P90 range as a shaded band
 * - Min-Max range as a lighter band
 * - Median as a solid line
 * - Time labels on X axis
 * - Value labels on Y axis
 * - Interactive tooltip on hover/touch
 */
export function renderChart(opts: ChartOptions): void {
  const {
    canvas,
    data: rawData,
    unit,
    color,
    convertValue,
    formatValue = (v) => v.toFixed(1),
    intensityBands,
    timeRange,
    latitude,
    longitude,
  } = opts;

  const conv = convertValue ?? ((v: number) => v);
  const data: ConvertedPoint[] = rawData.map((p) => ({
    ...p,
    timeMs: new Date(p.time).getTime(),
    median: conv(p.median),
    p10: conv(p.p10),
    p90: conv(p.p90),
    min: conv(p.min),
    max: conv(p.max),
  }));

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width * dpr;
  const height = rect.height * dpr;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const displayWidth = rect.width;
  const displayHeight = rect.height;
  const compact = displayWidth < 400;
  const hasBands = intensityBands && intensityBands.length > 0;
  const padding = {
    top: 10,
    right: compact ? 8 : 16,
    bottom: compact ? 28 : 32,
    left: hasBands ? (compact ? 56 : 72) : compact ? 40 : 50,
  };
  const fontSize = compact ? 9 : 11;
  const smallFontSize = compact ? 8 : 10;
  const chartWidth = displayWidth - padding.left - padding.right;
  const chartHeight = displayHeight - padding.top - padding.bottom;

  // Calculate Y range with some padding
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of data) {
    if (p.min < yMin) yMin = p.min;
    if (p.max > yMax) yMax = p.max;
  }
  const yPad = (yMax - yMin) * 0.1 || 1;
  yMin -= yPad;
  yMax += yPad;

  // When intensity bands are present, ensure yMin starts at 0 and yMax
  // covers at least the second-to-last band boundary so labels are visible.
  if (hasBands) {
    yMin = 0;
    // Find the smallest band max that is above all data
    const dataMax = Math.max(...data.map((p) => p.max));
    const bandCeiling = intensityBands.find((b) => b.max >= dataMax)?.max;
    if (bandCeiling !== undefined) {
      yMax = Math.max(yMax, bandCeiling);
    }
  }

  const [xMinMs, xMaxMs] = timeRange ?? [data[0]!.timeMs, data[data.length - 1]!.timeMs];
  const xTimeSpan = xMaxMs - xMinMs || 1;
  const timeToX = (ms: number): number => padding.left + ((ms - xMinMs) / xTimeSpan) * chartWidth;
  const xScale = (i: number): number => timeToX(data[i]!.timeMs);
  const yScale = (v: number): number =>
    padding.top + (1 - (v - yMin) / (yMax - yMin)) * chartHeight;

  // Clear
  ctx.clearRect(0, 0, displayWidth, displayHeight);

  // Draw intensity band shading (behind everything)
  if (hasBands) {
    for (const band of intensityBands) {
      const bandTop = Math.max(band.min, yMin);
      const bandBottom = Math.min(band.max, yMax);
      if (bandTop >= yMax || bandBottom <= yMin) continue;
      const y1 = yScale(bandBottom);
      const y2 = yScale(bandTop);
      ctx.fillStyle = band.color;
      ctx.fillRect(padding.left, y1, chartWidth, y2 - y1);
    }
  }

  // Draw min-max band
  ctx.fillStyle = hexToRgba(color, 0.08);
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i]!.max);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = data.length - 1; i >= 0; i--) {
    ctx.lineTo(xScale(i), yScale(data[i]!.min));
  }
  ctx.closePath();
  ctx.fill();

  // Draw P10-P90 band
  ctx.fillStyle = hexToRgba(color, 0.2);
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i]!.p90);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = data.length - 1; i >= 0; i--) {
    ctx.lineTo(xScale(i), yScale(data[i]!.p10));
  }
  ctx.closePath();
  ctx.fill();

  // Draw median line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i]!.median);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw axes
  ctx.strokeStyle = "#2a2d3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  // Y axis labels
  ctx.fillStyle = "#8b8fa3";
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  if (hasBands) {
    // Draw one label per intensity band, centred vertically in the visible portion
    for (const band of intensityBands) {
      const visibleMin = Math.max(band.min, yMin);
      const visibleMax = Math.min(band.max, yMax);
      if (visibleMin >= yMax || visibleMax <= yMin) continue;
      const midValue = (visibleMin + visibleMax) / 2;
      const y = yScale(midValue);
      ctx.fillStyle = "#8b8fa3";
      ctx.fillText(band.label, padding.left - 4, y);

      // Grid line at band boundary (skip the bottom boundary at 0)
      if (band.min > yMin) {
        ctx.strokeStyle = "#1a1d2730";
        ctx.beginPath();
        ctx.moveTo(padding.left, yScale(band.min));
        ctx.lineTo(padding.left + chartWidth, yScale(band.min));
        ctx.stroke();
      }
    }
  } else {
    const yTicks = compact ? 4 : 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = yMin + (i / yTicks) * (yMax - yMin);
      const y = yScale(v);
      ctx.fillText(compact ? formatValue(v) : `${formatValue(v)} ${unit}`, padding.left - 4, y);

      // Grid line
      ctx.strokeStyle = "#1a1d2720";
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartWidth, y);
      ctx.stroke();
    }
  }

  // X axis labels at consistent clock-hour boundaries
  ctx.fillStyle = "#8b8fa3";
  ctx.font = `${smallFontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxXLabels = compact ? 4 : 6;
  const labelTimes = computeXLabelTimes(xMinMs, xMaxMs, maxXLabels);
  for (const t of labelTimes) {
    const x = timeToX(t);
    const date = new Date(t);
    const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", hour12: true });
    const dayStr = date.toLocaleDateString(undefined, { weekday: "short" });
    ctx.fillText(`${dayStr}`, x, padding.top + chartHeight + 2);
    ctx.fillText(`${timeStr}`, x, padding.top + chartHeight + 2 + smallFontSize + 1);
  }

  // "Now" marker — vertical dashed line at current time
  const now = Date.now();
  if (now >= xMinMs && now <= xMaxMs) {
    const nowX = timeToX(now);
    ctx.save();
    ctx.strokeStyle = "#ffffff60";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(nowX, padding.top);
    ctx.lineTo(nowX, padding.top + chartHeight);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#ffffff80";
    ctx.font = `${smallFontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("now", nowX, padding.top - 1);
  }

  // Time markers — midnight, noon, sunrise, sunset
  if (latitude !== undefined && longitude !== undefined) {
    const markers = computeTimeMarkers(xMinMs, xMaxMs, latitude, longitude);
    const iconSize = compact ? 8 : 10;
    for (const marker of markers) {
      const mx = timeToX(marker.timeMs);
      const style = MARKER_STYLES[marker.type];

      // Vertical line
      ctx.save();
      ctx.strokeStyle = style.lineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, padding.top);
      ctx.lineTo(mx, padding.top + chartHeight);
      ctx.stroke();
      ctx.restore();

      // Icon above chart area
      drawMarkerIcon(ctx, marker.type, mx, padding.top - iconSize * 0.5 - 1, iconSize);
    }
  }

  // Save base image and chart state for tooltip interaction
  const baseImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
  chartStates.set(canvas, {
    data,
    unit,
    color,
    formatValue,
    padding,
    chartWidth,
    chartHeight,
    displayWidth,
    displayHeight,
    yMin,
    yMax,
    compact,
    fontSize,
    smallFontSize,
    intensityBands,
    timeToX,
    baseImage,
  });

  if (!listenersAttached.has(canvas)) {
    attachListeners(canvas);
    listenersAttached.add(canvas);
  }
}

function attachListeners(canvas: HTMLCanvasElement): void {
  let isTouch = false;

  const getX = (e: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  };

  canvas.addEventListener("pointerdown", (e) => {
    isTouch = e.pointerType === "touch";
    if (isTouch) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawTooltip(canvas, getX(e));
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (isTouch) {
      if (!e.pressure) return;
      e.preventDefault();
    }
    drawTooltip(canvas, getX(e));
  });

  canvas.addEventListener("pointerup", (e) => {
    if (isTouch) {
      canvas.releasePointerCapture(e.pointerId);
      clearTooltip(canvas);
      isTouch = false;
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (!isTouch) clearTooltip(canvas);
  });

  canvas.addEventListener("pointercancel", (e) => {
    canvas.releasePointerCapture(e.pointerId);
    clearTooltip(canvas);
    isTouch = false;
  });

  canvas.style.touchAction = "pan-y";
  canvas.style.userSelect = "none";
  (canvas.style as unknown as Record<string, string>)["-webkit-user-select"] = "none";
  canvas.style.cursor = "crosshair";
}

function clearTooltip(canvas: HTMLCanvasElement): void {
  const state = chartStates.get(canvas);
  if (!state) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(state.baseImage, 0, 0);
}

function drawTooltip(canvas: HTMLCanvasElement, pointerX: number): void {
  const state = chartStates.get(canvas);
  if (!state) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const {
    data,
    unit,
    color,
    formatValue,
    padding,
    chartWidth,
    chartHeight,
    displayWidth,
    displayHeight,
    yMin,
    yMax,
    compact,
  } = state;

  const { timeToX } = state;

  // Find nearest data point by pre-cached timestamp
  const pointerMs =
    data[0]!.timeMs +
    ((pointerX - padding.left) / chartWidth) *
      (data[data.length - 1]!.timeMs - data[0]!.timeMs || 1);
  let idx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < data.length; i++) {
    const dist = Math.abs(data[i]!.timeMs - pointerMs);
    if (dist < bestDist) {
      bestDist = dist;
      idx = i;
    }
  }
  const point = data[idx]!;

  const yScale = (v: number): number =>
    padding.top + (1 - (v - yMin) / (yMax - yMin)) * chartHeight;

  const dpr = window.devicePixelRatio || 1;
  const x = timeToX(point.timeMs);

  // Restore base chart (putImageData ignores transforms, operates in pixel space)
  ctx.putImageData(state.baseImage, 0, 0);
  // Reset transform and apply fresh dpr scale for overlay drawing
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Draw crosshair line
  ctx.strokeStyle = "#ffffff40";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, padding.top);
  ctx.lineTo(x, padding.top + chartHeight);
  ctx.stroke();

  // Draw dot on median
  const medianY = yScale(point.median);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, medianY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Build tooltip text
  const date = new Date(point.time);
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dayStr = date.toLocaleDateString(undefined, { weekday: "short" });
  const unitSuffix = unit ? ` ${unit}` : "";
  const lines = [
    `${dayStr} ${timeStr}`,
    `Median: ${formatValue(point.median)}${unitSuffix}`,
    `Range: ${formatValue(point.p10)} – ${formatValue(point.p90)}${unitSuffix}`,
  ];

  // Add intensity label when bands are configured
  if (state.intensityBands) {
    const band = state.intensityBands.find((b) => point.median >= b.min && point.median < b.max);
    if (band) {
      lines.push(band.label);
    }
  }

  // Measure tooltip
  const tooltipFont = compact ? 9 : 11;
  ctx.font = `${tooltipFont}px system-ui, sans-serif`;
  const lineHeight = tooltipFont + 4;
  const tooltipPadH = 8;
  const tooltipPadV = 6;
  let maxTextWidth = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxTextWidth) maxTextWidth = w;
  }
  const tooltipW = maxTextWidth + tooltipPadH * 2;
  const tooltipH = lines.length * lineHeight + tooltipPadV * 2;

  // Position tooltip — flip side if near edge, clamp within canvas
  let tooltipX = x + 10;
  if (tooltipX + tooltipW > displayWidth - 2) {
    tooltipX = x - tooltipW - 10;
  }
  tooltipX = Math.max(2, Math.min(displayWidth - tooltipW - 2, tooltipX));
  let tooltipY = medianY - tooltipH / 2;
  tooltipY = Math.max(2, Math.min(displayHeight - tooltipH - 2, tooltipY));

  // Draw tooltip background
  ctx.fillStyle = "rgba(20, 22, 30, 0.92)";
  ctx.strokeStyle = "#3a3d4a";
  ctx.lineWidth = 1;
  roundRect(ctx, tooltipX, tooltipY, tooltipW, tooltipH, 4);
  ctx.fill();
  ctx.stroke();

  // Draw tooltip text
  ctx.fillStyle = "#e4e6ed";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0 ? "#8b8fa3" : "#e4e6ed";
    ctx.fillText(lines[i]!, tooltipX + tooltipPadH, tooltipY + tooltipPadV + i * lineHeight);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
