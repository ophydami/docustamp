import { extUserForUser, resolveCaller } from './authGuard.js';

/**
 * `maxLimit` on this server is 500 (index.js), and parse-server silently pages
 * at 100 when no limit is set. Both callers (the template share dialog and the
 * team settings screen) render the whole list, so ask for as much as the server
 * will give and let the client page with `skip` if it ever needs to.
 */
const MAX_PAGE = 500;

/**
 * The teams of the caller's organisation.
 *
 * Two ways this used to throw instead of answering: `JSON.parse(JSON.stringify(
 * undefined))` for a caller with no (or a suspended) `contracts_Users` row, and
 * a `TypeError` reading `.objectId` off a missing `OrganizationId`. The second
 * is the common case rather than an edge one, because `usersignup` never sets
 * an organisation: only `addadmin` and `adduser` do. Both
 * came back as an opaque 400 and the share dialog simply never rendered.
 *
 * A caller with no organisation has no teams, which is an empty list, not an
 * error.
 *
 * @returns {Promise<Array>} `contracts_Teams` rows, newest first.
 */
export default async function getTeams(request) {
  const activeTeams = request.params?.active;
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const limit = pageSize(request.params?.limit);
  const skip =
    Number.isInteger(request.params?.skip) && request.params.skip > 0 ? request.params.skip : 0;
  try {
    const extUser = await extUserForUser(caller);
    if (!extUser || extUser.get('IsDisabled') === true) return [];
    const organizationId = extUser.get('OrganizationId')?.id;
    if (!organizationId) return [];

    const teamCls = new Parse.Query('contracts_Teams');
    teamCls.equalTo('OrganizationId', {
      __type: 'Pointer',
      className: 'contracts_Organizations',
      objectId: organizationId,
    });
    if (activeTeams) {
      teamCls.equalTo('IsActive', true);
    }
    teamCls.descending('createdAt');
    teamCls.limit(limit);
    if (skip) teamCls.skip(skip);
    return await teamCls.find({ useMasterKey: true });
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('err in getTeams', err);
    const code = err?.code || 400;
    const msg = err?.message || 'Something went wrong.';
    throw new Parse.Error(code, msg);
  }
}

/** A caller-supplied page size, clamped to what the server will serve. */
function pageSize(value) {
  if (!Number.isInteger(value) || value <= 0) return MAX_PAGE;
  return Math.min(value, MAX_PAGE);
}
