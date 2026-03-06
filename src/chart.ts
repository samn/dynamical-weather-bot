import type { ForecastPoint } from "./types.js";

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
  /** Saved image of the fully rendered chart (before any tooltip overlay) */
  baseImage: ImageData;
}

interface ConvertedPoint extends ForecastPoint {
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

const chartStates = new WeakMap<HTMLCanvasElement, ChartState>();
const listenersAttached = new WeakSet<HTMLCanvasElement>();

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
  } = opts;

  const conv = convertValue ?? ((v: number) => v);
  const data: ConvertedPoint[] = rawData.map((p) => ({
    ...p,
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

  const xScale = (i: number): number => padding.left + (i / (data.length - 1)) * chartWidth;
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

  // X axis labels (show every N hours)
  ctx.fillStyle = "#8b8fa3";
  ctx.font = `${smallFontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxXLabels = compact ? 4 : 6;
  const xLabelInterval = Math.max(1, Math.floor(data.length / maxXLabels));
  for (let i = 0; i < data.length; i += xLabelInterval) {
    const p = data[i]!;
    const x = xScale(i);
    const date = new Date(p.time);
    const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", hour12: true });
    const dayStr = date.toLocaleDateString(undefined, { weekday: "short" });
    ctx.fillText(`${dayStr}`, x, padding.top + chartHeight + 2);
    ctx.fillText(`${timeStr}`, x, padding.top + chartHeight + 2 + smallFontSize + 1);
  }

  // "Now" marker — vertical dashed line at current time
  const now = Date.now();
  const firstTime = new Date(data[0]!.time).getTime();
  const lastTime = new Date(data[data.length - 1]!.time).getTime();
  if (now >= firstTime && now <= lastTime) {
    const fraction = (now - firstTime) / (lastTime - firstTime);
    const nowX = padding.left + fraction * chartWidth;
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
      drawTooltip(canvas, getX(e));
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (isTouch && !e.pressure) return;
    drawTooltip(canvas, getX(e));
  });

  canvas.addEventListener("pointerup", () => {
    if (isTouch) {
      clearTooltip(canvas);
      isTouch = false;
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (!isTouch) clearTooltip(canvas);
  });

  canvas.addEventListener("pointercancel", () => {
    clearTooltip(canvas);
    isTouch = false;
  });

  canvas.style.touchAction = "pan-y";
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

  // Find nearest data point index from pointer x
  const fraction = (pointerX - padding.left) / chartWidth;
  const rawIdx = fraction * (data.length - 1);
  const idx = Math.max(0, Math.min(data.length - 1, Math.round(rawIdx)));
  const point = data[idx]!;

  const xScale = (i: number): number => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (v: number): number =>
    padding.top + (1 - (v - yMin) / (yMax - yMin)) * chartHeight;

  const dpr = window.devicePixelRatio || 1;
  const x = xScale(idx);

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
    const band = state.intensityBands.find(
      (b) => point.median >= b.min && point.median < b.max,
    );
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
