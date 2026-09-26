import { createAccountAndTenant } from '../lib/signup.js';
import { checkRateLimit, clientIp } from './authGuard.js';

/**
 * Self-service signup. The account it creates owns a brand new tenant and is
 * the only member of it, so it never needs a privileged role: both frontends
 * send `contracts_User` here (apps/web/src/features/auth/api.ts and
 * apps/web/src/features/auth/api.ts), and the first-admin bootstrap has its own
 * function, `addadmin`.
 *
 * `role` used to be written to the row verbatim AND split on `_` to build the
 * class name to write it to (`userDetails.role.split('_')[0] + '_Users'`), so a
 * client could pick both its own role and which class the profile landed in,
 * and a missing `role` was a TypeError swallowed by the catch below.
 *
 * The provisioning itself is `cloud/lib/signup.js`, shared with `addadmin`: the
 * two were ninety duplicated lines that had drifted on username normalisation
 * and on `normalizedEmail`. What stays here is this function's own contract: the
 * role allow-list, the rate limit and the answers both frontends match on.
 */
const SIGNUP_ROLES = new Set(['contracts_User']);
const DEFAULT_SIGNUP_ROLE = 'contracts_User';

/** Signups per source address per minute. */
const RATE_PER_IP_PER_MIN = 10;

/** The role to store, or a thrown error. Never used to derive a class name. */
function signupRole(role) {
  if (role === undefined || role === null || role === '') return DEFAULT_SIGNUP_ROLE;
  if (typeof role !== 'string' || !SIGNUP_ROLES.has(role)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Invalid role.');
  }
  return role;
}

export default async function usersignup(request) {
  const userDetails = request.params.userDetails;

  // Validated before the try/catch below, so a bad request comes back as a real
  // error instead of `undefined`.
  if (!userDetails || typeof userDetails !== 'object' || !userDetails.email) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide userDetails.');
  }
  checkRateLimit('usersignup:ip', clientIp(request), RATE_PER_IP_PER_MIN);
  const role = signupRole(userDetails.role);

  try {
    let result;
    try {
      result = await createAccountAndTenant(userDetails, request, { role });
    } catch (err) {
      // The email already has an account and the caller could not prove they
      // own it. Both frontends render "sign in instead" for this message.
      // No `error` key: `apps/web/src/lib/parse.ts` throws on any result whose
      // `error` is a non-empty string, so this typed answer never reached the
      // "sign in instead" branch it was written for.
      if (err?.code === Parse.Error.USERNAME_TAKEN) {
        return { message: 'User already exist', detail: err.message };
      }
      throw err;
    }
    if (result.alreadyProvisioned) {
      return { message: 'User already exist', sessionToken: result.sessionToken };
    }
    return { message: 'User sign up', sessionToken: result.sessionToken };
  } catch (err) {
    // This used to log and fall off the end, so the function resolved
    // `undefined` for any failure after the `_User` and its session existed:
    // a logged-in account with no `contracts_Users` row, which then breaks
    // `loadCaller`, `updatetenant`, `getteams` and `getReport`, and the web app
    // had to codify "a missing result is the only signal we get"
    // (apps/web/src/features/auth/api.ts). The caller is told which step failed
    // instead; the provisioning above is idempotent, so a retry completes it.
    console.log('Err ', err);
    if (err instanceof Parse.Error) throw err;
    throw new Parse.Error(
      err?.code || Parse.Error.SCRIPT_FAILED,
      err?.message || 'The account could not be set up. Please try again.'
    );
  }
}
