/**
 * `gettenant` reads a `partners_Tenant` row. The class itself is master-key
 * only (see 20250424104819-change_permission.cjs), so this function is the read
 * path, and it has two very different callers:
 *
 *  1. the settings screens of a signed-in member of the workspace, and
 *  2. the guest signing page, which has no session at all and identifies the
 *     workspace by the `contactId` in its signing link.
 *
 * It used to serve both without any authentication: `userId` and `contactId`
 * both came straight from the client and the whole row came back minus
 * `FileAdapters`/`PfxFile`. Anyone could therefore read any workspace's tenant
 * record (its address, contact number, mail templates, Google refresh token,
 * whatever a later column adds) by guessing an objectId.
 *
 * Now the authenticated branch ignores the `userId` parameter entirely and
 * derives the tenant from the caller's own `contracts_Users` row, exactly like
 * `updatetenant` does, and both branches answer with an explicit whitelist.
 */
import {
  assertNotDisabled,
  checkRateLimit,
  clientIp,
  extUserForUser,
  projectFields,
  resolveCaller,
} from './authGuard.js';

/**
 * What a member of the workspace may read. Everything the settings screens
 * render (apps/web/src/features/settings) plus the mail templates the old
 * frontend reads. Deliberately absent: `FileAdapters` and `PfxFile` (storage
 * credentials and the signing certificate), `google_refresh_token`, any SMTP
 * secret and anything matching *Token* / *Secret* / *Password*, which is why
 * this is a whitelist and not an `exclude` list: a new secret column added
 * later is invisible here until someone adds it on purpose.
 */
const MEMBER_TENANT_FIELDS = [
  'objectId',
  'createdAt',
  'updatedAt',
  'TenantName',
  'EmailAddress',
  'ContactNumber',
  'Domain',
  'Logo',
  'Favicon',
  'ThemeColor',
  'IsActive',
  'Address',
  'City',
  'State',
  'Country',
  'PinCode',
  'EmailSenderName',
  'EmailFooter',
  'ReplyTo',
  'HidePoweredBy',
  'SignatureType',
  'RequestSubject',
  'RequestBody',
  'CompletionSubject',
  'CompletionBody',
  'EmailEditorType',
];

/**
 * What an anonymous signer may read. The branding the signing page paints with
 * (the same set `getDocument` hands a signer), plus `SignatureType`, which
 * decides which signature widgets the page offers, and the request mail
 * template, which the old signing page forwards to the next signer when a
 * document is signed in order. Those templates are the copy the signer was
 * already emailed, so they are not a secret from this caller.
 */
const PUBLIC_TENANT_FIELDS = [
  'objectId',
  'TenantName',
  'Logo',
  'Favicon',
  'ThemeColor',
  'Domain',
  'HidePoweredBy',
  'SignatureType',
  'RequestSubject',
  'RequestBody',
];

/** Anonymous branding lookups per IP per minute. */
const RATE_CONTACT_PER_MIN = 30;

/** Branding for the workspace a signing-link contact belongs to. */
async function publicTenantForContact(contactId) {
  const contactQuery = new Parse.Query('contracts_Contactbook');
  const contact = await contactQuery.get(contactId, { useMasterKey: true }).catch(() => null);
  const tenantId = contact?.get('TenantId')?.id;
  if (!tenantId) return {};

  const tenantQuery = new Parse.Query('partners_Tenant');
  tenantQuery.equalTo('objectId', tenantId);
  // Two arguments, not one comma-joined key: `exclude('a,b')` excludes a
  // column literally called "a,b" and therefore nothing at all.
  tenantQuery.exclude('FileAdapters', 'PfxFile');
  const tenant = await tenantQuery.first({ useMasterKey: true });
  return projectFields(tenant, PUBLIC_TENANT_FIELDS);
}

/** The tenant of the caller's own `contracts_Users` row. */
async function tenantForCaller(caller) {
  const extUser = await extUserForUser(caller);
  if (!extUser) return {};
  assertNotDisabled(extUser);

  const tenantId = extUser.get('TenantId')?.id || '';
  const ownerId = extUser.get('CreatedBy')?.id || caller.id;

  const tenantQuery = new Parse.Query('partners_Tenant');
  if (tenantId) {
    tenantQuery.equalTo('objectId', tenantId);
  } else {
    // Legacy rows with no TenantId: the tenant is the one this account owns.
    tenantQuery.equalTo('UserId', {
      __type: 'Pointer',
      className: '_User',
      objectId: ownerId,
    });
  }
  // Two arguments, not one comma-joined key: `exclude('a,b')` excludes a
  // column literally called "a,b" and therefore nothing at all.
  tenantQuery.exclude('FileAdapters', 'PfxFile');
  const tenant = await tenantQuery.first({ useMasterKey: true });
  return projectFields(tenant, MEMBER_TENANT_FIELDS);
}

export default async function getTenant(request) {
  const contactId = typeof request.params?.contactId === 'string' ? request.params.contactId : '';

  if (contactId) {
    checkRateLimit('gettenant:contact', clientIp(request), RATE_CONTACT_PER_MIN);
    try {
      return await publicTenantForContact(contactId);
    } catch (err) {
      console.log('err in gettenant (contact)', err?.message);
      return {};
    }
  }

  // The `userId` parameter is ignored on purpose: the tenant always comes from
  // the caller's own row, so it cannot be pointed at somebody else's workspace.
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  try {
    return await tenantForCaller(caller);
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('err in gettenant', err?.message);
    throw new Parse.Error(err?.code || 400, err?.message || 'Something went wrong.');
  }
}
