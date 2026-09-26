import dns from 'node:dns/promises';
import net from 'node:net';
import axios from 'axios';
import { flattenPdf, generateId, sanitizeFileName, useLocal } from '../../Utils.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import { localFileUrlParts, ownServerOrigins } from '../parsefunction/fileUpload.js';
import { objectStorageOrigins, signLocalUrl, signStoredUrl } from './fileUrls.js';

/**
 * File helpers shared by the API, the MCP tools and the AI flow: upload PDF bytes
 * the way the web app does (flatten existing form fields first), fetch the bytes
 * of a stored document back for analysis, and decide which urls this deployment
 * is willing to fetch server side or store on a document.
 *
 * Three rules hold everything together:
 *
 *   assertFetchableUrl   may the server issue a GET to this url at all?
 *                        (http(s) only, and the host must resolve to a public
 *                        address unless it is one of our own storage origins)
 *   resolveFileUrl       turn a stored url into one that resolves right now.
 *                        Only our own urls are signed/presigned; a foreign url
 *                        is handed back untouched, and only when it is fetchable.
 *   assertStoredFileUrl  may this url be written onto a document? Only urls this
 *                        deployment produced; anything else is downloaded once
 *                        and re-uploaded, so no third party ever serves the bytes
 *                        a signer sees.
 *
 * Environment flags:
 *   ALLOW_PRIVATE_FETCH=true  skip the public-address check in
 *                             `assertFetchableUrl`. Only for tests that point
 *                             the server at a local fixture host; never set it
 *                             on a deployment.
 */

export const MAX_PDF_BYTES = 80 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
const PDF_MAGIC = '%PDF';
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Lifetime of the link this server signs for its own use (analysis downloads,
 * certificate rendering). Longer than a browser link because the fetch happens
 * behind a queue.
 */
const SERVER_FETCH_TTL = 600;

/**
 * One message for every network-level refusal (bad host, private address, DNS
 * failure, redirect, connection error), so the endpoint cannot be used to probe
 * what does or does not exist inside the network.
 */
const FETCH_FAILED = 'The file could not be fetched.';

/** Hostnames that name a metadata service whatever they resolve to. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

function fetchFailed() {
  return new Parse.Error(Parse.Error.VALIDATION_ERROR, FETCH_FAILED);
}

export function isPdfBytes(bytes) {
  return (
    bytes && bytes.length > 4 && Buffer.from(bytes.subarray(0, 4)).toString('latin1') === PDF_MAGIC
  );
}

export function bytesFromBase64(value) {
  if (typeof value !== 'string' || !value) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'fileBase64 is required.');
  }
  const clean =
    value.includes(',') && /^data:/i.test(value) ? value.slice(value.indexOf(',') + 1) : value;
  // Refuse on the encoded length, before a copy of the string and a decode of it
  // exist: the analyze paths never upload, so this used to be the only limit and
  // there was none. Base64 is 4 characters per 3 bytes.
  if (clean.length > Math.ceil((MAX_PDF_BYTES / 3) * 4) + 1024) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The PDF is larger than 80 MB.');
  }
  const bytes = Buffer.from(clean.replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'fileBase64 is empty.');
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The PDF is larger than 80 MB.');
  }
  return new Uint8Array(bytes);
}

/**
 * Upload PDF bytes and report what happened to them.
 *
 * Flattening is not cosmetic: a PDF that keeps its AcroForm has live interactive
 * fields underneath the signing widgets, and they capture the signer's clicks.
 * A failure used to be logged and nothing else, so a damaged form uploaded
 * through the API looked exactly like a clean one. The result says whether the
 * bytes were flattened, so the caller can pass it on as a warning.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {string} [fileName] original file name, only used for the extension check
 * @returns {Promise<{url: string, flattened: boolean, flattenError?: string}>}
 */
export async function uploadPdfBytesDetailed(bytes, fileName = 'document.pdf', { flatten = true } = {}) {
  if (!isPdfBytes(bytes)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Only PDF files can be uploaded here.');
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The PDF is larger than 80 MB.');
  }
  let data = bytes;
  let flattened = true;
  let flattenError;
  if (flatten === false) {
    // Keep the bytes exactly as given: a signed copy stored for verify_document
    // must keep its hash. The default flattens any AcroForm so live form fields
    // cannot sit under the signing widgets.
    flattened = false;
    flattenError = 'skipped on request (keepOriginal)';
  } else {
    try {
      // Same as the web upload pipeline: flatten any AcroForm so old form fields do
      // not fight the signing widgets.
      data = await flattenPdf(bytes);
    } catch (err) {
      flattened = false;
      flattenError = err?.message || String(err);
      console.log('files: flattenPdf failed, uploading as-is', flattenError);
    }
  }
  const base =
    sanitizeFileName(String(fileName || 'document.pdf').replace(/\.pdf$/i, '')) || 'document';
  const name = `${generateId(12)}_${base.slice(0, 60)}.pdf`;
  const res = await parseUploadFile(name, Buffer.from(data), 'application/pdf');
  const url = res?.url;
  if (!url) throw new Parse.Error(Parse.Error.FILE_SAVE_ERROR, 'Upload failed.');
  return { url, flattened, flattenError };
}

/**
 * Upload PDF bytes and return the stored URL (token-signed for local storage).
 * Use `uploadPdfBytesDetailed` when the caller can surface a warning.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {string} [fileName] original file name, only used for the extension check
 * @returns {Promise<string>}
 */
export async function uploadPdfBytes(bytes, fileName = 'document.pdf') {
  return (await uploadPdfBytesDetailed(bytes, fileName)).url;
}

/* --------------------------------------------------------------- addresses */

function ipv4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link local + the metadata address
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function ipv6Blocked(raw) {
  const ip = raw.toLowerCase().replace(/%.*$/, '');
  if (ip === '::' || ip === '::1') return true; // unspecified, loopback
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) {
    // The hex spelling of an IPv4-mapped address.
    const [, hi, lo] = ip.split(':').slice(-3);
    const n = (parseInt(hi, 16) << 16) + parseInt(lo, 16);
    return ipv4Blocked([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  if (/^fe[89ab]/.test(ip)) return true; // link local fe80::/10
  if (/^f[cd]/.test(ip)) return true; // unique local fc00::/7
  if (/^ff/.test(ip)) return true; // multicast
  return false;
}

/** True for any address the server must never be talked into connecting to. */
export function isBlockedAddress(address) {
  const version = net.isIP(String(address || ''));
  if (version === 4) return ipv4Blocked(String(address));
  if (version === 6) return ipv6Blocked(String(address));
  return true;
}

/* ------------------------------------------------------------------ origins */

/** Every origin this deployment serves its own files from. */
export function storageOrigins() {
  const origins = ownServerOrigins();
  for (const origin of objectStorageOrigins()) origins.add(origin);
  return origins;
}

function parseHttpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}

/**
 * The url as we would store it, or `''` when it is not one of ours: a local
 * `/files/...` url on one of our origins, or an object on our bucket. The query
 * string is dropped, so a caller-supplied token or presign never gets stored.
 */
export function storedFileUrl(raw) {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return '';
  const local = localFileUrlParts(parsed.href);
  if (local) return local.url;
  if (objectStorageOrigins().has(parsed.origin)) return `${parsed.origin}${parsed.pathname}`;
  return '';
}

/** True when the url is one this deployment produced. */
export function isStoredFileUrl(raw) {
  return Boolean(storedFileUrl(raw));
}

/* ------------------------------------------------------------------ fetching */

/**
 * Refuse to let a caller aim the server at anything but a public http(s) host.
 * Our own storage origins are allowed whatever they resolve to (a local
 * deployment serves its files off loopback); everything else has to resolve to
 * public addresses only. Every refusal past the scheme check uses one message so
 * the endpoint is not an internal host/port oracle.
 *
 * A DNS answer can still change between this check and the request (rebinding);
 * `maxRedirects: 0` and the short timeout below keep that window small, and no
 * response body is ever echoed back to the caller.
 *
 * @param {string} rawUrl
 * @returns {Promise<string>} the url, unchanged
 */
export async function assertFetchableUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Provide an http(s) file url.');
  }
  if (storageOrigins().has(parsed.origin)) return parsed.href;
  if (process.env.ALLOW_PRIVATE_FETCH === 'true') return parsed.href;

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host ||
    BLOCKED_HOSTS.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal')
  ) {
    throw fetchFailed();
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw fetchFailed();
    return parsed.href;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw fetchFailed();
  }
  if (!addresses.length) throw fetchFailed();
  for (const entry of addresses) {
    if (isBlockedAddress(entry?.address)) throw fetchFailed();
  }
  return parsed.href;
}

/**
 * A URL that will resolve right now. Only urls of ours are signed: a local file
 * gets the MASTER_KEY JWT, an object on our bucket gets a presign. A foreign url
 * is returned untouched, and only when the server would be allowed to fetch it.
 */
/**
 * Lifetime of the download urls handed back over the API / MCP. The server's own
 * fetches use SERVER_FETCH_TTL; an agent that reads a url in one step and uses
 * it two steps later needs longer (the old 600 s died between steps).
 */
export const API_URL_TTL = (() => {
  const n = Number(process.env.API_FILE_URL_TTL);
  return Number.isFinite(n) && n >= 300 && n <= 86400 ? Math.floor(n) : 3600;
})();

export async function resolveFileUrl(url, { ttl } = {}) {
  const lifetime = Number(ttl) > 0 ? Number(ttl) : SERVER_FETCH_TTL;
  if (!url) return '';
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Provide an http(s) file url.');
  }
  if (ownServerOrigins().has(parsed.origin)) {
    // Our own server. `/files/` is the only path worth signing; anything else on
    // our origin is handed back as it came in.
    if (!parsed.pathname.includes('/files/')) return parsed.href;
    return signLocalUrl(`${parsed.origin}${parsed.pathname}`, lifetime);
  }
  if (objectStorageOrigins().has(parsed.origin)) {
    if (useLocal !== 'true') {
      try {
        return await signStoredUrl(`${parsed.origin}${parsed.pathname}`, lifetime);
      } catch (err) {
        // Falling back to the unsigned url only moved the failure: the bucket
        // answers with an AccessDenied body, the magic-byte check rejects it and
        // the user is told their file is not a PDF. Say what is actually broken.
        console.log('files: presign failed', err?.message);
        throw new Parse.Error(
          Parse.Error.FILE_SAVE_ERROR,
          'Could not create a download link for this file: object storage is misconfigured.'
        );
      }
    }
    return parsed.href;
  }
  await assertFetchableUrl(parsed.href);
  return parsed.href;
}

/** Download the bytes of a stored (or any fetchable http) PDF. */
export async function fetchPdfBytes(url) {
  // resolveFileUrl signs our own urls and validates foreign ones, so by the time
  // we have a target it is either ours or a public host.
  const target = await resolveFileUrl(url);
  if (!target) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'A file url is required.');
  let res;
  try {
    res = await axios.get(target, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_PDF_BYTES,
      maxBodyLength: MAX_PDF_BYTES,
      // A redirect could point back at a private address that the check above
      // never saw, so redirects are refused rather than followed.
      maxRedirects: 0,
      timeout: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    console.log('files: fetch failed', err?.message);
    throw fetchFailed();
  }
  const bytes = new Uint8Array(res.data);
  if (!isPdfBytes(bytes)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The file at that URL is not a PDF.');
  }
  return bytes;
}

/** Accept either `{ fileBase64 }` or `{ url }` and return PDF bytes. */
export async function bytesFromInput(input = {}) {
  if (input.fileBase64) return bytesFromBase64(input.fileBase64);
  if (input.url) return await fetchPdfBytes(String(input.url));
  throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Provide fileBase64 or url.');
}

/* ------------------------------------------------------------------ storing */

/**
 * Refuse a stored url that another account's document already uses.
 *
 * We cannot prove who uploaded a given object, but we can see who is using it:
 * if a document outside the caller's account (and outside their tenant) points
 * at this file, the caller has no business attaching it to a document of their
 * own. Templates are deliberately shareable (SharedWith / SharedWithUsers), so
 * they are not treated as proof of exclusive ownership.
 */
async function assertFileNotOwnedByOthers(url, caller) {
  if (!caller?.userId || !url) return;
  const byUrl = new Parse.Query('contracts_Document');
  byUrl.equalTo('URL', url);
  const bySignedUrl = new Parse.Query('contracts_Document');
  bySignedUrl.equalTo('SignedUrl', url);
  const query = Parse.Query.or(byUrl, bySignedUrl);
  query.include('ExtUserPtr');
  query.limit(50);
  let rows;
  try {
    rows = await query.find({ useMasterKey: true });
  } catch (err) {
    // Availability over strictness: a failed lookup must not block a legitimate
    // create, the url itself has already been checked for shape and origin.
    console.log('files: ownership check failed', err?.message);
    return;
  }
  for (const row of rows) {
    if (row.get('CreatedBy')?.id === caller.userId) continue;
    const tenantId = row.get('ExtUserPtr')?.get?.('TenantId')?.id || '';
    if (tenantId && caller.tenantId && tenantId === caller.tenantId) continue;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'That file belongs to another account.');
  }
}

/**
 * The only way a url gets written onto a document or a template.
 *
 * - a url this deployment produced (local `/files/...` on one of our origins, or
 *   an object on our bucket) is kept, with its query string dropped, once it is
 *   clear no other account's document is using it;
 * - any other http(s) url is downloaded once through the SSRF-guarded fetch and
 *   re-uploaded to our own storage, and the new url is returned. A third-party
 *   host therefore never serves the bytes a signer is asked to sign, and can
 *   never swap them after the fact.
 *
 * @param {string} url
 * @param {import('./context.js').Caller} [caller]
 * @param {{fileName?: string}} [opts]
 * @returns {Promise<string>} the url to store
 */
export async function assertStoredFileUrl(url, caller, opts = {}) {
  const raw = String(url || '').trim();
  if (!raw) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'A document url is required.');
  const parsed = parseHttpUrl(raw);
  if (!parsed) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Provide an http(s) document url.');
  }
  const stored = storedFileUrl(parsed.href);
  if (stored) {
    await assertFileNotOwnedByOthers(stored, caller);
    return stored;
  }
  const bytes = await fetchPdfBytes(parsed.href);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const name =
    opts.fileName || decodeURIComponent(segments[segments.length - 1] || '') || 'document.pdf';
  return await uploadPdfBytes(bytes, name);
}
