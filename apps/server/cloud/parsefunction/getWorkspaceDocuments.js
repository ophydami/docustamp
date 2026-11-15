import {
  checkRateLimit,
  projectFields,
  resolveCaller,
  workspaceAdminScope,
  isInWorkspaceScope,
} from './authGuard.js';

/**
 * `getworkspacedocuments`: every document in the caller's workspace, for the
 * workspace's admins.
 *
 * A document's ACL names its owner and its signers and nobody else, so the
 * documents page (a plain class query under the caller's session) shows an
 * admin their own documents and nothing a teammate made. That stays as it is:
 * the ACL is what keeps a teammate's document from being changed by anyone but
 * its owner. This function is the one place an admin reads across the
 * workspace, with the master key and a where clause it builds itself.
 *
 * Reading only. Nothing here, and nothing the rows carry, lets the admin
 * remind, void, move, edit or delete a teammate's document: those paths all
 * check the owner (`lib/acl.isDocumentOwner`) or go through the ACL.
 *
 * The caller never supplies a where clause. It names a bucket and a few
 * narrowing values, the same ones the documents page already has, and the
 * clause is assembled from those.
 */

const RATE_PER_MIN = 120;
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const MAX_SKIP = 10000;
const MAX_SEARCH = 200;
/** `maxLimit` on this server is 500 (index.js), also for the master key. */
const PAGE = 500;
/** Profiles read to work out who is in the workspace. Far above any real team. */
const MAX_MEMBERS = 5000;

const NOT_ADMIN = "Only workspace admins can see everyone's documents.";

/** Buckets of the documents page. "Needs you" is about the caller, so it is not here. */
const BUCKETS = ['all', 'in_progress', 'completed', 'declined', 'expired', 'draft'];
const DATE_WINDOWS = new Set(['7', '30', '90']);

/** Exactly the columns the documents list reads (apps/web documents/api.ts LIST_KEYS). */
const ROW_FIELDS = [
  'objectId',
  'createdAt',
  'updatedAt',
  'Name',
  'Note',
  'URL',
  'SignedUrl',
  'CertificateUrl',
  'IsCompleted',
  'IsDeclined',
  'DeclineReason',
  'IsSignyourself',
  'SentToOthers',
  'SendinOrder',
  'SendInOrderStrict',
  'ExpiryDate',
  'DocSentAt',
  'TimeToCompleteDays',
  'AutomaticReminders',
  'RemindOnceInEvery',
  'IsEnableOTP',
  'IsTourEnabled',
  'AllowModifications',
  'NotifyOnSignatures',
  'RedirectUrl',
  'Placeholders',
  'AuditTrail',
  'OpenStats',
  'Type',
  'SenderName',
  'SenderMail',
  'TemplateId',
];

const QUERY_KEYS = [
  ...ROW_FIELDS.filter(field => !['objectId', 'createdAt', 'updatedAt'].includes(field)),
  'Signers.Name',
  'Signers.Email',
  'Signers.UserId',
  'Folder.Name',
  'CreatedBy.name',
  'CreatedBy.email',
  'CreatedBy.username',
  'ExtUserPtr.Name',
  'ExtUserPtr.Email',
].join(',');

const QUERY_INCLUDE = 'Signers,Folder,CreatedBy,ExtUserPtr';

const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });
const dateValue = date => ({ __type: 'Date', iso: date.toISOString() });

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every row of a query, a page at a time, up to `cap`. */
async function findAll(query, cap) {
  const rows = [];
  query.limit(PAGE);
  while (rows.length < cap) {
    query.skip(rows.length);
    // eslint-disable-next-line no-await-in-loop -- each page starts where the last one ended
    const page = await query.find({ useMasterKey: true });
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Whose documents the admin may see.
 *
 * `extUserIds` are the profiles in the admin's scope, suspended ones included:
 * a teammate who has left is exactly whose contracts the business still needs.
 * `soloUserIds` are the accounts behind them whose every profile is inside the
 * scope. They only matter for an older document with no `ExtUserPtr`, which can
 * be matched by `CreatedBy` alone, and an account that also has a profile in
 * another workspace must not have those shown to this one's admin.
 */
async function workspaceMembers(scope) {
  const inScope = new Parse.Query('contracts_Users');
  inScope.equalTo('TenantId', pointer('partners_Tenant', scope.tenantId));
  if (scope.orgId) {
    inScope.equalTo('OrganizationId', pointer('contracts_Organizations', scope.orgId));
  }
  inScope.select('UserId');
  inScope.ascending('createdAt');
  const profiles = await findAll(inScope, MAX_MEMBERS);

  const extUserIds = profiles.map(row => row.id);
  const userIds = [...new Set(profiles.map(row => row.get('UserId')?.id).filter(Boolean))];
  if (!userIds.length) return { extUserIds, soloUserIds: [] };

  const everyProfile = new Parse.Query('contracts_Users');
  everyProfile.containedIn(
    'UserId',
    userIds.map(id => pointer('_User', id))
  );
  everyProfile.select('UserId', 'TenantId', 'OrganizationId');
  everyProfile.ascending('createdAt');
  const elsewhere = new Set();
  for (const row of await findAll(everyProfile, MAX_MEMBERS * 2)) {
    const inside = isInWorkspaceScope(
      scope,
      row.get('TenantId')?.id || '',
      row.get('OrganizationId')?.id || ''
    );
    if (!inside) elsewhere.add(row.get('UserId')?.id);
  }
  return { extUserIds, soloUserIds: userIds.filter(id => !elsewhere.has(id)) };
}

/** "Created in this workspace", as a where clause. */
function ownerWhere(members) {
  const byProfile = {
    ExtUserPtr: { $in: members.extUserIds.map(id => pointer('contracts_Users', id)) },
  };
  if (!members.soloUserIds.length) return byProfile;
  return {
    $or: [
      byProfile,
      {
        ExtUserPtr: { $exists: false },
        CreatedBy: { $in: members.soloUserIds.map(id => pointer('_User', id)) },
      },
    ],
  };
}

/** One filter chip. The same clauses the documents page builds for its own query. */
function bucketWhere(bucket, now) {
  const where = { Type: { $ne: 'Folder' }, IsArchive: { $ne: true } };
  const open = { IsCompleted: { $ne: true }, IsDeclined: { $ne: true } };
  switch (bucket) {
    case 'in_progress':
      return { ...where, ...open, SignedUrl: { $exists: true }, ExpiryDate: { $gt: now } };
    case 'completed':
      return { ...where, IsCompleted: true, IsDeclined: { $ne: true } };
    case 'declined':
      return { ...where, IsDeclined: true };
    case 'expired':
      return { ...where, ...open, SignedUrl: { $exists: true }, ExpiryDate: { $lt: now } };
    case 'draft':
      return { ...where, ...open, SignedUrl: { $exists: false } };
    default:
      return where;
  }
}

/** Date window, template, search and the "expiring this week" view. */
function narrow(where, params) {
  const out = { ...where };
  const templateId = params?.templateId;
  if (typeof templateId === 'string' && /^[A-Za-z0-9]{1,40}$/.test(templateId)) {
    out.TemplateId = pointer('contracts_Template', templateId);
  }
  if (DATE_WINDOWS.has(String(params?.date))) {
    const days = Number(params.date);
    out.updatedAt = { $gte: dateValue(new Date(Date.now() - days * 86400000)) };
  }
  const search = typeof params?.search === 'string' ? params.search.trim() : '';
  if (search) {
    out.Name = { $regex: escapeRegExp(search.slice(0, MAX_SEARCH)), $options: 'i' };
  }
  if (params?.view === 'expiring') {
    out.ExpiryDate = {
      $gt: dateValue(new Date()),
      $lt: dateValue(new Date(Date.now() + 7 * 86400000)),
    };
    out.IsCompleted = { $ne: true };
    out.IsDeclined = { $ne: true };
    out.SignedUrl = { $exists: true };
  }
  return out;
}

function clampPaging(page, perPage) {
  const size = Math.min(Math.max(Math.trunc(Number(perPage)) || DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
  const index = Math.max(Math.trunc(Number(page)) || 1, 1);
  return { limit: size, skip: Math.min((index - 1) * size, MAX_SKIP) };
}

function projectSigner(signer) {
  const out = projectFields(signer, ['objectId', 'Name', 'Email']);
  const userId = signer?.UserId?.objectId;
  if (userId) out.UserId = pointer('_User', userId);
  return out;
}

/**
 * One list row. The query runs with the master key, so class-level protected
 * fields do not apply and the included rows (the owner's account and profile,
 * the signers' contacts) are cut down here to what the list shows.
 */
function projectRow(json, scope) {
  const row = projectFields(json, ROW_FIELDS);
  row.Signers = (Array.isArray(json.Signers) ? json.Signers : [])
    .filter(Boolean)
    .map(projectSigner);
  if (json.CreatedBy?.objectId) {
    row.CreatedBy = projectFields(json.CreatedBy, ['objectId', 'name', 'email', 'username']);
  }
  if (json.ExtUserPtr?.objectId) {
    row.ExtUserPtr = projectFields(json.ExtUserPtr, ['objectId', 'Name', 'Email']);
  }
  // Folders are each person's own filing. A teammate's folder means nothing in
  // the admin's drive, so it only travels on the admin's own rows.
  const mine =
    json.CreatedBy?.objectId === scope.userId || json.ExtUserPtr?.objectId === scope.extUserId;
  if (mine && json.Folder?.objectId) {
    row.Folder = projectFields(json.Folder, ['objectId', 'Name']);
  }
  return row;
}

export default async function getWorkspaceDocuments(request) {
  const user = await resolveCaller(request);
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
  }
  checkRateLimit('getworkspacedocuments', `u:${user.id}`, RATE_PER_MIN);

  const scope = await workspaceAdminScope(user);
  if (!scope) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, NOT_ADMIN);
  }

  const params = request.params || {};
  const owners = ownerWhere(await workspaceMembers(scope));
  const now = dateValue(new Date());
  const whereFor = bucket => ({ ...narrow(bucketWhere(bucket, now), params), ...owners });

  if (params.mode === 'counts') {
    const totals = await Promise.all(
      BUCKETS.map(bucket =>
        Parse.Query.fromJSON('contracts_Document', { where: whereFor(bucket) }).count({
          useMasterKey: true,
        })
      )
    );
    return { counts: Object.fromEntries(BUCKETS.map((bucket, i) => [bucket, totals[i]])) };
  }

  const bucket = params.filter === undefined ? 'all' : params.filter;
  if (!BUCKETS.includes(bucket)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'That filter is not available here.');
  }
  const where = whereFor(bucket);
  const { limit, skip } = clampPaging(params.page, params.perPage);
  const query = Parse.Query.fromJSON('contracts_Document', {
    where,
    keys: QUERY_KEYS,
    include: QUERY_INCLUDE,
    order: '-updatedAt',
    limit,
    skip,
  });
  const [rows, count] = await Promise.all([
    query.find({ useMasterKey: true }),
    Parse.Query.fromJSON('contracts_Document', { where }).count({ useMasterKey: true }),
  ]);
  return { results: rows.map(row => projectRow(row.toJSON(), scope)), count };
}
