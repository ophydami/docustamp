/**
 * Shared authorization / abuse-control helpers for the cloud functions.
 *
 * Why a session-token fallback exists (`resolveCaller`): the web app's cloud()
 * helper sends the session both as `X-Parse-Session-Token` (which Parse Server
 * reads into `request.user`) and as the lowercase `sessiontoken` header, which
 * a few functions read directly. `resolveCaller` accepts either, so a caller
 * that reaches a function through a path Parse does not populate (for example
 * an express route) is still identified.
 */

const MINUTE = 60 * 1000;
const RATE_BUCKETS = new Map();
const MAX_KEYS_PER_BUCKET = 5000;

/**
 * Numeric code for "too many requests"; older Parse SDKs lack the constant.
 *
 * Read off `globalThis` rather than the bare name: this module is now reachable
 * from `migrationdb` (through `lib/context.js`), and a bare `Parse?.` still
 * throws a ReferenceError when the identifier is not declared at all, which would
 * make the import order at boot load-bearing.
 */
export const RATE_LIMIT_CODE = globalThis.Parse?.Error?.REQUEST_LIMIT_EXCEEDED || 155;

/**
 * Cheap in-memory sliding-window limiter. Per process, so it is a speed bump
 * for abuse rather than a distributed quota; it costs one array filter.
 */
export function checkRateLimit(bucketName, key, max, windowMs = MINUTE) {
  if (!key || !max) return;
  let bucket = RATE_BUCKETS.get(bucketName);
  if (!bucket) {
    bucket = new Map();
    RATE_BUCKETS.set(bucketName, bucket);
  }
  const now = Date.now();
  const hits = (bucket.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    throw new Parse.Error(RATE_LIMIT_CODE, 'Too many requests. Please try again in a minute.');
  }
  hits.push(now);
  bucket.set(key, hits);
  if (bucket.size > MAX_KEYS_PER_BUCKET) {
    for (const [k, times] of bucket) {
      if (!times.length || now - times[times.length - 1] >= windowMs) bucket.delete(k);
    }
  }
  return hits.length;
}

/** Test seam: drop all counters. */
export function resetRateLimits() {
  RATE_BUCKETS.clear();
}

export function clientIp(request) {
  const h = request?.headers || {};
  const forwarded = h['x-forwarded-for'] || '';
  return (
    h['x-real-ip'] ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    request?.ip ||
    'unknown'
  );
}

/**
 * True when a `_Session` row is one parse-server itself would still accept.
 *
 * The header fallback below resolves the row with the master key, which skips
 * every check `Auth.getAuthForSessionToken` makes, so an expired token (the
 * default session is a year long, and expired rows are never swept) and a
 * restricted token both authenticated the caller. Rows written before
 * `expiresAt` existed have no expiry and stay valid, exactly as parse-server
 * treats them.
 */
function isUsableSession(session) {
  if (!session) return false;
  if (session.get('restricted') === true) return false;
  const expiresAt = session.get('expiresAt');
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return false;
  return true;
}

/**
 * The authenticated caller, or null. Falls back to the non-standard header
 * header spellings the web app sends (see file header).
 */
export async function resolveCaller(request) {
  if (request?.user) return request.user;
  const h = request?.headers || {};
  const token = h.sessiontoken || h['x-parse-session-token'] || h.sessionToken || '';
  if (!token || typeof token !== 'string') return null;
  try {
    const query = new Parse.Query(Parse.Session);
    query.equalTo('sessionToken', token);
    query.include('user');
    const session = await query.first({ useMasterKey: true });
    if (!isUsableSession(session)) return null;
    return session.get('user') || null;
  } catch (err) {
    console.log('resolveCaller: could not resolve session token', err?.message);
    return null;
  }
}

/**
 * A client-supplied identifier, asserted to be a plain string.
 *
 * Cloud-function params arrive as parsed JSON, so `{"$ne": ""}` reaches
 * `equalTo` as a real Mongo operator on a master-key query unless the type is
 * checked. Every id, email and domain that reaches a query should come through
 * here.
 *
 * @param {*} value the raw parameter.
 * @param {string} label used in the error message.
 * @param {number} [max] maximum length.
 * @returns {string} the trimmed string, or '' when the parameter was absent.
 */
export function stringParam(value, label, max = 254) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, `${label} must be text.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, `${label} is too long.`);
  }
  return text;
}

// Re-exported, not redefined: `cloud/lib/email.js` decides the stored form of
// an address, and a dozen modules already import it from here.
export { normaliseEmail };

/** Every email that legitimately belongs to a document: owner + signers. */
export function documentParticipantEmails(docJson) {
  const emails = new Set();
  const add = value => {
    const email = normaliseEmail(value);
    if (email) emails.add(email);
  };
  add(docJson?.ExtUserPtr?.Email);
  add(docJson?.SenderMail);
  add(docJson?.CreatedBy?.email);
  for (const placeholder of docJson?.Placeholders || []) {
    add(placeholder?.email);
    add(placeholder?.signerPtr?.Email);
  }
  for (const signer of docJson?.Signers || []) add(signer?.Email);
  return emails;
}

/** Every `_User` objectId that legitimately belongs to a document. */
export function documentParticipantUserIds(docJson) {
  const ids = new Set();
  const add = value => {
    if (typeof value === 'string' && value) ids.add(value);
  };
  add(docJson?.CreatedBy?.objectId);
  add(docJson?.ExtUserPtr?.UserId?.objectId);
  for (const placeholder of docJson?.Placeholders || []) {
    add(placeholder?.signerPtr?.UserId?.objectId);
  }
  for (const signer of docJson?.Signers || []) add(signer?.UserId?.objectId);
  return ids;
}

/**
 * True when `user` owns the document or is one of its signers. Falls back to
 * the document ACL, which `DocumentAftersave` rewrites to grant every signer
 * read+write (§11.13), so it is a reliable participant signal.
 */
export function isDocumentParticipant(docObject, user) {
  if (!user) return false;
  const docJson = docObject?.toJSON ? docObject.toJSON() : docObject;
  if (documentParticipantUserIds(docJson).has(user.id)) return true;
  if (documentParticipantEmails(docJson).has(normaliseEmail(user.get?.('email')))) return true;
  try {
    return docObject?.getACL?.()?.getReadAccess?.(user.id) === true;
  } catch {
    return false;
  }
}

/**
 * The `contracts_Users` row for a `_User`, or null.
 *
 * This is the one profile lookup in the product: it used to be spelled out
 * inline (`new Parse.Query('contracts_Users')` + `equalTo('UserId', ...)` +
 * `first({useMasterKey: true})`) in about twenty cloud functions, each with its
 * own idea of whether suspended rows count and which row wins.
 *
 * A `_User` is meant to have exactly one profile row, and an account that ends
 * up with two used to get whichever one Mongo happened to return first: tenant,
 * role, API token and branding could differ between two requests of the same
 * user. The rule is written down and stable: **the oldest row wins**, because
 * that is the workspace the account was originally provisioned into, and a row
 * added later (by `adduser`, or by a second signup) never silently takes over.
 *
 * @param {Parse.User|string|null} user the account, or its objectId.
 * @param {{include?: string[], exclude?: string[], activeOnly?: boolean, tenantId?: string}} [opts]
 *   `include`/`exclude` are pointer/field paths; `activeOnly` drops suspended
 *   rows; `tenantId` narrows to that workspace and answers null when the
 *   account has no row in it.
 * @returns {Promise<Parse.Object|null>}
 */
export async function extUserForUser(user, opts = {}) {
  const userId = typeof user === 'string' ? user : user?.id;
  if (!userId) return null;
  const rows = await extUserRowsForUser(userId, opts);
  if (opts.tenantId) {
    return rows.find(row => row.get('TenantId')?.id === opts.tenantId) || null;
  }
  return rows[0] || null;
}

/**
 * Every `contracts_Users` row for a `_User`, oldest first.
 *
 * The tie-break rule lives here, once: **the oldest row wins**, because that is
 * the workspace the account was originally provisioned into. `lib/context.js`
 * (which then prefers the row in an explicitly named tenant) and
 * `lib/apiTokens.js` (which then prefers the row that actually holds the token)
 * both start from this list, so a user with two profiles cannot get one answer
 * from a cloud function and a different one from the REST API.
 *
 * @param {string} userId `_User` objectId.
 * @param {{include?: string[], exclude?: string[], limit?: number, activeOnly?: boolean}} [opts]
 *   `include`/`exclude` are field paths passed straight to the query;
 *   `activeOnly` skips rows an admin has suspended.
 * @returns {Promise<Parse.Object[]>} never rejects; an unreadable class is an empty list.
 */
export async function extUserRowsForUser(
  userId,
  { include = [], exclude = [], limit = 20, activeOnly = false } = {}
) {
  if (!userId) return [];
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
  if (activeOnly) query.notEqualTo('IsDisabled', true);
  for (const path of include) query.include(path);
  for (const path of exclude) query.exclude(path);
  query.ascending('createdAt');
  query.limit(limit);
  const rows = await query.find({ useMasterKey: true }).catch(err => {
    console.log(`authGuard: could not read contracts_Users for ${userId}`, err?.message || err);
    return [];
  });
  if (rows.length > 1) {
    console.log(`authGuard: ${rows.length} contracts_Users rows for user ${userId}; oldest wins`);
  }
  return rows;
}

/**
 * True when this installation already has a workspace administrator, meaning a
 * non-suspended `contracts_Admin` whose organisation has been provisioned.
 *
 * The old test was `find()` (unlimited) plus `length === 1`, so zero admins and
 * two-or-more admins both answered "no admin". That answer is what routes a
 * signup down the `addadmin` path, so a second admin made every later signup a
 * tenant admin, which kept the count above one for good. One row is enough.
 */
export async function anyAdminExists() {
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserRole', 'contracts_Admin');
  query.notEqualTo('IsDisabled', true);
  query.exists('OrganizationId');
  query.limit(1);
  const found = await query.first({ useMasterKey: true });
  return !!found;
}

/**
 * Whether `caller` is allowed to learn that `user` exists.
 *
 * Visible when the target shares the caller's tenant/organisation, or is one of
 * the caller's contacts (which covers every signer on the caller's documents,
 * since signers are always `contracts_Contactbook` rows). Used by `getuserdetails`
 * and `getuserdetails`, which used to disagree about it.
 *
 * @param {Parse.User} user the account being looked up.
 * @param {Parse.User} caller the authenticated caller.
 * @returns {Promise<boolean>}
 */
export async function isUserVisibleToCaller(user, caller) {
  if (!user || !caller) return false;
  if (user.id === caller.id) return true;

  const callerExt = await extUserForUser(caller);
  if (callerExt) {
    const targetExt = await extUserForUser(user);
    if (targetExt) {
      const tenantId = callerExt.get('TenantId')?.id;
      const orgId = callerExt.get('OrganizationId')?.id;
      if (tenantId && targetExt.get('TenantId')?.id === tenantId) return true;
      if (orgId && targetExt.get('OrganizationId')?.id === orgId) return true;
    }
  }

  const contactQuery = new Parse.Query('contracts_Contactbook');
  contactQuery.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: user.id });
  contactQuery.equalTo('CreatedBy', { __type: 'Pointer', className: '_User', objectId: caller.id });
  contactQuery.notEqualTo('IsDeleted', true);
  const contact = await contactQuery.first({ useMasterKey: true }).catch(() => null);
  return !!contact;
}

/**
 * Signup path for an email that already has a `_User`.
 *
 * `usersignup` and `addadmin` used to mint a session for that account with the
 * master key (`POST /loginAs`) without ever checking the password that was
 * typed. Because `contracts_Contactbook.afterSave` creates a `_User` for every
 * contact (§11.16), any address that had merely been a signer could be claimed
 * by signing up with it. A session is now only issued when the caller proves
 * control of the account, in one of two ways:
 *
 *  1. the typed password logs in, or
 *  2. the caller already holds a session for exactly that account, which is how
 *     the old first-admin page works: it creates the `_User` itself and then
 *     calls `addadmin` (and how Google sign-in reaches `usersignup`).
 *
 * Otherwise `{ sessionToken: undefined }` comes back and the caller is told the
 * account already exists, which is the "sign in instead" copy both frontends
 * already render for `/already exist/i`.
 */
export async function sessionForExistingUser(existingUser, userDetails, request) {
  const caller = await resolveCaller(request);
  const password = userDetails?.password;
  if (caller && caller.id === existingUser.id) {
    const sessionToken = caller.getSessionToken?.() || request?.headers?.sessiontoken;
    if (sessionToken) {
      // A guest who signed an OTP-protected document holds a session for their
      // shadow `_User` (random password, cloud/lib/contacts.js). Taking that
      // session as the proof and dropping the password they typed at signup
      // left them with an account no password opens: only the emailed code
      // ever worked. Store it. The master-key write clears every session for
      // the account (RestWrite `clearSessions`), so the one handed back has to
      // be minted by logging in with the password just stored.
      if (password) {
        existingUser.set('password', password);
        await existingUser.save(null, { useMasterKey: true });
        const loggedIn = await Parse.User.logIn(existingUser.get('username'), password);
        return { id: loggedIn.id, sessionToken: loggedIn.getSessionToken() };
      }
      return { id: existingUser.id, sessionToken };
    }
  }

  if (password) {
    try {
      const loggedIn = await Parse.User.logIn(existingUser.get('username'), password);
      return { id: loggedIn.id, sessionToken: loggedIn.getSessionToken() };
    } catch (err) {
      console.log('sessionForExistingUser: password did not match', err?.message);
    }
  }

  throw new Parse.Error(
    Parse.Error.USERNAME_TAKEN,
    'An account with this email already exists. Please sign in instead.'
  );
}

/**
 * `signUp()` run inside cloud code does not always hand the session token back
 * on the object, so fall back to a real login. Both signup functions promise a
 * `sessionToken` in their result and their callers log in with it.
 */
export async function sessionTokenAfterSignUp(signedUpUser, username, password) {
  const token = signedUpUser.getSessionToken?.();
  if (token) return token;
  if (!password) return undefined;
  try {
    const loggedIn = await Parse.User.logIn(username, password);
    return loggedIn.getSessionToken();
  } catch (err) {
    console.log('sessionTokenAfterSignUp: could not log the new user in', err?.message);
    return undefined;
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * There used to be two of these, with opposite error contracts: this one, which
 * never rejects because the afterFind triggers must not fail a whole query over
 * one unsignable file, and a copy in `createbatchdocs` that propagated. A
 * maintainer importing "the" helper got whichever their file happened to import,
 * so the contract is now an explicit option instead of a property of which copy
 * you reached for.
 *
 * @param {Array} items
 * @param {number} limit how many callbacks may be in flight at once.
 * @param {(item: any, index: number) => Promise<any>} fn
 * @param {{throwOnError?: boolean}} [opts] `true` lets the first failure reject
 *   the whole run; the default swallows per-item failures and logs them.
 * @returns {Promise<Array>} each callback's result, in the input order.
 */
export async function mapWithConcurrency(items, limit, fn, { throwOnError = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const size = Math.max(1, Math.min(limit, list.length));
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (err) {
        if (throwOnError) throw err;
        // A single unsignable object must never fail the whole query.
        console.log('mapWithConcurrency: item failed', err?.message);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------------- *
 * Document access resolution (owner, participant, or signing-link token)
 * ------------------------------------------------------------------------- */

import { normaliseEmail } from '../lib/email.js';
import { isDocumentOwner } from '../lib/acl.js';
import { signingTokenFromRequest, verifySigningToken } from '../lib/signingToken.js';

/**
 * Documents created before this instant may still be opened with the legacy
 * `docId + contactId` link (no token): their signing links were emailed before
 * tokens existed. Set SIGNING_TOKEN_REQUIRED_FROM to the deploy time in production.
 */
export const SIGNING_TOKEN_REQUIRED_FROM = new Date(
  process.env.SIGNING_TOKEN_REQUIRED_FROM || '2026-08-23T00:00:00Z'
);

/** The exact message the signer page matches to show the OTP gate. Do not reword. */
export const OTP_GATE_MESSAGE = "You don't have access of this document!";

function docJsonOf(docObject) {
  return docObject?.toJSON ? docObject.toJSON() : docObject || {};
}

/** contactIds that legitimately sign this document (Signers array and bound placeholders). */
export function documentContactIds(docJson) {
  const ids = new Set();
  for (const s of docJson?.Signers || []) if (s?.objectId) ids.add(s.objectId);
  for (const p of docJson?.Placeholders || []) {
    if (p?.signerObjId) ids.add(p.signerObjId);
    if (p?.signerPtr?.objectId) ids.add(p.signerPtr.objectId);
  }
  return ids;
}

/**
 * Every contact (from the document's Signers) a logged-in user corresponds to:
 * the contact's `UserId` is that account, or its address is the account's.
 * Usually one; an account that was added twice gets both seats.
 *
 * @param {Object} docJson contracts_Document JSON with `Signers` included.
 * @param {Parse.User|null} user
 * @returns {string[]} contactIds, in Signers order.
 */
export function contactIdsForUser(docJson, user) {
  if (!user) return [];
  const email = normaliseEmail(user.get?.('email') || user.get?.('username'));
  const ids = [];
  for (const s of docJson?.Signers || []) {
    if (!s?.objectId) continue;
    const byAccount = !!s?.UserId?.objectId && s.UserId.objectId === user.id;
    const byAddress = !!email && normaliseEmail(s?.Email) === email;
    if ((byAccount || byAddress) && !ids.includes(s.objectId)) ids.push(s.objectId);
  }
  return ids;
}

/** True when the account's address has been proven (emailed code, Google, or verifyemail). */
function hasVerifiedEmail(user) {
  return user?.get?.('emailVerified') === true;
}

/**
 * Decide who the caller is with respect to a document, for the guest-signing
 * cloud functions (getDocument, signPdf, triggerevent, declinedoc,
 * linkcontacttodoc, getsignedurl, saveplaceholders, getcontact).
 *
 * Resolution order:
 *  1. master key                                   -> { kind: 'master' }
 *  2. session user who owns the document           -> { kind: 'owner', user }
 *  3. session user who is a signer (email/UserId) with a verified email
 *                                                  -> { kind: 'signer', user, contactId }
 *  4. valid signing-link token for this document   -> { kind: 'signer', contactId }
 *  5. legacy link (doc older than the cutover) with a contactId that is a signer
 *                                                  -> { kind: 'signer', contactId, legacy: true }
 *  otherwise throws OPERATION_FORBIDDEN.
 *
 * A session only stands for a signer (case 3) when it matches one of the
 * document's contacts AND its address is verified. Signup never proves the
 * mailbox, and a contact binds to whichever `_User` already holds its address
 * (`shadowUserFor`), so an account opened in someone else's name would
 * otherwise read and sign what is sent to them, skipping the emailed code even
 * on OTP documents. An unverified match is not refused outright: it falls
 * through to the link checks, so the emailed link still works for someone who
 * happens to be signed in, and with no usable link it gets OTP_GATE_MESSAGE,
 * whose code (AuthLoginAsMail) verifies the address. A session that matches no
 * contact never gets a seat from it, whatever contactId it claims.
 *
 * OTP documents (IsEnableOTP) additionally require a session that proves the
 * signer's identity (cases 2/3). A token alone on an OTP document throws the
 * OTP_GATE_MESSAGE so the signer page shows the code prompt.
 *
 * When `opts.contactId` is given (the signer the caller claims to be) it must
 * agree with the resolved contact. The owner may act for any contact of their
 * own document only when `opts.ownerMayActForContact` is true (reads, decline,
 * placeholder edits); without it (signPdf, triggerevent, sendmailv3) the owner
 * may only claim their own seat, so they cannot sign for a co-signer.
 *
 * @param {Parse.Cloud.FunctionRequest|{user?: any, master?: boolean, params?: any, headers?: any}} request
 * @param {Parse.Object|Object} docObject contracts_Document (object or JSON) with Signers/Placeholders loaded
 * @param {{contactId?: string, signingToken?: string, ownerMayActForContact?: boolean}} [opts]
 * @returns {Promise<{kind: 'master'|'owner'|'signer', user: Parse.User|null, contactId: string, legacy?: boolean}>}
 */
export async function resolveDocumentActor(request, docObject, opts = {}) {
  const docJson = docJsonOf(docObject);
  const docId = docJson?.objectId || docObject?.id || '';
  const claimed = typeof opts.contactId === 'string' ? opts.contactId : '';
  const contactIds = documentContactIds(docJson);

  if (request?.master) return { kind: 'master', user: null, contactId: claimed };

  const user = await resolveCaller(request);
  if (user && isDocumentOwner(docJson, user.id)) {
    if (claimed && !opts.ownerMayActForContact) {
      if (!contactIds.has(claimed)) {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          'That signer is not on this document.'
        );
      }
      if (!contactIdsForUser(docJson, user).includes(claimed)) {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          'You can only sign as yourself. Each signer signs from their own link.'
        );
      }
    }
    return { kind: 'owner', user, contactId: claimed };
  }

  // The seats this session would hold, if it is on the document at all.
  const mine =
    user && isDocumentParticipant(docObject, user) ? contactIdsForUser(docJson, user) : [];
  const verifiedSession = mine.length > 0 && hasVerifiedEmail(user);
  if (verifiedSession && (!claimed || mine.includes(claimed))) {
    return { kind: 'signer', user, contactId: claimed || mine[0] };
  }
  // A signed-in signer whose address is not verified yet: the emailed code
  // proves it, so that is what they are shown when no link gets them in.
  const unverifiedSession = mine.length > 0 && !verifiedSession;
  const refuse = message => {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      unverifiedSession ? OTP_GATE_MESSAGE : message
    );
  };

  const token =
    typeof opts.signingToken === 'string' && opts.signingToken
      ? opts.signingToken
      : signingTokenFromRequest(request);
  if (token) {
    const verified = verifySigningToken(token, { docId });
    if (!verified) refuse('This signing link is invalid or has expired.');
    if (!contactIds.has(verified.contactId)) {
      refuse('This signing link does not belong to this document.');
    }
    if (claimed && claimed !== verified.contactId) {
      refuse('You can only act as yourself on this document.');
    }
    if (docJson?.IsEnableOTP === true) {
      // The link is genuine but this document wants the signer to prove their
      // mailbox first; the page shows the OTP prompt on exactly this message.
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OTP_GATE_MESSAGE);
    }
    return { kind: 'signer', user: null, contactId: verified.contactId };
  }

  // Legacy grace: links emailed before tokens existed.
  const createdAt = docJson?.createdAt ? new Date(docJson.createdAt) : null;
  const legacyEligible = createdAt && createdAt.getTime() < SIGNING_TOKEN_REQUIRED_FROM.getTime();
  if (legacyEligible && claimed && contactIds.has(claimed)) {
    if (docJson?.IsEnableOTP === true) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OTP_GATE_MESSAGE);
    }
    return { kind: 'signer', user: null, contactId: claimed, legacy: true };
  }

  if (unverifiedSession || docJson?.IsEnableOTP === true) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OTP_GATE_MESSAGE);
  }
  if (verifiedSession) {
    // A verified signer claiming somebody else's seat, with no link for it.
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You can only act as yourself on this document.'
    );
  }
  throw new Parse.Error(
    Parse.Error.OPERATION_FORBIDDEN,
    user
      ? 'You do not have access to this document.'
      : 'Please open this document from your signing link.'
  );
}

/* ------------------------------------------------------------------------- *
 * Identity helpers (getTenant, getUserListByOrg, resetPassword, loginUser)
 * ------------------------------------------------------------------------- */

/** The message every entry point uses for a suspended account. Do not reword. */
export const DISABLED_ACCOUNT_MESSAGE = 'This account is disabled.';

/** Reads `IsDisabled` off either a Parse object or its JSON. */
export function isDisabledExtUser(extUser) {
  if (!extUser) return false;
  const value = extUser.get ? extUser.get('IsDisabled') : extUser.IsDisabled;
  return value === true;
}

/** Throws OPERATION_FORBIDDEN when the row belongs to a suspended account. */
export function assertNotDisabled(extUser) {
  if (isDisabledExtUser(extUser)) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, DISABLED_ACCOUNT_MESSAGE);
  }
}

/**
 * Copies exactly `fields` out of `source` (a Parse object or plain JSON).
 * Keys that are absent stay absent, so the shape matches what the class holds
 * and nothing outside the whitelist can ever be added by a later schema change.
 *
 * @param {Parse.Object|Object|null} source
 * @param {string[]} fields
 * @returns {Object}
 */
export function projectFields(source, fields) {
  if (!source) return {};
  const json = source.toJSON ? source.toJSON() : source;
  const out = {};
  for (const field of fields) {
    if (json[field] !== undefined) out[field] = json[field];
  }
  return out;
}

/** A pointer trimmed to `{objectId}`, so an included row never leaks with it. */
export function pointerId(value) {
  const objectId = value?.objectId || value?.id || '';
  return objectId ? { objectId } : undefined;
}
