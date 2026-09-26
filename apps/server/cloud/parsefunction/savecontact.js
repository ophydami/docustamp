import { assertEmail, ensureContact, findContactByEmail, normaliseEmail } from '../lib/contacts.js';
import { extUserForUser } from './authGuard.js';

/**
 * `savecontact` adds one contact to the caller's address book.
 *
 * It is an adapter now. "Create a contact plus its shadow `_User` plus the ACL"
 * existed in four drifted copies (here, `editcontact`, the contactbook afterSave
 * trigger and `cloud/lib/contacts.js`): only the library one validated the
 * address, pre-checked for an existing shadow user and handled `EMAIL_TAKEN`, and
 * only this one refused duplicates. The library helper is the writer; the
 * duplicate refusal, which is this function's own contract, stays here.
 *
 * The response is unchanged: the full contact row
 * (`apps/web/src/features/contacts/api.ts` reads `objectId` and `Email` off it).
 */
export default async function savecontact(request) {
  const name = request.params.name;
  const phone = request.params.phone;
  // One shared normaliser (lowercase, no whitespace). The shadow `_User` behind
  // a contact is looked up case-sensitively by `logIn`, `setPasswordResetToken`
  // and the signup pre-check, so an address stored with capitals produced an
  // account nobody could ever reach.
  const email = normaliseEmail(request.params?.email);
  const company = request.params?.company;
  const jobTitle = request.params?.jobTitle;

  // The whole body used to sit inside `if (request.user)` with no else, so an
  // anonymous call fell off the end and Parse answered HTTP 200 with a null
  // result, which the SPA then dereferenced.
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  assertEmail(email);

  // The tenant is the caller's own, never the `tenantId` parameter: `getcontact`
  // grants a cross-user read to anyone sharing a contact's `TenantId`, so a
  // client-written value was an authorisation decision made by the client.
  const extUser = await extUserForUser(request.user);
  const caller = {
    userId: request.user.id,
    tenantId: extUser?.get('TenantId')?.id || '',
  };

  if (await findContactByEmail(caller, email)) {
    throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'Contact already exists.');
  }

  // `ensureContact` creates the shadow `_User` with a random password that is
  // never stored (it used to be the address itself, so anyone who knew a
  // signer's email could log in as them), writes the owner+contact ACL, and
  // reconciles a row a concurrent call created rather than leaving a duplicate.
  const contact = await ensureContact(caller, { name, email, phone, company, jobTitle });
  if (!contact.created) {
    // Somebody else created it between the check above and the write.
    throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'Contact already exists.');
  }
  const saved = await new Parse.Query('contracts_Contactbook').get(contact.objectId, {
    useMasterKey: true,
  });
  return JSON.parse(JSON.stringify(saved));
}
