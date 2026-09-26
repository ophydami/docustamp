import { appName } from '../../Utils.js';
import { renderMail, requestDetails, strong } from '../lib/mailShell.js';
import { COMPLETION_ACTIVITIES, isParticipantBasic } from '../../utils/workflowUtils.js';
import {
  buildRequestMail,
  buildSigningUrl,
  formatExpiryDate,
  resolveAppOrigin,
  resolveRecipient,
} from '../lib/requestMail.js';
import { mintSigningToken, signingTokenExpiry } from '../lib/signingToken.js';
import { isDocumentOwner } from '../lib/acl.js';
import { checkRateLimit, extUserForUser } from './authGuard.js';
import sendSystemMail from './sendSystemMail.js';
import { withTenantBranding } from './tenantBranding.js';

/**
 * Re-exported so `sendmailv3`, `pdf/PDF.js` and the specs keep their imports.
 * The definitions moved to `cloud/lib/requestMail.js`, which is the single
 * builder of the signature-request mail: this file used to hold a second copy of
 * the whole renderer, and the two had drifted.
 */
export { buildSigningUrl, formatExpiryDate, resolveAppOrigin };

// Roles that may send a reminder for a document they do not own, as long as
// they belong to the same tenant as the document owner.
const ADMIN_ROLES = ['contracts_Admin', 'contracts_OrgAdmin'];

// Keep the audit of sent reminders bounded so the document does not grow forever.
const MAX_REMINDER_ENTRIES = 50;

/**
 * Nothing capped manual reminders: no limiter, and `LastReminderAt` was written
 * but never read, so an owner could loop `sendreminder` against their own
 * document and mail-bomb third-party signers from the platform's SPF-aligned
 * domain. Both guards live in `sendReminderForDoc` so the cloud function, the
 * REST endpoint and the MCP tool inherit them.
 */
const REMINDERS_PER_DOC_PER_MIN = 3;
const REMINDERS_PER_CALLER_PER_MIN = 10;

/** A document may not be reminded again inside this window. */
export const MIN_REMINDER_INTERVAL_MS =
  Number(process.env.MIN_REMINDER_INTERVAL_MINUTES || 60) * 60 * 1000;

/** `Parse.Error` code used when a reminder is refused as too soon. */
export const TOO_SOON_CODE = Parse.Error.REQUEST_LIMIT_EXCEEDED || 155;

/**
 * How long the caller still has to wait before this document may be reminded
 * again, in milliseconds. `0` means it may be sent now.
 * @param {Object} docJson plain (JSON) document.
 * @param {Date} [now] reference time.
 * @returns {number} remaining cooldown in ms.
 */
export function reminderCooldownRemaining(docJson, now = new Date()) {
  if (MIN_REMINDER_INTERVAL_MS <= 0) return 0;
  const raw = docJson?.LastReminderAt?.iso || docJson?.LastReminderAt;
  const last = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + MIN_REMINDER_INTERVAL_MS - now.getTime());
}

// Pluggable mail transport. Production uses `sendSystemMail`; specs swap in a
// spy through `setReminderMailTransport` so no real mail is ever sent in tests.
let mailTransport = null;

/**
 * Override the transport used to deliver reminder mails. Pass `null` to restore
 * the default `sendSystemMail` transport.
 * @param {Function|null} transport receives the same `params` object `sendmailv3` takes.
 */
export function setReminderMailTransport(transport) {
  mailTransport = transport || null;
}

async function deliverMail(params) {
  // Brand here rather than in the provider so the pluggable transport (and the
  // specs that swap one in) sees the same From name and footer a real send gets.
  const branded = await withTenantBranding(params);
  if (mailTransport) {
    return await mailTransport(branded);
  }
  return await sendSystemMail({ params: branded });
}

/**
 * Default reminder mail, used when neither the document nor the tenant defines a
 * RequestSubject/RequestBody pair.
 * @param {Object} param mail-merge values.
 * @returns {{subject: string, body: string}} rendered subject and html body.
 */
export function reminderMailTemplate(param) {
  const subject = `Reminder: ${param.title} is waiting for your signature`;
  // `senderName` and `note` used to be passed in and rendered nowhere, so a
  // reminder named only the sender's address and dropped the message the owner
  // had written on the document. The shell escapes both.
  const body = renderMail({
    title: 'Signature reminder',
    preheader: `${param.title} is still waiting for your signature`,
    paragraphs: [
      `This is a friendly reminder that ${strong(param.title || '')} is still waiting for your signature.`,
    ],
    note: param.note,
    details: requestDetails(param),
    cta: { url: param.signingUrl, label: 'Review and sign' },
    sender: param,
  });
  return { subject, body };
}

/**
 * Has this participant already fulfilled their signing duty?
 * @param {Array} auditTrail document AuditTrail.
 * @param {string} signerObjId contracts_Contactbook objectId of the participant.
 * @returns {boolean} true when a completion activity exists for the signer.
 */
function hasSigned(auditTrail, signerObjId) {
  if (!signerObjId || !Array.isArray(auditTrail)) return false;
  return auditTrail.some(
    entry =>
      entry?.UserPtr?.objectId === signerObjId && COMPLETION_ACTIVITIES.includes(entry?.Activity)
  );
}

/**
 * Work out who still owes a signature, honouring `SendinOrder`.
 * @param {Object} doc plain (JSON) document.
 * @returns {{pending: Array, skipped: Array}} recipients to mail and why the rest were skipped.
 */
export function selectReminderRecipients(doc) {
  const participants = (doc?.Placeholders || []).filter(isParticipantBasic);
  const auditTrail = doc?.AuditTrail || [];
  const skipped = [];
  const outstanding = [];

  for (const placeholder of participants) {
    const recipient = resolveRecipient(placeholder, doc?.Signers);
    if (hasSigned(auditTrail, recipient.signerObjId)) {
      skipped.push({ email: recipient.email, reason: 'already_signed' });
      continue;
    }
    if (!recipient.email) {
      skipped.push({ email: '', reason: 'no_email' });
      continue;
    }
    outstanding.push(recipient);
  }

  // Sequential documents only ever chase the signer whose turn it is.
  if (doc?.SendinOrder && outstanding.length > 1) {
    const [current, ...waiting] = outstanding;
    for (const recipient of waiting) {
      skipped.push({ email: recipient.email, reason: 'not_their_turn' });
    }
    return { pending: [current], skipped };
  }

  return { pending: outstanding, skipped };
}

/**
 * Send reminder mails for one document. Shared by the `sendreminder` cloud
 * function and the `autoReminders` job, so both behave identically.
 * @param {Object} options options.
 * @param {Object} options.doc Parse object for the document (fetched with master key).
 * @param {string} options.by objectId of the triggering user, or 'system' for the job.
 * @param {string} [options.publicUrl] `public_url` request header when there is a request.
 * @param {boolean} [options.skipCooldown] the sweep has already claimed the document.
 * @returns {Promise<{sent: string[], skipped: Array<{email: string, reason: string}>}>} outcome.
 */
export async function sendReminderForDoc({ doc, by, publicUrl, skipCooldown = false }) {
  const _doc = JSON.parse(JSON.stringify(doc));

  if (!skipCooldown) {
    const waitMs = reminderCooldownRemaining(_doc);
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60000);
      throw new Parse.Error(
        TOO_SOON_CODE,
        `This document was reminded recently. Please try again in ${minutes} minute${
          minutes === 1 ? '' : 's'
        }.`
      );
    }
    // Per-document and per-caller, so neither one owner nor one document can be
    // used to spray mail at signers.
    checkRateLimit('sendreminder:doc', _doc.objectId, REMINDERS_PER_DOC_PER_MIN);
    if (by && by !== 'system') checkRateLimit('sendreminder:by', by, REMINDERS_PER_CALLER_PER_MIN);
  }

  const origin = resolveAppOrigin(publicUrl);
  const { pending, skipped } = selectReminderRecipients(_doc);
  const sent = [];

  const expiresAt = signingTokenExpiry(_doc);

  for (const recipient of pending) {
    const token = recipient.signerObjId
      ? mintSigningToken({
          docId: _doc.objectId,
          contactId: recipient.signerObjId,
          expiresAt,
        })
      : '';
    const signingUrl = buildSigningUrl(
      origin,
      _doc.objectId,
      recipient.email,
      recipient.signerObjId,
      token
    );
    // One builder for the request mail and the reminder (cloud/lib/requestMail.js);
    // only the fallback template and the subject prefix differ.
    const params = buildRequestMail(_doc, recipient, signingUrl, {
      fallback: reminderMailTemplate,
      subjectPrefix: 'Reminder:',
    });
    try {
      const res = await deliverMail(params);
      // Only an explicit success counts as sent: the providers used to answer
      // `undefined` on a non-200 and this read that as a delivered reminder.
      if (res?.status === 'success') {
        sent.push(recipient.email);
      } else {
        console.log('sendreminder mail not accepted: ', res?.reason || res?.status);
        skipped.push({ email: recipient.email, reason: res?.reason || 'mail_failed' });
      }
    } catch (err) {
      console.log('sendreminder mail error: ', err?.message || err);
      skipped.push({ email: recipient.email, reason: err?.message || 'mail_failed' });
    }
  }

  if (sent.length > 0) {
    await recordReminder(_doc.objectId, { SentAt: new Date(), To: sent, By: by });
  }

  return { sent, skipped };
}

/**
 * Append one entry to `Reminders` and stamp `LastReminderAt`.
 *
 * This used to push onto the snapshot taken before the mails went out and write
 * the whole array back, so an owner clicking Remind while the sweep was mailing
 * the same document produced two batches of mail and one audit entry. The array
 * is re-read immediately before the write, and a losing write retries on the
 * fresher copy. `add` alone is not enough because the array is trimmed.
 *
 * @param {string} docId contracts_Document objectId.
 * @param {{SentAt: Date, To: string[], By: string}} entry the reminder to record.
 * @returns {Promise<void>}
 */
async function recordReminder(docId, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await new Parse.Query('contracts_Document')
      .select('Reminders')
      .get(docId, { useMasterKey: true })
      .catch(() => null);
    const reminders = Array.isArray(fresh?.get('Reminders')) ? fresh.get('Reminders') : [];
    // Write through a bare object rather than saving `fresh`: the afterFind
    // trigger swaps SignedUrl/URL for short-lived presigned links on
    // single-result reads, and saving that object back would persist the
    // expiring URL.
    const update = new Parse.Object('contracts_Document');
    update.id = docId;
    update.set('Reminders', [...reminders, entry].slice(-MAX_REMINDER_ENTRIES));
    update.set('LastReminderAt', entry.SentAt);
    try {
      await update.save(null, { useMasterKey: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.log('sendreminder: could not record the reminder', err?.message || err);
        return;
      }
    }
  }
}

/**
 * Fetch a document for reminding, with everything the mail builder needs.
 * @param {string} docId document objectId.
 * @returns {Promise<Parse.Object>} the document.
 */
export async function fetchReminderDoc(docId) {
  const query = new Parse.Query('contracts_Document');
  // A soft-deleted document is not remindable. `Parse.Query.get` applies the
  // query's constraints, so an archived document answers OBJECT_NOT_FOUND here
  // rather than reaching the mail builder through the REST/MCP path, which had
  // to catch it separately.
  query.notEqualTo('IsArchive', true);
  query.include('ExtUserPtr.TenantId');
  query.include('CreatedBy');
  query.include('Signers');
  query.include('Placeholders.signerPtr');
  return await query.get(docId, { useMasterKey: true });
}

async function assertCanRemind(doc, user) {
  const _doc = JSON.parse(JSON.stringify(doc));
  if (isDocumentOwner(_doc, user.id)) return;

  // Every other admin check in the codebase excludes suspended admins; this one
  // did not, so a disabled admin kept the privilege.
  const extUser = await extUserForUser(user, { activeOnly: true, include: ['TenantId'] });
  const role = extUser?.get('UserRole');
  const callerTenantId = extUser?.get('TenantId')?.id;
  const docTenantId = _doc?.ExtUserPtr?.TenantId?.objectId;
  let isTenantAdmin =
    ADMIN_ROLES.includes(role) && callerTenantId && docTenantId && callerTenantId === docTenantId;

  // An OrgAdmin is confined to their own organisation everywhere else
  // (`addUser`, `getUserListByOrg`); tenant equality alone let one organisation's
  // admin mail another organisation's counterparties.
  if (isTenantAdmin && role === 'contracts_OrgAdmin') {
    const callerOrgId = extUser?.get('OrganizationId')?.id;
    const docOrgId = _doc?.ExtUserPtr?.OrganizationId?.objectId;
    isTenantAdmin = Boolean(callerOrgId && docOrgId && callerOrgId === docOrgId);
  }

  if (!isTenantAdmin) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You are not allowed to send reminders for this document.'
    );
  }
}

/**
 * `sendreminder` cloud function. Chases every recipient who still owes a
 * signature on a document the caller owns (or administers within their tenant).
 * @param {Object} request Parse cloud function request with `params.docId`.
 * @returns {Promise<{sent: string[], skipped: Array<{email: string, reason: string}>}>} outcome.
 */
export default async function sendreminder(request) {
  const docId = request?.params?.docId;
  if (!docId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'missing parameter docId.');
  }
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  let doc;
  try {
    doc = await fetchReminderDoc(docId);
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
    throw err;
  }

  await assertCanRemind(doc, request.user);

  if (doc.get('IsCompleted')) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is already completed.');
  }
  if (doc.get('IsDeclined')) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has been declined.');
  }
  if (doc.get('IsArchive')) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is archived.');
  }
  if (!doc.get('SignedUrl') && !doc.get('DocSentAt')) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has not been sent for signature.');
  }
  // The automatic sweep filters `ExpiryDate > now` and the document list calls
  // an expired document expired, but this path did not check at all: an owner
  // could mail "still waiting for your signature" with a Sign here button for a
  // document that can no longer be signed.
  const expiry = doc.get('ExpiryDate');
  if (expiry && new Date(expiry).getTime() < Date.now()) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has expired.');
  }

  return await sendReminderForDoc({
    doc,
    by: request.user.id,
    publicUrl: request?.headers?.public_url,
  });
}
