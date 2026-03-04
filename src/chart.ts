import type { ForecastPoint } from "./types.js";

interface ChartOptions {
  canvas: HTMLCanvasElement;
  data: ForecastPoint[];
  label: string;
  unit: string;
  color: string;
  /** Format value for display */
  formatValue?: (v: number) => string;
}

/**
 * Render a probabilistic forecast chart on a canvas element.
 * Shows:
 * - P10-P90 range as a shaded band
 * - Min-Max range as a lighter band
 * - Median as a solid line
 * - Time labels on X axis
 * - Value labels on Y axis
 */
export function renderChart(opts: ChartOptions): void {
  const { canvas, data, unit, color, formatValue = (v) => v.toFixed(1) } = opts;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width * dpr;
  const height = rect.height * dpr;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const displayWidth = rect.width;
  const displayHeight = rect.height;
  const padding = { top: 10, right: 16, bottom: 32, left: 50 };
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

  const xScale = (i: number): number => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (v: number): number =>
    padding.top + (1 - (v - yMin) / (yMax - yMin)) * chartHeight;

  // Clear
  ctx.clearRect(0, 0, displayWidth, displayHeight);

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
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(v);
    ctx.fillText(`${formatValue(v)} ${unit}`, padding.left - 4, y);

    // Grid line
    ctx.strokeStyle = "#1a1d2720";
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  // X axis labels (show every N hours)
  ctx.fillStyle = "#8b8fa3";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xLabelInterval = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += xLabelInterval) {
    const p = data[i]!;
    const x = xScale(i);
    const date = new Date(p.time);
    const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", hour12: true });
    const dayStr = date.toLocaleDateString(undefined, { weekday: "short" });
    ctx.fillText(`${dayStr}`, x, padding.top + chartHeight + 4);
    ctx.fillText(`${timeStr}`, x, padding.top + chartHeight + 16);
  }

  // Legend
  ctx.fillStyle = "#8b8fa3";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("━ median  ▓ p10-p90  ░ min-max", displayWidth - padding.right, 8);
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
