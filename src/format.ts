/** Format a forecast init time ISO string for display */
export function formatInitTime(iso: string): string {
  const d = new Date(iso);
  return `Forecast initialized ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}

/**
 * Format a timestamp as a short human-readable day-part phrase in local
 * time, e.g. "Wed morning", "Thu afternoon", "early Sat" (before 5 AM).
 */
export function formatDayPart(time: string | Date): string {
  const d = typeof time === "string" ? new Date(time) : time;
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const h = d.getHours();
  if (h < 5) return `early ${weekday}`;
  if (h < 12) return `${weekday} morning`;
  if (h < 17) return `${weekday} afternoon`;
  if (h < 21) return `${weekday} evening`;
  return `${weekday} night`;
}
