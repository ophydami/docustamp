import { createAccountAndTenant } from '../lib/signup.js';
import {
  anyAdminExists,
  checkRateLimit,
  clientIp,
  extUserForUser,
  normaliseEmail,
  resolveCaller,
} from './authGuard.js';

/**
 * `addadmin` is the first-admin bootstrap: the web app's first-admin signup path
 * and the "very first account" branch of the new one both call it, and both
 * send `contracts_Admin`. It is the only path that hands out that role at
 * signup, so the role is validated against a one-entry allow-list rather than
 * written verbatim, and a missing `role` no longer lands `undefined` in
 * `UserRole`.
 */
const ADMIN_BOOTSTRAP_ROLES = new Set(['contracts_Admin']);
const DEFAULT_ADMIN_ROLE = 'contracts_Admin';

/** First-admin bootstrap attempts per source address per minute. */
const RATE_PER_IP_PER_MIN = 5;

/** Matches `/already exist/i`, which is the copy both frontends render. */
const ADMIN_EXISTS_MESSAGE =
  'An administrator already exists on this installation. Please sign in instead.';

/**
 * Whether this caller may run the bootstrap on an installation that already has
 * an administrator.
 *
 * The function used to have no caller authorisation at all: the only gate was
 * the browser politely calling `checkadminexist` first, so anyone could keep
 * provisioning tenants, organisations and `contracts_Admin` rows. The marginal
 * privilege each one buys is small (admin of a workspace you just created,
 * which is what `usersignup` gives you anyway) but every extra admin used to
 * flip `checkadminexist` to "not_exist" for good, which routed every later
 * signup down this path.
 *
 * Once an admin exists the call must be attributable: either an existing admin
 * is running it, or the caller holds a session for exactly the account being
 * bootstrapped (which is how the old first-admin page works: it creates the
 * `_User` itself and then calls this). An anonymous call is refused.
 *
 * @param {Object} request the cloud request.
 * @param {string} targetEmail the address being made an admin.
 * @returns {Promise<boolean>}
 */
async function mayBootstrapAdmin(request, targetEmail) {
  if (!(await anyAdminExists())) return true;
  const caller = await resolveCaller(request);
  if (!caller) return false;
  const callerEmail = normaliseEmail(caller.get('email') || caller.get('username'));
  if (callerEmail && callerEmail === targetEmail) return true;
  const callerExt = await extUserForUser(caller);
  return callerExt?.get('UserRole') === 'contracts_Admin' && callerExt?.get('IsDisabled') !== true;
}

function adminRole(role) {
  if (role === undefined || role === null || role === '') return DEFAULT_ADMIN_ROLE;
  if (typeof role !== 'string' || !ADMIN_BOOTSTRAP_ROLES.has(role)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Invalid role.');
  }
  return role;
}
/**
 * Give the freshly created admin row its organisation and "All Users" team.
 *
 * Failures used to be logged and swallowed here, yet the function still
 * answered `'User sign up'` with a session token. This is the only place
 * `UserRole` becomes `contracts_Admin` and `OrganizationId` is set, so a failure
 * left the installation permanently in the "no admin yet" state that
 * `checkadminexist` reports. It throws now; the caller reports which step
 * failed and the work is idempotent, so a retry finishes it.
 */
async function addTeamAndOrg(extUser) {
  const extUserCls = new Parse.Query('contracts_Users');
  const updateUser = await extUserCls.get(extUser.objectId, { useMasterKey: true });
  if (updateUser && !updateUser?.get('OrganizationId')) {
    const orgCls = new Parse.Object('contracts_Organizations');
    orgCls.set('Name', extUser.Company);
    orgCls.set('IsActive', true);
    orgCls.set('ExtUserId', {
      __type: 'Pointer',
      className: 'contracts_Users',
      objectId: extUser?.objectId,
    });
    orgCls.set('CreatedBy', {
      __type: 'Pointer',
      className: '_User',
      objectId: extUser?.UserId?.objectId,
    });
    orgCls.set('TenantId', {
      __type: 'Pointer',
      className: 'partners_Tenant',
      objectId: extUser?.TenantId?.objectId,
    });

    const orgRes = await orgCls.save(null, { useMasterKey: true });
    const teamCls = new Parse.Object('contracts_Teams');
    teamCls.set('Name', 'All Users');
    teamCls.set('OrganizationId', {
      __type: 'Pointer',
      className: 'contracts_Organizations',
      objectId: orgRes.id,
    });
    teamCls.set('IsActive', true);
    const teamRes = await teamCls.save(null, { useMasterKey: true });
    updateUser.set('UserRole', 'contracts_Admin');
    updateUser.set('OrganizationId', {
      __type: 'Pointer',
      className: 'contracts_Organizations',
      objectId: orgRes.id,
    });
    updateUser.set('TeamIds', [
      {
        __type: 'Pointer',
        className: 'contracts_Teams',
        objectId: teamRes.id,
      },
    ]);
    await updateUser.save(null, { useMasterKey: true });
  }
}

export default async function AddAdmin(request) {
  const userDetails = request.params.userDetails;
  if (!userDetails || typeof userDetails !== 'object' || !userDetails.email) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide userDetails.');
  }
  checkRateLimit('addadmin:ip', clientIp(request), RATE_PER_IP_PER_MIN);
  const role = adminRole(userDetails.role);
  const email = normaliseEmail(userDetails.email);

  if (!(await mayBootstrapAdmin(request, email))) {
    // Answered rather than thrown: this is the same "the account you want
    // already exists" shape the two branches below use, and both frontends
    // render it as "sign in instead".
    return { message: ADMIN_EXISTS_MESSAGE };
  }

  let result;
  try {
    // The provisioning is `cloud/lib/signup.js`, shared with `usersignup`: the
    // two used to be ninety duplicated lines that had drifted on username
    // normalisation and on `normalizedEmail`, so the unique sparse index on that
    // column only constrained accounts made through one of the two doors.
    result = await createAccountAndTenant(userDetails, request, { role });
  } catch (err) {
    // The email already has an account and the caller could not prove they own
    // it. Both frontends render "sign in instead" for this message. No `error`
    // key: apps/web/src/lib/parse.ts throws on any result carrying one, so the
    // typed answer never reached the branch it was written for.
    if (err?.code === Parse.Error.USERNAME_TAKEN) {
      return { message: 'User already exist', detail: err.message };
    }
    throw err;
  }

  try {
    if (result.alreadyProvisioned) {
      // Hand back the session that was just minted for this account rather than
      // orphaning it and sending the caller to the login screen to type the
      // same password again.
      return { message: 'User already exist', sessionToken: result.sessionToken };
    }
    // The one step that is this function's own: the organisation, the "All
    // Users" team and the `contracts_Admin` role.
    await addTeamAndOrg(result.extUser);
    return { message: 'User sign up', sessionToken: result.sessionToken };
  } catch (err) {
    // Swallowing this used to answer `undefined` for a failed tenant or profile
    // save, and `'User sign up'` for a failed organisation save, which left the
    // installation permanently reporting "no admin yet". The caller is told
    // which step failed; every step above is idempotent, so a retry finishes
    // the provisioning instead of hitting "already exists".
    console.log('Err ', err);
    if (err instanceof Parse.Error) throw err;
    throw new Parse.Error(
      err?.code || Parse.Error.SCRIPT_FAILED,
      err?.message || 'The admin account could not be set up. Please try again.'
    );
  }
}
