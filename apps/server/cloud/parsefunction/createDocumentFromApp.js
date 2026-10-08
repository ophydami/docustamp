import { buildDocumentObject, normaliseSettings, settingsFromDoc } from '../lib/documents.js';
import { assertStoredFileUrl } from '../lib/files.js';
import { normaliseContent } from '../lib/textDocument.js';
import { assertNotDisabled, extUserForUser } from './authGuard.js';

/**
 * `createdocumentfromapp` inserts the document the web app has just built.
 *
 * It is an adapter now, not a fifth way of writing `contracts_Document`: the
 * payload is mapped onto the shape `cloud/lib/documents.js` takes and the row is
 * built by `buildDocumentObject`, which is the single writer. That is what stops
 * the five creation paths drifting apart again on ownership, on the
 * `SendinOrder` / `SendInOrderStrict` pair, on the expiry base date and on
 * optional columns such as `PenColors`.
 *
 * It runs with the master key, so who the row belongs to is decided here rather
 * than taken from the payload: the browser used to hand in `CreatedBy` and
 * `ExtUserPtr`, which meant any signed-in caller could file a document under
 * somebody else's account (and have it counted against their quota). Both
 * pointers now come from the session, and the client's are ignored.
 *
 * The file url gets the same treatment as every other entry point: it has to be
 * a file this deployment stores, otherwise it is copied into our storage first
 * (see `assertStoredFileUrl`).
 *
 * The response is unchanged: the saved Parse object, whose `objectId` the SPA
 * reads (`apps/web/src/features/send/api.ts` createDraft).
 */
export default async function createDocumentFromApp(request) {
  const doc = request.params?.document;

  if (!doc) {
    throw new Parse.Error(Parse.Error.INVALID_JSON, 'Missing document payload.');
  }

  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  const extUser = await extUserForUser(request.user);
  if (!extUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User profile not found.');
  }
  assertNotDisabled(extUser);
  const caller = {
    userId: request.user.id,
    extUserId: extUser.id,
    tenantId: extUser.get('TenantId')?.id || '',
  };

  const url = await assertStoredFileUrl(doc?.URL, caller);
  // A bulk send creates the row already sent, and SignedUrl is then the same
  // stored file; it is validated in its own right rather than trusted.
  const signedUrl = doc.SignedUrl ? await assertStoredFileUrl(doc.SignedUrl, caller) : '';

  try {
    // `settingsFromDoc` reads the same column names the SPA writes, so the
    // payload needs no field-by-field translation; `normaliseSettings` then
    // applies the one set of rules (clamped expiry, strict order only with
    // sequential sending, addresses lowercased).
    const settings = normaliseSettings({
      ...settingsFromDoc(doc),
      // This path has always defaulted the flag to off when the client omits it.
      notifyOnSignatures: doc.NotifyOnSignatures !== undefined ? doc.NotifyOnSignatures : false,
    });

    const docCls = buildDocumentObject(caller, {
      name: doc?.Name || 'untitled document',
      url,
      description: doc.Description,
      note: doc.Note,
      settings,
      signedUrl: signedUrl || undefined,
      sentToOthers: doc.SentToOthers === true,
      isTourEnabled: doc.IsTourEnabled === true,
      docSentAt: doc?.DocSentAt?.iso ? new Date(doc.DocSentAt.iso) : undefined,
      template: doc.TemplateId || undefined,
      signers: doc.Signers?.length ? doc.Signers : undefined,
      placeholders: doc.Placeholders?.length ? doc.Placeholders : undefined,
      signatureType: doc.SignatureType,
      penColors: doc.PenColors,
      // A written document: the typed content its PDF was rendered from, held
      // to the same shape and limits the renderer applies.
      content: doc.Content ? normaliseContent(doc.Content) : undefined,
      // ExpiryDate / NextReminderDate are deliberately not set here: this row is
      // still being assembled by the wizard (recipients and fields arrive in
      // later PUTs), and `DocumentAftersave` derives both from the stored
      // settings on insert, which is the one place that decision lives.
    });

    const docRes = await docCls.save(null, { useMasterKey: true });

    // No quota charge here. There were two contradictory rules: DocumentBeforesave
    // counts a document when `SignedUrl` first appears (on send) while this
    // function counted at insert, so a document created and then sent was charged
    // twice. The call was broken anyway: it passed `doc?.ExtUserPtr?.id` where the
    // SPA sends plain pointer JSON, which has `objectId` and no `id`, and it was
    // not awaited. Counting on send is the rule, and DocumentAftersave owns it.
    return docRes;
  } catch (error) {
    console.log('error in create document from app: ', error);
    throw error;
  }
}
