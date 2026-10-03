import { resolveCaller } from './authGuard.js';

/**
 * Saves the caller's own signature/initials/stamp images.
 *
 * `contracts_Signature` rows used to carry no ACL and the class was
 * world-readable and world-writable, so passing someone else's row `id` here
 * (or simply paging the class over REST) exposed and overwrote other people's
 * signatures. Two things stop that now: the row is only ever written when the
 * caller already owns it, and every save (re)asserts an owner-only ACL, which
 * also heals rows written before this change.
 */
/**
 * A key the caller did not send is left alone, never blanked: the settings
 * screen saves the signature on its own and the initials on their own.
 *
 * @param {Object} request Parse cloud function request.
 */
export default async function saveSignature(request) {
  const { signature, userId, initials, id, title, stamp } = request.params;

  if (!userId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing userId parameter.');
  }
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  if (userId !== caller.id) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Cannot save signature for the current user.');
  }
  const userPtr = { __type: 'Pointer', className: '_User', objectId: userId };
  const signatureCls = new Parse.Object('contracts_Signature');
  if (id) {
    await assertOwnsSignature(id, caller.id);
    signatureCls.id = id;
  } else {
    // Upsert. The signer flow adopts a signature with `{userId, signature,
    // initials}` and no `id`, so every adopt used to insert another row for
    // the same user; `getdefaultsignature` then returned an unspecified one
    // of them and the settings page could show a stale image.
    const existingId = await findSignatureIdFor(userId);
    if (existingId) signatureCls.id = existingId;
  }
  const setField = (field, value) => {
    if (value) signatureCls.set(field, value);
  };
  setField('Initials', initials);
  setField('ImageURL', signature);
  setField('Stamp', stamp);
  setField('SignatureName', title);
  signatureCls.set('UserId', userPtr);
  signatureCls.setACL(ownerAcl(userId));
  return await signatureCls.save(null, { useMasterKey: true });
}

/**
 * Owner-only ACL: nobody but the signature's owner (and the master key). Also
 * used for the signature an AI agent saves for its user (lib/savedSignature.js).
 */
export function ownerAcl(userId) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  acl.setReadAccess(userId, true);
  acl.setWriteAccess(userId, true);
  return acl;
}

/**
 * Refuses to touch a `contracts_Signature` row the caller does not own.
 * The owner is the `UserId` pointer (`CreatedBy` on very old rows).
 */
async function assertOwnsSignature(id, callerId) {
  const query = new Parse.Query('contracts_Signature');
  const existing = await query.get(id, { useMasterKey: true }).catch(() => null);
  if (!existing) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Signature not found.');
  }
  const ownerId = existing.get('UserId')?.id || existing.get('CreatedBy')?.id || null;
  if (ownerId !== callerId) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You can only change your own signature.'
    );
  }
  return existing;
}

/**
 * The id of the row that already holds this user's signature, newest first, or
 * `null` when they have none yet.
 * @param {string} userId `_User` objectId.
 * @returns {Promise<string|null>} contracts_Signature objectId.
 */
export async function findSignatureIdFor(userId) {
  const query = new Parse.Query('contracts_Signature');
  query.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
  query.descending('updatedAt');
  const existing = await query.first({ useMasterKey: true }).catch(() => null);
  return existing?.id || null;
}
