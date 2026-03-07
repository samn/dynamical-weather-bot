/** Format a forecast init time ISO string for display */
export function formatInitTime(iso: string): string {
  const d = new Date(iso);
  return `Forecast initialized ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}
