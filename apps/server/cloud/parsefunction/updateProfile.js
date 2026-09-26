import { extUserForUser, resolveCaller } from './authGuard.js';

/**
 * Self-service edits to the caller's own `contracts_Users` row.
 *
 * The web app used to PUT `classes/contracts_Users/<id>` directly, and the
 * class was created with `update: { '*': true }` and no row ACL, so the very
 * same request could carry `UserRole: 'contracts_Admin'`, repoint `TenantId`,
 * or plant an `ApiTokenHash` on somebody else's row. The class API is closed
 * now (master key only) and profile edits come through here, where the row is
 * resolved from the session rather than from a client-supplied objectId and
 * only the keys below may be written.
 */

/** Free-text fields, with the maximum length each may hold. */
const STRING_FIELDS = {
  Name: 200,
  Phone: 40,
  Company: 200,
  JobTitle: 200,
  Language: 20,
  Timezone: 100,
  DateFormat: 40,
  DownloadFilenameFormat: 200,
  ProfilePic: 2000,
  Webhook: 2000,
};

const BOOLEAN_FIELDS = new Set([
  'UseNameAsSender',
  'NotifyOnSignatures',
  'SendinOrder',
  'IsTourEnabled',
  'IsLTVEnabled',
  'Is12HourTime',
]);

/** Array-valued preferences. Value: the maximum number of entries. */
const ARRAY_FIELDS = {
  TourStatus: 50,
  SignatureType: 20,
  PenColors: 20,
};

/**
 * Everything a caller must never set on their own row: role, tenancy, the
 * disabled flag, the API-token secrets, and the identity/audit pointers.
 * Anything outside the whitelists above is rejected anyway; this list exists
 * so the rejection message is explicit about privilege escalation.
 */
const FORBIDDEN_FIELDS = new Set([
  'UserRole',
  'TenantId',
  'OrganizationId',
  'TeamIds',
  'IsDisabled',
  'IsContactEntry',
  'Email',
  'UserId',
  'CreatedBy',
  'ACL',
  'objectId',
  'createdAt',
  'updatedAt',
  'ApiTokenHash',
  'ApiTokenPrefix',
  'ApiTokenCreatedAt',
  'ApiTokenLastUsedAt',
  'DeleteOTP',
  'DeleteOTPExpiry',
  'DeleteOTPSentAt',
  'DeleteOTPTries',
  'DeleteOTPHash',
  'DeleteLinkHash',
  'DeleteLinkExpiry',
]);

/** Never handed back to the client, even to the row's own owner. */
const PROTECTED_IN_RESPONSE = [
  'ApiTokenHash',
  'ApiTokenPrefix',
  'ApiTokenCreatedAt',
  'ApiTokenLastUsedAt',
  'DeleteOTP',
  'DeleteOTPExpiry',
  'DeleteOTPSentAt',
  'DeleteOTPTries',
  'DeleteOTPHash',
  'DeleteLinkHash',
  'DeleteLinkExpiry',
];

function invalid(message) {
  return new Parse.Error(Parse.Error.INVALID_QUERY, message);
}

/** `SignatureType` keeps the invariant `updatepreferences` already enforces. */
function validateSignatureType(value) {
  const enabled = value.filter(x => x && x.enabled);
  if (enabled.length === 0) {
    throw invalid('At least one signature type should be enabled.');
  }
  if (enabled.length === 1 && enabled[0]?.name === 'default') {
    throw invalid('At least one signature type other than the default should be enabled.');
  }
}

function coerce(key, value) {
  if (Object.prototype.hasOwnProperty.call(STRING_FIELDS, key)) {
    if (value === null || value === '') return '';
    if (typeof value !== 'string') throw invalid(`${key} must be a string.`);
    const trimmed = value.trim();
    if (trimmed.length > STRING_FIELDS[key]) {
      throw invalid(`${key} must be at most ${STRING_FIELDS[key]} characters.`);
    }
    if ((key === 'Webhook' || key === 'ProfilePic') && trimmed && !/^https?:\/\//i.test(trimmed)) {
      throw invalid(`${key} must be an http(s) URL.`);
    }
    return trimmed;
  }
  if (BOOLEAN_FIELDS.has(key)) {
    if (typeof value !== 'boolean') throw invalid(`${key} must be true or false.`);
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(ARRAY_FIELDS, key)) {
    if (!Array.isArray(value)) throw invalid(`${key} must be an array.`);
    if (value.length > ARRAY_FIELDS[key]) {
      throw invalid(`${key} must have at most ${ARRAY_FIELDS[key]} entries.`);
    }
    if (JSON.stringify(value).length > 20000) throw invalid(`${key} is too large.`);
    if (key === 'SignatureType') validateSignatureType(value);
    return value;
  }
  return undefined;
}

export default async function updateProfile(request) {
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  const patch = request.params?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalid('Please provide a patch object.');
  }

  const keys = Object.keys(patch);
  if (!keys.length) {
    throw invalid('Please provide at least one field to update.');
  }

  const escalation = keys.filter(key => FORBIDDEN_FIELDS.has(key));
  if (escalation.length) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `These fields cannot be changed from your profile: ${escalation.join(', ')}.`
    );
  }

  const updates = {};
  const unknown = [];
  for (const key of keys) {
    const value = coerce(key, patch[key]);
    if (value === undefined) unknown.push(key);
    else updates[key] = value;
  }
  if (unknown.length) {
    throw new Parse.Error(
      Parse.Error.INVALID_KEY_NAME,
      `Not an editable profile field: ${unknown.join(', ')}.`
    );
  }

  const extUser = await extUserForUser(caller);
  if (!extUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
  }
  if (extUser.get('IsDisabled') === true) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This account is disabled.');
  }

  for (const [key, value] of Object.entries(updates)) {
    extUser.set(key, value);
  }
  const saved = await extUser.save(null, { useMasterKey: true });

  const json = JSON.parse(JSON.stringify(saved));
  for (const field of PROTECTED_IN_RESPONSE) delete json[field];
  return json;
}
