import {
  extUserForUser,
  normaliseEmail,
  sessionForExistingUser,
  sessionTokenAfterSignUp,
} from '../parsefunction/authGuard.js';

/**
 * The one account-provisioning routine, shared by `usersignup` (self-service)
 * and `addadmin` (the first-admin bootstrap).
 *
 * The two used to be about ninety identical lines each, and they had already
 * drifted in ways that mattered:
 *
 *  - `usersignup` stored the username exactly as typed and set `normalizedEmail`;
 *    `addadmin` lowercased the username and never set `normalizedEmail`, so the
 *    unique sparse index on that column only constrained accounts made through
 *    one of the two doors, and `adduser` / `ContactBookAftersave` set neither.
 *  - `usersignup`'s "does this account exist" pre-check queried `username`
 *    case-sensitively. Parse-server enforces username uniqueness
 *    case-insensitively, so for an account stored with different capitals the
 *    pre-check missed, `signUp()` threw 202, and the correct-password branch in
 *    `sessionForExistingUser` was never reached: a user typing the right
 *    password was told the account already exists.
 *
 * Both are fixed here, once. The address is normalised, the account is looked up
 * by every column it could be stored under, and `normalizedEmail` is always set.
 *
 * The two cloud functions keep their own external contracts: their role
 * allow-lists, their rate limits, their authorisation gates and their response
 * messages stay where they are. What lives here is the sequence of writes.
 */

/** The address, lowercased and de-spaced, as every column below stores it. */
export function signupEmail(userDetails) {
  return normaliseEmail(userDetails?.email);
}

/**
 * The `_User` for an address, whatever case it happens to be stored under.
 *
 * Three columns can carry it: `username` (what `logIn` matches), `email`, and
 * `normalizedEmail` (written by signup since the unique index was added). The
 * lookup is case-sensitive in the database, so an account created before the
 * normalisation landed is only found through one of the other two.
 *
 * @param {string} email a normalised address.
 * @returns {Promise<Parse.User|undefined>}
 */
export async function findUserByEmail(email) {
  if (!email) return undefined;
  for (const field of ['username', 'normalizedEmail', 'email']) {
    const query = new Parse.Query(Parse.User);
    query.equalTo(field, email);
    // eslint-disable-next-line no-await-in-loop -- three cheap indexed lookups, and the first hit wins
    const found = await query.first({ useMasterKey: true });
    if (found) return found;
  }
  return undefined;
}

/**
 * Find or create the `_User` behind a signup.
 *
 * An existing account only yields a session when the caller proves they control
 * it (see `authGuard.sessionForExistingUser`); otherwise that throws
 * `USERNAME_TAKEN` and the cloud function turns it into its own "sign in
 * instead" answer.
 *
 * @param {Object} userDetails the request's `userDetails`.
 * @param {Object} request the cloud request, for the session proof.
 * @returns {Promise<{id: string, sessionToken?: string, existingUser: boolean}>}
 */
export async function accountForSignup(userDetails, request) {
  const email = signupEmail(userDetails);
  const existing = await findUserByEmail(email);
  if (existing) {
    const session = await sessionForExistingUser(existing, userDetails, request);
    return { ...session, existingUser: true };
  }

  const user = new Parse.User();
  // Username and email are the same normalised string. Storing the address as
  // typed made the account unreachable by every case-sensitive lookup in the
  // product (`logIn`, `setPasswordResetToken`, the shadow-user lookup behind
  // every contact).
  user.set('username', email);
  user.set('password', userDetails.password);
  user.set('email', email);
  user.set('normalizedEmail', email);
  if (userDetails?.phone) user.set('phone', userDetails.phone);
  user.set('name', userDetails.name);

  const res = await user.signUp();
  const sessionToken = await sessionTokenAfterSignUp(res, email, userDetails.password);
  return { id: res.id, sessionToken, existingUser: false };
}

/** The `contracts_Users` row this account already has, if any. */
async function existingProfileForUser(userId) {
  return (await extUserForUser(userId)) || undefined;
}

/**
 * The tenant this account already owns, if signup was retried after a partial
 * failure.
 *
 * `_User`, `partners_Tenant` and `contracts_Users` are three separate saves with
 * no transaction, and the "already provisioned" guard queries the last of the
 * three, so a failure between them used to leave an orphan tenant and a retry
 * created a second one for the same `_User`. Nothing dedupes `partners_Tenant`
 * on `UserId`, so storage accounting then accrued to one tenant while branding
 * and templates came from the other.
 *
 * @param {string} userId `_User` objectId.
 * @returns {Promise<Parse.Object|undefined>}
 */
export async function existingTenantForUser(userId) {
  const query = new Parse.Query('partners_Tenant');
  query.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
  query.ascending('createdAt');
  return await query.first({ useMasterKey: true });
}

/**
 * A time zone the runtime knows, or nothing.
 *
 * The value is read back by `GenerateCertificate` and handed to date-fns-tz,
 * which throws `RangeError: Invalid time zone specified` for a garbage string,
 * inside the completion path. A signup must not fail over a bad guess from the
 * browser, so an unusable value is simply not stored and the account falls back
 * to the server default.
 *
 * @param {*} value candidate zone.
 * @returns {string} the zone to store, or ''.
 */
export function usableTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return zone;
  } catch {
    console.log(`signup: ignoring unknown time zone "${zone}"`);
    return '';
  }
}

/** The tenant row for a new account, reusing one a half-finished attempt left. */
async function provisionTenant(userId, userDetails, email) {
  const tenant = (await existingTenantForUser(userId)) || new Parse.Object('partners_Tenant');
  tenant.set('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
  if (userDetails?.phone) tenant.set('ContactNumber', userDetails.phone);
  tenant.set('TenantName', userDetails.company);
  tenant.set('EmailAddress', email);
  tenant.set('IsActive', true);
  tenant.set('CreatedBy', { __type: 'Pointer', className: '_User', objectId: userId });
  for (const [field, key] of [
    ['PinCode', 'pincode'],
    ['Country', 'country'],
    ['State', 'state'],
    ['City', 'city'],
    ['Address', 'address'],
  ]) {
    if (userDetails?.[key]) tenant.set(field, userDetails[key]);
  }
  return await tenant.save(null, { useMasterKey: true });
}

/** The `contracts_Users` profile for a new account. */
async function provisionProfile(userId, userDetails, email, { role, tenantId }) {
  const profile = new Parse.Object('contracts_Users');
  profile.set('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
  profile.set('UserRole', role);
  profile.set('Email', email);
  profile.set('Name', userDetails.name);
  if (userDetails?.phone) profile.set('Phone', userDetails.phone);
  profile.set('TenantId', { __type: 'Pointer', className: 'partners_Tenant', objectId: tenantId });
  if (userDetails?.company) profile.set('Company', userDetails.company);
  if (userDetails?.jobTitle) profile.set('JobTitle', userDetails.jobTitle);
  const timezone = usableTimezone(userDetails?.timezone);
  if (timezone) profile.set('Timezone', timezone);
  // Owner-only row ACL. `contracts_Users` rows used to be saved with no ACL at
  // all on a class that anyone could update, which is how an objectId was enough
  // to grant yourself `contracts_Admin`.
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  acl.setReadAccess(userId, true);
  acl.setWriteAccess(userId, true);
  profile.setACL(acl);
  return await profile.save(null, { useMasterKey: true });
}

/**
 * Create the account, its tenant and its `contracts_Users` profile.
 *
 * Every step is idempotent, so a retry after a partial failure completes the
 * provisioning instead of duplicating it.
 *
 * @param {Object} userDetails the request's `userDetails`.
 * @param {Object} request the cloud request.
 * @param {{role: string}} opts the role to store; each cloud function validates
 *   its own allow-list before calling.
 * @returns {Promise<{userId: string, sessionToken?: string, alreadyProvisioned: boolean,
 *   email: string, extUser?: Object}>} `extUser` is the plain profile JSON of a
 *   freshly created row, which `addadmin` needs for its organisation and team.
 */
export async function createAccountAndTenant(userDetails, request, { role }) {
  const email = signupEmail(userDetails);
  const account = await accountForSignup(userDetails, request);

  const existingProfile = await existingProfileForUser(account.id);
  if (existingProfile) {
    // The session was minted for an account whose password the caller just
    // proved they know; throwing it away orphaned a real `_Session` row and
    // bounced the caller to the login screen to type the same password again.
    return {
      userId: account.id,
      sessionToken: account.sessionToken,
      alreadyProvisioned: true,
      email,
    };
  }

  const tenant = await provisionTenant(account.id, userDetails, email);
  const profile = await provisionProfile(account.id, userDetails, email, {
    role,
    tenantId: tenant.id,
  });

  return {
    userId: account.id,
    sessionToken: account.sessionToken,
    alreadyProvisioned: false,
    email,
    extUser: {
      objectId: profile.id,
      Name: userDetails.name,
      Email: email,
      Phone: userDetails?.phone || '',
      TenantId: { objectId: tenant.id },
      UserId: { objectId: account.id },
      UserRole: role,
      Company: userDetails.company,
      JobTitle: userDetails.jobTitle,
    },
  };
}
