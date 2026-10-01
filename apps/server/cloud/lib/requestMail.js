import { appName, replaceMailVaribles } from '../../Utils.js';
import { bodyCarriesUrl, mailTemplate, renderMail } from './mailShell.js';
import { documentStatus, loadDoc } from './documents.js';
import { normaliseEmail } from './email.js';
import { COMPLETION_ACTIVITIES, isParticipantBasic } from '../../utils/workflowUtils.js';
import { mintSigningToken, signingTokenExpiry } from './signingToken.js';
import { emitUserEvent } from './webhooks.js';
import { extUserRowsForUser } from '../parsefunction/authGuard.js';
import { withTenantBranding } from '../parsefunction/tenantBranding.js';
import sendSystemMail from '../parsefunction/sendSystemMail.js';

/**
 * The signature-request email, sent server-side, and the only builder for it.
 *
 * The web app composes this mail in the browser and posts it to `sendmailv3`;
 * `batchdocuments` builds it on the server and loops back over HTTP. The API, the
 * MCP tools and the AI flow cannot do either, so this module renders the same mail
 * (document RequestSubject/RequestBody, then the tenant's, then the sender's own
 * `contracts_Users` templates, then the built-in template, with the same
 * `{{vars}}`) and hands it to the mail provider directly.
 *
 * `sendreminder` used to render the same message from its own copy of this code,
 * and the copies had already drifted: only this one turned newlines into `<br/>`,
 * so the same tenant RequestBody arrived as one unbroken paragraph in reminders,
 * and only the reminder copy fell back to the sender's own stored templates. One
 * builder now serves both; a reminder passes its own fallback template and a
 * subject prefix (`buildRequestMail(doc, recipient, url, {fallback, subjectPrefix})`).
 *
 * The signing-link helpers (`resolveAppOrigin`, `buildSigningUrl`) live here too,
 * because every builder of this mail needs them and they used to sit in
 * `sendReminder.js`, which made the dependency circular.
 */

/**
 * Resolve the origin the signing links should point at. The request header wins
 * (it is the host the caller actually reached), then PUBLIC_URL, then the origin
 * of SERVER_URL as a last resort.
 * @param {string} [publicUrl] value of the `public_url` request header.
 * @returns {string} an origin without a trailing slash, or '' when nothing is configured.
 */
export function resolveAppOrigin(publicUrl) {
  const candidates = [publicUrl, process.env.PUBLIC_URL, process.env.SERVER_URL];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // try the next candidate
    }
  }
  return '';
}

function toBase64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Build the guest signing link for a recipient, per the `/login/<base64>` scheme.
 *
 * The fourth segment is the per-signer token (`cloud/lib/signingToken.js`): the
 * three-segment form proved nothing beyond "I know a docId and a contactId",
 * both of which used to be handed out by `getDocument`. Links for a placeholder
 * that has no contact yet keep the two-segment form; there is nothing to bind.
 *
 * @param {string} origin app origin.
 * @param {string} docId document objectId.
 * @param {string} email recipient email.
 * @param {string} [contactId] contracts_Contactbook objectId when the signer is linked.
 * @param {string} [token] signing token minted for (docId, contactId).
 * @returns {string} absolute signing url.
 */
export function buildSigningUrl(origin, docId, email, contactId, token) {
  if (!contactId) return `${origin}/login/${toBase64(`${docId}/${email}`)}`;
  const payload = token
    ? `${docId}/${email}/${contactId}/${token}`
    : `${docId}/${email}/${contactId}`;
  return `${origin}/login/${toBase64(payload)}`;
}

let mailTransport = null;

/** Test seam: replace the provider with `async params => ({status})`. */
export function setRequestMailTransport(transport) {
  mailTransport = transport || null;
}

async function deliverMail(params) {
  const branded = await withTenantBranding(params);
  if (mailTransport) return await mailTransport(branded);
  return await sendSystemMail({ params: branded });
}

/**
 * The document's expiry as a human date. Falls back to createdAt +
 * TimeToCompleteDays (then 15 days) so a document created without an expiry
 * still renders a date instead of throwing on `ExpiryDate.iso`. `ExpiryDate` is
 * accepted both as a Parse date (`{iso}`) and as a plain string, because the
 * request path and the reminder path used to read it differently.
 * @param {Object} doc plain (JSON) document.
 * @returns {string} a localised date such as "3 March 2026".
 */
export function formatExpiryDate(doc) {
  const raw = doc?.ExpiryDate?.iso || doc?.ExpiryDate;
  let expiryDate = raw ? new Date(raw) : null;
  if (!expiryDate || isNaN(expiryDate.getTime())) {
    const created = doc?.createdAt ? new Date(doc.createdAt) : new Date();
    expiryDate = new Date(created);
    expiryDate.setDate(expiryDate.getDate() + (Number(doc?.TimeToCompleteDays) || 15));
  }
  return expiryDate.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The recipient one placeholder addresses.
 *
 * Three variants of this existed and each picked the display name differently.
 * An included `signerPtr` wins when it carries an address (that is the freshest
 * contact row), then the matching entry in `Signers`, then whatever the
 * placeholder itself recorded.
 *
 * @param {Object} placeholder one entry of `Placeholders`.
 * @param {Array} signers the document's `Signers`.
 */
export function resolveRecipient(placeholder, signers) {
  const signerObjId = placeholder?.signerObjId || placeholder?.signerPtr?.objectId || '';
  const fromSigners =
    signerObjId && Array.isArray(signers)
      ? signers.find(signer => signer?.objectId === signerObjId)
      : null;
  const contact = placeholder?.signerPtr?.Email ? placeholder.signerPtr : fromSigners;
  return {
    signerObjId,
    name: contact?.Name || placeholder?.Name || '',
    email: normaliseEmail(contact?.Email || placeholder?.email),
    phone: contact?.Phone || '',
  };
}

/** Contact ids that already have a completion activity on the document. */
function signedContactIds(doc) {
  const ids = new Set();
  for (const entry of doc?.AuditTrail || []) {
    if (COMPLETION_ACTIVITIES.includes(entry?.Activity) && entry?.UserPtr?.objectId) {
      ids.add(entry.UserPtr.objectId);
    }
  }
  return ids;
}

/**
 * Who gets the first request mail: everyone, or only the first signer when the
 * document signs in order.
 *
 * @param {Object} doc plain document JSON.
 * @param {{only?: string[]}} [opts] restrict to these addresses; the signing-order
 *   rule is then the caller's business (a resend nudges whoever is outstanding,
 *   not signer 1 all over again).
 */
export function selectRequestRecipients(doc, opts = {}) {
  const participants = (doc?.Placeholders || []).filter(isParticipantBasic);
  const recipients = participants.map(p => resolveRecipient(p, doc?.Signers)).filter(r => r.email);
  if (Array.isArray(opts.only)) {
    const wanted = new Set(opts.only.map(e => String(e || '').toLowerCase()));
    return recipients.filter(r => wanted.has(r.email));
  }
  if (doc?.SendinOrder && recipients.length > 1) return [recipients[0]];
  return recipients;
}

/**
 * Who a resend should actually go to: the participants who have not signed yet,
 * and for a sequential document only the first of those.
 *
 * Without this a resend mailed "please sign" to everyone who had already signed,
 * and on a sequential document it always re-mailed signer 1 (usually done weeks
 * ago) while the person being waited on got nothing. Needs a document loaded
 * with its AuditTrail.
 *
 * @param {Object} doc plain document JSON including AuditTrail.UserPtr.
 * @returns {Array<{email: string, name: string, signerObjId: string}>}
 */
export function pendingRequestRecipients(doc) {
  const signed = signedContactIds(doc);
  const outstanding = (doc?.Placeholders || [])
    .filter(isParticipantBasic)
    .map(p => resolveRecipient(p, doc?.Signers))
    .filter(r => r.email && !(r.signerObjId && signed.has(r.signerObjId)));
  return doc?.SendinOrder ? outstanding.slice(0, 1) : outstanding;
}

/**
 * The participant record for one email on a document, or null when that address
 * is not a participant. `sendmailv3` uses it to render the next-signer mail for
 * a guest without trusting anything the guest said about the recipient.
 * @param {Object} doc plain document JSON.
 * @param {string} email recipient address.
 */
export function requestRecipientFor(doc, email) {
  const wanted = String(email || '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  const participants = (doc?.Placeholders || []).filter(isParticipantBasic);
  for (const placeholder of participants) {
    const recipient = resolveRecipient(placeholder, doc?.Signers);
    if (recipient.email && recipient.email === wanted) return recipient;
  }
  return null;
}

/**
 * The display name a signature-related mail goes out under. The address is
 * always the transport's own (SMTP_USER_EMAIL); this is only the name in front
 * of it, and the tenant's `EmailSenderName` still overrides it in
 * `applyBranding`.
 *
 * Company first: a request that arrives as "Acme" reads like the business
 * it comes from, where the old default, the sender's bare email address as the
 * display name, read like a misconfigured mailer. The sender's own name is used
 * when they asked for it (`UseNameAsSender`, or a document-level `SenderName`),
 * and the app name is the last resort. The address itself is never the name.
 *
 * @param {{senderName?: string, company?: string, useNameAsSender?: boolean}} p
 * @returns {string}
 */
export function senderDisplayName({ senderName = '', company = '', useNameAsSender = false } = {}) {
  const name = String(senderName || '').trim();
  const org = String(company || '').trim();
  if (useNameAsSender && name) return name;
  return org || name || appName;
}

/** Matches the `{{signing_url}}` marker the way an author types it (spaces tolerated). */
const SIGNING_URL_MARKER = /\{\{\s*signing_url\s*\}\}/i;

/**
 * Whether a subject/body template places the signing link itself.
 * @param {string} text a RequestBody (or any template text).
 */
export function hasSigningLinkMarker(text) {
  return SIGNING_URL_MARKER.test(String(text || ''));
}

/**
 * The custom request body the mail will be rendered from, or '' when the
 * built-in template applies: the document's own, then the tenant's, then the
 * sender's own `contracts_Users` template (same precedence as `buildRequestMail`).
 * @param {Object} doc plain document JSON with ExtUserPtr(+TenantId).
 */
export function customRequestBody(doc) {
  const tenant = doc?.ExtUserPtr?.TenantId;
  const owner = doc?.ExtUserPtr;
  return doc?.RequestBody || tenant?.RequestBody || owner?.RequestBody || '';
}

/** The warning a caller gets when its message leaves the link to the safety net. */
export const MESSAGE_WITHOUT_LINK = {
  code: 'message_without_link',
  message:
    'The email body has no {{signing_url}}, so the signing link is appended after your text (a button and the plain link). Put {{signing_url}} where you want the link.',
};

/**
 * Render the request (or reminder) mail for one recipient.
 *
 * @param {Object} doc plain document JSON with ExtUserPtr(+TenantId).
 * @param {{name: string, email: string, phone?: string}} recipient
 * @param {string} signingUrl the recipient's own signing link.
 * @param {{fallback?: Function, subjectPrefix?: string}} [opts]
 *   `fallback` renders the built-in template when neither the document, the
 *   tenant nor the sender defines a subject/body pair (default: the request
 *   template). `subjectPrefix` is prepended to a *custom* subject unless it
 *   already starts with it, so a reminder does not read exactly like the
 *   original request.
 * @returns {Object} mail params for the transport.
 */
export function buildRequestMail(doc, recipient, signingUrl, opts = {}) {
  const senderName = doc?.SenderName || doc?.ExtUserPtr?.Name || '';
  const senderEmail = doc?.SenderMail || doc?.ExtUserPtr?.Email || '';
  const organization = doc?.ExtUserPtr?.Company || '';
  const localExpireDate = formatExpiryDate(doc);
  const tenant = doc?.ExtUserPtr?.TenantId;
  const owner = doc?.ExtUserPtr;

  // Document snapshot, then tenant (`updatetenant`), then the owner's own
  // `contracts_Users` row (a member's own templates), then the
  // built-in template. The owner fallback existed only on the reminder path.
  const mailSubject = doc?.RequestSubject || tenant?.RequestSubject || owner?.RequestSubject || '';
  const mailBody = customRequestBody(doc);

  let replaced;
  if (mailSubject && mailBody) {
    // Newlines become <br/>: a stored template is plain text with paragraph
    // breaks, and the reminder copy of this code did not do it, so the same
    // body arrived as one unbroken paragraph there. The fragment is wrapped in
    // the shared mail shell below, after the merge.
    const fragment = mailBody.replace(/"/g, "'").replace(/\n/g, '<br/>');
    replaced = replaceMailVaribles(mailSubject, fragment, {
      document_title: doc?.Name || '',
      note: doc?.Note || '',
      sender_name: senderName,
      sender_mail: senderEmail,
      sender_phone: doc?.ExtUserPtr?.Phone || '',
      receiver_name: recipient.name,
      receiver_email: recipient.email,
      receiver_phone: recipient.phone || '',
      expiry_date: localExpireDate,
      company_name: organization,
      signing_url: signingUrl,
    });
  }
  const renderFallback = typeof opts.fallback === 'function' ? opts.fallback : mailTemplate;
  const fallback = renderFallback({
    title: doc?.Name || '',
    senderName,
    senderMail: senderEmail,
    organization,
    localExpireDate,
    signingUrl,
    note: doc?.Note || '',
  });

  // A reminder that reads exactly like the original request is confusing, so a
  // custom subject is prefixed unless the author already worded it that way.
  // Matched on the prefix's leading word, so "Reminder about the lease" counts
  // as already-worded and does not become "Reminder: Reminder about ...".
  let subject = replaced?.subject || fallback.subject;
  const prefix = typeof opts.subjectPrefix === 'string' ? opts.subjectPrefix.trim() : '';
  const prefixWord = prefix.replace(/[^\p{L}\p{N}]+$/u, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (prefix && replaced?.subject && prefixWord) {
    if (!new RegExp(`^\\s*${prefixWord}\\b`, 'iu').test(subject)) subject = `${prefix} ${subject}`;
  }

  const useNameAsSender = Boolean(doc?.SenderName) || doc?.ExtUserPtr?.UseNameAsSender === true;
  return {
    extUserId: doc?.ExtUserPtr?.objectId,
    recipient: recipient.email,
    subject,
    from: senderDisplayName({ senderName, company: organization, useNameAsSender }),
    replyto: senderEmail || '',
    // A custom body goes into the same shell as the built-in one. One that never
    // placed {{signing_url}} gets the button and the plain link appended: a
    // request mail without its link is the one mail that must never go out.
    html: replaced
      ? renderMail({
          bodyHtml: replaced.body,
          cta: bodyCarriesUrl(replaced.body, signingUrl)
            ? undefined
            : { url: signingUrl, label: 'Review and sign' },
          sender: { senderName, senderMail: senderEmail, organization },
        })
      : fallback.body,
  };
}

/**
 * Send the request mail for a document that has just been marked sent.
 * @param {Object} options
 * @param {Object} options.doc plain JSON with ExtUserPtr(+TenantId), Signers, Placeholders
 * @param {string} [options.publicUrl] origin for the signing links
 * @param {string[]} [options.only] restrict to these emails (e.g. after a resend)
 * @returns {Promise<{sent: string[], failed: Array<{email: string, reason: string}>, signingLinks: Array<{email: string, url: string}>}>}
 */
export async function sendSignatureRequestMails({ doc, publicUrl, only }) {
  const origin = resolveAppOrigin(publicUrl);
  const recipients = selectRequestRecipients(doc, { only: Array.isArray(only) ? only : undefined });
  const sent = [];
  const failed = [];
  const signingLinks = [];
  const expiresAt = signingTokenExpiry(doc);
  for (const recipient of recipients) {
    const signingToken = recipient.signerObjId
      ? mintSigningToken({ docId: doc.objectId, contactId: recipient.signerObjId, expiresAt })
      : '';
    const url = buildSigningUrl(
      origin,
      doc.objectId,
      recipient.email,
      recipient.signerObjId,
      signingToken
    );
    signingLinks.push({ email: recipient.email, url, signingToken: signingToken || undefined });
    try {
      const res = await deliverMail(buildRequestMail(doc, recipient, url));
      // Anything that is not an explicit success is a failure: the providers used
      // to answer `undefined` on a non-200 and callers read that as "sent".
      if (res?.status === 'success') sent.push(recipient.email);
      else {
        console.log('requestMail: send failed', res?.reason || res?.status);
        failed.push({ email: recipient.email, reason: res?.reason || 'mail_failed' });
      }
    } catch (err) {
      console.log('requestMail: send failed', err?.message || err);
      failed.push({ email: recipient.email, reason: err?.message || 'mail_failed' });
    }
  }
  announceReceived(doc.objectId, sent);
  return { sent, failed, signingLinks };
}

/* ------------------------------------------------------- the received event */

/** The role of the seat bound to `contactId`, numbered like the inbox numbers it. */
function seatRole(doc, contactId) {
  let order = 0;
  for (const group of doc?.Placeholders || []) {
    if (!isParticipantBasic(group)) continue;
    order += 1;
    if ((group?.signerObjId || group?.signerPtr?.objectId) === contactId) {
      return group?.Role || `Role ${order}`;
    }
  }
  return '';
}

/**
 * The `_User` id behind a contact when it is a real DocuStamp account at the
 * address the request went to, else ''.
 *
 * Every contact points at a `_User` (a shadow one is made for each new address),
 * so the account is told apart by its `contracts_Users` profile, and a suspended
 * one does not count. The address must match too, the same rule
 * `agentSign.findAgentSeat` applies before an agent may sign that seat.
 */
async function accountUserId(contact, email) {
  const userId = contact?.UserId?.objectId || '';
  if (!userId || !email) return '';
  const rows = await extUserRowsForUser(userId, { include: ['UserId'], activeOnly: true });
  const matches = rows.some(
    row =>
      normaliseEmail(row.get('Email')) === email ||
      normaliseEmail(row.get('UserId')?.get?.('email')) === email
  );
  return matches ? userId : '';
}

/**
 * Deliver `received` to the own webhooks of each mailed recipient whose turn it
 * now is. The document is read fresh, so the turn is judged on what is stored
 * after the send or the signature that caused this: on a document signed in
 * order only the first person still to sign counts, otherwise everyone who has
 * not signed. A recipient whose contact is not a real account is skipped.
 * Awaitable (tests); request paths go through `announceReceived`.
 *
 * @param {string} docId
 * @param {string[]} emails addresses the request mail actually went to.
 * @returns {Promise<Array>} the delivery results.
 */
export async function deliverReceived(docId, emails) {
  const wanted = new Set((emails || []).map(normaliseEmail).filter(Boolean));
  if (!docId || !wanted.size) return [];
  const doc = JSON.parse(JSON.stringify(await loadDoc(docId)));
  if (documentStatus(doc) !== 'in_progress') return [];
  const results = [];
  for (const recipient of pendingRequestRecipients(doc)) {
    if (!recipient.signerObjId || !wanted.has(recipient.email)) continue;
    const contact = (doc.Signers || []).find(s => s?.objectId === recipient.signerObjId);
    const userId = await accountUserId(contact, recipient.email);
    if (!userId) continue;
    const myRole = seatRole(doc, recipient.signerObjId);
    results.push(...(await emitUserEvent('received', userId, doc, { myRole })));
  }
  return results;
}

/**
 * Tell the people a request mail just went to, on their own webhooks, that the
 * document now waits on them (the `received` event). Called after every request
 * mail: the first send, the next signer after a signature, a replaced signer and
 * a resend (a resend asks them again, so it is announced again; a consumer
 * keys on the document id). Fire and forget: a send never fails or waits over it.
 *
 * @param {string} docId
 * @param {string[]} emails addresses the request mail actually went to.
 */
export function announceReceived(docId, emails) {
  if (!docId || !Array.isArray(emails) || !emails.length) return;
  Promise.resolve()
    .then(() => deliverReceived(docId, emails))
    .catch(err => console.log('requestMail: received event failed', err?.message || err));
}

/**
 * Signing links for every participant, without sending anything.
 * Each link carries the recipient's own token, so handing one out is handing out
 * access to exactly that signer's view of the document.
 */
export function signingLinksFor(doc, publicUrl) {
  const origin = resolveAppOrigin(publicUrl);
  const expiresAt = signingTokenExpiry(doc);
  return (doc?.Placeholders || [])
    .filter(isParticipantBasic)
    .map(p => resolveRecipient(p, doc?.Signers))
    .filter(r => r.email)
    .map(r => {
      const signingToken = r.signerObjId
        ? mintSigningToken({ docId: doc.objectId, contactId: r.signerObjId, expiresAt })
        : '';
      return {
        name: r.name,
        email: r.email,
        contactId: r.signerObjId || undefined,
        url: buildSigningUrl(origin, doc.objectId, r.email, r.signerObjId, signingToken),
        signingToken: signingToken || undefined,
      };
    });
}
