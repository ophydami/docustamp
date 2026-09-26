import crypto from 'node:crypto';
import { extUserRowsForUser } from '../parsefunction/authGuard.js';
import { conditionalUpdate } from './atomic.js';

/**
 * Personal API tokens for the REST API (`/v1/*`) and the MCP endpoint (`/mcp`).
 *
 * One token per user, stored hashed on `contracts_Users`:
 *   ApiTokenHash        sha256 hex of the raw token
 *   ApiTokenPrefix      first characters, shown in the UI so a user can tell keys apart
 *   ApiTokenCreatedAt   Date
 *   ApiTokenLastUsedAt  Date, refreshed at most every LAST_USED_WRITE_INTERVAL_MS
 *
 * The raw token is returned exactly once, at creation. Format: `os_` + 40 base62
 * characters (238 bits), so the hash is not brute-forceable and no salt is needed.
 */

export const TOKEN_PREFIX = 'os_';
const TOKEN_BODY_LENGTH = 40;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DISPLAY_PREFIX_LENGTH = 11; // "os_" + 8
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_RE = /^os_[A-Za-z0-9]{40}$/;

export function generateRawToken() {
  const bytes = crypto.randomBytes(TOKEN_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < TOKEN_BODY_LENGTH; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `${TOKEN_PREFIX}${body}`;
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

export function looksLikeToken(raw) {
  return typeof raw === 'string' && TOKEN_RE.test(raw.trim());
}

/**
 * Pull a bearer token out of an Express/Parse request.
 *
 * Exactly two header names carry a credential, `Authorization: Bearer ...` and
 * `x-api-token`, and both are documented in docs/AI_AND_MCP.md. `x-api-key` used
 * to be accepted as a third, undocumented channel: one more header an operator
 * has to know about when writing log redaction or proxy rules, and one they
 * would not have redacted.
 */
export function tokenFromHeaders(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  const direct = headers['x-api-token'] || '';
  return typeof direct === 'string' ? direct.trim() : '';
}

/**
 * The `contracts_Users` row the caller's token lives on.
 *
 * One `_User` can own several rows (one per tenant they were added to), so a
 * bare `first()` could revoke the token on one row while the live token sat on
 * another and report `revoked: false`. The row that actually holds a token wins;
 * otherwise the oldest row, which is the same one `loadCaller` picks.
 */
async function extUserForUserId(userId) {
  // Same list and same tie-break as `authGuard.extUserForUser` and
  // `lib/context.js`; only the preference on top differs.
  const rows = await extUserRowsForUser(userId);
  return rows.find(row => row.get('ApiTokenHash')) || rows[0];
}

/** What the settings page shows. Never includes the hash. */
export function describeToken(extUser) {
  const prefix = extUser?.get?.('ApiTokenPrefix') ?? extUser?.ApiTokenPrefix;
  if (!prefix) return null;
  const createdAt = extUser?.get?.('ApiTokenCreatedAt') ?? extUser?.ApiTokenCreatedAt;
  const lastUsedAt = extUser?.get?.('ApiTokenLastUsedAt') ?? extUser?.ApiTokenLastUsedAt;
  return {
    prefix,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt?.iso || null,
    lastUsedAt: lastUsedAt instanceof Date ? lastUsedAt.toISOString() : lastUsedAt?.iso || null,
  };
}

/**
 * Create (or rotate) the caller's token.
 *
 * There is one slot per user, so the write is a compare-and-set on the hash that
 * was read: two overlapping creates used to return two usable-looking tokens of
 * which only the last-written one authenticated, and a user who double-clicked
 * "Generate token" could copy the dead one. The loser now gets a plain error,
 * and `rotated` tells the UI a live credential was replaced.
 *
 * @returns {Promise<{token: string, prefix: string, createdAt: string, rotated: boolean}>}
 */
export async function createApiToken(user) {
  if (!user?.id) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const extUser = await extUserForUserId(user.id);
  if (!extUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User profile not found.');
  }
  const previous = extUser.get('ApiTokenHash') || '';
  const token = generateRawToken();
  const createdAt = new Date();
  const where = previous ? { ApiTokenHash: previous } : { ApiTokenHash: { $exists: false } };
  const won = await conditionalUpdate('contracts_Users', extUser.id, where, {
    ApiTokenHash: hashToken(token),
    ApiTokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    ApiTokenCreatedAt: createdAt,
    ApiTokenLastUsedAt: null,
  });
  if (!won) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'The token was changed by another request. Reload the page and try again.'
    );
  }
  return {
    token,
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    createdAt: createdAt.toISOString(),
    rotated: Boolean(previous),
  };
}

export async function revokeApiToken(user) {
  if (!user?.id) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const extUser = await extUserForUserId(user.id);
  if (!extUser) return { revoked: false };
  return await revokeApiTokenForExtUser(extUser);
}

/**
 * Revoke the token on a `contracts_Users` row directly, for the paths that
 * already hold the row and are acting on somebody else's account: an admin
 * resetting a member's password (`resetpassword`) or suspending them
 * (`updateteammember`). A suspended or reset account must not keep a working
 * bearer token for the REST API and the MCP endpoint.
 *
 * @param {Parse.Object} extUserObj a `contracts_Users` row
 * @returns {Promise<{revoked: boolean}>}
 */
export async function revokeApiTokenForExtUser(extUserObj) {
  if (!extUserObj?.id) return { revoked: false };
  const had = Boolean(extUserObj.get('ApiTokenHash'));
  const update = new Parse.Object('contracts_Users');
  update.id = extUserObj.id;
  update.unset('ApiTokenHash');
  update.unset('ApiTokenPrefix');
  update.unset('ApiTokenCreatedAt');
  update.unset('ApiTokenLastUsedAt');
  await update.save(null, { useMasterKey: true });
  return { revoked: had };
}

export async function getApiTokenInfo(user) {
  if (!user?.id) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const extUser = await extUserForUserId(user.id);
  return { token: describeToken(extUser) };
}

/**
 * Resolve a raw token to its owner.
 * @returns {Promise<{user: Parse.User, extUser: Parse.Object} | null>}
 */
export async function resolveApiToken(raw) {
  if (!looksLikeToken(raw)) return null;
  const query = new Parse.Query('contracts_Users');
  query.equalTo('ApiTokenHash', hashToken(raw.trim()));
  // A suspended account keeps no API access: the token stops resolving the
  // moment an admin flips `IsDisabled`, whether or not it was also revoked.
  query.notEqualTo('IsDisabled', true);
  query.include('UserId');
  query.include('TenantId');
  const extUser = await query.first({ useMasterKey: true });
  if (!extUser) return null;
  const user = extUser.get('UserId');
  if (!user?.id) return null;
  if (!(user instanceof Parse.User) || !user.get('username')) {
    // Pointer was not expanded (class mismatch); fetch it properly.
    const fetched = await new Parse.Query(Parse.User).get(user.id, { useMasterKey: true });
    return { user: fetched, extUser, touch: () => touchLastUsed(extUser) };
  }
  return { user, extUser, touch: () => touchLastUsed(extUser) };
}

async function touchLastUsed(extUser) {
  try {
    const last = extUser.get('ApiTokenLastUsedAt');
    if (last instanceof Date && Date.now() - last.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    const update = new Parse.Object('contracts_Users');
    update.id = extUser.id;
    update.set('ApiTokenLastUsedAt', new Date());
    await update.save(null, { useMasterKey: true });
  } catch (err) {
    console.log('apiTokens: could not record last use', err?.message);
  }
}
