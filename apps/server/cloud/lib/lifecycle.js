import { escapeHtml } from '../../Utils.js';
import { renderMail, strong } from './mailShell.js';
import { isParticipantBasic } from '../../utils/workflowUtils.js';
import { conditionalUpdate, readFresh, tryMarkDeclined, updateWithVersion, MAX_WRITE_ATTEMPTS } from './atomic.js';
import { upsertAuditEntry } from './auditTrail.js';
import { ensureContact } from './contacts.js';
import { userPointer } from './context.js';
import {
  assertOwner,
  documentStatus,
  getDocument,
  loadDoc,
  normaliseChain,
  pointerOrEmpty,
} from './documents.js';
import { updateDraft } from './drafts.js';
import { normaliseEmail } from './email.js';
import {
  pendingRequestRecipients,
  resolveRecipient,
  sendSignatureRequestMails,
} from './requestMail.js';
import { scheduleFieldsFor } from './schedule.js';
import sendSystemMail from '../parsefunction/sendSystemMail.js';
import { emitInBackground } from './webhooks.js';

/**
 * What an owner can still do to a document after it was sent: void it, swap a
 * signer who has not signed yet, mail one signer again, move the deadline, or
 * wait for it to change. The draft tools stop at send_document; these pick up
 * from there.
 */

let systemMailer = async params => await sendSystemMail({ params });
/** Test seam: replace the transport the lifecycle notifications go through. */
export function setLifecycleMailTransport(fn) {
  systemMailer = fn || (async params => await sendSystemMail({ params }));
}

async function loadLive(caller, docId) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  return d;
}

function fail(message, code = Parse.Error.SCRIPT_FAILED) {
  return new Parse.Error(code, message);
}

function signedIds(d) {
  const ids = new Set();
  for (const e of d?.AuditTrail || []) {
    if (['Signed', 'Approved', 'Declined'].includes(e?.Activity) && e?.UserPtr?.objectId) {
      ids.add(e.UserPtr.objectId);
    }
  }
  return ids;
}

/** The signer groups with their resolved contact, in order. */
function participants(d) {
  return (d?.Placeholders || [])
    .map((g, index) => ({ g, index }))
    .filter(({ g }) => isParticipantBasic(g))
    .map(({ g, index }) => ({ group: g, index, ...resolveRecipient(g, d?.Signers) }));
}

function findParticipant(d, ref) {
  const list = participants(d);
  const needle = String(ref ?? '').trim().toLowerCase();
  if (!needle) throw fail('Say which signer: their email, contactId or role.', Parse.Error.VALIDATION_ERROR);
  const hit =
    list.find(p => p.email === needle) ||
    list.find(p => p.signerObjId === ref) ||
    list.find(p => String(p.group?.Role || '').toLowerCase() === needle) ||
    (/^\d+$/.test(needle) ? list[Number(needle)] : null);
  if (!hit) throw fail(`Signer "${ref}" is not on this document.`, Parse.Error.OBJECT_NOT_FOUND);
  return hit;
}

function assertLive(d) {
  const status = documentStatus(d);
  if (status === 'draft') throw fail('This document has not been sent yet; edit it with the draft tools.');
  if (status === 'completed') throw fail('This document is completed and can no longer be changed.');
  if (status === 'declined' || status === 'voided') throw fail(`This document was ${status} and can no longer be changed.`);
  return status;
}

function voidMailHtml({ docName, senderName, senderEmail, reason }) {
  return renderMail({
    title: 'Signature request withdrawn',
    preheader: `${senderName || senderEmail} has withdrawn the request to sign ${docName}`,
    paragraphs: [
      `${strong(senderName || senderEmail)} has withdrawn the request to sign ${strong(docName)}. No further action is needed and the signing link no longer works.`,
      reason ? `${strong('Reason:')} ${escapeHtml(reason)}` : '',
    ],
    sender: { senderName, senderMail: senderEmail },
  });
}

/**
 * Void (withdraw) a sent document. Recorded as a decline by the owner with
 * `IsVoided: true`, which is the one state the signing path already refuses;
 * pending signers can be told by mail.
 */
export async function voidDocument(caller, docId, { reason = '', notifySigners = true } = {}) {
  const d = await loadLive(caller, docId);
  assertLive(d);
  const text = String(reason || '').trim().slice(0, 2000);
  const done = await tryMarkDeclined(d.objectId, {
    DeclineReason: text || 'Withdrawn by the sender',
    DeclineBy: userPointer(caller),
    IsVoided: true,
    VoidedAt: new Date(),
  });
  if (!done) {
    const latest = await readFresh('contracts_Document', d.objectId, ['IsDeclined', 'IsCompleted']);
    throw fail(
      latest?.IsCompleted
        ? 'The document was completed while you were voiding it.'
        : 'The document was already declined or voided.'
    );
  }
  // Audit: the owner voided it. The owner has no contact id, so the entry
  // carries the contracts_Users pointer, like an owner signature does.
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const fresh = await readFresh('contracts_Document', d.objectId, ['AuditTrail', 'updatedAt']);
    if (!fresh) break;
    const entry = {
      UserPtr: { __type: 'Pointer', className: 'contracts_Users', objectId: caller.extUserId },
      Activity: 'Voided',
      ipAddress: '',
      VoidedOn: new Date().toISOString(),
    };
    const trail = [...(Array.isArray(fresh.AuditTrail) ? fresh.AuditTrail : []), entry];
    if (await updateWithVersion('contracts_Document', d.objectId, fresh.updatedAt, { AuditTrail: trail })) break;
  }

  const notified = [];
  const failed = [];
  if (notifySigners) {
    const signed = signedIds(d);
    const pending = participants(d).filter(p => p.email && !signed.has(p.signerObjId));
    for (const p of pending) {
      try {
        const res = await systemMailer({
          extUserId: d?.ExtUserPtr?.objectId,
          recipient: p.email,
          subject: `Signature request withdrawn: "${d.Name}"`,
          html: voidMailHtml({
            docName: d.Name,
            senderName: d.SenderName || d.ExtUserPtr?.Name || '',
            senderEmail: d.SenderMail || d.ExtUserPtr?.Email || '',
            reason: text,
          }),
          replyto: d.SenderMail || d.ExtUserPtr?.Email || '',
        });
        if (res?.status === 'success') notified.push(p.email);
        else failed.push({ email: p.email, reason: res?.reason || res?.message || 'mail_failed' });
      } catch (err) {
        failed.push({ email: p.email, reason: err?.message || 'mail_failed' });
      }
    }
  }
  emitInBackground('voided', { ...d, IsDeclined: true, IsVoided: true, DeclineReason: text }, { reason: text });
  const summary = await getDocument(caller, d.objectId);
  return { ...summary, voided: true, reason: text || undefined, notified, failed };
}

/**
 * Put a different person in a signer's seat. Only for a signer who has not
 * signed yet; their fields stay where they are. The new signer is mailed when
 * it is (already) their turn.
 */
export async function replaceSigner(caller, docId, { signer, email, name, phone, notify = true } = {}) {
  const d = await loadLive(caller, docId);
  assertLive(d);
  const target = findParticipant(d, signer);
  if (signedIds(d).has(target.signerObjId)) {
    throw fail(`${target.email || target.group?.Role} has already signed; a signed seat cannot be replaced.`);
  }
  const newEmail = normaliseEmail(email);
  if (!newEmail) throw fail('Give the new signer\'s email.', Parse.Error.VALIDATION_ERROR);
  if (participants(d).some(p => p.email === newEmail && p.signerObjId !== target.signerObjId)) {
    throw fail(`${newEmail} is already a signer on this document.`, Parse.Error.VALIDATION_ERROR);
  }
  const contact = await ensureContact(caller, { email: newEmail, name, phone });

  const placeholders = (d.Placeholders || []).map((g, i) =>
    i === target.index
      ? {
          ...g,
          signerObjId: contact.objectId,
          signerPtr: pointerOrEmpty(contact.objectId),
          email: newEmail,
          Name: contact.name || g.Name,
        }
      : g
  );
  const signers = (d.Signers || []).map(s =>
    s?.objectId === target.signerObjId ? pointerOrEmpty(contact.objectId) : pointerOrEmpty(s?.objectId)
  );
  if (!signers.some(s => s?.objectId === contact.objectId)) signers.push(pointerOrEmpty(contact.objectId));

  const ok = await updateWithVersion('contracts_Document', d.objectId, d.updatedAt, {
    Placeholders: placeholders,
    Signers: signers,
  });
  if (!ok) throw fail('The document changed while you were editing it; try again.');

  let mail = { sent: [], failed: [], skipped: undefined };
  if (notify) {
    const fresh = JSON.parse(JSON.stringify(await loadDoc(d.objectId)));
    const turn = pendingRequestRecipients(fresh).some(r => r.email === newEmail);
    if (turn) {
      mail = await sendSignatureRequestMails({ doc: fresh, publicUrl: caller.publicUrl, only: [newEmail] });
      delete mail.signingLinks;
    } else {
      mail.skipped = 'Signing is in order and it is not this signer\'s turn yet; they will be mailed when it is.';
    }
  }
  const summary = await getDocument(caller, d.objectId);
  return {
    ...summary,
    replaced: { previous: { email: target.email, contactId: target.signerObjId }, now: { email: newEmail, contactId: contact.objectId, name: contact.name } },
    mail,
  };
}

/** Mail the signing request again to one signer (not everybody). */
export async function resendTo(caller, docId, { signer } = {}) {
  const d = await loadLive(caller, docId);
  assertLive(d);
  const target = findParticipant(d, signer);
  if (!target.email) throw fail('That signer has no email address.');
  if (signedIds(d).has(target.signerObjId)) throw fail(`${target.email} has already signed.`);
  const turn = pendingRequestRecipients(d).some(r => r.email === target.email);
  if (!turn) {
    throw fail('Signing is in order and it is not this signer\'s turn yet; mail the current signer instead.');
  }
  const mail = await sendSignatureRequestMails({ doc: d, publicUrl: caller.publicUrl, only: [target.email] });
  delete mail.signingLinks;
  const summary = await getDocument(caller, d.objectId);
  return { ...summary, mail };
}

/** Move the deadline: `days` from now, or an absolute `expiresAt`. */
export async function extendExpiry(caller, docId, { days, expiresAt } = {}) {
  const d = await loadLive(caller, docId);
  assertLive(d);
  let when;
  if (expiresAt) {
    when = new Date(expiresAt);
    if (Number.isNaN(when.getTime())) throw fail('expiresAt is not a date.', Parse.Error.VALIDATION_ERROR);
  } else {
    const n = Math.floor(Number(days));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      throw fail('Give days (1 to 365) or expiresAt.', Parse.Error.VALIDATION_ERROR);
    }
    when = new Date();
    when.setDate(when.getDate() + n);
  }
  if (when.getTime() <= Date.now()) throw fail('The new expiry must be in the future.', Parse.Error.VALIDATION_ERROR);
  const anchor = d?.DocSentAt?.iso ? new Date(d.DocSentAt.iso) : new Date(d.createdAt);
  const totalDays = Math.max(1, Math.ceil((when.getTime() - anchor.getTime()) / 86400000));
  const ok = await conditionalUpdate(
    'contracts_Document',
    d.objectId,
    { IsCompleted: { $ne: true }, IsDeclined: { $ne: true } },
    { ExpiryDate: when, TimeToCompleteDays: totalDays }
  );
  if (!ok) throw fail('The document completed or was declined meanwhile.');
  const summary = await getDocument(caller, d.objectId);
  return { ...summary, previousExpiresAt: d?.ExpiryDate?.iso || undefined };
}

const WAIT_MAX_SECONDS = 55;
const WAIT_POLL_MS = 2500;

/**
 * Block until the document reaches a status (or any change from its current
 * one), for up to `timeoutSec` (max 55 s, under typical HTTP timeouts). Cheaper
 * than spinning get_document: one call, one result.
 */
/**
 * Set or clear the follow-up chain on a document that can still complete: a
 * draft, or a sent document nobody has finished yet. The chain only fires at
 * completion (cloud/lib/chain.js), so changing it mid-flight is safe; a
 * completed, declined or voided document is refused because the chain would
 * never fire. A draft is routed through updateDraft so the change lands in the
 * version history like every other draft edit.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {Object|null} chainInput see documents.normaliseChain; null clears.
 * @returns {Promise<Object>} the get_document summary, chain included.
 */
export async function setDocumentChain(caller, docId, chainInput, { origin = '' } = {}) {
  const d = await loadLive(caller, docId);
  if (d.IsCompleted) {
    throw fail('Document is already completed, so a follow-up chain would never fire.');
  }
  if (d.IsDeclined) {
    throw fail(
      d.IsVoided
        ? 'Document was voided, so a follow-up chain would never fire.'
        : 'Document has been declined, so a follow-up chain would never fire.'
    );
  }
  if (!d.SignedUrl && !d.DocSentAt) {
    await updateDraft(caller, docId, { chain: chainInput ?? null }, { origin });
  } else {
    const chain = await normaliseChain(caller, chainInput ?? null);
    // Trigger-free, like every other post-send write: the afterSave pipeline
    // (versions, reminder scheduling) has no business running for this stamp.
    await conditionalUpdate('contracts_Document', d.objectId, {}, { Chain: chain });
  }
  return await getDocument(caller, docId);
}

export async function waitForDocument(caller, docId, { status, timeoutSec = 30 } = {}) {
  const started = Date.now();
  const limit = Math.min(WAIT_MAX_SECONDS, Math.max(1, Number(timeoutSec) || 30)) * 1000;
  const wanted = Array.isArray(status) ? status : status ? [status] : null;
  let first = await getDocument(caller, docId, { urls: false });
  const initial = first.status;
  const signedCount = doc => doc.signers.filter(s => s.status === 'signed').length;
  const initialSigned = signedCount(first);
  let current = first;
  for (;;) {
    const reached = wanted
      ? wanted.includes(current.status) || (wanted.includes('declined') && current.status === 'voided')
      : current.status !== initial || signedCount(current) !== initialSigned;
    if (reached) return { ...current, waitedMs: Date.now() - started, reached: true };
    if (Date.now() - started + WAIT_POLL_MS > limit) {
      return { ...current, waitedMs: Date.now() - started, reached: false, timedOut: true };
    }
    await new Promise(r => setTimeout(r, WAIT_POLL_MS));
    current = await getDocument(caller, docId, { urls: false });
  }
}
