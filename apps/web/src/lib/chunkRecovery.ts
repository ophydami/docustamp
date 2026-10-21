/**
 * Recovery when a piece of the app fails to download.
 *
 * Feature pages are lazy chunks (see app/router.tsx). The browser can fail to
 * fetch one for reasons that have nothing to do with the code: a VPN or proxy
 * dropping a single request, a flaky connection, or a deploy that replaced the
 * files under a tab that was already open. Vite's preload helper dispatches
 * `vite:preloadError` before it throws in that case, and a lazy page with no
 * dependencies of its own throws a bare "Failed to fetch dynamically imported
 * module" instead.
 *
 * Both get the same treatment: reload the page once. A fresh load repairs a
 * stale tab outright and gets past a one-off hiccup. The reload is remembered
 * in sessionStorage per URL, so a page that fails again within RETRY_WINDOW_MS
 * is left to RouteErrorPage, which offers "Try again" instead of reloading
 * forever. With no storage to remember it (private mode, strict settings) the
 * page is never auto-reloaded, for the same reason.
 */

const STORAGE_KEY = "docustamp:chunk-reload";
/** A second failure inside this window is shown, not retried. */
const RETRY_WINDOW_MS = 30_000;

let reloadPending = false;

type ReloadRecord = { href: string; at: number };

function readRecord(): ReloadRecord | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReloadRecord>;
    return typeof parsed.href === "string" && typeof parsed.at === "number"
      ? { href: parsed.href, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

function writeRecord(record: ReloadRecord): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** True when this URL already auto-reloaded for a download failure a moment ago. */
export function alreadyReloaded(href = window.location.href, now = Date.now()): boolean {
  const last = readRecord();
  return !!last && last.href === href && now - last.at < RETRY_WINDOW_MS;
}

/** A reload has been requested on this page; the error page shows a spinner meanwhile. */
export function isReloadPending(): boolean {
  return reloadPending;
}

/**
 * Reload the page once for a download failure. Returns false when the page
 * already reloaded for one just now, or when nothing can remember that it did,
 * so the caller shows the error instead.
 */
export function reloadOnce(): boolean {
  if (reloadPending) return true;
  const href = window.location.href;
  if (alreadyReloaded(href)) return false;
  if (!writeRecord({ href, at: Date.now() })) return false;
  reloadPending = true;
  window.location.reload();
  return true;
}

/** The messages browsers use when a dynamic import() cannot be fetched. */
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chrome, Edge, Opera
  /Importing a module script failed/i, // Safari
  /error loading dynamically imported module/i, // Firefox
  /Unable to preload CSS/i // Vite's own message for a stylesheet
];

/** Whether an error is a page or stylesheet that could not be downloaded. */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Call once at startup, before anything is rendered. */
export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    // The event is not cancelled: the error still throws, so the console keeps
    // the real reason and RouteErrorPage shows a spinner until the reload lands.
    console.warn("[docustamp] a part of the app failed to download", event.payload);
    reloadOnce();
  });
}
