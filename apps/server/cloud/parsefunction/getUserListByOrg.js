import { extUserForUser, pointerId, projectFields } from './authGuard.js';

/**
 * The team screen's member list.
 *
 * The function runs with the master key, so the `protectedFields` the class CLP
 * now declares for `ApiToken*` / `DeleteOTP*` do not apply to it: it has to
 * project the rows itself. It used to return whole `contracts_Users` rows,
 * which handed every admin of a workspace the API-token hashes, webhook URLs
 * and account-deletion OTPs of everyone in their organisation.
 */

/** Exactly what apps/web/src/features/settings TeamSection renders. */
const MEMBER_FIELDS = [
  'objectId',
  'Name',
  'Email',
  'Phone',
  'UserRole',
  'IsDisabled',
  'JobTitle',
  'Company',
  'Timezone',
  'createdAt',
  'updatedAt',
];

/** Teams are `include`d, so trim each one to what the list shows. */
const TEAM_FIELDS = ['objectId', 'Name'];

/** `maxLimit` on this server is 500 (index.js); the default page is only 100. */
const MAX_PAGE = 500;

/** A caller-supplied page size, clamped to what the server will serve. */
function pageSize(value) {
  if (!Number.isInteger(value) || value <= 0) return MAX_PAGE;
  return Math.min(value, MAX_PAGE);
}

function projectMember(row) {
  const json = JSON.parse(JSON.stringify(row));
  const member = projectFields(json, MEMBER_FIELDS);
  const teams = Array.isArray(json.TeamIds) ? json.TeamIds : [];
  member.TeamIds = teams.map(team => projectFields(team, TEAM_FIELDS));
  const userId = pointerId(json.UserId);
  if (userId) member.UserId = userId;
  const organizationId = pointerId(json.OrganizationId);
  if (organizationId) member.OrganizationId = organizationId;
  return member;
}

export default async function getUserListByOrg(req) {
  const OrganizationId = req.params.organizationId;
  const orgPtr = {
    __type: 'Pointer',
    className: 'contracts_Organizations',
    objectId: OrganizationId,
  };
  if (!req?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  } else {
    try {
      if (!OrganizationId) {
        throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide organizationId.');
      }
      // Authorize the requested organization against the caller's server-side
      // tenant/organization. This prevents an authenticated user from
      // enumerating users in an arbitrary organization or tenant.
      const callerExtUser = await extUserForUser(req.user, { activeOnly: true });
      if (!callerExtUser) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
      }
      const callerTenantId = callerExtUser.get('TenantId')?.id;
      const callerOrgId = callerExtUser.get('OrganizationId')?.id;
      const callerRole = callerExtUser.get('UserRole');
      const isAdmin = callerRole === 'contracts_Admin' || callerRole === 'contracts_OrgAdmin';

      const orgQuery = new Parse.Query('contracts_Organizations');
      const targetOrg = await orgQuery.get(OrganizationId, { useMasterKey: true });
      // Must belong to the caller's tenant.
      if (!callerTenantId || targetOrg.get('TenantId')?.id !== callerTenantId) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Unauthorized.');
      }
      // Non-admins may only list their own organization.
      if (!isAdmin && OrganizationId !== callerOrgId) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Unauthorized.');
      }

      const extUser = new Parse.Query('contracts_Users');
      extUser.equalTo('OrganizationId', orgPtr);
      extUser.include('TeamIds');
      extUser.descending('createdAt');
      // Without an explicit limit parse-server pages at 100 and says nothing
      // about it, so an organisation of 150 people showed 100 of them and an
      // admin could not suspend, reset or delete the rest.
      extUser.limit(pageSize(req.params?.limit));
      const skip = Number.isInteger(req.params?.skip) && req.params.skip > 0 ? req.params.skip : 0;
      if (skip) extUser.skip(skip);
      const userRes = await extUser.find({ useMasterKey: true });
      return userRes.map(projectMember);
    } catch (err) {
      console.log('err in getuserlist', err);
      throw err;
    }
  }
}
