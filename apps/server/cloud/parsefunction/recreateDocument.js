import { isDocumentOwner } from '../lib/acl.js';
import { readFresh } from '../lib/atomic.js';
import { buildDocumentObject, normaliseSettings, settingsFromDoc } from '../lib/documents.js';
import { scheduleFieldsFor } from '../lib/schedule.js';
import { resetPlaceholdersForCopy } from '../lib/widgets.js';
import { extUserForUser, resolveCaller } from './authGuard.js';

/**
 * Clone a document into a fresh, unsent copy (the "recreate" button on a
 * declined or expired document).
 *
 * It used to load any `contracts_Document` by objectId with the master key and
 * copy `toJSON()` wholesale into a new row: any logged-in user could name a
 * docId and walk away with a copy of somebody else's contract, its signer list
 * and its file, and the spread also carried over the audit trail, the signed
 * URL, the certificate, the document hash, the reminder schedule and the
 * decline reason. The caller must own the document now, and the new row is
 * written by `buildDocumentObject` (cloud/lib/documents.js), the single writer
 * of `contracts_Document`, so what a new document carries is decided in one
 * place rather than by a per-function field list. Everything about the previous
 * run is left behind: no audit trail, no signed url, no certificate, no document
 * hash, no `DocSentAt`, no reminder state, no decline reason, and no `SendMail`
 * flag, because nothing has been mailed yet.
 *
 * Response shape is unchanged (`apps/web/src/features/inbox/api.ts` and
 * `features/documents/api.ts` read `objectId`).
 */
export default async function recreateDocument(request) {
  const { docId } = request.params || {};
  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing docId parameter');
  }
  const user = request.user || (await resolveCaller(request));
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User not aunthenticated');
  }

  const docQuery = new Parse.Query('contracts_Document');
  docQuery.equalTo('objectId', docId);
  docQuery.notEqualTo('IsArchive', true);
  docQuery.include('ExtUserPtr');
  const doc = await docQuery.first({ useMasterKey: true });
  if (!doc) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found');
  }

  const source = doc.toJSON();
  if (!isDocumentOwner(source, user.id)) {
    // Same wording as "no such document": the caller learns nothing either way.
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found');
  }
  if (source?.IsSignyourself) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Signyourself Document not allowed');
  }

  // The copy is built from the stored row, read again with no triggers. `source`
  // came out of a query, and the afterFind trigger replaced URL / SignedUrl /
  // CertificateUrl with presigned links that expire in a couple of minutes, so
  // copying `source.URL` would make an expiring, credential-bearing url the new
  // document's canonical file.
  const stored = (await readFresh('contracts_Document', docId)) || source;
  const extUser = await extUserForUser(user);
  const settings = normaliseSettings(settingsFromDoc(stored));
  // The copy gets a fresh deadline: the original's has usually gone by, which is
  // half the reason the document is being recreated. Same helper as every other
  // schedule in the product.
  const schedule = scheduleFieldsFor(
    {
      TimeToCompleteDays: settings.expiryDays,
      AutomaticReminders: settings.remindEveryDays > 0,
      RemindOnceInEvery: settings.remindEveryDays || 5,
    },
    { now: new Date() }
  );

  const copy = buildDocumentObject(
    { userId: user.id, extUserId: extUser?.id || '' },
    {
      name: stored.Name,
      url: stored.URL,
      note: stored.Note,
      description: stored.Description,
      settings,
      schedule,
      // Fresh widgets: no filled responses, no per-signer signed urls, no carried
      // defaults. The run being recreated is over, so its answers do not travel.
      placeholders: resetPlaceholdersForCopy(stored.Placeholders, {
        clearDefaults: true,
        legacyTextType: true,
      }),
      signers: Array.isArray(stored.Signers) ? stored.Signers : undefined,
      folder: stored.Folder || undefined,
      template: stored.TemplateId || undefined,
      message: { subject: stored.RequestSubject, body: stored.RequestBody },
      senderName: stored.SenderName,
      senderMail: stored.SenderMail,
      signatureType: stored.SignatureType,
      penColors: stored.PenColors,
    }
  );
  copy.set('IsCompleted', false);
  copy.set('IsDeclined', false);
  if (!extUser) {
    // Nothing to point `ExtUserPtr` at; the row is still owned through
    // `CreatedBy`, which is what every ownership check reads first.
    copy.unset('ExtUserPtr');
  }

  const created = await copy.save(null, { useMasterKey: true });
  // No quota charge here. There were two contradictory rules: DocumentBeforesave
  // counts a document when `SignedUrl` first appears (on send) while this
  // function counted at insert, so a recreated document was charged twice, once
  // for being recreated and again for being sent. Counting on send is the rule.
  const newDoc = JSON.parse(JSON.stringify(created));
  return { objectId: newDoc.objectId, createdAt: newDoc.createdAt, updatedAt: newDoc.updatedAt };
}
