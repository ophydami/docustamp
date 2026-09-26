import { extUserRowsForUser, resolveCaller, stringParam } from './authGuard.js';

/**
 * `gettemplate` used to build its access clause only when the caller had teams:
 * a caller with no `TeamIds` fell through to a bare `objectId` query run with the
 * master key, so any signed-in account could read any template in the install,
 * including its file urls and the owner's tenant row. The access clause is now
 * unconditional, and a caller with no `contracts_Users` row can only match on
 * `CreatedBy`.
 */

const TEMPLATE_INCLUDES = [
  'ExtUserPtr',
  'ExtUserPtr.TenantId',
  'Signers',
  'CreatedBy',
  'Placeholders.signerPtr',
  'Bcc',
  'Cc',
];

function teamAncestors(extUserJson) {
  const teams = extUserJson?.TeamIds;
  if (!Array.isArray(teams)) return [];
  let ancestors = [];
  for (const team of teams) {
    if (Array.isArray(team?.Ancestors)) ancestors = [...ancestors, ...team.Ancestors];
  }
  return ancestors;
}

/**
 * A query for one template that only matches when the caller may read it:
 * they created it, they own it through `contracts_Users`, it is shared with
 * them directly, or it is shared with one of their teams.
 *
 * @param {string} templateId template objectId.
 * @param {Parse.User|null} user the authenticated caller.
 * @param {Parse.Object|null} extUser the caller's `contracts_Users` row, when they have one.
 * @returns {Parse.Query} a query that is safe to run with the master key.
 */
export function accessibleTemplateQuery(templateId, user, extUser) {
  const clauses = [];
  if (user?.id) {
    const createdBy = new Parse.Query('contracts_Template');
    createdBy.equalTo('CreatedBy', { __type: 'Pointer', className: '_User', objectId: user.id });
    clauses.push(createdBy);
  }
  if (extUser?.id) {
    const extPointer = {
      __type: 'Pointer',
      className: 'contracts_Users',
      objectId: extUser.id,
    };
    const owned = new Parse.Query('contracts_Template');
    owned.equalTo('ExtUserPtr', extPointer);
    clauses.push(owned);

    const sharedWithUser = new Parse.Query('contracts_Template');
    sharedWithUser.equalTo('SharedWithUsers', extPointer);
    clauses.push(sharedWithUser);

    const ancestors = teamAncestors(JSON.parse(JSON.stringify(extUser)));
    if (ancestors.length > 0) {
      const sharedWithTeam = new Parse.Query('contracts_Template');
      sharedWithTeam.containedIn('SharedWith', ancestors);
      clauses.push(sharedWithTeam);
    }
  }
  // No caller at all: a query that can never match, rather than a bare objectId
  // lookup run with the master key.
  const query =
    clauses.length === 0 ? new Parse.Query('contracts_Template') : Parse.Query.or(...clauses);
  if (clauses.length === 0) query.equalTo('objectId', '');
  query.equalTo('objectId', templateId);
  query.notEqualTo('IsArchive', true);
  return query;
}

/**
 * The caller's `contracts_Users` row with `TeamIds` resolved (the team clause
 * needs each team's `Ancestors`), by pointer first and then by email.
 */
export async function extUserForCaller(user) {
  if (!user?.id) return null;
  // Same list and same tie-break as every other profile lookup (oldest wins),
  // so the templates a caller can reach do not depend on which row the database
  // happened to return first.
  const [found] = await extUserRowsForUser(user.id, { include: ['TeamIds'] });
  if (found) return found;
  const email = user.get?.('email') || user.get?.('username');
  if (!email) return null;
  const byEmail = new Parse.Query('contracts_Users');
  byEmail.equalTo('Email', email);
  byEmail.include('TeamIds');
  return await byEmail.first({ useMasterKey: true }).catch(() => null);
}

/**
 * Errors are thrown, never returned as `{error: string}` with HTTP 200, and the
 * catch never hands the raw Error back as a successful result: a caller that did
 * not sniff for a truthy `.error` rendered an empty template in the editor
 * instead of an access-denied message. The REST layer maps Parse.Error codes to
 * statuses and the SPA turns them into one CloudError.
 */
const NO_ACCESS = "template deleted or you don't have access.";

export default async function GetTemplate(request) {
  try {
    // Cloud-function params arrive as parsed JSON, so `{"$ne": ""}` would reach
    // `equalTo` as a real Mongo operator on a master-key query unless the type is
    // checked.
    const templateId = stringParam(request.params?.templateId, 'templateId', 64);
    const user = request.master ? null : await resolveCaller(request);
    if (!templateId || (!user && !request.master)) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NO_ACCESS);
    }

    let query;
    if (request.master) {
      query = new Parse.Query('contracts_Template');
      query.equalTo('objectId', templateId);
      query.notEqualTo('IsArchive', true);
    } else {
      const extUser = await extUserForCaller(user);
      query = accessibleTemplateQuery(templateId, user, extUser);
    }
    for (const path of TEMPLATE_INCLUDES) query.include(path);

    const res = await query.first({ useMasterKey: true });
    if (!res) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NO_ACCESS);
    }
    const templateRes = JSON.parse(JSON.stringify(res));
    delete templateRes?.ExtUserPtr?.TenantId?.FileAdapters;
    delete templateRes?.ExtUserPtr?.TenantId?.PfxFile;
    if (templateRes?.CreatedBy) {
      delete templateRes.CreatedBy.authData;
      delete templateRes.CreatedBy.sessionToken;
    }
    return templateRes;
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.error(
      'gettemplate: could not read template',
      request.params?.templateId,
      err?.message || err
    );
    if (err?.response?.data?.code === 209 || err?.code === 209) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
    }
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NO_ACCESS);
  }
}
