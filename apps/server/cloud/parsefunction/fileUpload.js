import { cloudServerUrl, serverAppId } from '../../Utils.js';
import { DEFAULT_URL_TTL, signLocalUrl } from '../lib/fileUrls.js';
import { checkRateLimit, clientIp, resolveCaller } from './authGuard.js';

const MAX_URL_LENGTH = 2048;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const RATE_AUTHENTICATED_PER_MIN = 120;
const RATE_ANONYMOUS_PER_MIN = 60;

/** The origin of an http(s) url, or `''` for anything else. */
export function httpOrigin(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * The origins this deployment serves its own files from: the public url the app
 * is reached at, and the loopback url the server calls itself on. Read from the
 * environment on every call so tests (and a reconfigured deployment) are not
 * pinned to whatever was set when this module was first imported.
 */
export function ownServerOrigins() {
  const origins = new Set();
  for (const value of [process.env.SERVER_URL, process.env.PUBLIC_URL, cloudServerUrl]) {
    const origin = httpOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * Split a local file url into its parts, or return null when it is not one of
 * ours. "Ours" means the origin is one this server serves (so a foreign host
 * cannot pass by simply putting `/files/` in its path) and the path is a Parse
 * file path: `/files/<appId>/<name>`, or the older `/files/<name>` that some
 * stored rows still carry.
 */
export function localFileUrlParts(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!ownServerOrigins().has(parsed.origin)) return null;
  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const filesAt = segments.indexOf('files');
  if (filesAt === -1) return null;
  const after = segments.slice(filesAt + 1);
  if (after.length < 1 || after.length > 2) return null;
  const fileName = after[after.length - 1];
  if (!FILE_NAME_RE.test(fileName || '')) return null;
  return {
    // The bare url; a caller-supplied token or query string is discarded.
    url: `${parsed.origin}${parsed.pathname}`,
    appId: after.length === 2 ? after[0] : '',
    fileName,
  };
}

/**
 * `fileupload` only mints a JWT for a local `/files/` URL; it never accepts
 * file bytes or base64, so there is no size/mime check to make here. What it
 * used to lack is any check that the string it signs is even one of our files,
 * so it would happily sign anything handed to it.
 */
export function assertLocalFileUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide a valid file url.');
  }
  const parts = localFileUrlParts(rawUrl);
  if (!parts || parts.appId !== serverAppId) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'Only files stored on this server can be signed.'
    );
  }
  return parts.url;
}

export default async function fileUpload(request) {
  const fileUrl = assertLocalFileUrl(request.params?.url);
  const caller = request.master ? null : await resolveCaller(request);
  if (!request.master) {
    // Guest signers of a document without `IsEnableOTP` genuinely have no
    // session (GuestLogin clears localStorage and only the OTP path mints one),
    // and they reach this through image widgets and prefill images. So the
    // anonymous path stays open but is validated above and rate limited here.
    checkRateLimit(
      'fileupload',
      caller ? `u:${caller.id}` : `ip:${clientIp(request)}`,
      caller ? RATE_AUTHENTICATED_PER_MIN : RATE_ANONYMOUS_PER_MIN
    );
  }
  try {
    const urlwithjwt = signLocalUrl(fileUrl, DEFAULT_URL_TTL);
    return { url: urlwithjwt };
  } catch (err) {
    console.log('Err ', err);
    throw err;
  }
}
