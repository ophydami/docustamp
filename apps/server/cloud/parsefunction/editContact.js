import { assertEmail, contactAcl, normaliseEmail, shadowUserFor } from '../lib/contacts.js';
import { extUserForUser, resolveCaller } from './authGuard.js';

/**
 * Edit one of the caller's contacts.
 *
 * The old implementation set `IsDeleted: true` on the original row *first* and
 * only then looked for a duplicate email and built the replacement, so any
 * rejected edit (duplicate address, invalid email, a failed save) left the
 * caller's contact soft-deleted and gone from every list, and a successful edit
 * changed the objectId under every document that pointed at it.
 *
 * The row is validated first and then updated in place. A changed address still
 * needs a `_User` behind it, which is exactly what `shadowUserFor` gives us, so
 * there is no reason left to recreate the contact.
 *
 * The response stays the full contact row (`apps/web/src/features/contacts/api.ts`
 * reads `objectId`/`Email` off it), only now with the objectId it went in with.
 */
export default async function editContact(request) {
  const { contactId, name, email, phone } = request.params || {};
  const company = request.params?.company;
  const jobTitle = request.params?.jobTitle;

  const user = request.user || (await resolveCaller(request));
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  if (!contactId || typeof contactId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing contactId parameter.');
  }
  const createdBy = { __type: 'Pointer', className: '_User', objectId: user.id };
  const address = normaliseEmail(email);
  assertEmail(address);

  const contact = await new Parse.Query('contracts_Contactbook')
    .get(contactId, { useMasterKey: true })
    .catch(() => null);
  const owner = contact?.get('CreatedBy')?.id || contact?.get('CreatedBy')?.objectId;
  if (!contact || contact.get('IsDeleted') === true || owner !== user.id) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Contact not found.');
  }

  // Validate before touching anything: a rejected edit must leave the row alone.
  const previousEmail = normaliseEmail(contact.get('Email'));
  if (address !== previousEmail) {
    const duplicates = new Parse.Query('contracts_Contactbook');
    duplicates.equalTo('CreatedBy', createdBy);
    duplicates.notEqualTo('IsDeleted', true);
    duplicates.equalTo('Email', address);
    duplicates.notEqualTo('objectId', contactId);
    const isContactExist = await duplicates.first({ useMasterKey: true });
    if (isContactExist) {
      throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'Contact already exists.');
    }
  }

  if (name) contact.set('Name', name);
  contact.set('Email', address);
  // An empty string is "clear it"; an absent field leaves the value alone.
  for (const [field, value] of [
    ['Phone', phone],
    ['Company', company],
    ['JobTitle', jobTitle],
  ]) {
    if (value === undefined || value === null) continue;
    if (value === '') contact.unset(field);
    else contact.set(field, value);
  }
  // The tenant is the caller's own, never the `tenantId` parameter: `getcontact`
  // grants a cross-user read to anyone sharing a contact's `TenantId`, so a
  // client-written value was an authorisation decision made by the client.
  const extUser = await extUserForUser(user);
  const callerTenantId = extUser?.get('TenantId')?.id || '';
  if (callerTenantId) {
    contact.set('TenantId', {
      __type: 'Pointer',
      className: 'partners_Tenant',
      objectId: callerTenantId,
    });
  }
  contact.set('UserRole', 'contracts_Guest');
  contact.set('IsDeleted', false);
  contact.set('CreatedBy', createdBy);

  if (address !== previousEmail) {
    // Shared with `savecontact` and the contactbook afterSave trigger: the
    // shadow `_User` gets a random password that is never stored, instead of
    // its own email address (§C).
    const shadow = await shadowUserFor(name || address.split('@')[0], address, phone);
    contact.set('UserId', { __type: 'Pointer', className: '_User', objectId: shadow.id });
    contact.setACL(contactAcl(user.id, shadow.id));
  }

  const saved = await contact.save(null, { useMasterKey: true });
  return JSON.parse(JSON.stringify(saved));
}
