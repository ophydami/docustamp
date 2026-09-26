import { extUserRowsForUser } from '../parsefunction/authGuard.js';

/**
 * The "caller" every library function takes instead of a Parse request.
 *
 * Cloud functions build it from `request.user`; the REST API and the MCP endpoint
 * build it from an API token. Either way the library code below only ever sees
 * `{ user, extUser, tenant }` and runs with the master key scoped to that user,
 * so one implementation serves all three entry points.
 */

/**
 * @typedef {Object} Caller
 * @property {Parse.User} user
 * @property {string} userId
 * @property {Object} extUser plain JSON of the contracts_Users row
 * @property {string} extUserId
 * @property {Object|null} tenant plain JSON of partners_Tenant (when linked)
 * @property {string} tenantId
 * @property {string} name
 * @property {string} email
 * @property {string} company
 * @property {boolean} useNameAsSender
 * @property {string} publicUrl origin the app is reached at, for signing links
 */

/**
 * The caller's `contracts_Users` row.
 *
 * One `_User` may have several rows (`adduser` reuses an existing `_User` and
 * creates a fresh ext row inside the caller's tenant), and this row decides the
 * tenant, the company and the sender identity of everything the caller writes.
 * A bare `first()` let whichever row the database happened to return first win,
 * and the winner could flip between requests. The oldest row is the caller's own
 * profile, so it is the answer unless a tenant was named explicitly.
 *
 * @param {string} userId `_User` objectId.
 * @param {string} [tenantId] pick the row in this tenant when there is one.
 * @returns {Promise<Parse.Object|undefined>}
 */
async function extUserRowFor(userId, tenantId) {
  // One query, one tie-break rule, shared with `authGuard.extUserForUser` and
  // `lib/apiTokens.js`: oldest row first. A bare `first()` in three places let
  // whichever row the database happened to return win, and the winner could
  // differ between a cloud function, the REST API and a token lookup for the
  // same user.
  const rows = await extUserRowsForUser(userId, { include: ['TenantId', 'TeamIds'] });
  if (tenantId) {
    const inTenant = rows.find(row => {
      const tenant = row.get('TenantId');
      return (tenant?.id || tenant?.objectId) === tenantId;
    });
    if (inTenant) return inTenant;
  }
  return rows[0];
}

/**
 * @param {Parse.User} user
 * @param {{publicUrl?: string, extUser?: Parse.Object, tenantId?: string}} [opts]
 * @returns {Promise<Caller>}
 */
export async function loadCaller(user, opts = {}) {
  if (!user?.id) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const extUserObj = opts.extUser || (await extUserRowFor(user.id, opts.tenantId));
  if (!extUserObj) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User profile not found.');
  }
  // Every library entry point (cloud functions, the REST API, the MCP endpoint)
  // funnels through here, so this is where a suspended account is stopped.
  const disabled = extUserObj.get ? extUserObj.get('IsDisabled') : extUserObj.IsDisabled;
  if (disabled === true) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This account is disabled.');
  }
  const extUser = JSON.parse(JSON.stringify(extUserObj));
  const tenant =
    extUser?.TenantId && extUser.TenantId.__type !== 'Pointer' ? extUser.TenantId : null;
  return {
    user,
    userId: user.id,
    extUser,
    extUserId: extUser.objectId,
    tenant,
    tenantId: extUser?.TenantId?.objectId || '',
    name: extUser?.Name || user.get('name') || '',
    email: (extUser?.Email || user.get('email') || '').toLowerCase(),
    company: extUser?.Company || '',
    useNameAsSender: extUser?.UseNameAsSender === true,
    publicUrl: opts.publicUrl || '',
  };
}

export function userPointer(caller) {
  return { __type: 'Pointer', className: '_User', objectId: caller.userId };
}

export function extUserPointer(caller) {
  return { __type: 'Pointer', className: 'contracts_Users', objectId: caller.extUserId };
}
