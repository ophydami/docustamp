import { setTemplateCount } from '../../utils/CountUtils.js';
import { rebuildParticipantAcl, signerIdsOf } from '../lib/acl.js';

export default async function TemplateAfterSave(request) {
  try {
    if (!request.original) {
      console.log('new entry is insert in contracts_Template', request?.object?.id);
      const obj = request.object;
      const objId = obj?.id;
      const ip = request?.headers?.['x-real-ip'] || '';
      const originIp = obj?.get?.('OriginIp') || '';
      const createdAt = obj?.get?.('createdAt');

      // update acl of New template If There are signers present in array
      const signers = obj?.get('Signers');
      const hasSigners = Array.isArray(signers) && signers.length > 0;
      // Awaited: an unawaited save turns any failure into an unhandled rejection.
      await updateTemplateMeta({ objId, createdAt, ip, originIp });
      // Every new template gets an ACL, signers or not. `updateSelfDoc` used to
      // run only when `request.user` was set, so a template created with the
      // master key and no signers was stored with no ACL at all, which in Parse
      // means world readable and world writable. The owner comes from
      // `CreatedBy`, never from the session.
      if (hasSigners) {
        await rebuildParticipantAcl('contracts_Template', objId);
      } else if (objId) {
        await rebuildParticipantAcl('contracts_Template', objId, { includeSigners: false });
      }
      // Charged here rather than in the beforeSave hook, where the increment was
      // unawaited and landed whether or not the write actually committed: a save
      // rejected by a CLP, an ACL or the database left the quota charged with no
      // path to undo it, and the counter is what the quota display reads.
      const extUserId = obj?.get('ExtUserPtr')?.id;
      if (extUserId) await setTemplateCount(extUserId);
    } else {
      // Same rule as `DocumentAftersave`: rebuild on every user-driven save, and
      // on any save that changed `Signers`, including the master-key saves
      // `createduplicate` and the template tools make. Without the second
      // condition a template whose roles were rebound server-side kept the
      // previous signers' ACL and stayed unshared while the call reported
      // success.
      const signersChanged = signerIdsOf(request.original) !== signerIdsOf(request.object);
      if (request?.user || signersChanged) {
        const signers = request.object.get('Signers');
        if (signers && signers.length > 0) {
          await rebuildParticipantAcl('contracts_Template', request.object.id);
        } else {
          if (request?.object?.id) {
            await rebuildParticipantAcl('contracts_Template', request.object.id, {
              includeSigners: false,
            });
          }
        }
      }
    }
  } catch (err) {
    console.log('err in aftersave of contracts_Template');
    console.log(err);
  }

  async function updateTemplateMeta({ objId, createdAt, ip, originIp }) {
    const templateQuery = new Parse.Query('contracts_Template');
    templateQuery.include('ExtUserPtr.TenantId');

    const obj = await templateQuery.get(objId, { useMasterKey: true });
    const update = writeTarget(objId);
    let dirty = false;

    // Automatic reminders
    const AutoReminder = obj?.get('AutomaticReminders') || false;
    if (AutoReminder) {
      const RemindOnceInEvery = obj?.get('RemindOnceInEvery') || 5;
      const ReminderDate = new Date(createdAt);
      ReminderDate.setDate(ReminderDate.getDate() + RemindOnceInEvery);
      update.set('NextReminderDate', ReminderDate);
      dirty = true;
    } else if (obj?.get('NextReminderDate')) {
      // `saveastemplate` used to copy the source document's NextReminderDate,
      // which belongs to a different send and is usually in the past. With
      // reminders off there is nothing to remind about, so the stale date goes.
      update.unset('NextReminderDate');
      dirty = true;
    }
    if (!originIp && ip) {
      update.set('OriginIp', ip);
      dirty = true;
    }
    if (!dirty) return;

    try {
      await update.save(null, { useMasterKey: true });
    } catch (err) {
      console.log(`could not save template meta for ${objId}: `, err?.message || err);
    }
  }

  /**
   * A write target that carries nothing it was not given.
   *
   * `contracts_Template` has an afterFind trigger that replaces URL, SignedUrl
   * and CertificateUrl with freshly presigned links good for a couple of
   * minutes, so every object that comes out of a query has those fields dirty
   * and saving it would persist a credential-bearing, expiring url as the
   * canonical value.
   */
  function writeTarget(objId) {
    const update = new Parse.Object('contracts_Template');
    update.id = objId;
    return update;
  }
}
