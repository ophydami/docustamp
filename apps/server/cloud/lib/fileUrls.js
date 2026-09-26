import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import jwt from 'jsonwebtoken';
import { httpOrigin, localFileUrlParts } from '../parsefunction/fileUpload.js';

/**
 * The one place a stored file url is signed, and the one place the object
 * storage client is configured.
 *
 * Before this module there were four signers and three S3 clients:
 *
 *   getSignedLocalUrl / presignedlocalUrl   thirty lines apart in getSignedUrl.js,
 *                                           the same JWT payload, different
 *                                           defaults (200s each) and different
 *                                           error handling;
 *   Utils.getSecureUrl                      a third spelling of the same JWT;
 *   files.resolveFileUrl                    a fourth, at 600s;
 *   makeS3Client (getSignedUrl.js),
 *   createS3Client (deleteFileUrl.js),
 *   the adapter config (index.js)           three endpoint normalisations, one of
 *                                           which produced `https://https://...`
 *                                           whenever DO_ENDPOINT carried a scheme,
 *                                           so every account-deletion S3 delete
 *                                           failed DNS and was swallowed.
 *
 * Callers pick between them more or less at random, which is why hardening one
 * (a shorter lifetime, an audience claim, a host check) only ever covered part
 * of the traffic. Everything now goes through `signStoredUrl`.
 *
 * Environment:
 *   FILE_TOKEN_SECRET  HMAC secret for the `/files/` read tokens. Falls back to
 *                      MASTER_KEY so tokens minted by an older build keep
 *                      working; set it, because `getsignedurl` is effectively a
 *                      public signing oracle for whatever key is used here.
 *   DO_SPACE / DO_ENDPOINT / DO_REGION / DO_ACCESS_KEY_ID / DO_SECRET_ACCESS_KEY
 *                      object storage; the DO_ names are historical and hold the
 *                      AWS S3 values just as well.
 */

/** Default lifetime of a signed file link, in seconds. */
export const DEFAULT_URL_TTL = 200;

/** Pinned so a token cannot claim `alg: none` (or an asymmetric algorithm). */
export const FILE_TOKEN_ALG = 'HS256';

/** The HMAC secret for file-read tokens. Read per call so a test can set it. */
export function fileTokenSecret() {
  return process.env.FILE_TOKEN_SECRET || process.env.MASTER_KEY;
}

/** True when this deployment serves files off its own disk rather than S3. */
function storesLocally() {
  return String(process.env.USE_LOCAL || '').toLowerCase() === 'true';
}

/** An endpoint value with a scheme, whether or not the configured one had one. */
export function makeEndpoint(endpoint) {
  if (!endpoint) return '';
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `https://${endpoint}`;
}

/**
 * The origins our own object storage is reachable at: the public base url the
 * files adapter stamps onto stored urls, the S3/Spaces endpoint itself, and the
 * virtual-host spelling of the bucket on that endpoint. Empty when this
 * deployment stores files on disk instead.
 */
export function objectStorageOrigins() {
  const origins = new Set();
  const base = httpOrigin(process.env.DO_BASEURL);
  if (base) origins.add(base);
  const endpoint = httpOrigin(makeEndpoint(process.env.DO_ENDPOINT));
  if (endpoint) {
    origins.add(endpoint);
    const bucket = process.env.DO_SPACE;
    if (bucket) {
      const parsed = new URL(endpoint);
      origins.add(`${parsed.protocol}//${bucket}.${parsed.host}`);
    }
  }
  return origins;
}

/** The configured bucket. */
export function storageBucket() {
  return process.env.DO_SPACE || '';
}

/**
 * The S3/Spaces client, configured once.
 *
 * `deleteFileUrl.js` built its own with `endpoint: 'https://' + DO_ENDPOINT`,
 * which doubles the scheme for a DO_ENDPOINT that already carries one, and it
 * only set an endpoint at all when the value did not mention amazonaws.com.
 * Both spellings are handled here.
 */
export function makeS3Client() {
  const endpoint = makeEndpoint(process.env.DO_ENDPOINT);
  return new S3Client({
    region: process.env.DO_REGION,
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: process.env.DO_ACCESS_KEY_ID,
      secretAccessKey: process.env.DO_SECRET_ACCESS_KEY,
    },
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The object key a stored url points at.
 *
 * This used to keep only the last path segment and never percent-decode, so a
 * deployment that stores under a key prefix (or a file whose name contains a
 * space) presigned a key that does not exist. The whole pathname is the key;
 * only the bucket segment is dropped, and that only in the path-style spelling
 * (`https://endpoint/<bucket>/<key>`), never in the virtual-host spelling
 * (`https://<bucket>.endpoint/<key>`) where it is part of the host.
 *
 * @param {string} url a url on one of `objectStorageOrigins()`.
 * @returns {string} the decoded object key.
 */
export function extractKeyFromUrl(url) {
  const parsedUrl = new URL(url);
  const bucket = storageBucket();
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  // Virtual-host style already carries the bucket in the host.
  const hostHasBucket = bucket ? parsedUrl.host.startsWith(`${bucket}.`) : false;
  if (!hostHasBucket && bucket && segments[0] === bucket) segments.shift();
  return segments.map(part => safeDecode(part)).join('/');
}

/**
 * Bucket and key for a stored url, or null when the url makes no sense.
 * Used by the presigner and by the account-deletion sweep, so both agree on
 * which object a url names.
 */
export function s3ParamsFor(url) {
  try {
    const parsed = new URL(url);
    const Bucket = storageBucket() || parsed.hostname.split('.')[0];
    const Key = extractKeyFromUrl(parsed.href);
    if (!Bucket || !Key) return null;
    return { Bucket, Key };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- local files */

/**
 * Mint a read token for a local `/files/` url, or say plainly that this server
 * cannot sign one.
 *
 * The only ways `jwt.sign` throws are a missing/invalid secret or an
 * unserialisable payload, both server misconfigurations. Reporting them as
 * "Invalid or expired token" told users to ask for a fresh link and sent
 * operators looking for expiry logic that does not exist here.
 */
export function signFileToken(fileUrl, expirationTimeInSeconds) {
  const secretKey = fileTokenSecret();
  const exp = expirationTimeInSeconds || DEFAULT_URL_TTL;
  try {
    const payload = { fileUrl, exp: Math.floor(Date.now() / 1000) + exp };
    return jwt.sign(payload, secretKey, { algorithm: FILE_TOKEN_ALG });
  } catch (err) {
    console.log('Could not sign this file url', err?.message || err);
    const failure = new Parse.Error(
      Parse.Error.OTHER_CAUSE,
      'Could not sign this file url (server misconfiguration).'
    );
    failure.cause = err;
    throw failure;
  }
}

/**
 * A local `/files/` url with a read token. Any query string the caller supplied
 * is dropped first, so a stale (or forged) token never survives re-signing.
 *
 * @param {string} fileUrl a `/files/...` url on this server.
 * @param {number} [ttl] lifetime in seconds.
 * @returns {string} the signed url.
 */
export function signLocalUrl(fileUrl, ttl) {
  const bare = String(fileUrl || '').split('?')[0];
  return `${bare}?token=${signFileToken(bare, ttl)}`;
}

/** Verify a `/files/` read token. Returns the url, or the string 'Unauthorized'. */
export function validateSignedLocalUrl(signedUrl) {
  const urlParams = new URLSearchParams(String(signedUrl || '').split('?')[1]);
  const token = urlParams.get('token');
  try {
    if (!token) throw new Error('No token provided.');
    const decoded = jwt.verify(token, fileTokenSecret(), { algorithms: [FILE_TOKEN_ALG] });
    const fileUrl = String(signedUrl).split('?')[0];
    if (decoded.fileUrl !== fileUrl) throw new Error('Invalid file URL in token.');
    return signedUrl;
  } catch (error) {
    console.log('Error validating file', error.message);
    return 'Unauthorized';
  }
}

/* ------------------------------------------------------------------- signing */

/**
 * A short-lived link to a stored file, whatever kind of storage it lives on.
 *
 * - a local `/files/` url gets a read token;
 * - an object on one of our own storage origins gets an S3 presign (or is left
 *   alone when the deployment stores locally);
 * - anything else is handed back untouched, because presigning a url that is not
 *   ours would mint a link to whatever object on our bucket happens to carry
 *   that name.
 *
 * @param {string} url the stored (unsigned) url.
 * @param {number} [ttl] lifetime in seconds.
 * @returns {Promise<string>} a url that resolves right now.
 */
export async function signStoredUrl(url, ttl = DEFAULT_URL_TTL) {
  if (!url || typeof url !== 'string') return url;
  if (isLocalFileUrl(url)) return signLocalUrl(url, ttl);
  if (storesLocally()) return url;
  const origin = httpOrigin(url);
  if (!origin || !objectStorageOrigins().has(origin)) {
    console.log('signStoredUrl: not one of our storage origins, left unsigned');
    return url;
  }
  const params = s3ParamsFor(url);
  if (!params) return url;
  return await presign(makeS3Client(), new GetObjectCommand(params), { expiresIn: ttl });
}

/**
 * Does this url name a file this server serves itself?
 *
 * `localFileUrlParts` is the strict version (our origin, a Parse file path, a
 * safe file name); the `/files/` substring test alone is what the old signers
 * used, and it is kept as a fallback for the loopback urls the server writes for
 * itself before PUBLIC_URL is configured.
 */
export function isLocalFileUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (localFileUrlParts(url)) return true;
  return url.includes('/files/');
}
