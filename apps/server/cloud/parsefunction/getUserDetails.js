import {
  extUserRowsForUser,
  isUserVisibleToCaller,
  normaliseEmail,
  resolveCaller,
  stringParam,
} from './authGuard.js';

/**
 * The same secrets `contracts_Users` declares as `protectedFields` (see
 * databases/migrations/20260822000000-lock_down_class_permissions.cjs), plus the
 * webhook URL. This function runs with the master key, so the CLP does not
 * apply to it and the columns have to be excluded by hand: the caller's own row
 * used to reach the browser complete with `ApiTokenHash` and `Webhook`, even
 * though `apiTokens.describeToken` exists precisely so the hash never leaves the
 * server.
 */
const SECRET_EXT_USER_FIELDS = [
  'ApiTokenHash',
  'ApiTokenPrefix',
  'ApiTokenCreatedAt',
  'ApiTokenLastUsedAt',
  'DeleteOTP',
  'DeleteOTPExpiry',
  'DeleteOTPSentAt',
  'DeleteOTPTries',
  'DeleteOTPHash',
  'DeleteLinkHash',
  'DeleteLinkExpiry',
  'Webhook',
  'google_refresh_token',
];

/**
 * What a profile row may show the browser: the pointers the settings screen
 * renders, minus the secrets above and the two tenant blobs nothing renders.
 * Both branches below (by pointer, and the legacy by-address fallback) project
 * the same way, which they previously did in two hand-kept copies.
 */
const PROFILE_PROJECTION = {
  include: ['TenantId', 'UserId', 'CreatedBy'],
  exclude: [
    'CreatedBy.authData',
    'TenantId.FileAdapters',
    'TenantId.PfxFile',
    ...SECRET_EXT_USER_FIELDS,
  ],
};

/**
 * The `contracts_Users` row of the caller, or the id of the row belonging to
 * an address the caller is allowed to know about.
 *
 * The `email` branch used to satisfy the authentication check all by itself,
 * which made this an unauthenticated account-existence oracle that also handed
 * out the profile objectId: an attacker could validate a list of addresses and
 * then aim the OTP flow at the ones that answered. It now needs a session and
 * applies the visibility rules of `authGuard.isUserVisibleToCaller` (same tenant, same
 * organisation, or a contact of the caller), and answers the same way for
 * "no such user" and "not yours".
 *
 * Response shape is unchanged: `{objectId}` for the email branch, the row for
 * the caller's own branch, `''` when there is nothing to return.
 */
async function getUserDetails(request) {
  const reqEmail = normaliseEmail(stringParam(request.params?.email, 'email'));
  const userId = stringParam(request.params?.userId, 'userId', 64);
  const caller = await resolveCaller(request);
  if (!caller && !request.master) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  try {
    if (reqEmail) return await lookupByEmail(reqEmail, caller, request.master === true);
    // A master-key call with no address has no caller to answer about.
    if (!caller) return '';

    const email = normaliseEmail(caller.get('email') || caller.get('username'));
    const rows = await extUserRowsForUser(caller.id, PROFILE_PROJECTION);
    // `userId` narrows to the row a particular account created, which is how the
    // team screen reads a colleague's profile.
    const res = userId ? rows.find(row => row.get('CreatedBy')?.id === userId) : rows[0];
    if (res) return res;

    // Legacy rows carry no `UserId` pointer; fall back to the address.
    if (!email) return '';
    const byEmail = new Parse.Query('contracts_Users');
    byEmail.equalTo('Email', email);
    byEmail.ascending('createdAt');
    for (const path of PROFILE_PROJECTION.include) byEmail.include(path);
    for (const path of PROFILE_PROJECTION.exclude) byEmail.exclude(path);
    return (await byEmail.first({ useMasterKey: true })) || '';
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('Err ', err);
    const code = err?.code || 400;
    const msg = err?.message || 'Something went wrong.';
    throw new Parse.Error(code, msg);
  }
}

/** `{objectId}` for an address the caller may know about, `''` otherwise. */
async function lookupByEmail(email, caller, isMaster) {
  const query = new Parse.Query('contracts_Users');
  query.equalTo('Email', email);
  query.ascending('createdAt');
  const row = await query.first({ useMasterKey: true });
  if (!row) return '';
  if (isMaster) return { objectId: row.id };

  const callerEmail = normaliseEmail(caller.get('email') || caller.get('username'));
  if (callerEmail === email) return { objectId: row.id };

  const userId = row.get('UserId')?.id;
  if (userId) {
    const target = await new Parse.Query(Parse.User)
      .get(userId, { useMasterKey: true })
      .catch(() => null);
    if (target && (await isUserVisibleToCaller(target, caller))) return { objectId: row.id };
  }
  // Same answer as "no such address", so nothing is enumerable.
  return '';
}

export default getUserDetails;
