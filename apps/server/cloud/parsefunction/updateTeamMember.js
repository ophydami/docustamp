import { extUserForUser, resolveCaller } from './authGuard.js';
import { revokeApiTokenForExtUser } from '../lib/apiTokens.js';
import { revokeOAuthGrantsForUser } from '../lib/oauth.js';

/**
 * Admin-only edits to another member's `contracts_Users` row: their role and
 * whether their access is suspended.
 *
 * The web app used to PUT `UserRole` and `IsDisabled` straight onto
 * `classes/contracts_Users/<id>`, which the class CLP allowed for anyone at
 * all (`update: { '*': true }`, no row ACL): knowing an objectId was enough to
 * make yourself `contracts_Admin`. The class API is closed now and the checks
 * live here, on the server, against the caller's own row.
 */

/** `contracts_Editor` is included because the team screen offers it. */
const ASSIGNABLE_ROLES = new Set([
  'contracts_Admin',
  'contracts_OrgAdmin',
  'contracts_Editor',
  'contracts_User',
]);

const ADMIN_ROLES = new Set(['contracts_Admin', 'contracts_OrgAdmin']);

const PROTECTED_IN_RESPONSE = [
  'ApiTokenHash',
  'ApiTokenPrefix',
  'ApiTokenCreatedAt',
  'ApiTokenLastUsedAt',
  'DeleteOTP',
  'DeleteOTPExpiry',
  'DeleteOTPSentAt',
  'DeleteOTPTries',
];

const forbidden = (message = 'Unauthorized.') =>
  new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, message);

export default async function updateTeamMember(request) {
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  const { extUserId, role, isDisabled } = request.params || {};
  if (!extUserId || typeof extUserId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide extUserId.');
  }
  if (role === undefined && isDisabled === undefined) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide role or isDisabled.');
  }
  if (role !== undefined && !ASSIGNABLE_ROLES.has(role)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Invalid role.');
  }
  if (isDisabled !== undefined && typeof isDisabled !== 'boolean') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'isDisabled must be true or false.');
  }

  const callerExt = await extUserForUser(caller);
  if (!callerExt) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
  }
  if (callerExt.get('IsDisabled') === true) {
    throw forbidden();
  }
  const callerRole = callerExt.get('UserRole');
  if (!ADMIN_ROLES.has(callerRole)) {
    throw forbidden();
  }
  const isAdmin = callerRole === 'contracts_Admin';
  const callerTenantId = callerExt.get('TenantId')?.id;
  const callerOrgId = callerExt.get('OrganizationId')?.id;
  if (!callerTenantId) {
    throw forbidden();
  }

  const targetQuery = new Parse.Query('contracts_Users');
  const target = await targetQuery.get(extUserId, { useMasterKey: true }).catch(() => null);
  if (!target) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Team member not found.');
  }

  // Same tenant always; an OrgAdmin is additionally confined to their own org.
  if (target.get('TenantId')?.id !== callerTenantId) {
    throw forbidden();
  }
  if (!isAdmin) {
    const targetOrgId = target.get('OrganizationId')?.id;
    if (!callerOrgId || targetOrgId !== callerOrgId) {
      throw forbidden();
    }
  }

  // Nobody locks themselves out or hands themselves a role through this path.
  if (target.id === callerExt.id || target.get('UserId')?.id === caller.id) {
    throw forbidden('You cannot change your own role or access.');
  }

  // Only a tenant Admin may create another Admin, or touch an existing one.
  if (!isAdmin && target.get('UserRole') === 'contracts_Admin') {
    throw forbidden('Only an admin can change another admin.');
  }
  if (role === 'contracts_Admin' && !isAdmin) {
    throw forbidden('Only an admin can grant the admin role.');
  }

  if (role !== undefined) {
    target.set('UserRole', role);
  }
  if (isDisabled !== undefined) {
    target.set('IsDisabled', isDisabled);
  }
  const saved = await target.save(null, { useMasterKey: true });

  // Suspending an account must also cut off what it already holds: its personal
  // API token (REST/MCP), the apps it connected over OAuth and every live session.
  if (isDisabled === true) {
    await revokeApiTokenForExtUser(saved);
    const targetUserId = saved.get('UserId')?.id;
    if (targetUserId) await revokeOAuthGrantsForUser(targetUserId);
    if (targetUserId) {
      const sessions = new Parse.Query(Parse.Session);
      sessions.equalTo('user', { __type: 'Pointer', className: '_User', objectId: targetUserId });
      const rows = await sessions.find({ useMasterKey: true }).catch(() => []);
      if (rows.length)
        await Parse.Object.destroyAll(rows, { useMasterKey: true }).catch(() => undefined);
    }
  }

  const json = JSON.parse(JSON.stringify(saved));
  for (const field of PROTECTED_IN_RESPONSE) delete json[field];
  return json;
}
