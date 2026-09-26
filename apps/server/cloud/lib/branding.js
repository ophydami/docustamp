import { appName } from '../../Utils.js';
import { senderDisplayName } from './requestMail.js';
import { brandingFromTenant } from '../parsefunction/tenantBranding.js';
import { updateTenantForUser } from '../parsefunction/updateTenant.js';

/**
 * Workspace email branding, read and written through the API token paths (MCP
 * tools `get_branding` / `update_branding`).
 *
 * This is the tenant's `EmailSenderName`, `ReplyTo`, `EmailFooter`, `Logo`,
 * `HidePoweredBy` and the default request / completion mail templates, the same
 * fields the web app's Settings > Branding and Settings > Email templates write
 * through `updatetenant`. The write goes through `updateTenantForUser`, so the
 * role check (tenant admin or org admin) and every validation rule are the ones
 * the web app gets.
 */

const ROLES_THAT_EDIT = new Set(['contracts_Admin', 'contracts_OrgAdmin']);

/** Friendly key -> partners_Tenant key. */
const FIELD_TO_TENANT_KEY = Object.freeze({
  workspaceName: 'TenantName',
  senderName: 'EmailSenderName',
  replyTo: 'ReplyTo',
  footer: 'EmailFooter',
  logoUrl: 'Logo',
  hidePoweredBy: 'HidePoweredBy',
  requestSubject: 'RequestSubject',
  requestBody: 'RequestBody',
  completionSubject: 'CompletionSubject',
  completionBody: 'CompletionBody',
});

export const BRANDING_FIELDS = Object.freeze(Object.keys(FIELD_TO_TENANT_KEY));

/** The {{variables}} the stored mail templates understand (Utils.replaceMailVaribles). */
export const TEMPLATE_VARIABLES = Object.freeze([
  'document_title',
  'note',
  'sender_name',
  'sender_mail',
  'sender_phone',
  'receiver_name',
  'receiver_email',
  'receiver_phone',
  'expiry_date',
  'company_name',
  'signing_url',
]);

function str(value) {
  return typeof value === 'string' ? value : '';
}

async function loadTenant(tenantId) {
  const query = new Parse.Query('partners_Tenant');
  query.equalTo('objectId', tenantId);
  // Never the signing certificate or the storage credentials.
  query.exclude('FileAdapters', 'PfxFile');
  const tenant = await query.first({ useMasterKey: true });
  return tenant ? JSON.parse(JSON.stringify(tenant)) : null;
}

/**
 * The workspace's branding as the caller sees it.
 *
 * @param {import('./context.js').Caller} caller
 * @returns {Promise<Object>}
 */
export async function getBranding(caller) {
  if (!caller?.tenantId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'This account has no workspace.');
  }
  const tenant = await loadTenant(caller.tenantId);
  if (!tenant) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Workspace not found.');
  }
  const branding = brandingFromTenant(tenant);
  const canEdit = ROLES_THAT_EDIT.has(caller.extUser?.UserRole);
  // What a signature request from this caller actually goes out as: the
  // workspace sender name when set, otherwise the per-sender default
  // (company, or the sender's own name when they asked for it).
  const effectiveSenderName =
    branding.senderName ||
    senderDisplayName({
      senderName: caller.name,
      company: caller.company,
      useNameAsSender: caller.useNameAsSender,
    });
  return {
    tenantId: tenant.objectId,
    workspaceName: branding.tenantName,
    senderName: branding.senderName,
    effectiveSenderName,
    replyTo: branding.replyTo,
    footer: branding.footer,
    logoUrl: branding.logo,
    hidePoweredBy: branding.hidePoweredBy,
    requestSubject: str(tenant.RequestSubject),
    requestBody: str(tenant.RequestBody),
    completionSubject: str(tenant.CompletionSubject),
    completionBody: str(tenant.CompletionBody),
    templateVariables: TEMPLATE_VARIABLES,
    canEdit,
    ...(canEdit
      ? {}
      : { note: 'Only a workspace admin can change these; this account can read them.' }),
    poweredByText: `Sent via ${appName}.`,
  };
}

/**
 * Change any of the branding fields. `null` (or an empty string) clears a
 * field; keys that are not present are left alone.
 *
 * @param {import('./context.js').Caller} caller
 * @param {Object} changes friendly keys, see BRANDING_FIELDS
 * @returns {Promise<Object>} the branding after the write, as `getBranding`
 */
export async function updateBranding(caller, changes = {}) {
  if (!caller?.tenantId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'This account has no workspace.');
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'changes must be an object.');
  }
  const unknown = Object.keys(changes).filter(key => !FIELD_TO_TENANT_KEY[key]);
  if (unknown.length) {
    throw new Parse.Error(
      Parse.Error.INVALID_KEY_NAME,
      `Not a branding field: ${unknown.join(', ')}. Known fields: ${BRANDING_FIELDS.join(', ')}.`
    );
  }
  const details = {};
  for (const [field, key] of Object.entries(FIELD_TO_TENANT_KEY)) {
    if (!(field in changes)) continue;
    const value = changes[field];
    // An empty string on a template means "back to the built-in template",
    // which `updateTenantForUser` only does for null/undefined.
    details[key] = value === '' ? null : value;
  }
  if (!Object.keys(details).length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `Nothing to change. Pass at least one of: ${BRANDING_FIELDS.join(', ')}.`
    );
  }
  // One of the two mail templates without the other is never applied
  // (requestMail.js uses a subject/body pair), so say so up front.
  await updateTenantForUser(caller.user, caller.tenantId, details);
  const after = await getBranding(caller);
  const warnings = [];
  if (Boolean(after.requestSubject) !== Boolean(after.requestBody)) {
    warnings.push(
      'requestSubject and requestBody are only used together; the built-in request mail is sent until both are set.'
    );
  }
  if (Boolean(after.completionSubject) !== Boolean(after.completionBody)) {
    warnings.push(
      'completionSubject and completionBody are only used together; the built-in completion mail is sent until both are set.'
    );
  }
  return { ...after, changed: Object.keys(details).length, ...(warnings.length ? { warnings } : {}) };
}
