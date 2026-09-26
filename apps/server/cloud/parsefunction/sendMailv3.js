import { sendMail } from '../lib/mailTransport.js';
import { buildRequestMail, requestRecipientFor } from '../lib/requestMail.js';
import { mintSigningToken, signingTokenExpiry } from '../lib/signingToken.js';
import { buildSigningUrl, resolveAppOrigin } from './sendReminder.js';
import { withTenantBranding } from './tenantBranding.js';
import {
  checkRateLimit,
  clientIp,
  documentParticipantEmails,
  extUserForUser,
  isDocumentParticipant,
  resolveCaller,
  resolveDocumentActor,
} from './authGuard.js';
import { isValidEmail, normaliseEmail } from '../lib/email.js';

const MAX_RECIPIENTS = 25;
const MAX_FROM = 80;
const MAX_SUBJECT = 998;
const MAX_BODY = 512 * 1024;
const RATE_AUTHENTICATED_PER_MIN = 60;
const RATE_ANONYMOUS_PER_MIN = 30;

/** The only mail a caller who is not the owner may ask this function to render. */
const GUEST_TEMPLATE = 'next_signer';
/** Free-form fields a guest may not supply; the server renders the mail instead. */
const GUEST_FORBIDDEN_FIELDS = ['html', 'text', 'subject', 'from', 'cc', 'bcc', 'attachments'];

/** `to`/`cc`/`bcc` accept a string or an array of strings in this codebase. */
function collectAddresses(value, out) {
  if (!value) return;
  const list = Array.isArray(value) ? value : String(value).split(',');
  for (const entry of list) {
    const email = normaliseEmail(entry);
    if (email) out.push(email);
  }
}

/**
 * A value that is safe to place in a mail header: one line, no control
 * characters, no angle brackets. Mirrors `tenantBranding.assertPlainLine`,
 * which guards the same risk on the tenant's stored sender name.
 * @param {*} value the candidate.
 * @param {string} label used in the error message.
 * @param {number} max length cap.
 * @returns {string} the trimmed value ('' when not supplied).
 */
function assertHeaderSafe(value, label, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, `${label} must be text.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `${label} must be ${max} characters or fewer.`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(text)) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `${label} contains characters that are not allowed.`
    );
  }
  return text;
}

export function validateMailParams(params) {
  const recipients = [];
  collectAddresses(params.recipient, recipients);
  collectAddresses(params.cc, recipients);
  collectAddresses(params.bcc, recipients);
  if (!recipients.length) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'A recipient is required.');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `At most ${MAX_RECIPIENTS} recipients per message.`
    );
  }
  for (const email of recipients) {
    if (!isValidEmail(email)) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `Invalid recipient address: ${email}`);
    }
  }
  if (typeof params.subject === 'string' && params.subject.length > MAX_SUBJECT) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Subject is too long.');
  }
  // `from` and `replyto` are concatenated straight into the From/Reply-To
  // headers by the transport, so a CR/LF injects a header and an angle bracket
  // opens a second address group ahead of the platform sender. They were the
  // only mail params nothing checked.
  assertHeaderSafe(params.from, 'Sender name', MAX_FROM);
  const replyto = assertHeaderSafe(params.replyto, 'Reply-to address', 254);
  if (replyto && !isValidEmail(replyto)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Reply-to must be a valid email address.');
  }
  const bodyLength = (params.html?.length || 0) + (params.text?.length || 0);
  if (bodyLength > MAX_BODY) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Message body is too large.');
  }
  return recipients;
}

/**
 * Every recipient must already be a contact created by `extUser`, or `extUser`
 * itself. That is what "notify the next signer" and "resend the request mail"
 * actually do, and it stops the function being a generic relay.
 */
async function recipientsAreOwnContacts(extUser, recipients) {
  const ownerEmail = normaliseEmail(extUser.get('Email'));
  const unknown = [...new Set(recipients)].filter(email => email !== ownerEmail);
  if (!unknown.length) return true;
  const ownerUserId = extUser.get('UserId')?.id;
  if (!ownerUserId) return false;
  const query = new Parse.Query('contracts_Contactbook');
  query.equalTo('CreatedBy', { __type: 'Pointer', className: '_User', objectId: ownerUserId });
  query.containedIn('Email', unknown);
  query.notEqualTo('IsDeleted', true);
  query.limit(1000);
  const rows = await query.find({ useMasterKey: true }).catch(() => []);
  const known = new Set(rows.map(row => normaliseEmail(row.get('Email'))));

  // A placeholder can carry an email before `linkcontacttodoc` has created the
  // contact for it (quick send, bulk send), so accept those too.
  const stillUnknown = unknown.filter(email => !known.has(email));
  if (stillUnknown.length) {
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.equalTo('ExtUserPtr', {
      __type: 'Pointer',
      className: 'contracts_Users',
      objectId: extUser.id,
    });
    docQuery.containedIn('Placeholders.email', stillUnknown);
    docQuery.notEqualTo('IsArchive', true);
    docQuery.limit(1000);
    const docs = await docQuery.find({ useMasterKey: true }).catch(() => []);
    for (const doc of docs) {
      for (const placeholder of doc.get('Placeholders') || []) {
        known.add(normaliseEmail(placeholder?.email));
      }
    }
  }
  return unknown.every(email => known.has(email));
}

/**
 * Render the guest's mail on the server.
 *
 * A signing link proves "I am this signer on this document" and nothing more, so
 * a guest may ask for one specific mail (the next signer's request mail) and may
 * not choose its subject, body or sender. The mail is the same one the request
 * flow sends, with a signing link tokenised for the recipient.
 */
async function renderGuestTemplate(request, doc, recipients) {
  const params = request.params || {};
  const template = typeof params.template === 'string' ? params.template.trim() : '';
  if (template !== GUEST_TEMPLATE) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `A signing link may only send the '${GUEST_TEMPLATE}' template.`
    );
  }
  const supplied = GUEST_FORBIDDEN_FIELDS.filter(field => params[field]);
  if (supplied.length) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `A signing link cannot choose the ${supplied.join(', ')} of a mail.`
    );
  }
  if (recipients.length !== 1) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `The '${GUEST_TEMPLATE}' mail goes to exactly one participant.`
    );
  }
  const docJson = doc.toJSON();
  const recipient = requestRecipientFor(docJson, recipients[0]);
  if (!recipient) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You may only email participants of this document.'
    );
  }
  const origin = resolveAppOrigin(request?.headers?.public_url);
  const signingToken = recipient.signerObjId
    ? mintSigningToken({
        docId: docJson.objectId,
        contactId: recipient.signerObjId,
        expiresAt: signingTokenExpiry(docJson),
      })
    : '';
  const signingUrl = buildSigningUrl(
    origin,
    docJson.objectId,
    recipient.email,
    recipient.signerObjId,
    signingToken
  );
  return buildRequestMail(docJson, recipient, signingUrl);
}

/**
 * Decides whether this caller may send this message, and what it may send.
 *
 * Rules:
 *  1. `docId` given -> the caller must resolve as an actor on that document
 *     (owner, participant, or a guest holding that document's signing token).
 *     The owner keeps the free-form mail; everyone else gets the server-rendered
 *     `next_signer` template. It used to be enough for the *recipients* to be
 *     participants, which let any anonymous caller who knew a docId send
 *     arbitrary html to every signer on it.
 *  2. `templateId` given -> the caller must own or be on that template.
 *  3. `extUserId` given -> the caller must be that ext user, or every recipient
 *     must be one of that ext user's own contacts.
 *  4. Neither given -> an authenticated caller may send; anonymous is refused.
 *
 * The branding tenant and the mail counter are taken from `sender`, which this
 * function derives from the authorised row (the document's/template's
 * `ExtUserPtr`, or the ext user the caller actually is). `extUserId` used to be
 * read straight off the request in the docId branch, which never inspected it,
 * so a caller who owned any document could send mail carrying another tenant's
 * branding and reply-to and charge the send against that tenant's counter.
 *
 * @returns {Promise<{mode: string, params?: Object, sender?: string}>}
 */
async function authoriseMail(request, caller, recipients) {
  const docId = request.params?.docId || request.params?.documentId || '';
  const templateId = request.params?.templateId || '';
  const extUserId = request.params?.extUserId || '';

  if (docId) {
    const query = new Parse.Query('contracts_Document');
    query.include('ExtUserPtr,ExtUserPtr.TenantId,Signers,Placeholders.signerPtr,CreatedBy');
    const doc = await query.get(docId, { useMasterKey: true }).catch(() => null);
    if (!doc) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
    const actor = await resolveDocumentActor(request, doc, {
      contactId: request.params?.contactId,
      signingToken: request.params?.signingToken,
    });
    const wantsTemplate =
      typeof request.params?.template === 'string' && request.params.template.trim();
    const sender = doc.get('ExtUserPtr')?.id || '';
    if ((actor.kind === 'owner' || actor.kind === 'master') && !wantsTemplate)
      return { mode: 'free', sender };
    return {
      mode: 'template',
      sender,
      params: await renderGuestTemplate(request, doc, recipients),
    };
  }

  if (templateId) {
    const query = new Parse.Query('contracts_Template');
    query.include('ExtUserPtr,Signers,Placeholders.signerPtr,CreatedBy');
    const tpl = await query.get(templateId, { useMasterKey: true }).catch(() => null);
    if (!tpl) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found.');
    }
    const tplSender = tpl.get('ExtUserPtr')?.id || '';
    if (caller && isDocumentParticipant(tpl, caller)) return { mode: 'free', sender: tplSender };
    const allowed = documentParticipantEmails(tpl.toJSON());
    if (caller && recipients.every(email => allowed.has(email))) {
      return { mode: 'free', sender: tplSender };
    }
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You may only email participants of this template.'
    );
  }

  if (extUserId) {
    const extQuery = new Parse.Query('contracts_Users');
    extQuery.include('UserId');
    const extUser = await extQuery.get(extUserId, { useMasterKey: true }).catch(() => null);
    if (!extUser) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Sender not found.');
    }
    if (caller && extUser.get('UserId')?.id === caller.id) {
      return { mode: 'free', sender: extUser.id };
    }
    if (await recipientsAreOwnContacts(extUser, recipients)) {
      return { mode: 'free', sender: extUser.id };
    }
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'You may only email contacts of this account.'
    );
  }

  if (caller) return { mode: 'free', sender: await extUserIdFor(caller) };
  throw new Parse.Error(
    Parse.Error.INVALID_SESSION_TOKEN,
    'sendmailv3 requires an authenticated user.'
  );
}

/** The caller's own `contracts_Users` row id, or '' when they have none. */
async function extUserIdFor(caller) {
  const extUser = await extUserForUser(caller);
  return extUser?.id || '';
}

/**
 * `sendmailv3`: the mail endpoint the web app calls.
 *
 * Answers `{status: 'success'}` and throws `Parse.Error(SCRIPT_FAILED, ...)` on
 * every failure path, including "no provider configured". It used to answer
 * `{status: 'error'}` with no message, or nothing at all, which the SPA read as
 * a successful send.
 */
async function sendmailv3(req) {
  const recipients = validateMailParams(req.params || {});
  const caller = req.master ? null : await resolveCaller(req);
  let plan = { mode: 'free' };
  if (!req.master) {
    checkRateLimit(
      'sendmailv3',
      caller ? `u:${caller.id}` : `ip:${clientIp(req)}`,
      caller ? RATE_AUTHENTICATED_PER_MIN : RATE_ANONYMOUS_PER_MIN
    );
    plan = await authoriseMail(req, caller, recipients);
  }

  // Tenant branding (sender display name, reply-to fallback, footer, Powered by)
  // is applied here so every caller of `sendmailv3` gets it. See tenantBranding.js.
  const base = plan.mode === 'template' ? plan.params : req.params || {};
  // The sender the authorisation actually resolved wins over anything the
  // client sent, and `tenantId` is dropped so branding is derived from it.
  const resolved = req.master
    ? base
    : { ...base, extUserId: plan.sender || '', tenantId: undefined };
  const params = await withTenantBranding(resolved);
  const res = await sendMail(params);
  if (res?.status !== 'success') {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      `Mail could not be sent: ${res?.reason || 'the mail provider did not accept the message.'}`
    );
  }
  return { status: 'success' };
}

export default sendmailv3;
