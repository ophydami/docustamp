import { resolveCaller } from './authGuard.js';
import { extUserForCaller } from './GetTemplate.js';
import reportJson, { applySearch } from './reportsJson.js';

/** Rows one call may read. The afterFind hook presigns every one of them. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const MAX_SKIP = 10000;

/** Parse error codes that really do mean "you may not do this". */
const AUTHORIZATION_CODES = new Set([
  Parse.Error.OBJECT_NOT_FOUND, // 101
  Parse.Error.SESSION_MISSING, // 206
  Parse.Error.INVALID_SESSION_TOKEN, // 209
  Parse.Error.OPERATION_FORBIDDEN, // 119
]);

function clampPaging(limit, skip) {
  return {
    limit: Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT),
    skip: Math.min(Math.max(Math.trunc(Number(skip)) || 0, 0), MAX_SKIP),
  };
}

/** Every team ancestor of the caller's teams, de-duplicated. */
function teamAncestorsOf(extUser) {
  if (!extUser) return [];
  const json = JSON.parse(JSON.stringify(extUser));
  const teams = Array.isArray(json?.TeamIds) ? json.TeamIds : [];
  const set = new Set();
  for (const team of teams) {
    for (const ancestor of team?.Ancestors || []) set.add(ancestor);
  }
  return [...set];
}

/**
 * Run one of the canned reports.
 *
 * Three things were wrong here and they compounded:
 *
 *  - the caller was resolved with `axios.get(cloudServerUrl + '/users/me')`, an
 *    HTTP call this process made to itself against a hardcoded localhost url,
 *    and the results were fetched with a second loopback call to
 *    `/classes/<cls>` carrying the master key in a header;
 *  - the ext user was looked up by `Email` rather than by the `UserId` pointer
 *    every other function uses, and the `if (!extUser)` fallback had no `return`
 *    or `else`, so it fell straight into `JSON.parse(JSON.stringify(extUser))`
 *    and `extUser.id` and crashed for any account whose `contracts_Users.Email`
 *    had drifted or that had no ext-user row yet;
 *  - the catch covered the whole body and answered every failure, including that
 *    crash and a connection-refused on the loopback url, with
 *    `{error: "You don't have access!"}` and HTTP 200, so a misconfigured
 *    deployment looked to every user like a permissions problem.
 *
 * Now the caller and the rows are read in process, the ext user is resolved by
 * pointer through the shared helper, the fallback is a real `else`, and only
 * genuine authorization codes produce an access message. Everything else throws.
 */
export default async function getReport(request) {
  const reportId = request.params?.reportId;
  const searchTerm = request.params?.searchTerm || '';
  const signerStatus = request.params?.signerStatus || '';
  const { limit, skip } = clampPaging(request.params?.limit, request.params?.skip);

  const user = await resolveCaller(request);
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
  }

  // Resolved by the `UserId` pointer (with the shared helper's email fallback),
  // never by an email string on its own.
  const extUser = await extUserForCaller(user);
  const json =
    reportId &&
    reportJson(reportId, user.id, {
      extUserId: extUser?.id || '',
      teamAncestors: teamAncestorsOf(extUser),
    });
  if (!json) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Report is not available!');
  }

  let paramsObj = applySearch({ reportId, baseWhere: { ...(json.params || {}) }, searchTerm });
  const clsName = json.reportClass || 'contracts_Document';

  if (clsName === 'contracts_Document' && signerStatus) {
    const normalizedStatus =
      signerStatus === 'viewed' ? 'Viewed' : signerStatus === 'signed' ? 'Signed' : '';
    if (normalizedStatus) {
      paramsObj = { ...paramsObj, 'AuditTrail.Activity': normalizedStatus };
    }
  }

  const query = Parse.Query.fromJSON(clsName, {
    where: paramsObj,
    keys: (json.keys || []).join(','),
    include: 'AuditTrail.UserPtr,Placeholders.signerPtr,ExtUserPtr.TenantId',
    order: '-updatedAt',
    limit,
    skip,
  });

  try {
    const rows = await query.find({ useMasterKey: true });
    return rows.map(row => row.toJSON());
  } catch (err) {
    console.error('getreport: could not run report', reportId, err?.message || err);
    if (AUTHORIZATION_CODES.has(err?.code)) {
      throw new Parse.Error(err.code, "You don't have access!");
    }
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Report unavailable.');
  }
}
