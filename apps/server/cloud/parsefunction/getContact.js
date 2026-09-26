import { signingTokenFromRequest, verifySigningToken } from '../lib/signingToken.js';
import { checkRateLimit, clientIp, extUserForUser, resolveCaller } from './authGuard.js';

const RATE_ANONYMOUS_PER_MIN = 60;

/** The fields the signer page actually needs; drops CreatedBy/TenantId/ACL. */
function publicProjection(contact) {
  return {
    objectId: contact.id,
    Name: contact.get('Name') || '',
    Email: contact.get('Email') || '',
    Phone: contact.get('Phone') || '',
    JobTitle: contact.get('JobTitle') || '',
    Company: contact.get('Company') || '',
    TourStatus: contact.get('TourStatus') || [],
    UserRole: contact.get('UserRole') || '',
    UserId: contact.get('UserId')?.toPointer?.() || contact.get('UserId'),
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

/**
 * True when this contact is a signer on this document.
 *
 * There used to be an unscoped form of this question ("is this contact a signer
 * anywhere"), which is true for essentially every contact, so an anonymous
 * caller who omitted `docId` could walk objectIds and read the contact book one
 * row at a time. Only the previous frontend called that way; the signer page
 * always names the document, so `docId` is now required and the question is
 * always the narrow one.
 */
async function isSignerOnDocument(contact, docId) {
  const bySigner = new Parse.Query('contracts_Document');
  bySigner.equalTo('Signers', {
    __type: 'Pointer',
    className: 'contracts_Contactbook',
    objectId: contact.id,
  });
  // `Signers` and `Placeholders` are parallel arrays kept in sync by index
  // (§11.4), but a placeholder can be bound a moment before the splice lands.
  const byPlaceholder = new Parse.Query('contracts_Document');
  byPlaceholder.equalTo('Placeholders.signerObjId', contact.id);

  for (const q of [bySigner, byPlaceholder]) {
    q.notEqualTo('IsArchive', true);
    q.equalTo('objectId', docId);
  }
  const query = Parse.Query.or(bySigner, byPlaceholder);
  const doc = await query.first({ useMasterKey: true }).catch(() => null);
  return !!doc;
}

/**
 * The tenant a contact really belongs to: the one on its owner's `contracts_Users`
 * row, not the `TenantId` column, which every contact-writing function used to
 * copy out of a client parameter. Reading the stored field made a cross-user
 * grant out of a value the client chose.
 */
async function ownerTenantId(contact) {
  const ownerId = contact.get('CreatedBy')?.id || contact.get('CreatedBy')?.objectId;
  if (!ownerId) return '';
  const owner = await extUserForUser(ownerId);
  return owner?.get('TenantId')?.id || '';
}

/**
 * How much of a contact the caller may see.
 *
 * `full` is the owner of the row and the contact themself. A colleague in the
 * same tenant gets `public` (the reduced projection), never the raw row: the
 * tenant branch used to hand back `CreatedBy`, `TenantId`, the ACL and `UserId`,
 * so any member of a large tenant could walk objectIds and export the whole
 * company's contact book with the row-owner attached.
 */
async function contactVisibility(contact, caller) {
  if (!caller) return 'none';
  if (contact.get('UserId')?.id === caller.id) return 'full';
  if (contact.get('CreatedBy')?.id === caller.id) return 'full';
  const tenantId = await ownerTenantId(contact);
  if (tenantId) {
    const callerExt = await extUserForUser(caller);
    if (callerExt?.get('TenantId')?.id === tenantId) return 'public';
  }
  return 'none';
}

/**
 * The rate-limit key for an anonymous caller.
 *
 * `clientIp` prefers `x-real-ip`, which index.js fills in from the client's own
 * `X-Forwarded-For` when no proxy overwrites it, so a limiter keyed on it can be
 * defeated with a header. The socket address parse-server puts on the request
 * cannot be spoofed and is used first.
 */
function limiterKey(request) {
  return request?.ip || clientIp(request);
}

/**
 * Used to be a fully unauthenticated dump of any `contracts_Contactbook` row.
 *
 * The guest signing page calls it before any session exists (a document without
 * `IsEnableOTP` never mints one), so the anonymous path has to stay. It is now
 * limited to contacts that really are signers on the named document, returns a
 * reduced projection, and is rate limited per IP.
 */
export default async function getContact(request) {
  const contactId = request.params?.contactId;
  const docId = request.params?.docId || '';
  if (!contactId || typeof contactId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide a contactId.');
  }
  try {
    const contactCls = new Parse.Query('contracts_Contactbook');
    const contactRes = await contactCls.get(contactId, { useMasterKey: true });
    if (request.master) return contactRes;

    const caller = await resolveCaller(request);
    const visibility = await contactVisibility(contactRes, caller);
    if (visibility === 'full') return contactRes;
    if (visibility === 'public') return publicProjection(contactRes);

    if (!caller) {
      checkRateLimit('getcontact', `ip:${limiterKey(request)}`, RATE_ANONYMOUS_PER_MIN);
    }

    // A signing-link token is proof of "I am this contact on this document",
    // which is stronger than the "is a signer somewhere" test below.
    const token = signingTokenFromRequest(request);
    if (token && docId) {
      const verified = verifySigningToken(token, { docId });
      if (verified?.contactId === contactId) {
        return publicProjection(contactRes);
      }
    }

    // Past this point the only thing that can grant access is "you are a signer
    // on this document", so the document has to be named. The answer is the same
    // OBJECT_NOT_FOUND a missing contact gets, so a caller cannot use a bare
    // contactId to learn that the row exists.
    if (!docId) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Contact not found.');
    }
    if (await isSignerOnDocument(contactRes, docId)) {
      return publicProjection(contactRes);
    }
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Contact not found.');
  } catch (err) {
    console.log('Err in contracts_Contactbook class ', err);
    throw err;
  }
}
