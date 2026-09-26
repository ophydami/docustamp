import crypto from 'node:crypto';

/**
 * Per-signer signing-link tokens.
 *
 * A signing link used to be just `/login/base64(docId/email/contactId)`: anyone
 * who learned a docId (it is in every link, and `getDocument` used to hand out
 * every contactId) could act as any signer. The link now also carries a token
 * bound to (docId, contactId) and signed with a server secret, so a link only
 * ever proves "I am this signer on this document". Guest cloud functions accept
 * the token as `signingToken` and verify it with `verifySigningToken`.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256). Payload keys
 * are short on purpose because the token travels inside an emailed URL:
 *   d  document objectId
 *   c  contracts_Contactbook objectId (the signer)
 *   x  expiry, ms since epoch
 */

const SEPARATOR = '.';
const DEFAULT_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 days when the document has no ExpiryDate
const GRACE_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // links keep working a month past ExpiryDate

function secret() {
  const explicit = process.env.SIGNING_LINK_SECRET;
  if (explicit) return explicit;
  const master = process.env.MASTER_KEY || '';
  // Derive rather than reuse the master key directly, so a leaked token secret
  // could never be confused with the master key. The label keeps its original
  // "opensign-" prefix on purpose: changing it would invalidate every signing
  // link already sent.
  return crypto.createHash('sha256').update(`opensign-signing-link:${master}`).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

/**
 * Expiry for a token on a document: ExpiryDate plus a grace month, or a default TTL.
 * @param {{ExpiryDate?: {iso?: string}|Date}} [doc]
 */
export function signingTokenExpiry(doc) {
  const iso =
    doc?.ExpiryDate?.iso || (doc?.ExpiryDate instanceof Date ? doc.ExpiryDate.toISOString() : null);
  const exp = iso ? new Date(iso).getTime() : NaN;
  if (Number.isFinite(exp) && exp > Date.now()) return exp + GRACE_AFTER_EXPIRY_MS;
  return Date.now() + DEFAULT_TTL_MS;
}

/**
 * @param {{docId: string, contactId: string, expiresAt?: number|Date}} input
 * @returns {string} token
 */
export function mintSigningToken({ docId, contactId, expiresAt }) {
  if (!docId || !contactId) throw new Error('mintSigningToken: docId and contactId are required');
  const x =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : Number(expiresAt) || Date.now() + DEFAULT_TTL_MS;
  const payload = b64url(JSON.stringify({ d: String(docId), c: String(contactId), x }));
  return `${payload}${SEPARATOR}${sign(payload)}`;
}

/**
 * Verify a token. Returns the bound contactId, or null when the token is missing,
 * malformed, forged, expired, or minted for another document.
 * @param {string} token
 * @param {{docId: string, now?: number}} opts
 * @returns {{contactId: string, expiresAt: number}|null}
 */
export function verifySigningToken(token, { docId, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || !docId) return null;
  const idx = token.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.d !== String(docId) || typeof payload.c !== 'string' || !payload.c)
    return null;
  if (!Number.isFinite(payload.x) || payload.x < now) return null;
  return { contactId: payload.c, expiresAt: payload.x };
}

/** Pull the token out of a cloud-function request (param) or an express request (query/header). */
export function signingTokenFromRequest(request) {
  const p = request?.params || request?.body || {};
  const q = request?.query || {};
  const h = request?.headers || {};
  const raw = p.signingToken || q.t || q.signingToken || h['x-signing-token'] || '';
  return typeof raw === 'string' ? raw.trim() : '';
}
