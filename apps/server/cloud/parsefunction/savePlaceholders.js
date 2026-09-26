import { signingTokenFromRequest } from '../lib/signingToken.js';
import { resolveDocumentActor } from './authGuard.js';

/**
 * `saveplaceholders` persists the widgets a signer placed themselves.
 *
 * The signing page used to write `Placeholders` with a plain REST PUT on
 * `contracts_Document`, which needs document write access in the ACL: that is
 * why every signer used to be granted write on the row, and with it the ability
 * to rewrite any other column (Signers, AuditTrail, IsCompleted). This function
 * is the narrow replacement: it writes exactly one column (two, for the
 * self-sign flag) after checking that the caller may modify this document.
 */

/** A generous cap that no honest layout comes close to. */
const MAX_PLACEHOLDERS_BYTES = 200 * 1024;

function assertPlaceholders(placeholders) {
  if (!Array.isArray(placeholders)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'placeholders must be an array.');
  }
  for (const entry of placeholders) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        'placeholders must be an array of objects.'
      );
    }
  }
  let serialised;
  try {
    serialised = JSON.stringify(placeholders);
  } catch {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'placeholders could not be serialised.');
  }
  if (Buffer.byteLength(serialised, 'utf8') > MAX_PLACEHOLDERS_BYTES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'placeholders payload is too large.');
  }
}

export default async function savePlaceholders(request) {
  const docId = request.params?.docId;
  const placeholders = request.params?.placeholders;
  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'missing parameter docId.');
  }
  assertPlaceholders(placeholders);

  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', docId);
  query.include('ExtUserPtr');
  query.include('Signers');
  query.notEqualTo('IsArchive', true);
  const doc = await query.first({ useMasterKey: true });
  if (!doc) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
  }

  const actor = await resolveDocumentActor(request, doc, {
    contactId: request.params?.contactId,
    signingToken: signingTokenFromRequest(request),
    ownerMayActForContact: true,
  });

  const _doc = doc.toJSON();
  if (_doc.IsCompleted === true) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is already completed.');
  }
  if (_doc.IsDeclined === true) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has been declined.');
  }

  const isOwner = actor.kind === 'owner' || actor.kind === 'master';
  const selfSign = _doc.IsSignyourself === true;
  if (!isOwner && !selfSign && _doc.AllowModifications !== true) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'This document does not allow recipients to change its fields.'
    );
  }

  // A bare object, so the presigned urls the afterFind trigger put on `doc` are
  // never written back over the stored ones.
  const write = new Parse.Object('contracts_Document');
  write.id = doc.id;
  write.set('Placeholders', placeholders);
  if (request.params?.isSignyourself === true && isOwner) {
    write.set('IsSignyourself', true);
  }
  await write.save(null, { useMasterKey: true });

  return { ok: true };
}
