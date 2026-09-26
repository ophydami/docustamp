import crypto from 'node:crypto';
import { extUserForUser, resolveCaller } from '../parsefunction/authGuard.js';

/**
 * Signed, expiring links for the self-service account-deletion flow.
 *
 * `GET /delete-account/:userId`, `POST /delete-account/:userId/otp` and
 * `POST /delete-account/:userId` used to run master-key queries with no
 * credential at all: the `:userId` in the path was the only thing they asked
 * for. That made them an existence oracle (404 vs 200), let anyone mail a
 * deletion code to any admin every 30 seconds, and left a 6 digit code as the
 * only thing between a stranger and a deleted workspace.
 *
 * All three routes now require one of:
 *
 *  1. the token minted into the emailed link (`?t=` or the form body), which is
 *     HMAC-signed, expires in 24 h, is bound to that one `userId`, and carries
 *     a nonce whose hash is stored on the `contracts_Users` row, so only the
 *     most recently mailed link works and it dies with the row, or
 *  2. a session belonging to that same account (the `sessiontoken` header
 *     spellings `resolveCaller` understands).
 *
 * Token format, like `signingToken.js`: base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256(payload)). Payload keys are short because the token
 * travels in an emailed URL:
 *   u  the `_User` objectId the link deletes
 *   n  nonce, matched against `DeleteLinkHash` on the row
 *   x  expiry, ms since epoch
 */

const SEPARATOR = '.';

/** How long an emailed deletion link stays usable. */
export const DELETION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function secret() {
  const explicit = process.env.ACCOUNT_DELETION_SECRET;
  if (explicit) return explicit;
  const master = process.env.MASTER_KEY || '';
  // Derived rather than the master key itself, and with a label of its own, so
  // a deletion-link secret can never be confused with the signing-link one.
  return crypto.createHash('sha256').update(`docustamp-account-deletion:${master}`).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

/** A fresh link nonce. Only its hash is ever stored. */
export function newDeletionNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

/** The only representation of a nonce that touches the database. */
export function hashDeletionNonce(nonce) {
  return crypto
    .createHash('sha256')
    .update(`docustamp-deletion-nonce:${String(nonce ?? '')}`)
    .digest('hex');
}

/**
 * @param {{userId: string, nonce: string, expiresAt?: number|Date}} input
 * @returns {string} token
 */
export function mintDeletionToken({ userId, nonce, expiresAt }) {
  if (!userId || !nonce) throw new Error('mintDeletionToken: userId and nonce are required');
  const x =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : Number(expiresAt) || Date.now() + DELETION_TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ u: String(userId), n: String(nonce), x }));
  return `${payload}${SEPARATOR}${sign(payload)}`;
}

/**
 * Verify a token's signature, expiry and `userId` binding. Says nothing about
 * whether the nonce is still the live one; `authoriseDeletionRequest` checks
 * that against the row.
 *
 * @param {string} token
 * @param {{userId: string, now?: number}} opts
 * @returns {{userId: string, nonce: string, expiresAt: number}|null}
 */
export function verifyDeletionToken(token, { userId, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || !userId) return null;
  const idx = token.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  const payloadB64 = token.slice(0, idx);
  const a = Buffer.from(token.slice(idx + 1));
  const b = Buffer.from(sign(payloadB64));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.u !== String(userId)) return null;
  if (typeof payload.n !== 'string' || !payload.n) return null;
  if (!Number.isFinite(payload.x) || payload.x < now) return null;
  return { userId: payload.u, nonce: payload.n, expiresAt: payload.x };
}

/** Pull the token out of an express request: `?t=`, the form body, or a header. */
export function deletionTokenFromRequest(req) {
  const q = req?.query || {};
  const body = req?.body || {};
  const h = req?.headers || {};
  const raw = q.t || q.token || body.t || body.token || h['x-deletion-token'] || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Mint the link token for an account and make it the only live one: the nonce
 * hash and the expiry replace whatever was there, any half-finished OTP is
 * dropped, and the attempt counter starts again (a brand new mailed link is the
 * one and only way to clear a lock-out, since a resend must not clear it).
 *
 * @param {Parse.Object} extUser the `contracts_Users` row
 * @param {string} userId the `_User` objectId the link is bound to
 * @returns {Promise<string>} the token to put in the link
 */
export async function issueDeletionLinkToken(extUser, userId) {
  const nonce = newDeletionNonce();
  const expiresAt = new Date(Date.now() + DELETION_TOKEN_TTL_MS);
  extUser.set('DeleteLinkHash', hashDeletionNonce(nonce));
  extUser.set('DeleteLinkExpiry', expiresAt);
  extUser.unset('DeleteOTP'); // plaintext column from the old scheme
  extUser.unset('DeleteOTPHash');
  extUser.unset('DeleteOTPExpiry');
  extUser.unset('DeleteOTPSentAt');
  extUser.set('DeleteOTPTries', 0);
  await extUser.save(null, { useMasterKey: true });
  return mintDeletionToken({ userId, nonce, expiresAt });
}

/** Drop the link and every OTP field, so the token cannot be replayed. */
export function clearDeletionState(extUser) {
  extUser.unset('DeleteLinkHash');
  extUser.unset('DeleteLinkExpiry');
  extUser.unset('DeleteOTP');
  extUser.unset('DeleteOTPHash');
  extUser.unset('DeleteOTPExpiry');
  extUser.unset('DeleteOTPSentAt');
  extUser.unset('DeleteOTPTries');
}

/**
 * Who is asking to delete `req.params.userId`, if anyone may.
 *
 * Unknown account and unauthorised caller both come back as `null` on purpose:
 * the routes answer 404 either way, so the endpoint stops confirming which
 * userIds exist.
 *
 * @param {{params?: object, query?: object, body?: object, headers?: object}} req
 * @returns {Promise<{extUser: Parse.Object, userId: string, token: string, via: 'token'|'session'}|null>}
 */
export async function authoriseDeletionRequest(req) {
  const userId = req?.params?.userId;
  if (!userId || typeof userId !== 'string' || userId === ':userId') return null;

  const extUser = await extUserForUser(userId);
  if (!extUser) return null;

  const token = deletionTokenFromRequest(req);
  if (token) {
    const verified = verifyDeletionToken(token, { userId });
    const stored = extUser.get('DeleteLinkHash');
    const expiry = extUser.get('DeleteLinkExpiry');
    const live = expiry ? new Date(expiry).getTime() > Date.now() : false;
    if (verified && live && typeof stored === 'string' && stored) {
      const presented = hashDeletionNonce(verified.nonce);
      const a = Buffer.from(presented);
      const b = Buffer.from(stored);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { extUser, userId, token, via: 'token' };
      }
    }
  }

  const caller = await resolveCaller(req);
  if (caller && caller.id === userId) return { extUser, userId, token: '', via: 'session' };

  return null;
}
