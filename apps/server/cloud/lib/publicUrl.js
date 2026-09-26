/**
 * The origin (scheme + host) that users actually reach this deployment on.
 *
 * Signing links, reminder mails, the certificate and the MCP handshake all need
 * an absolute url. Deriving it from the incoming `Host` header lets any client
 * dictate the links a signer receives (host header injection), so the header is
 * only a development fallback:
 *
 *   1. PUBLIC_URL          the app origin, e.g. https://sign.example.com
 *   2. SERVER_URL          its origin, when absolute and not a loopback host
 *      (SERVER_URL is the api url, e.g. https://sign.example.com/api/app)
 *   3. the request itself   `req.protocol` + `Host`, for local development where
 *      neither variable is set. `req.protocol` honours `trust proxy`.
 */

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

/** The origin of an absolute url string, or '' when it is unusable. */
function originOf(value, { allowLoopback = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    if (!allowLoopback && LOOPBACK.test(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * The configured public origin, independent of any request.
 * @returns {string} e.g. 'https://sign.example.com', or '' when unconfigured.
 */
export function configuredPublicOrigin() {
  return (
    originOf(process.env.PUBLIC_URL) ||
    originOf(process.env.SERVER_URL, { allowLoopback: false }) ||
    ''
  );
}

/**
 * The public origin for one request: the configured origin when there is one,
 * otherwise the origin the request came in on (development only).
 * @param {import('express').Request} [req]
 * @returns {string} an origin with no trailing slash, or '' when unknowable.
 */
export function publicOriginFor(req) {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const host = req?.get?.('host') || req?.headers?.host || '';
  if (!host) return '';
  const protocol = req?.protocol || 'http';
  return `${protocol}://${host}`;
}
