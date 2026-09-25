/**
 * localStorage access that degrades to "nothing persisted" when storage is
 * unavailable. Reading `localStorage` throws when the browser blocks site
 * data, and writes throw when the quota is exceeded; either used to take
 * down the whole app at startup, since preferences are read on load.
 */

/** Read a stored string, or null when absent or storage is unavailable */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store a string, silently dropping it when storage is unavailable or full */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full — the preference just won't persist
  }
}
