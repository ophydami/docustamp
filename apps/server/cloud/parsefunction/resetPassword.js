import { revokeApiTokenForExtUser } from '../lib/apiTokens.js';
import { assertNotDisabled, checkRateLimit, extUserForUser, resolveCaller } from './authGuard.js';

/**
 * An admin sets another member's password.
 *
 * Role rules (they mirror `updateteammember`, which encodes the same model):
 *  - the caller must hold `contracts_Admin` or `contracts_OrgAdmin` and must
 *    not be suspended;
 *  - the target must be in the caller's tenant, and for an `contracts_OrgAdmin`
 *    caller also in the caller's own organisation (this was missing: an
 *    OrgAdmin could reset anyone in the whole tenant);
 *  - `contracts_OrgAdmin` and `contracts_Admin` targets are refused unless the
 *    caller is `contracts_Admin`, and an admin may not reset another admin
 *    either. Taking over a peer admin's account is an escalation, not an
 *    administrative task; recovery for a locked-out admin is the ordinary
 *    "forgot password" mail flow, which proves control of the mailbox.
 *
 * On success everything the old password could still reach is torn down: the
 * target's `_Session` rows are destroyed and their personal API token is
 * revoked.
 */

const ADMIN_ROLES = new Set(['contracts_Admin', 'contracts_OrgAdmin']);

/** Password resets per admin per minute. */
const RATE_PER_CALLER_PER_MIN = 10;

const forbidden = (message = 'Unauthorized.') =>
  new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, message);

/** Drops every session of the account whose password was just changed. */
async function destroySessions(user) {
  const query = new Parse.Query(Parse.Session);
  query.equalTo('user', user);
  query.limit(1000);
  const sessions = await query.find({ useMasterKey: true });
  if (!sessions.length) return 0;
  await Parse.Object.destroyAll(sessions, { useMasterKey: true });
  return sessions.length;
}

export default async function resetPassword(request) {
  const userId = request.params.userId;
  const newPassword = request.params.password;

  if (!userId || !newPassword) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide required parameters.');
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  checkRateLimit('resetpassword:caller', caller.id, RATE_PER_CALLER_PER_MIN);

  if (caller.id === userId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Unauthorized to reset your own password.');
  }

  try {
    const callerExt = await extUserForUser(caller);
    if (!callerExt) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Admin user tenant not found.');
    }
    assertNotDisabled(callerExt);

    const callerRole = callerExt.get('UserRole');
    if (!ADMIN_ROLES.has(callerRole)) {
      throw forbidden();
    }
    const isAdmin = callerRole === 'contracts_Admin';
    const callerTenantId = callerExt.get('TenantId')?.id;
    const callerOrgId = callerExt.get('OrganizationId')?.id;
    if (!callerTenantId) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Admin user tenant not found.');
    }

    const targetExt = await extUserForUser(userId, { tenantId: callerTenantId });
    if (!targetExt) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found or not allowed.');
    }

    // An OrgAdmin never reaches outside their own organisation.
    if (!isAdmin) {
      const targetOrgId = targetExt.get('OrganizationId')?.id;
      if (!callerOrgId || targetOrgId !== callerOrgId) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found or not allowed.');
      }
    }

    const targetRole = targetExt.get('UserRole');
    if (targetRole === 'contracts_Admin') {
      throw forbidden("An admin's password cannot be reset from here.");
    }
    if (targetRole === 'contracts_OrgAdmin' && !isAdmin) {
      throw forbidden('Only an admin can reset an organisation admin.');
    }
    if (targetExt.id === callerExt.id) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Unauthorized to reset your own password.');
    }

    const userQuery = new Parse.Query(Parse.User);
    userQuery.equalTo('objectId', userId);
    const user = await userQuery.first({ useMasterKey: true });

    if (!user) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
    }

    user.set('password', newPassword);
    await user.save(null, { useMasterKey: true });

    // The old password is gone, so everything it still authorises goes too.
    const destroyed = await destroySessions(user);
    await revokeApiTokenForExtUser(targetExt);

    return {
      status: 'success',
      message: 'Password has been reset.',
      sessionsRevoked: destroyed,
    };
  } catch (error) {
    console.error('Error while resetting password:', error);
    throw error;
  }
}
