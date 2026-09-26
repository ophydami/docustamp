import { setDocumentCount } from '../../utils/CountUtils.js';
import { rebuildParticipantAcl, signerIdsOf } from '../lib/acl.js';
import { SCHEDULE_INPUT_FIELDS, scheduleFieldsFor } from '../lib/schedule.js';
import { recordExternalEdit } from '../lib/drafts.js';

async function DocumentAftersave(request) {
  try {
    if (!request.original) {
      console.log('new entry is insert in contracts_Document ', request?.object?.id);
      const obj = request.object;
      const objId = obj?.id;
      const createdAt = obj?.get?.('createdAt');
      const folder = obj?.get?.('Type');
      const ip = request?.headers?.['x-real-ip'] || '';
      const originIp = obj?.get?.('OriginIp') || '';
      if (createdAt) {
        await updateDocumentMeta({ objId, folder, ip, originIp });
      }

      const signers = obj?.get?.('Signers');
      const hasSigners = Array.isArray(signers) && signers.length > 0;
      // Every new document gets an ACL, signers or not. `updateSelfDoc` used to
      // run only when `request.user` was set, so a document created with the
      // master key and no signers (the MCP/REST draft tools, batch creation, an
      // import) was stored with no ACL at all, which in Parse means world
      // readable and world writable. The owner comes from `CreatedBy`, never
      // from the session, so it is the same either way.
      if (hasSigners) {
        await rebuildParticipantAcl('contracts_Document', objId);
      } else if (objId) {
        await rebuildParticipantAcl('contracts_Document', objId, { includeSigners: false });
      }
    } else {
      // Rebuild the ACL on every user-driven save (legacy behaviour) and on any
      // save that changed `Signers`, including master-key saves from the MCP /
      // REST draft tools, duplicate and linkcontacttodoc. Without the second
      // condition a document whose recipients were swapped server-side kept the
      // previous signers' ACL, so `getDocument` rejected the real signer right
      // after a successful OTP login.
      const signersChanged = signerIdsOf(request.original) !== signerIdsOf(request.object);
      if (request?.user || signersChanged) {
        const signers = request.object.get('Signers');
        if (signers && signers.length > 0) {
          await rebuildParticipantAcl('contracts_Document', request.object.id);
        } else {
          if (request?.object?.id) {
            await rebuildParticipantAcl('contracts_Document', request.object.id, {
              includeSigners: false,
            });
          }
        }
      }
      await rescheduleIfNeeded(request);
      await chargeOnSend(request);
    }
  } catch (err) {
    console.log('err in aftersave of contracts_Document');
    console.log(err);
  }
  // A draft edited from the browser (session write) goes into the same version
  // history the MCP/REST draft tools keep. Housekeeping: it never fails the save
  // and never gets in the way of the ACL rebuild above.
  try {
    if (request.original) await recordExternalEdit(request);
  } catch (err) {
    console.log('contracts_Document afterSave: version not recorded', err?.message || err);
  }

  /**
   * Charge the owner's quota the first time a document is sent.
   *
   * This used to be an unawaited `setDocumentCount` in `DocumentBeforesave`, so
   * the counter was bumped independently of whether the write actually
   * committed: a save rejected afterwards by a CLP, an ACL or the database left
   * the quota charged with no path to undo it, and the unawaited call meant the
   * surrounding try/catch could never see a failure. Here the row exists.
   *
   * One rule, one place: the counter moves when `SignedUrl` first appears, which
   * is when the document is sent. `recreateDocument` and `createDocumentFromApp`
   * used to charge at insert as well, so a recreated document was billed twice.
   */
  async function chargeOnSend(req) {
    const original = req.original;
    const object = req.object;
    if (!original || original.get('SignedUrl') || !object.get('SignedUrl')) return;
    const extUserId = object.get('ExtUserPtr')?.id || original.get('ExtUserPtr')?.id;
    if (!extUserId) return;
    await setDocumentCount(extUserId);
  }

  /** Same value on both sides of a save? Dates compare by instant. */
  function sameValue(a, b) {
    if (a instanceof Date || b instanceof Date) {
      return (a instanceof Date ? a.getTime() : a) === (b instanceof Date ? b.getTime() : b);
    }
    return a === b;
  }

  /**
   * Recompute ExpiryDate / NextReminderDate when the settings that drive them
   * change on an existing document.
   *
   * They used to be written on insert only, so raising TimeToCompleteDays or
   * switching AutomaticReminders on after the fact changed nothing the server
   * acts on: no NextReminderDate meant the sweep never saw the document. Sending
   * counts too, because that is when the clock really starts (DocSentAt).
   *
   * A save that sets ExpiryDate or NextReminderDate itself is left alone: an
   * explicit date always wins over a derived one.
   */
  async function rescheduleIfNeeded(req) {
    const object = req.object;
    const original = req.original;
    const folder = object?.get('Type');
    if (folder !== undefined && folder !== 'AIDoc') return;

    const changed = SCHEDULE_INPUT_FIELDS.some(
      field => !sameValue(original?.get(field), object?.get(field))
    );
    if (!changed) return;
    const explicit = ['ExpiryDate', 'NextReminderDate'].some(
      field => !sameValue(original?.get(field), object?.get(field))
    );
    if (explicit) return;

    const { ExpiryDate, NextReminderDate } = scheduleFieldsFor(
      {
        DocSentAt: object.get('DocSentAt'),
        createdAt: object.get('createdAt') || object.createdAt,
        TimeToCompleteDays: object.get('TimeToCompleteDays'),
        AutomaticReminders: object.get('AutomaticReminders') === true,
        RemindOnceInEvery: object.get('RemindOnceInEvery'),
      },
      { defaultExpiryDays: folder === undefined ? undefined : null }
    );

    // A bare object: `request.object` may carry the presigned urls the afterFind
    // trigger swapped in, and saving it would persist those.
    const update = new Parse.Object('contracts_Document');
    update.id = object.id;
    if (ExpiryDate) update.set('ExpiryDate', ExpiryDate);
    if (NextReminderDate) update.set('NextReminderDate', NextReminderDate);
    else update.unset('NextReminderDate');
    try {
      await update.save(null, { useMasterKey: true });
    } catch (err) {
      console.log(`could not reschedule document ${object.id}: `, err?.message || err);
    }
  }

  /**
   * A write target that carries nothing it was not given.
   *
   * `contracts_Document` has an afterFind trigger that replaces URL, SignedUrl
   * and CertificateUrl with freshly presigned links good for a couple of
   * minutes. Every object that comes out of a query therefore has those fields
   * dirty, and saving it persists a credential-bearing, already-expiring url as
   * the canonical value, which then gets copied forward into templates,
   * duplicates and draft snapshots. So nothing here ever saves a queried object:
   * the id goes onto a bare object and only the intended fields are written.
   */
  function writeTarget(objId) {
    const update = new Parse.Object('contracts_Document');
    update.id = objId;
    return update;
  }

  async function updateDocumentMeta({ objId, folder, ip, originIp }) {
    const documentQuery = new Parse.Query('contracts_Document');
    documentQuery.include('ExtUserPtr.TenantId');

    const doc = await documentQuery.get(objId, { useMasterKey: true });
    const update = writeTarget(objId);
    let dirty = false;
    if (folder === undefined || folder === 'AIDoc') {
      const { ExpiryDate, NextReminderDate } = scheduleFieldsFor(
        {
          DocSentAt: doc.get('DocSentAt'),
          createdAt: doc.get('createdAt') || doc.createdAt,
          TimeToCompleteDays: doc.get('TimeToCompleteDays'),
          AutomaticReminders: doc.get('AutomaticReminders') === true,
          RemindOnceInEvery: doc.get('RemindOnceInEvery'),
        },
        // Keep the default of 15 days for a plain document only; AIDoc keeps its
        // original behaviour of no forced default.
        { defaultExpiryDays: folder === undefined ? undefined : null }
      );
      if (ExpiryDate) {
        update.set('ExpiryDate', ExpiryDate);
        dirty = true;
      }
      if (NextReminderDate) {
        update.set('NextReminderDate', NextReminderDate);
        dirty = true;
      }

      // OriginIp
      if (!originIp && ip) {
        update.set('OriginIp', ip);
        dirty = true;
      }
    }
    if (!dirty) return;

    try {
      await update.save(null, { useMasterKey: true });
    } catch (err) {
      console.log(`could not save document meta for ${objId}: `, err?.message || err);
    }
  }
}

export default DocumentAftersave;
