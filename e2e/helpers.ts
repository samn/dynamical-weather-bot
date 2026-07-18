import type { Page } from "@playwright/test";
import { ProxyAgent, type Dispatcher } from "undici";

// ── Shared e2e helpers ──────────────────────────────────────────────────

/** Shared undici ProxyAgent (one warm connection pool per worker process) */
let sharedDispatcher: Dispatcher | undefined | null = null;

/** Create (once) an undici ProxyAgent if HTTPS_PROXY is set in the environment */
function getProxyDispatcher(): Dispatcher | undefined {
  if (sharedDispatcher === null) {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    sharedDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  }
  return sharedDispatcher;
}

/**
 * Fetch with retries for transient failures. Network errors and 5xx
 * responses are retried (idempotent methods only) so a single dropped
 * connection doesn't fail a whole forecast load.
 * Returns null when all attempts fail.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  method: string,
): Promise<Response | null> {
  const MAX_ATTEMPTS = method === "GET" || method === "HEAD" ? 3 : 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(url, init);
    } catch {
      // fall through to retry/give-up below
    }
    if (response && response.status < 500) return response;
    if (attempt === MAX_ATTEMPTS) return response;
    // Drain the failed response so its socket returns to the pool
    await response?.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

/**
 * Route all external (non-localhost) requests through Node.js fetch
 * with proxy support. This bypasses browser CORS restrictions and
 * proxy authentication issues while keeping all data real.
 */
export async function proxyExternalRequests(page: Page): Promise<void> {
  const dispatcher = getProxyDispatcher();
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    async (route) => {
      const request = route.request();
      const response = await fetchWithRetry(
        request.url(),
        {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() || undefined,
          dispatcher,
        } as RequestInit,
        request.method(),
      );
      // The page may close while a retry backoff is sleeping — swallow
      // fulfill/abort errors so teardown doesn't see unhandled rejections.
      try {
        if (!response) {
          await route.abort("failed");
          return;
        }
        const body = Buffer.from(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          headers[key] = value;
        }
        await route.fulfill({ status: response.status, headers, body });
      } catch {
        // Route already handled or page closed — nothing to do.
      }
    },
  );
}

/**
 * Block all requests to the forecast data stores (Icechunk S3 buckets and
 * the legacy dynamical.org Zarr host). Used to force cache-only loads and
 * keep background refreshes off the network.
 */
export async function blockDataStores(page: Page): Promise<void> {
  await page.route("**/data.dynamical.org/**", (route) => route.abort("blockedbyclient"));
  await page.route("**/*.s3.us-west-2.amazonaws.com/**", (route) =>
    route.abort("blockedbyclient"),
  );
}

/**
 * Page-side predicate: does a canvas have non-trivial rendered content
 * (≥1% non-transparent pixels)? Shared by the load-wait and assertions so
 * the threshold lives in exactly one place. Must stay self-contained — it
 * is serialized into the page by waitForFunction/evaluate.
 */
const canvasHasContentInPage = (id: string): boolean => {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { width, height } = canvas;
  if (width === 0 || height === 0) return false;
  const data = ctx.getImageData(0, 0, width, height).data;
  let nonTransparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > 0) nonTransparent++;
  }
  return nonTransparent > width * height * 0.01;
};

/**
 * Wait for a complete forecast to load and render.
 * Works for both fresh network loads and cache-based loads.
 * Detects error states early and provides a clear failure message.
 */
export async function waitForForecastLoad(page: Page, timeout = 120_000): Promise<void> {
  // Wait for app to reach a terminal state: success or error
  await page.waitForFunction(
    () => {
      const error = document.getElementById("error");
      const forecast = document.getElementById("forecast");
      const initTime = document.getElementById("init-time-label");
      const controls = document.getElementById("model-controls");
      if (!error || !forecast || !initTime || !controls) return false;
      // Error state reached
      if (!error.classList.contains("hidden")) return true;
      // Full success: forecast visible, init time set, controls visible, cache populated
      // (cache is written only after all variable fetches complete).
      const cacheRaw = localStorage.getItem("weather-cache");
      const cacheHasEntry =
        cacheRaw !== null && Object.keys(JSON.parse(cacheRaw) as object).length > 0;
      return (
        !forecast.classList.contains("hidden") &&
        initTime.textContent !== "" &&
        !controls.classList.contains("hidden") &&
        cacheHasEntry
      );
    },
    { timeout },
  );

  // Check for error
  const errorVisible = !(await page
    .locator("#error")
    .evaluate((el) => el.classList.contains("hidden")));
  if (errorVisible) {
    const msg = await page.locator("#error").textContent();
    throw new Error(`Forecast failed to load: ${msg}`);
  }

  // Wait for chart canvas to render
  await page.waitForFunction(canvasHasContentInPage, "temp-chart", { timeout: 30_000 });
}

/** Extract the first cache entry from localStorage. */
export async function extractCacheEntry(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("weather-cache");
    if (!raw) return null;
    const store = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(store);
    if (keys.length === 0) return null;
    return store[keys[0]!] as Record<string, unknown>;
  });
}

/** Check whether a canvas has non-trivial rendered content (≥1% non-transparent pixels). */
export async function canvasHasContent(page: Page, canvasId: string): Promise<boolean> {
  return page.evaluate(canvasHasContentInPage, canvasId);
}

/** Get a pixel-sum fingerprint for a canvas (for change detection). */
export async function getCanvasPixelSum(page: Page, canvasId: string): Promise<number> {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]!;
    return sum;
  }, canvasId);
}

/** Shape of a forecast data point extracted from cache */
export interface CachedPoint {
  time: string;
  hoursFromNow: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

/** Shape of a per-model input extracted from cache */
export interface CachedModelInput {
  model: string;
  points: CachedPoint[];
  isEnsemble: boolean;
}
