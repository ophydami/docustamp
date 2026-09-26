import {
  normaliseFooter,
  normaliseLogoUrl,
  normaliseReplyTo,
  normaliseSenderName,
  normaliseTenantName,
  resetTenantBrandingCache,
} from './tenantBranding.js';
import { extUserForUser } from './authGuard.js';

/**
 * Mail templates, editable by a tenant admin since the first version.
 *
 * These are HTML bodies and subject lines by design, so they are not escaped or
 * stripped of markup the way the branding keys are; what they were missing was
 * any check at all. Any JSON value of any size went straight into
 * `partners_Tenant` next to keys whose length and control characters are
 * carefully validated. Bodies are now capped, subjects are capped and stripped
 * of CR/LF (they end up in a mail header), and a non-string is refused.
 */
const TEMPLATE_KEYS = ['CompletionBody', 'CompletionSubject', 'RequestBody', 'RequestSubject'];
const SUBJECT_KEYS = new Set(['CompletionSubject', 'RequestSubject']);
const MAX_TEMPLATE_SUBJECT = 500;
const MAX_TEMPLATE_BODY = 100000;

/** The two editors the mail-template screens offer, per template. */
const EDITOR_TYPES = new Set(['basic', 'advanced', 'editor']);
const EDITOR_SLOTS = ['request', 'completion'];

function templateValue(key, raw) {
  if (typeof raw !== 'string') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `${key} must be text.`);
  }
  const isSubject = SUBJECT_KEYS.has(key);
  const max = isSubject ? MAX_TEMPLATE_SUBJECT : MAX_TEMPLATE_BODY;
  if (raw.length > max) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `${key} must be ${max} characters or fewer.`
    );
  }
  // A subject is a mail header value: CR/LF there is header injection.
  return isSubject ? raw.replace(/[\r\n]+/g, ' ').trim() : raw;
}

/**
 * `EmailEditorType` is `{request?: 'basic'|'advanced', completion?: ...}` (see
 * apps/web/src/features/settings/types.ts). It had no allowed-value list and
 * could not be cleared, because the write was gated on the value being truthy.
 */
function editorTypeValue(raw) {
  if (raw === null || raw === '' || (typeof raw === 'object' && !Object.keys(raw).length)) {
    return null; // clear it
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'EmailEditorType must be an object.');
  }
  const out = {};
  for (const [slot, value] of Object.entries(raw)) {
    if (!EDITOR_SLOTS.includes(slot)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `EmailEditorType has no "${slot}" template.`
      );
    }
    if (!EDITOR_TYPES.has(value)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `EmailEditorType.${slot} must be one of ${[...EDITOR_TYPES].join(', ')}.`
      );
    }
    out[slot] = value;
  }
  return out;
}

/**
 * Branding keys, each with the check that turns a client string into what is
 * stored. A key whose value is `undefined` (or an empty string, for the
 * optional ones) is unset rather than written.
 */
const BRANDING_KEYS = {
  TenantName: normaliseTenantName,
  Logo: normaliseLogoUrl,
  EmailSenderName: normaliseSenderName,
  EmailFooter: normaliseFooter,
  ReplyTo: normaliseReplyTo,
  HidePoweredBy: value => {
    if (typeof value !== 'boolean') {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'HidePoweredBy must be true or false.');
    }
    return value;
  },
};

const VALID_KEYS = new Set([...TEMPLATE_KEYS, ...Object.keys(BRANDING_KEYS), 'EmailEditorType']);

/**
 * `updatetenant` writes the tenant's mail templates and its branding
 * (workspace name, logo, sender name, reply-to, footer, Powered by). The class
 * itself is master-key only, so this function is the only write path.
 *
 * Authorisation: the caller must hold `contracts_Admin` or `contracts_OrgAdmin`
 * on the tenant they are updating. `tenantId` from the client is never trusted;
 * it only has to agree with the tenant derived from the caller's
 * `contracts_Users` row.
 * @param {Object} request Parse cloud request with `params.tenantId` and `params.details`.
 * @returns {Promise<Object>} the updated tenant, without FileAdapters/PfxFile.
 */
export default async function updateTenant(request) {
  const { tenantId, details } = request.params;

  if (!tenantId || !details) {
    throw new Parse.Error(400, 'Missing tenantId or details.');
  }
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'unauthorized');
  }
  return await updateTenantForUser(request.user, tenantId, details);
}

/** The keys `updateTenantForUser` accepts, for callers that map friendlier names onto them. */
export const TENANT_SETTING_KEYS = Object.freeze([...VALID_KEYS]);

/**
 * The write behind `updatetenant`, shared with the MCP / API branding tools
 * (cloud/lib/branding.js) so every path applies the same role check and the
 * same validation.
 *
 * @param {Parse.User} user the caller
 * @param {string} tenantId must be the caller's own tenant
 * @param {Object} details keys from `TENANT_SETTING_KEYS`; null/undefined unsets
 * @returns {Promise<Object>} the updated tenant, without FileAdapters/PfxFile.
 */
export async function updateTenantForUser(user, tenantId, details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'details must be an object.');
  }
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'unauthorized');
  }

  // Derive the caller's tenant and role server-side. Never trust the
  // client-supplied tenantId: an authenticated user may only update their own
  // tenant and must hold an admin role to do so.
  const callerExtUser = await extUserForUser(user, { activeOnly: true });
  if (!callerExtUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
  }
  const callerRole = callerExtUser.get('UserRole');
  if (callerRole !== 'contracts_Admin' && callerRole !== 'contracts_OrgAdmin') {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Unauthorized.');
  }
  const callerTenantId = callerExtUser.get('TenantId')?.id;
  if (!callerTenantId || callerTenantId !== tenantId) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Unauthorized.');
  }

  const unknown = Object.keys(details).filter(key => !VALID_KEYS.has(key));
  if (unknown.length) {
    throw new Parse.Error(
      Parse.Error.INVALID_KEY_NAME,
      `Not an editable workspace setting: ${unknown.join(', ')}.`
    );
  }

  const tenant = new Parse.Object('partners_Tenant');
  tenant.id = tenantId;

  for (const key of TEMPLATE_KEYS) {
    if (!(key in details)) continue;
    if (details[key] === undefined || details[key] === null) {
      tenant.unset(key);
    } else {
      tenant.set(key, templateValue(key, details[key]));
    }
  }

  for (const [key, normalise] of Object.entries(BRANDING_KEYS)) {
    if (!(key in details)) continue;
    const raw = details[key];
    if (raw === undefined || raw === null) {
      tenant.unset(key);
      continue;
    }
    const value = normalise(raw);
    // TenantName always has a value; the rest clear when emptied.
    if (value === '' && key !== 'TenantName') {
      tenant.unset(key);
    } else {
      tenant.set(key, value);
    }
  }

  if ('EmailEditorType' in details) {
    const editorType =
      details.EmailEditorType === undefined ? null : editorTypeValue(details.EmailEditorType);
    if (editorType === null) {
      tenant.unset('EmailEditorType');
    } else {
      tenant.set('EmailEditorType', editorType);
    }
  }

  await tenant.save(null, { useMasterKey: true });
  resetTenantBrandingCache();

  // Re-read rather than returning the saved object: `exclude` keeps the signing
  // certificate and the storage credentials out of the response, exactly like
  // `gettenant` does, and the afterFind trigger presigns the logo.
  const readback = new Parse.Query('partners_Tenant');
  readback.equalTo('objectId', tenantId);
  readback.exclude('FileAdapters', 'PfxFile');
  const saved = await readback.first({ useMasterKey: true });
  return saved ? JSON.parse(JSON.stringify(saved)) : {};
}
