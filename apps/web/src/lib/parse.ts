import Parse from "parse";

/**
 * Parse SDK bootstrap.
 *
 * VITE_APPID      app id, must match APP_ID on the server (default "opensign")
 * VITE_SERVERURL  full server URL, e.g. https://sign.example.com/api/app
 *                 When unset we use same-origin `/api/app`, which the Vite dev
 *                 proxy forwards to VITE_DEV_PROXY_TARGET and Caddy forwards
 *                 to the Parse container in production.
 */
export const APP_ID: string = import.meta.env.VITE_APPID || "opensign";
export const SERVER_URL: string = (
  import.meta.env.VITE_SERVERURL || `${window.location.origin}/api/app`
).replace(/\/+$/, "");

/**
 * Where the server's plain Express routes live.
 *
 * The server mounts parse-server at `PARSE_MOUNT` (default `/app`) and its own
 * routes (`/docxtopdf`, `/decryptpdf`, `/deleteuser`, `/mcp`, `/v1`) at the root
 * of the same Express app, so the base is SERVER_URL with the mount stripped:
 * `https://host/api/app` -> `https://host/api`.
 *
 * The mount is configurable, so this is not a hardcoded `/app`:
 *  - VITE_CUSTOM_ROUTE_BASE wins outright, for a deployment that puts the two
 *    behind different hostnames or prefixes.
 *  - VITE_PARSE_MOUNT (must match the server's PARSE_MOUNT) is stripped as a
 *    suffix, which is the only way to get a multi-segment mount right.
 *  - Otherwise the last path segment goes, which covers every single-segment
 *    mount (`/app`, `/parse`, ...).
 */
export const CUSTOM_ROUTE_BASE: string = (() => {
  const override = import.meta.env.VITE_CUSTOM_ROUTE_BASE;
  if (typeof override === "string" && override.trim()) return override.trim().replace(/\/+$/, "");
  const mount = (import.meta.env.VITE_PARSE_MOUNT ?? "").trim().replace(/\/+$/, "");
  if (mount) {
    const suffix = mount.startsWith("/") ? mount : `/${mount}`;
    if (SERVER_URL.endsWith(suffix)) return SERVER_URL.slice(0, -suffix.length);
  }
  return SERVER_URL.replace(/\/[^/]*$/, "");
})();

/** The custom-route base, as a function for call sites that read it lazily. */
export function customRouteBase(): string {
  return CUSTOM_ROUTE_BASE;
}

let initialized = false;

export function initParse() {
  if (initialized) return Parse;
  Parse.initialize(APP_ID, import.meta.env.VITE_JS_KEY || undefined);
  Parse.serverURL = SERVER_URL;
  initialized = true;
  return Parse;
}

export function sessionToken(): string | undefined {
  return Parse.User.current()?.getSessionToken() ?? undefined;
}

/**
 * Headers for raw HTTP calls to the Parse server.
 * Several cloud functions on this server read the session from a lowercase
 * `sessiontoken` header instead of the standard one, so we always send both.
 */
export function parseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = sessionToken();
  return {
    "Content-Type": "application/json",
    "X-Parse-Application-Id": APP_ID,
    ...(token ? { "X-Parse-Session-Token": token, sessiontoken: token } : {}),
    ...extra
  };
}

export class CloudError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "CloudError";
    this.code = code;
  }
}

/**
 * Call a cloud function over raw HTTP (not the SDK) so both session header
 * spellings are sent and results come back as plain JSON, not Parse.Objects.
 * Throws CloudError on a Parse error envelope or when the function returns
 * `{ error }` / `{ status: "error" }` inside `result` (this server does both).
 */
export async function cloud<T = unknown>(
  name: string,
  params: Record<string, unknown> = {},
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await fetch(`${SERVER_URL}/functions/${name}`, {
    method: "POST",
    headers: parseHeaders(opts.headers),
    body: JSON.stringify(params),
    signal: opts.signal
  });
  let json: { result?: unknown; error?: unknown; code?: number } = {};
  try {
    json = await res.json();
  } catch {
    if (!res.ok) throw new CloudError(`${name} failed: HTTP ${res.status}`);
  }
  if (!res.ok || json.error !== undefined) {
    const msg = typeof json.error === "string" ? json.error : `${name} failed: HTTP ${res.status}`;
    throw new CloudError(msg, json.code);
  }
  const result = json.result as T;
  if (result && typeof result === "object") {
    const r = result as { error?: unknown; status?: unknown; message?: unknown; reason?: unknown };
    if (typeof r.error === "string" && r.error) throw new CloudError(r.error);
    // `status: "error"` is a failure even when the function says nothing else:
    // the mail functions used to answer a bare `{ status: "error" }`, which this
    // let through as a successful call.
    if (r.status === "error") {
      const detail = [r.message, r.reason].find((v) => typeof v === "string" && v) as string | undefined;
      throw new CloudError(detail ?? `${name} reported a failure`);
    }
  }
  return result;
}

/** GET/PUT/POST against Parse REST classes with the same headers. */
export async function rest<T = unknown>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; query?: Record<string, string> } = {}
): Promise<T> {
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const res = await fetch(`${SERVER_URL}/${path.replace(/^\/+/, "")}${qs}`, {
    method: init.method ?? "GET",
    headers: parseHeaders(),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloudError((json as { error?: string }).error ?? `HTTP ${res.status}`, (json as { code?: number }).code);
  return json as T;
}

export { Parse };
