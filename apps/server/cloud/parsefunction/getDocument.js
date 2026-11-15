import { signingTokenFromRequest } from '../lib/signingToken.js';
import { checkRateLimit, clientIp, resolveDocumentActor } from './authGuard.js';
import { SECRET_EXT_USER_FIELDS } from './getUserDetails.js';

/**
 * `getDocument` used to hand the whole master-key row to anyone who knew a
 * docId: the owner's `_User` (authData, session tokens), the tenant's storage
 * and mail credentials, every signer's contact details, and presigned links to
 * the file itself. It also passed the caller's `include` string straight into a
 * master-key query, so any pointer on the class could be dereferenced.
 *
 * Now: a fixed include list, `resolveDocumentActor` decides who is asking, and
 * a signer (guest link or otherwise) only ever gets the projection the signing
 * page reads. Owners and the master key keep the full row, minus credentials.
 *
 * An admin of the owner's workspace may look too. They get the owner's view of
 * the document with the owner's profile cut down to what the page shows, and
 * `ViewAs: 'workspace_admin'` so the page knows to offer nothing but reading
 * and downloading.
 */

/** The only includes that may run; a caller-supplied `include` is filtered to these. */
const INCLUDE_WHITELIST = [
  'ExtUserPtr',
  'ExtUserPtr.TenantId',
  'Signers',
  'Placeholders.signerPtr',
  'AuditTrail.UserPtr',
  'DeclineBy',
  'CreatedBy',
  'Folder',
  'Bcc',
  'Cc',
];

const RATE_ANONYMOUS_PER_MIN = 60;

/** Keys that must never leave the server, at any depth of the response. */
const SECRET_KEYS = new Set([
  'authData',
  'sessionToken',
  'password',
  '_hashed_password',
  '_email_verify_token',
  '_perishable_token',
  '_password_changed_at',
  '_failed_login_count',
  '_account_lockout_expires_at',
  'google_refresh_token',
  'FileAdapters',
  'PfxFile',
  'SMTPPass',
  'SMTPPassword',
  'SMTPSecret',
  'ApiToken',
  'TokenHash',
  'SecretKey',
]);

/** Tenant fields a signer may see: branding only. */
const SAFE_TENANT_FIELDS = [
  'objectId',
  'TenantName',
  'Logo',
  'ThemeColor',
  'Domain',
  'HidePoweredBy',
];

/** `contracts_Users` fields the signing page reads. */
const SAFE_EXT_USER_FIELDS = [
  'objectId',
  'Name',
  'Email',
  'Phone',
  'Company',
  'JobTitle',
  'DateFormat',
  'Timezone',
  'Is12HourTime',
  'UseNameAsSender',
];

/** `contracts_Contactbook` fields the signing page reads. */
const SAFE_CONTACT_FIELDS = ['objectId', 'Name', 'Email', 'Phone', 'Company', 'JobTitle'];

/** Document columns a signer may see. Everything else is owner-only. */
const SIGNER_DOCUMENT_FIELDS = [
  'objectId',
  'Name',
  'Note',
  'Description',
  'URL',
  'SignedUrl',
  'CertificateUrl',
  'DocumentHash',
  'IsCompleted',
  'IsDeclined',
  'DeclineReason',
  'IsArchive',
  'IsSignyourself',
  'SentToOthers',
  'SendinOrder',
  'SendInOrderStrict',
  'IsEnableOTP',
  'IsTourEnabled',
  'AllowModifications',
  'NotifyOnSignatures',
  'TimeToCompleteDays',
  'ExpiryDate',
  'DocSentAt',
  'SignatureType',
  'PenColors',
  'RedirectUrl',
  'SenderName',
  'SenderMail',
  'IsSendMail',
  'createdAt',
  'updatedAt',
];

function pick(source, fields) {
  if (!source || typeof source !== 'object') return undefined;
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** Recursively drop credential-ish keys from an owner/master response. */
function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = scrubSecrets(inner);
  }
  return out;
}

/** A `_User` row reduced to what the page renders. */
function publicUser(user) {
  if (!user || typeof user !== 'object') return user;
  const projected = { objectId: user.objectId };
  const name = user.name || user.Name;
  const email = user.email || user.Email || user.username;
  if (name) projected.name = name;
  if (email) projected.email = email;
  return projected;
}

function publicContact(contact) {
  if (!contact || typeof contact !== 'object') return contact;
  const projected = pick(contact, SAFE_CONTACT_FIELDS) || {};
  // The signer page matches the signed-in user against the contact's `_User`.
  if (contact.UserId?.objectId) {
    projected.UserId = {
      __type: 'Pointer',
      className: '_User',
      objectId: contact.UserId.objectId,
    };
  }
  return projected;
}

function publicPlaceholders(placeholders) {
  if (!Array.isArray(placeholders)) return [];
  return placeholders.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const copy = { ...entry };
    if (copy.signerPtr && typeof copy.signerPtr === 'object' && copy.signerPtr.objectId) {
      copy.signerPtr = publicContact(copy.signerPtr);
    }
    return copy;
  });
}

function publicAuditTrail(auditTrail) {
  if (!Array.isArray(auditTrail)) return [];
  return auditTrail.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const copy = { ...entry };
    if (copy.UserPtr && typeof copy.UserPtr === 'object') {
      copy.UserPtr = publicContact(copy.UserPtr);
    }
    return copy;
  });
}

/** Everything a signer needs and nothing else. */
function signerProjection(doc) {
  const projected = pick(doc, SIGNER_DOCUMENT_FIELDS) || {};
  projected.Placeholders = publicPlaceholders(doc.Placeholders);
  projected.Signers = Array.isArray(doc.Signers) ? doc.Signers.map(publicContact) : [];
  projected.AuditTrail = publicAuditTrail(doc.AuditTrail);
  if (doc.CreatedBy) projected.CreatedBy = publicUser(doc.CreatedBy);
  if (doc.DeclineBy) projected.DeclineBy = publicUser(doc.DeclineBy);
  if (doc.ExtUserPtr) {
    const extUser = pick(doc.ExtUserPtr, SAFE_EXT_USER_FIELDS) || {};
    if (doc.ExtUserPtr.TenantId) {
      extUser.TenantId = pick(doc.ExtUserPtr.TenantId, SAFE_TENANT_FIELDS);
    }
    projected.ExtUserPtr = extUser;
  }
  return projected;
}

/** Owners and the master key keep the full row, minus credentials. */
function ownerProjection(doc) {
  const scrubbed = scrubSecrets(doc);
  if (scrubbed.CreatedBy) scrubbed.CreatedBy = publicUser(scrubbed.CreatedBy);
  if (scrubbed.DeclineBy) scrubbed.DeclineBy = publicUser(scrubbed.DeclineBy);
  return scrubbed;
}

/** The owner's `contracts_Users` row, reduced to what a reader other than the owner may hold. */
function publicExtUser(extUser) {
  const projected = pick(extUser, SAFE_EXT_USER_FIELDS) || {};
  if (extUser?.TenantId) projected.TenantId = pick(extUser.TenantId, SAFE_TENANT_FIELDS);
  return projected;
}

/** Profile columns that belong to the account holder alone. */
const PROFILE_SECRET_KEYS = new Set(SECRET_EXT_USER_FIELDS);

/** Recursively drop the account-only profile columns, wherever a profile row is embedded. */
function scrubProfileSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubProfileSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (PROFILE_SECRET_KEYS.has(key)) continue;
    out[key] = scrubProfileSecrets(inner);
  }
  return out;
}

/**
 * What a workspace admin sees of a teammate's document: everything about the
 * document, nothing about the teammate's account.
 *
 * The owner's profile row carries their API token hash, webhook url and
 * account-deletion code columns. To the owner those are their own, so
 * `scrubSecrets` leaves them in. Here the profile on the document is projected
 * down to what the page shows, and the same columns are dropped anywhere else
 * the row is embedded (the audit trail points at it when the owner signed).
 */
function viewerProjection(doc) {
  const projected = scrubProfileSecrets(ownerProjection(doc));
  if (projected.ExtUserPtr) projected.ExtUserPtr = publicExtUser(doc.ExtUserPtr);
  projected.ViewAs = 'workspace_admin';
  return projected;
}

/** Cheap "is this call carrying a session at all" test, for rate limiting only. */
function hasSession(request) {
  const h = request?.headers || {};
  return Boolean(request?.user || h.sessiontoken || h['x-parse-session-token'] || h.sessionToken);
}

function extraIncludes(rawInclude) {
  if (typeof rawInclude !== 'string' || !rawInclude) return [];
  return rawInclude
    .split(',')
    .map(x => x.trim())
    .filter(x => INCLUDE_WHITELIST.includes(x));
}

export default async function getDocument(request) {
  const docId = request?.params?.docId;
  // Errors are thrown, never returned as `{error: string}` with HTTP 200: this
  // function used to answer an authorization failure with a 200 and (on the
  // catch path) with `return err`, which Parse serialised as `{}`, so the signer
  // page rendered an empty document instead of a message. The REST layer maps
  // Parse.Error codes to statuses and the SPA turns them into one CloudError.
  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please pass required parameters!');
  }

  const signingToken = signingTokenFromRequest(request);
  if (!request?.master && !hasSession(request)) {
    checkRateLimit('getdocument', `ip:${clientIp(request)}`, RATE_ANONYMOUS_PER_MIN);
  }

  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', docId);
  for (const path of INCLUDE_WHITELIST) query.include(path);
  // Kept for compatibility with callers that ask for includes explicitly; the
  // value is filtered against the same list rather than trusted.
  for (const path of extraIncludes(request?.params?.include)) query.include(path);
  query.notEqualTo('IsArchive', true);

  const res = await query.first({ useMasterKey: true });
  if (!res) {
    throw new Parse.Error(
      Parse.Error.OBJECT_NOT_FOUND,
      "document deleted or you don't have access."
    );
  }

  // Throws (including the OTP gate message) when the caller has no standing.
  const actor = await resolveDocumentActor(request, res, {
    contactId: request?.params?.contactId,
    signingToken,
    ownerMayActForContact: true,
    allowWorkspaceViewer: true,
  });

  const document = JSON.parse(JSON.stringify(res));
  if (actor.kind === 'master' || actor.kind === 'owner') {
    return ownerProjection(document);
  }
  if (actor.kind === 'viewer') return viewerProjection(document);
  return signerProjection(document);
}
