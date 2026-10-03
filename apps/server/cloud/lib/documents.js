import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../../Utils.js';
import { setDocumentCount } from '../../utils/CountUtils.js';
import {
  findPendingPriorSigner,
  findPlaceholderIndex,
  isParticipantBasic,
} from '../../utils/workflowUtils.js';
import { accessibleTemplateQuery } from '../parsefunction/GetTemplate.js';
import { isDocumentOwner } from './acl.js';
import { verifiedIdentityProblem } from './agentIdentity.js';
import { agentSignDocument, findAgentSeat, prepareAgentSignature } from './agentSign.js';
import { emitInBackground } from './webhooks.js';
import { conditionalUpdate } from './atomic.js';
import { extUserPointer, userPointer } from './context.js';
import { assertEmail, ensureContact, normaliseEmail, searchPattern } from './contacts.js';
import { isValidEmail } from './email.js';
import { API_URL_TTL, assertStoredFileUrl, resolveFileUrl } from './files.js';
import { signingScopeProblem } from './oauth.js';
import {
  MESSAGE_WITHOUT_LINK,
  customRequestBody,
  hasSigningLinkMarker,
  pendingRequestRecipients,
  sendSignatureRequestMails,
  signingLinksFor,
} from './requestMail.js';
import { scheduleFieldsFor } from './schedule.js';
import { accountOf, checkSeatName, nameMismatchMessage } from './signerName.js';
import {
  buildPlaceholders,
  countFields,
  countSignerFields,
  normaliseWidgetType,
  PREFILL_ROLE,
  resetPlaceholdersForCopy,
  sanitisePlaceholders,
} from './widgets.js';

/**
 * Document operations for API callers. Everything here takes a `Caller` (see
 * context.js), runs with the master key and scopes by `CreatedBy`, and returns
 * plain JSON summaries rather than Parse objects.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  expiryDays: 15,
  remindEveryDays: 0,
  sendInOrder: false,
  strictOrder: false,
  otp: false,
  notifyOnSignatures: true,
  allowModifications: false,
  redirectUrl: '',
  bcc: [],
  cc: [],
  dateFormat: '',
  timezone: '',
  is12HourTime: undefined,
});

/** The date formats the certificate and date fields understand (Utils.selectFormat). */
export const DATE_FORMATS = Object.freeze([
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'YYYY-MM-DD',
  'MM-DD-YYYY',
  'MM.DD.YYYY',
  'MMM DD, YYYY',
  'MMMM DD, YYYY',
  'DD MMM, YYYY',
  'DD MMMM, YYYY',
  'DD.MM.YYYY',
  'DD-MMM-YYYY',
  'L',
  'LL',
]);

function validTimezone(value) {
  const zone = String(value || '').trim();
  if (!zone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `"${zone}" is not an IANA timezone (e.g. "America/Chicago").`);
  }
}

const MAX_RECIPIENTS = 25;

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Refuse a settings request that asks for something the normalisation would
 * quietly drop.
 *
 * `strictOrder` only means anything with `sendInOrder` on, and it used to be
 * coerced to false with no word to the caller, who was told strict sequential
 * enforcement was applied when it was not.
 *
 * @param {Object} [input] the settings exactly as the caller sent them.
 * @param {Object} [current] the document's current settings, for a partial update.
 */
export function assertSettingsInput(input, current = {}) {
  if (!input || typeof input !== 'object') return;
  if (input.strictOrder !== true) return;
  const inOrder =
    input.sendInOrder === undefined ? current.sendInOrder === true : input.sendInOrder === true;
  if (!inOrder) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'strictOrder needs sendInOrder: true (it enforces the order signers are let in).'
    );
  }
}

export function normaliseSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const cleanList = list =>
    (Array.isArray(list) ? list : [])
      .map(e => (typeof e === 'string' ? { email: e } : e || {}))
      .map(e => ({
        Name: String(e.name || e.Name || ''),
        Email: normaliseEmail(e.email || e.Email),
      }))
      .filter(e => e.Email);
  return {
    expiryDays: clampInt(s.expiryDays, 1, 365, 15),
    remindEveryDays: clampInt(s.remindEveryDays, 0, 60, 0),
    sendInOrder: s.sendInOrder === true,
    strictOrder: s.sendInOrder === true && s.strictOrder === true,
    otp: s.otp === true || s.auth === 'otp',
    notifyOnSignatures: s.notifyOnSignatures !== false,
    allowModifications: s.allowModifications === true,
    redirectUrl: typeof s.redirectUrl === 'string' ? s.redirectUrl.trim().slice(0, 2048) : '',
    bcc: cleanList(s.bcc),
    cc: cleanList(s.cc),
    dateFormat: (() => {
      const f = String(s.dateFormat || '').trim();
      if (!f) return '';
      if (!DATE_FORMATS.includes(f)) {
        throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `dateFormat must be one of ${DATE_FORMATS.join(', ')}.`);
      }
      return f;
    })(),
    timezone: validTimezone(s.timezone),
    is12HourTime: typeof s.is12HourTime === 'boolean' ? s.is12HourTime : undefined,
  };
}

/**
 * The settings a stored document already carries, in the caller-facing shape
 * `normaliseSettings` takes. The inverse of `documentFields`, and the seam every
 * partial settings update goes through, so a change that touches one column does
 * not silently reset the rest.
 *
 * @param {Object} d plain document (or template) JSON.
 */
export function settingsFromDoc(d) {
  const list = v =>
    Array.isArray(v)
      ? v
          .map(e => ({ name: e?.Name || '', email: String(e?.Email || '').toLowerCase() }))
          .filter(e => e.email)
      : [];
  return {
    expiryDays: Number(d?.TimeToCompleteDays) || 15,
    remindEveryDays: d?.AutomaticReminders ? Number(d?.RemindOnceInEvery) || 5 : 0,
    sendInOrder: d?.SendinOrder === true,
    strictOrder: d?.SendInOrderStrict === true,
    otp: d?.IsEnableOTP === true,
    notifyOnSignatures: d?.NotifyOnSignatures !== false,
    allowModifications: d?.AllowModifications === true,
    redirectUrl: d?.RedirectUrl || '',
    bcc: list(d?.Bcc),
    cc: list(d?.Cc),
    dateFormat: d?.DateFormat || '',
    timezone: d?.Timezone || '',
    is12HourTime: typeof d?.Is12HourTime === 'boolean' ? d.Is12HourTime : undefined,
  };
}

/**
 * Put the caller in every recipient marked `me: true`.
 *
 * Name and email come from the account, never from the input, so an agent that
 * adds "me" cannot point the seat at some other address. That seat is what
 * `signForMe` and `sign_document` sign (lib/agentSign.js findAgentSeat).
 *
 * @param {Array} list recipients as the caller sent them.
 * @param {import('./context.js').Caller} [caller] without one, `me` is refused.
 * @returns {Array} the same list, `me` entries resolved and the flag dropped.
 */
export function resolveMeRecipients(list, caller) {
  if (!Array.isArray(list)) return list;
  return list.map((r, i) => {
    if (!r || typeof r !== 'object' || r.me !== true) return r;
    const email = normaliseEmail(caller?.email);
    if (!email) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        caller
          ? `Recipient ${i + 1} is marked "me" but this account has no email address.`
          : `Recipient ${i + 1}: "me" is not accepted here. Give your name and email instead.`
      );
    }
    const { me: _me, ...rest } = r;
    return { ...rest, name: String(caller.name || rest.name || '').trim(), email };
  });
}

/**
 * Normalise the recipients list an API caller sends.
 * @param {Array<{name?: string, email?: string, me?: boolean, role?: string, phone?: string, order?: number}>} input
 *   `me: true` is the caller (see resolveMeRecipients).
 * @param {import('./context.js').Caller} [caller]
 */
export function normaliseRecipients(input, caller) {
  const list = resolveMeRecipients(Array.isArray(input) ? input : [], caller);
  if (!list.length)
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'At least one recipient is required.');
  if (list.length > MAX_RECIPIENTS) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `At most ${MAX_RECIPIENTS} recipients.`);
  }
  const seen = new Set();
  return list.map((r, i) => {
    const email = normaliseEmail(typeof r === 'string' ? r : r?.email);
    assertEmail(email, `recipient ${i + 1} email`);
    if (seen.has(email)) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Duplicate recipient ${email}.`);
    }
    seen.add(email);
    return {
      name: String((typeof r === 'object' && r?.name) || '').trim() || email.split('@')[0],
      email,
      role: String((typeof r === 'object' && r?.role) || '').trim() || `Role ${i + 1}`,
      phone: typeof r === 'object' && r?.phone ? String(r.phone) : undefined,
    };
  });
}

/**
 * Fields from the API: `{ recipient: <index|email|role>, type, page, x, y, width?, height?, label?, required?, values? }`.
 * Returns per-recipient field arrays aligned with `recipients`, plus prefill fields.
 */
export function groupFieldsByRecipient(fields, recipients) {
  const perRecipient = recipients.map(() => []);
  const prefill = [];
  for (const [i, f] of (Array.isArray(fields) ? fields : []).entries()) {
    if (!f || typeof f !== 'object') continue;
    const type = normaliseWidgetType(f.type);
    if (!type)
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Field ${i + 1}: unknown type "${f.type}".`
      );
    if (!Number.isFinite(Number(f.page)) || Number(f.page) < 1) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Field ${i + 1}: page must be >= 1.`);
    }
    if (!Number.isFinite(Number(f.x)) || !Number.isFinite(Number(f.y))) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Field ${i + 1}: x and y are required.`);
    }
    const ref = f.recipient ?? f.role ?? f.signer ?? 0;
    const field = { ...f, type };
    if (ref === PREFILL_ROLE || ref === 'sender' || ref === 'owner') {
      prefill.push(field);
      continue;
    }
    let idx = -1;
    if (typeof ref === 'number') idx = ref;
    else if (typeof ref === 'string') {
      const needle = ref.trim().toLowerCase();
      idx = recipients.findIndex(r => r.email === needle || r.role.toLowerCase() === needle);
      if (idx === -1 && /^\d+$/.test(needle)) idx = Number(needle);
    }
    if (idx < 0 || idx >= recipients.length) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Field ${i + 1}: recipient "${ref}" not found.`
      );
    }
    perRecipient[idx].push(field);
  }
  return { perRecipient, prefill };
}

/** Default layout when the caller gives recipients but no fields: one signature box each, bottom of the last page. */
export function defaultFieldsFor(recipients, pageCount = 1, pageWidth = 612, pageHeight = 792) {
  const perRecipient = recipients.map(() => []);
  const margin = 40;
  const boxW = 150;
  const boxH = 60;
  const gap = 12;
  const perRow = Math.max(1, Math.floor((pageWidth - margin * 2 + gap) / (boxW + gap)));
  recipients.forEach((_, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const y = pageHeight - margin - boxH - row * (boxH + 28 + gap);
    const x = margin + col * (boxW + gap);
    perRecipient[i].push(
      { type: 'signature', page: pageCount, x, y: Math.max(margin, y), width: boxW, height: boxH },
      {
        type: 'date',
        page: pageCount,
        x,
        y: Math.max(margin, y) + boxH + 4,
        width: 100,
        height: 20,
      }
    );
  });
  return perRecipient;
}

export function pointerOrEmpty(contactId) {
  return contactId
    ? { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId }
    : {};
}

/**
 * The caller's folder as a pointer, or an error.
 *
 * A folder is a `contracts_Document` row with `Type: "Folder"`, so an unchecked
 * `folderId` was a way to file a document under somebody else's folder and have
 * its name echoed back in every summary.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} folderId
 * @returns {Promise<Object>} a contracts_Document pointer.
 */
export async function assertFolder(caller, folderId) {
  const q = new Parse.Query('contracts_Document');
  q.equalTo('Type', 'Folder');
  q.equalTo('CreatedBy', userPointer(caller));
  q.notEqualTo('IsArchive', true);
  let folder;
  try {
    folder = await q.get(String(folderId), { useMasterKey: true });
  } catch {
    folder = null;
  }
  if (!folder) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, `Folder ${folderId} not found.`);
  }
  return { __type: 'Pointer', className: 'contracts_Document', objectId: folder.id };
}

/**
 * A template the caller may use, as a pointer. Same access rule as `gettemplate`:
 * their own, shared with them directly, or shared with one of their teams.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} templateId
 * @returns {Promise<Object>} a contracts_Template pointer.
 */
export async function assertTemplate(caller, templateId) {
  const template = await loadAccessibleTemplate(caller, templateId);
  return { __type: 'Pointer', className: 'contracts_Template', objectId: template.objectId };
}

/** One template the caller may use, as plain JSON. Throws when they may not. */
async function loadAccessibleTemplate(caller, templateId) {
  const id = String(templateId || '');
  const query = accessibleTemplateQuery(id, caller.user, extUserShim(caller));
  query.include('ExtUserPtr.TenantId');
  const found = await query.first({ useMasterKey: true });
  if (!found) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found.');
  }
  return JSON.parse(JSON.stringify(found));
}

/**
 * `accessibleTemplateQuery` expects the caller's `contracts_Users` row as a Parse
 * object (it reads `.id` and stringifies it for the team ancestors). The library
 * layer carries that row as plain JSON, so this is the adapter.
 */
function extUserShim(caller) {
  if (!caller?.extUserId) return null;
  const json = caller.extUser || {};
  return { id: caller.extUserId, toJSON: () => json };
}

/**
 * Validate and normalise a `chain` input: "when this document completes, create
 * and send a document from this template". Stored as the `Chain` column on
 * `contracts_Document` (and on `contracts_Template`, from which new documents
 * inherit it); `cloud/lib/chain.js` runs it when the last signature lands.
 *
 * `recipients` is optional: without it the completed document's own signers are
 * carried over, in placeholder order, when the chain fires. With it, the list
 * must fill every signer role of the target template.
 *
 * @param {import('./context.js').Caller} caller
 * @param {Object|null} input `{templateId, recipients?, name?, note?, message?}`; null clears.
 * @returns {Promise<Object|null>} the stored shape, or null.
 */
export async function normaliseChain(caller, input) {
  if (input === null || input === undefined) return null;
  const templateId = String(input.templateId || '').trim();
  if (!templateId) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'chain.templateId is required (the template the follow-up document is created from). Pass chain: null to remove the chain.'
    );
  }
  const t = await loadAccessibleTemplate(caller, templateId);
  const roles = (t.Placeholders || []).filter(g => g?.Role !== PREFILL_ROLE);
  if (!roles.length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `Template "${t.Name}" has no signer roles, so nothing could be sent from it.`
    );
  }
  const out = { templateId: t.objectId, templateName: t.Name || '' };
  if (input.recipients !== undefined && input.recipients !== null) {
    const recipients = normaliseRecipients(input.recipients, caller);
    if (recipients.length !== roles.length) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Template "${t.Name}" has ${roles.length} role(s): ${roles
          .map(g => g.Role)
          .join(', ')}. chain.recipients names ${recipients.length}. Leave recipients out to reuse the completed document's signers.`
      );
    }
    out.recipients = recipients;
  }
  const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
  if (name) out.name = name;
  const note = String(input.note || '').trim().slice(0, MAX_NOTE_LENGTH);
  if (note) out.note = note;
  if (input.message?.subject || input.message?.body) {
    out.message = {
      ...(input.message.subject ? { subject: String(input.message.subject).slice(0, 998) } : {}),
      ...(input.message.body ? { body: String(input.message.body).slice(0, 20000) } : {}),
    };
  }
  return out;
}

/** The `chain` block of a document/template summary, or undefined. */
export function chainJson(chain) {
  if (!chain?.templateId) return undefined;
  return {
    templateId: chain.templateId,
    templateName: chain.templateName || undefined,
    recipients: chain.recipients?.length
      ? chain.recipients.map(r => ({ name: r.name, email: r.email, role: r.role }))
      : undefined,
    name: chain.name || undefined,
  };
}

/** The stored form of a caller's `Idempotency-Key`, or '' when there is none. */
function idempotencyKeyOf(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

/**
 * The document a previous request with this `Idempotency-Key` created, if any.
 *
 * The REST layer keeps a short in-memory replay cache; this is the durable
 * fallback, so a retry after a restart (or against another process) returns the
 * first document instead of creating a second one.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} key the raw Idempotency-Key header.
 * @returns {Promise<Object|null>} the same summary `getDocument` returns.
 */
export async function findByIdempotencyKey(caller, key) {
  const stored = idempotencyKeyOf(key);
  if (!stored) return null;
  const query = new Parse.Query('contracts_Document');
  query.equalTo('CreatedBy', userPointer(caller));
  query.equalTo('CreatedWithKey', stored);
  query.notEqualTo('IsArchive', true);
  query.ascending('createdAt');
  const found = await query.first({ useMasterKey: true });
  if (!found) return null;
  return await getDocument(caller, found.id);
}

/** Trim a string field to the column's limit, or drop it when there is nothing. */
function text(value, max) {
  const out = typeof value === 'string' ? value : value === undefined ? '' : String(value ?? '');
  const trimmed = out.slice(0, max);
  return trimmed || undefined;
}

/**
 * Every column a **new** `contracts_Document` row gets, from one normalised input.
 *
 * This is the single writer. `contracts_Document` used to be constructed
 * independently in five places (`createDocument`, `drafts.duplicateDocument`,
 * `createdocumentfromapp`, `createbatchdocs` and `recreatedocument`) which
 * disagreed about ownership, about whether `SendInOrderStrict` was normalised
 * against `SendinOrder`, about whether an ACL was written inline or left to the
 * afterSave trigger, about the expiry base date, and about optional columns:
 * `PenColors` was set by two of them and by neither of the other three, so the
 * signer UI offered different pen colours depending on which path had made the
 * document. Every new column had to be added in five files.
 *
 * Ownership is never taken from the input: `CreatedBy` and `ExtUserPtr` always
 * come from the caller. Anything a request body says about them is ignored.
 *
 * @param {import('./context.js').Caller|{userId: string, extUserId: string}} caller
 * @param {Object} input normalised values (see `createDocument` for the caller-facing shape).
 * @param {string} input.name
 * @param {string} input.url stored file url.
 * @param {Object} input.settings the output of `normaliseSettings`.
 * @param {Array} [input.placeholders]
 * @param {Array} [input.signers] contracts_Contactbook pointers, index-parallel with placeholders.
 * @param {Object} [input.schedule] `{ExpiryDate, NextReminderDate}` when they are pre-computed.
 * @returns {Object} column name -> value, with absent columns left out entirely.
 */
export function documentFields(caller, input = {}) {
  const s = input.settings || normaliseSettings();
  const schedule = input.schedule || {};
  const fields = {
    Name: text(input.name, MAX_NAME_LENGTH) || 'Untitled document',
    URL: input.url,
    ExtUserPtr: extUserPointer(caller),
    CreatedBy: userPointer(caller),
    Description: text(input.description, MAX_DESCRIPTION_LENGTH),
    Note: text(input.note, MAX_NOTE_LENGTH),
    // A document is a draft until it is sent; only the bulk paths insert one
    // that has already gone out.
    SentToOthers: input.sentToOthers === true,
    SendinOrder: s.sendInOrder,
    // Never on its own. `SendInOrderStrict` is what the signer page and the
    // server both refuse a signature on, so a stored `true` under a document
    // that is not sent in order blocks every signer for a rule the sender turned
    // off. `normaliseSettings` already folds the two together; this is the one
    // place the column is written, so it cannot drift again.
    SendInOrderStrict: s.strictOrder,
    IsEnableOTP: s.otp,
    IsTourEnabled: input.isTourEnabled === true,
    AllowModifications: s.allowModifications,
    AutomaticReminders: s.remindEveryDays > 0,
    RemindOnceInEvery: s.remindEveryDays || 5,
    NotifyOnSignatures: s.notifyOnSignatures,
    TimeToCompleteDays: s.expiryDays,
    ExpiryDate: schedule.ExpiryDate || undefined,
    NextReminderDate: schedule.NextReminderDate || undefined,
    RedirectUrl: s.redirectUrl || undefined,
    Bcc: s.bcc?.length ? s.bcc : undefined,
    Cc: s.cc?.length ? s.cc : undefined,
    DateFormat: s.dateFormat || undefined,
    Timezone: s.timezone || undefined,
    Is12HourTime: typeof s.is12HourTime === 'boolean' ? s.is12HourTime : undefined,
    TemplateId: input.template || undefined,
    Folder: input.folder || undefined,
    Signers: Array.isArray(input.signers) ? input.signers : undefined,
    Placeholders: Array.isArray(input.placeholders) ? input.placeholders : undefined,
    RequestSubject: text(input.message?.subject, 998),
    RequestBody: text(input.message?.body, 20000),
    SignatureType: input.signatureType?.length ? input.signatureType : undefined,
    // Which pen colours the signer UI offers. It was set on two of the five old
    // creation paths, so the same template sent two ways gave signers different
    // choices.
    PenColors: input.penColors?.length ? input.penColors : undefined,
    SenderName: text(input.senderName, 200),
    SenderMail: text(input.senderMail, 254),
    EmailEditorType: text(input.emailEditorType, 40),
    OriginIp: text(input.originIp, 64),
    CreatedVia: text(input.origin, 40),
    // The REST layer's Idempotency-Key replay cache lives in memory, so it is
    // lost on a restart and unknown to a second process. Recording the key on the
    // row gives it a durable fallback (see findByIdempotencyKey).
    CreatedWithKey: idempotencyKeyOf(input.idempotencyKey) || undefined,
    EnvelopeParts: Array.isArray(input.envelopeParts) && input.envelopeParts.length ? input.envelopeParts : undefined,
    SignedUrl: input.signedUrl || undefined,
    DocSentAt: input.docSentAt || undefined,
    BatchKey: input.batchKey || undefined,
    BulkSendToken: input.bulkSendToken || undefined,
    // "Send a follow-up when this completes" (see normaliseChain / lib/chain.js),
    // and the back-pointer a chained follow-up carries to the document that
    // triggered it.
    Chain: input.chain || undefined,
    ChainedFrom: input.chainedFrom
      ? { __type: 'Pointer', className: 'contracts_Document', objectId: String(input.chainedFrom) }
      : undefined,
    ACL: input.acl || undefined,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
}

/**
 * The same fields as an unsaved `Parse.Object`, for the callers that need one
 * back (`createdocumentfromapp` returns it, `recreatedocument` reads its id).
 *
 * @param {import('./context.js').Caller|{userId: string, extUserId: string}} caller
 * @param {Object} input see `documentFields`.
 * @returns {Parse.Object}
 */
export function buildDocumentObject(caller, input = {}) {
  const doc = new Parse.Object('contracts_Document');
  const fields = documentFields(caller, input);
  const acl = fields.ACL;
  delete fields.ACL;
  for (const [key, value] of Object.entries(fields)) doc.set(key, value);
  if (acl) doc.setACL(acl instanceof Parse.ACL ? acl : new Parse.ACL(acl));
  return doc;
}

/**
 * Create a document for the caller (draft by default, sent when `send: true`).
 *
 * @param {import('./context.js').Caller} caller
 * @param {Object} input
 * @param {string} input.name
 * @param {string} input.url stored PDF url; an external url is downloaded once and copied into our storage
 * @param {Array} input.recipients see normaliseRecipients
 * @param {Array} [input.fields] see groupFieldsByRecipient
 * @param {Array} [input.placeholders] ready-made Placeholders (from the AI proposal); wins over `fields`
 * @param {Object} [input.settings]
 * @param {{subject?: string, body?: string}} [input.message]
 * @param {string} [input.note]
 * @param {string} [input.description]
 * @param {string} [input.templateId]
 * @param {string} [input.folderId]
 * @param {boolean} [input.send]
 * @param {boolean} [input.signForMe] with `send`: the caller's agent signs the
 *   caller's own seat as it goes out (see sendDocument).
 * @param {boolean} [input.confirmNameMismatch] with `signForMe`: the user
 *   confirmed they sign for the party the document names (see sendDocument).
 * @param {{pageCount?: number, width?: number, height?: number}} [input.pageInfo] for the default layout
 */
export async function createDocument(caller, input) {
  const name =
    String(input?.name || '')
      .trim()
      .slice(0, MAX_NAME_LENGTH) || 'Untitled document';
  // Never store a url straight from the caller: it is either one of ours, or it
  // is copied into our storage first (see assertStoredFileUrl).
  const url = await assertStoredFileUrl(input?.url, caller, { fileName: input?.fileName });
  const recipients = normaliseRecipients(input?.recipients, caller);
  assertSettingsInput(input?.settings);
  const settings = normaliseSettings(input?.settings);
  // Both pointers used to be written straight from the caller's input.
  const folder = input?.folderId ? await assertFolder(caller, input.folderId) : null;
  const template = input?.templateId ? await assertTemplate(caller, input.templateId) : null;
  // Validated up front: a chain naming a template the caller cannot use fails
  // the create, not the completion months later.
  const chain = input?.chain !== undefined ? await normaliseChain(caller, input.chain) : null;

  // Contacts first: Placeholders and Signers must be index-parallel (§6.2).
  const contacts = [];
  for (const r of recipients) contacts.push(await ensureContact(caller, r));

  let placeholders;
  if (Array.isArray(input?.placeholders) && input.placeholders.length) {
    placeholders = bindPlaceholders(input.placeholders, recipients, contacts);
  } else {
    const info = input?.pageInfo || {};
    const grouped =
      Array.isArray(input?.fields) && input.fields.length
        ? groupFieldsByRecipient(input.fields, recipients)
        : {
            perRecipient: defaultFieldsFor(
              recipients,
              info.pageCount || 1,
              info.width,
              info.height
            ),
            prefill: [],
          };
    const roles = recipients.map((r, i) => ({
      role: r.role,
      name: r.name,
      email: r.email,
      contactId: contacts[i].objectId,
      fields: grouped.perRecipient[i],
    }));
    if (grouped.prefill.length)
      roles.push({ role: PREFILL_ROLE, isPrefill: true, fields: grouped.prefill });
    placeholders = buildPlaceholders(roles);
  }

  const now = new Date();
  // One helper decides every schedule in the product (see schedule.js): a new
  // document's clock starts now and moves to DocSentAt when it is sent.
  const { ExpiryDate, NextReminderDate } = scheduleFieldsFor(
    {
      TimeToCompleteDays: settings.expiryDays,
      AutomaticReminders: settings.remindEveryDays > 0,
      RemindOnceInEvery: settings.remindEveryDays || 5,
    },
    { now }
  );

  const doc = buildDocumentObject(caller, {
    ...input,
    name,
    url,
    settings,
    placeholders,
    signers: contacts.map(c => pointerOrEmpty(c.objectId)),
    template,
    folder,
    chain: chain || undefined,
    schedule: { ExpiryDate, NextReminderDate },
  });
  const saved = await doc.save(null, { useMasterKey: true });
  setDocumentCount(caller.extUserId);

  // The row is always inserted as a draft and `send: true` goes through
  // sendDocument, so one code path owns the send: the same readiness checks, the
  // same guarded transition, and an expiry counted from the moment it went out.
  // The create path used to set SignedUrl/DocSentAt itself and mail every signer
  // a link to a document that could have no fields at all.
  if (input?.send) {
    try {
      return await sendDocument(caller, saved.id, {
        signForMe: input.signForMe === true,
        confirmNameMismatch: input.confirmNameMismatch === true,
      });
    } catch (err) {
      // The row exists either way, so the caller is told where it is rather than
      // being left with an error and no document id.
      throw new Parse.Error(
        err?.code || Parse.Error.SCRIPT_FAILED,
        `${err?.message || 'The document could not be sent.'} The draft was created (documentId ${saved.id}); fix it and call send_document.`
      );
    }
  }
  const summary = await getDocument(caller, saved.id);
  return { ...summary, mail: null };
}

/**
 * Bind an AI/template `Placeholders` array to actual recipients. Roles are matched
 * by position in `recipients` (prefill groups are kept as-is).
 */
export function bindPlaceholders(placeholders, recipients, contacts) {
  // Caller-supplied groups (the MCP schema takes `z.any()`) are checked here:
  // they used to be stored verbatim, so an unknown type or a non-numeric
  // coordinate only failed at stamping time, after the signer had signed.
  // The same reset every copy path applies (`lib/widgets.js`): a template or an
  // AI proposal is a layout, and any answer stored in it belongs to the document
  // it was captured on. `createDocumentFromTemplate` used to pass the template's
  // widgets straight through, so a template written by any path other than
  // `saveastemplate` carried its stored answers into every document made from it.
  const checked = resetPlaceholdersForCopy(sanitisePlaceholders(placeholders));
  const signerGroups = checked.filter(g => g?.Role !== PREFILL_ROLE);
  const prefillGroups = checked.filter(g => g?.Role === PREFILL_ROLE);
  if (signerGroups.length !== recipients.length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `The layout has ${signerGroups.length} signer role(s) but ${recipients.length} recipient(s) were given.`
    );
  }
  const bound = signerGroups.map((g, i) => ({
    ...g,
    Role: g.Role || recipients[i].role,
    signerObjId: contacts[i].objectId,
    signerPtr: pointerOrEmpty(contacts[i].objectId),
    email: recipients[i].email,
  }));
  return [...bound, ...prefillGroups];
}

export async function loadDoc(docId, { includeAudit = true } = {}) {
  const query = new Parse.Query('contracts_Document');
  query.include('ExtUserPtr');
  query.include('ExtUserPtr.TenantId');
  query.include('CreatedBy');
  query.include('Signers');
  query.include('Placeholders.signerPtr');
  if (includeAudit) query.include('AuditTrail.UserPtr');
  query.include('DeclineBy');
  query.include('Folder');
  query.notEqualTo('IsArchive', true);
  let obj;
  try {
    obj = await query.get(String(docId || ''), { useMasterKey: true });
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
    throw err;
  }
  return obj;
}

/**
 * Refuse a caller who does not own this document.
 *
 * The predicate itself is `lib/acl.isDocumentOwner`, shared with `authGuard`'s
 * document-actor resolution and `recreatedocument`; four copies of it used to
 * exist with three different rule sets.
 */
export function assertOwner(docJson, caller) {
  if (!isDocumentOwner(docJson, caller?.userId)) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'You do not own this document.');
  }
}

export function documentStatus(d) {
  if (d?.IsDeclined && d?.IsVoided) return 'voided';
  if (d?.IsDeclined) return 'declined';
  if (d?.IsCompleted) return 'completed';
  if (!d?.SignedUrl && !d?.DocSentAt) return 'draft';
  if (d?.ExpiryDate?.iso && new Date(d.ExpiryDate.iso).getTime() < Date.now()) return 'expired';
  return 'in_progress';
}

function signedMap(d) {
  const map = new Map();
  for (const entry of d?.AuditTrail || []) {
    if (entry?.Activity === 'Signed' && entry?.UserPtr?.objectId) {
      map.set(entry.UserPtr.objectId, entry?.SignedOn?.iso || entry?.SignedOn || null);
    }
  }
  return map;
}

export function summariseDocument(d, caller, { links = true } = {}) {
  const signed = signedMap(d);
  const signers = (d?.Placeholders || []).filter(isParticipantBasic).map((p, i) => {
    const contactId = p?.signerObjId || p?.signerPtr?.objectId || '';
    const contact = (d?.Signers || []).find(s => s?.objectId === contactId);
    const email = (contact?.Email || p?.email || '').toLowerCase();
    const signedAt = contactId ? signed.get(contactId) : null;
    const declined =
      d?.IsDeclined && d?.DeclineBy?.objectId && d.DeclineBy.objectId === contact?.UserId?.objectId;
    return {
      order: i + 1,
      role: p?.Role || `Role ${i + 1}`,
      name: contact?.Name || p?.Name || '',
      email,
      contactId: contactId || undefined,
      status: signedAt ? 'signed' : declined ? 'declined' : d?.IsVoided ? 'voided' : 'pending',
      signedAt: signedAt || undefined,
      fields: (p?.placeHolder || []).reduce((n, pg) => n + (pg.pos || []).length, 0),
    };
  });
  const links_ = links && caller ? signingLinksFor(d, caller.publicUrl) : [];
  for (const s of signers) {
    const l = links_.find(x => x.email === s.email);
    if (l && s.status === 'pending' && documentStatus(d) === 'in_progress') s.signingUrl = l.url;
  }
  return {
    objectId: d.objectId,
    name: d.Name,
    status: documentStatus(d),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    sentAt: d?.DocSentAt?.iso || undefined,
    expiresAt: d?.ExpiryDate?.iso || undefined,
    completedAt: d?.IsCompleted ? d?.updatedAt : undefined,
    declineReason: d?.IsDeclined ? d?.DeclineReason || '' : undefined,
    voided: d?.IsVoided === true ? true : undefined,
    note: d?.Note || undefined,
    description: d?.Description || undefined,
    sendInOrder: d?.SendinOrder === true,
    otp: d?.IsEnableOTP === true,
    templateId: d?.TemplateId?.objectId || undefined,
    folderId: d?.Folder?.objectId || undefined,
    folderName: d?.Folder?.Name || undefined,
    fieldCount: countFields(d?.Placeholders),
    signers,
    hasCertificate: Boolean(d?.CertificateUrl),
    chain: chainJson(d?.Chain),
    chainedFrom: d?.ChainedFrom?.objectId || undefined,
    chainResult: d?.ChainResult
      ? {
          status: d.ChainResult.status,
          documentId: d.ChainResult.documentId || undefined,
          error: d.ChainResult.error || undefined,
          at: d.ChainResult.at || undefined,
        }
      : undefined,
    envelope: Array.isArray(d?.EnvelopeParts) && d.EnvelopeParts.length
      ? { parts: d.EnvelopeParts, pageCount: d.EnvelopeParts.reduce((n, p) => n + (Number(p?.pageCount) || 0), 0) || undefined }
      : undefined,
  };
}

export async function getDocument(caller, docId, { urls = true, links = false } = {}) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  // Signing urls carry the signer's token, so they are opt-in here
  // (`get_signing_links` / `includeLinks: true`), not in every document read.
  const summary = summariseDocument(d, caller, { links });
  if (urls) {
    summary.urls = {
      original: await resolveFileUrl(d.URL, { ttl: API_URL_TTL }),
      signed: d.SignedUrl ? await resolveFileUrl(d.SignedUrl, { ttl: API_URL_TTL }) : undefined,
      certificate: d.CertificateUrl ? await resolveFileUrl(d.CertificateUrl, { ttl: API_URL_TTL }) : undefined,
      app: caller.publicUrl ? `${caller.publicUrl}/documents/${d.objectId}` : undefined,
    };
  }
  return summary;
}

/** The raw document JSON the AI/editor needs (owner only). */
export async function getDocumentRaw(caller, docId) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  return d;
}

const STATUSES = ['draft', 'in_progress', 'completed', 'declined', 'voided', 'expired'];

/**
 * The query for one status bucket, built from the same predicate
 * `documentStatus` applies to a loaded row:
 *
 *   sent      SignedUrl or DocSentAt exists
 *   expired   sent, and ExpiryDate exists and is in the past
 *
 * The two used to disagree: the filters demanded `SignedUrl` and an
 * `ExpiryDate`, so a sent row without one of them (an AIDoc, a hand-built
 * payload) was reported as `in_progress` by get_document while matching no
 * bucket at all, and an agent iterating by status never saw it.
 *
 * @param {string} status one of STATUSES.
 * @returns {Parse.Query} a query for that bucket only.
 */
function statusQuery(status) {
  const doc = () => new Parse.Query('contracts_Document');
  const sent = () => Parse.Query.or(doc().exists('SignedUrl'), doc().exists('DocSentAt'));
  const live = q => {
    q.notEqualTo('IsCompleted', true);
    q.notEqualTo('IsDeclined', true);
    return q;
  };
  switch (status) {
    case 'draft': {
      const q = doc();
      q.doesNotExist('SignedUrl');
      q.doesNotExist('DocSentAt');
      return live(q);
    }
    case 'in_progress': {
      const notExpired = Parse.Query.or(
        doc().doesNotExist('ExpiryDate'),
        doc().greaterThan('ExpiryDate', new Date())
      );
      return live(Parse.Query.and(sent(), notExpired));
    }
    case 'expired': {
      const q = doc();
      q.exists('ExpiryDate');
      q.lessThan('ExpiryDate', new Date());
      return live(Parse.Query.and(sent(), q));
    }
    case 'completed': {
      const q = doc();
      q.equalTo('IsCompleted', true);
      // documentStatus reports a declined document as declined even when it also
      // carries IsCompleted, so the buckets stay disjoint.
      q.notEqualTo('IsDeclined', true);
      return q;
    }
    case 'declined': {
      const q = doc().equalTo('IsDeclined', true);
      q.notEqualTo('IsVoided', true);
      return q;
    }
    case 'voided':
      return doc().equalTo('IsVoided', true);
    default:
      return doc();
  }
}

export async function listDocuments(
  caller,
  { status = 'all', limit = 25, skip = 0, search = '' } = {}
) {
  if (status && status !== 'all' && !STATUSES.includes(status)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `status must be one of all, ${STATUSES.join(', ')}.`
    );
  }
  const query =
    status && status !== 'all' ? statusQuery(status) : new Parse.Query('contracts_Document');
  query.equalTo('CreatedBy', userPointer(caller));
  query.notEqualTo('IsArchive', true);
  query.doesNotExist('Type'); // folders are documents with Type: "Folder"
  // `matches` compiles the term as a regular expression inside the database.
  const term = searchPattern(search);
  if (term) query.matches('Name', term, 'i');
  query.include('Signers');
  query.include('Placeholders.signerPtr');
  query.include('AuditTrail.UserPtr');
  query.descending('updatedAt');
  query.limit(clampInt(limit, 1, 200, 25));
  query.skip(clampInt(skip, 0, 100000, 0));
  const rows = await query.find({ useMasterKey: true });
  return rows.map(r => summariseDocument(JSON.parse(JSON.stringify(r)), caller, { links: false }));
}

async function mailForDocument(caller, docId, { only } = {}) {
  const obj = await loadDoc(docId, { includeAudit: false });
  const d = JSON.parse(JSON.stringify(obj));
  return await sendSignatureRequestMails({ doc: d, publicUrl: caller.publicUrl, only });
}

/**
 * Everything that must be true before a document may go out.
 *
 * This is the one gate: `create_document { send: true }` used to bypass it
 * entirely, and it used to be looser than `review_draft`, which reports unbound
 * recipients, bad or duplicate addresses and fields that fall off the page as
 * blocking errors while the send path let all of them through. The checks that
 * need no PDF read run always; the geometry check runs when the page sizes were
 * cached the last time the file was read (see drafts.js `ensurePageSizes`).
 *
 * @param {Object} d plain document JSON.
 */
export function assertSendable(d) {
  const fail = message => new Parse.Error(Parse.Error.SCRIPT_FAILED, message);
  const participants = (d?.Placeholders || []).filter(isParticipantBasic);
  if (!participants.length) throw fail('Add at least one recipient before sending.');
  const seen = new Set();
  for (const p of participants) {
    const contactId = p?.signerObjId || p?.signerPtr?.objectId || '';
    const contact = (d?.Signers || []).find(s => s?.objectId === contactId);
    const email = String(contact?.Email || p?.email || '').toLowerCase();
    const who = p?.Role || 'A role';
    if (!contactId && !email) throw fail('Every role needs a recipient before sending.');
    if (!email) throw fail(`${who} has no email address.`);
    if (!isValidEmail(email)) throw fail(`${who}: "${email}" is not a valid email address.`);
    if (seen.has(email))
      throw fail(`${email} appears twice: every recipient needs their own address.`);
    seen.add(email);
    if (!contactId)
      throw fail(`${who} is not linked to a contact; set the recipients again before sending.`);
  }
  // Prefill boxes are the owner's own; a document whose only fields are prefill
  // gives every signer a link with nothing to do.
  if (!countSignerFields(d?.Placeholders)) {
    throw fail('Place at least one field for a signer before sending.');
  }
  const pages = cachedPageSizes(d);
  if (pages?.length) {
    for (const g of d?.Placeholders || []) {
      for (const p of g?.placeHolder || []) {
        if (Number(p?.pageNumber) > pages.length) {
          throw fail(
            `A field sits on page ${p.pageNumber} but the PDF has ${pages.length} page(s). Run review_draft and fix the layout before sending.`
          );
        }
      }
    }
  }
}

/** Page geometry cached on the row for the file it currently points at, if any. */
export function cachedPageSizes(d) {
  const cache = d?.PageSizes;
  if (!cache || cache.url !== d?.URL || !Array.isArray(cache.pages)) return null;
  return cache.pages;
}

/**
 * Refuse `signForMe` before anything goes out when it could not work: the app
 * may not sign, the caller has no seat, or (signing in order) someone signs
 * before the caller. A required value the agent cannot fill, or a name printed
 * for the caller's party that is not theirs, is refused next, in sendDocument,
 * also before anything goes out. A failure only found while signing falls back
 * to mailing everybody instead.
 *
 * @returns {{contactId: string, placeholder: Object}} the caller's seat.
 */
function assertCanSignForMe(caller, d) {
  const scopeProblem = signingScopeProblem(caller);
  if (scopeProblem) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, scopeProblem);
  const identityProblem = verifiedIdentityProblem(caller);
  if (identityProblem) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, identityProblem);
  const seat = findAgentSeat(d, caller);
  if (!seat) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'You are not one of the recipients, so there is nothing for your agent to sign. Add yourself as a recipient with me: true, or send without signForMe.'
    );
  }
  if (d.SendinOrder === true) {
    const idx = findPlaceholderIndex(d.Placeholders, seat.contactId);
    if (findPendingPriorSigner(d.Placeholders, idx, d.AuditTrail)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        "You are not first in the signing order, so your agent can't sign before sending. Send it, then call sign_document when it's your turn."
      );
    }
  }
  return seat;
}

/** Whether anybody has signed this document yet. */
function hasSignature(d) {
  return (d?.AuditTrail || []).some(entry => entry?.Activity === 'Signed');
}

/** What the audit trail records as the permission for an own-document signature. */
export function ownDocumentAllowance(caller) {
  return {
    via: 'own_document',
    name: caller.name,
    email: caller.email,
    at: new Date(),
    signingEnabledAt: caller.oauth?.signingEnabledAt || null,
  };
}

/**
 * Mark a draft as sent and mail its signers.
 *
 * `signForMe`: the caller is one of the signers and their agent signs that part
 * as the document goes out ("draft it, sign for me, send it to the tenant").
 * The order is the guarded "mark sent", the agent's signature
 * (lib/agentSign.js, which also emails the owner a "signed for you" notice),
 * then the request mail to whoever still has to sign, so the caller is never
 * asked to sign a part that is already signed. Missing values are refused
 * before sending, and so is a document that prints another name for the
 * caller's party (lib/signerName.js) unless `confirmNameMismatch` says the user
 * confirmed they sign for it. If the signature still fails, everybody is mailed
 * as usual, the caller included, and `warnings` says why.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {{resend?: boolean, signForMe?: boolean, confirmNameMismatch?: boolean}} [opts]
 */
export async function sendDocument(
  caller,
  docId,
  { resend = false, signForMe = false, confirmNameMismatch = false } = {}
) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  if (d.IsCompleted)
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is already completed.');
  if (d.IsDeclined) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has been declined.');
  assertSendable(d);
  const alreadySent = Boolean(d.SignedUrl || d.DocSentAt);
  if (alreadySent && !resend) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'Document was already sent. Pass resend: true to mail again.'
    );
  }
  if (signForMe && alreadySent) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'signForMe only works when a draft is first sent. To sign a document that is already out, call sign_document.'
    );
  }
  let nameCheck = null;
  if (signForMe) {
    const seat = assertCanSignForMe(caller, d);
    // Every value the agent will fill, checked on the draft before it goes out:
    // a required field the agent cannot fill is refused here, not after mailing.
    const { missing } = await prepareAgentSignature(caller, d.objectId, { allowDraft: true });
    if (missing.length) {
      const list = missing.map(m => `${m.label} (field ${m.key}): ${m.reason}`).join(' ');
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Your agent cannot sign your part, so nothing was sent. ${list} Send without signForMe and sign from your email, or fill this in DocuStamp.`
      );
    }
    // The name the draft prints for the caller's party, before anyone is mailed:
    // the other side must never get a document whose page and signature disagree.
    nameCheck = await checkSeatName(d, seat, accountOf(caller));
    if (nameCheck.status === 'mismatch' && confirmNameMismatch !== true) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `${nameMismatchMessage(nameCheck)} Nothing was sent.`
      );
    }
  }
  let only;
  if (!alreadySent) {
    // The transition is guarded on the fields still being unset, so two
    // overlapping sends (an MCP transport retry is normal) cannot both mail
    // every signer: the loser is told the document has already gone out.
    const sentAt = new Date();
    const { ExpiryDate, NextReminderDate } = scheduleFieldsFor(
      { ...d, DocSentAt: sentAt },
      { defaultExpiryDays: DEFAULT_SETTINGS.expiryDays }
    );
    const won = await conditionalUpdate(
      'contracts_Document',
      d.objectId,
      { SignedUrl: { $exists: false }, DocSentAt: { $exists: false } },
      {
        SignedUrl: d.URL,
        SentToOthers: true,
        DocSentAt: sentAt,
        SendMail: true,
        // A document an app sent (ChatGPT and the like) used to be forced to
        // need the emailed code. Not any more: the app never holds a signing
        // link (mcp/server.js strips them), so the link in the signer's own
        // inbox is enough, and the code stays a per-document setting (`otp`).
        // The clock starts now: a draft that sat for a month used to be sent
        // already expired, because ExpiryDate was fixed at creation.
        ExpiryDate,
        NextReminderDate: NextReminderDate || undefined,
      }
    );
    if (!won) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        'Document was already sent. Pass resend: true to mail again.'
      );
    }
  } else {
    // A resend is a nudge: only the people still owing a signature, and on a
    // sequential document only the one being waited on.
    const pending = pendingRequestRecipients(d).map(r => r.email);
    if (!pending.length) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        'Everybody has already signed this document, so there is nobody to mail.'
      );
    }
    only = pending;
  }

  const warnings = [];
  let signedForYou = null;
  let signError = '';
  if (signForMe) {
    try {
      signedForYou = await agentSignDocument(caller, d.objectId, {
        allowedBy: ownDocumentAllowance(caller),
        notifyOwner: true,
        confirmNameMismatch: confirmNameMismatch === true,
        nameCheck,
      });
    } catch (err) {
      console.log('documents: the agent could not sign before mailing', err?.message || err);
      signError = String(err?.message || 'signing failed').replace(/\.?\s*$/, '.');
    }
  }

  // Read back after any signing attempt: an agent signature can land even when
  // something after it failed, and a signed document must never go back to a
  // draft or ask its signer to sign again.
  const fresh = signForMe ? JSON.parse(JSON.stringify(await loadDoc(d.objectId))) : null;
  const landed = Boolean(signedForYou) || hasSignature(fresh);
  if (signError) {
    warnings.push(
      landed
        ? `Your part was signed, but something after it failed: ${signError} Check the document with get_document.`
        : `Your agent could not sign for you: ${signError} The request went to every signer, you included, so you can sign from your email, or call sign_document once the problem is fixed.`
    );
  }
  let mail;
  if (landed) {
    // A signature has landed: from here on the document is out for good, and
    // only the people still owing a signature are mailed, like a resend. On an
    // in-order document lib/agentSign.js has already mailed the next signer
    // (the signer page does that for a person), so that one is not mailed twice.
    const mailedBySigning =
      fresh.SendinOrder === true ? normaliseEmail(signedForYou?.nextSigner?.email) : '';
    const pending = pendingRequestRecipients(fresh)
      .map(r => r.email)
      .filter(email => email !== mailedBySigning);
    mail = pending.length
      ? await mailForDocument(caller, d.objectId, { only: pending })
      : { sent: [], failed: [], signingLinks: [] };
    if (mailedBySigning) mail = { ...mail, sent: [...mail.sent, mailedBySigning] };
    if (mail.failed.length) {
      warnings.push(
        `Your part is signed, but the request could not be mailed to ${mail.failed
          .map(f => `${f.email} (${f.reason})`)
          .join(', ')}. Fix the mail settings, then call resend_to.`
      );
    }
  } else {
    mail = await mailForDocument(caller, d.objectId, { only });
    if (!alreadySent && !mail.sent.length) {
      // Nothing was delivered, so nobody holds a link. Put the document back to a
      // draft rather than leave it looking sent, and say so: the call can then
      // simply be retried once the mail settings are fixed. Never once a
      // signature landed (the branch above): that document is out for good.
      const revert = new Parse.Object('contracts_Document');
      revert.id = d.objectId;
      revert.unset('SignedUrl');
      revert.unset('DocSentAt');
      revert.set('SendMail', false);
      revert.set('SentToOthers', false);
      await revert.save(null, { useMasterKey: true });
      const reason = mail.failed[0]?.reason || 'mail_failed';
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        `The document could not be mailed to anybody (${reason}), so it is still a draft. Fix the mail settings and send again.`
      );
    }
  }
  if (!alreadySent) emitInBackground('sent', { ...d, DocSentAt: { iso: new Date().toISOString() }, SignedUrl: d.URL }, {});
  // The REST contract includes the signing urls here; the MCP tool strips them
  // unless asked (includeLinks).
  const summary = await getDocument(caller, d.objectId, { links: true });
  // The custom body (document, tenant or sender template) had no place for the
  // link, so `buildRequestMail` appended one. The mail is out; say what happened.
  const body = customRequestBody(d);
  if (body && !hasSigningLinkMarker(body)) warnings.push(MESSAGE_WITHOUT_LINK.message);
  return {
    ...summary,
    mail,
    ...(signedForYou ? { signedForYou } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function signingLinks(caller, docId) {
  const d = await getDocumentRaw(caller, docId);
  return signingLinksFor(d, caller.publicUrl);
}

/* ------------------------------------------------------------------ templates */

export function templateJson(t) {
  const roles = (t?.Placeholders || [])
    .filter(g => g?.Role !== PREFILL_ROLE)
    .map((g, i) => ({
      order: i + 1,
      role: g?.Role || `Role ${i + 1}`,
      fields: (g?.placeHolder || []).reduce((n, pg) => n + (pg.pos || []).length, 0),
    }));
  return {
    objectId: t.objectId,
    name: t.Name || '',
    note: t.Note || undefined,
    description: t.Description || undefined,
    roles,
    sendInOrder: t?.SendinOrder === true,
    chain: chainJson(t?.Chain),
    updatedAt: t.updatedAt,
  };
}

/**
 * Every template the caller may use: their own, shared with them directly, or
 * shared with one of their teams. Same rule as `gettemplate`; the API used to
 * see personal templates only, so a workspace whose NDA is a team template
 * owned by the legal lead could not reach it through a token at all.
 */
function accessibleTemplatesQuery(caller) {
  const extUser = extUserShim(caller);
  const clauses = [new Parse.Query('contracts_Template').equalTo('CreatedBy', userPointer(caller))];
  if (extUser?.id) {
    const pointer = extUserPointer(caller);
    clauses.push(new Parse.Query('contracts_Template').equalTo('ExtUserPtr', pointer));
    clauses.push(new Parse.Query('contracts_Template').equalTo('SharedWithUsers', pointer));
    const ancestors = [];
    for (const team of caller.extUser?.TeamIds || []) {
      if (Array.isArray(team?.Ancestors)) ancestors.push(...team.Ancestors);
    }
    if (ancestors.length) {
      clauses.push(new Parse.Query('contracts_Template').containedIn('SharedWith', ancestors));
    }
  }
  return clauses.length === 1 ? clauses[0] : Parse.Query.or(...clauses);
}

export async function listTemplates(caller, { limit = 50, skip = 0, search = '' } = {}) {
  const query = accessibleTemplatesQuery(caller);
  query.notEqualTo('IsArchive', true);
  const term = searchPattern(search);
  if (term) query.matches('Name', term, 'i');
  query.descending('updatedAt');
  query.limit(clampInt(limit, 1, 200, 50));
  query.skip(clampInt(skip, 0, 100000, 0));
  const rows = await query.find({ useMasterKey: true });
  return rows.map(r => templateJson(JSON.parse(JSON.stringify(r))));
}

/**
 * Create a document from one of the caller's templates. Recipients bind to the
 * template's roles in order (or by `role` name when given).
 */
export async function createDocumentFromTemplate(caller, templateId, input = {}) {
  // Ownership, direct sharing and team sharing, in the query itself.
  const t = await loadAccessibleTemplate(caller, templateId);
  const recipients = normaliseRecipients(input.recipients, caller);
  const signerGroups = (t.Placeholders || []).filter(g => g?.Role !== PREFILL_ROLE);
  const prefillGroups = (t.Placeholders || []).filter(g => g?.Role === PREFILL_ROLE);
  if (signerGroups.length !== recipients.length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `Template "${t.Name}" has ${signerGroups.length} role(s): ${signerGroups
        .map(g => g.Role)
        .join(', ')}. ${recipients.length} recipient(s) were given.`
    );
  }
  // Reorder recipients to the template's roles when role names are given.
  const ordered = signerGroups.map((g, i) => {
    const byRole = recipients.find(
      r => r.role.toLowerCase() === String(g.Role || '').toLowerCase()
    );
    return byRole || recipients[i];
  });
  if (new Set(ordered.map(r => r.email)).size !== ordered.length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'Recipients could not be mapped to template roles.'
    );
  }
  // `bindPlaceholders` (inside createDocument) resets the stored widget values
  // and rebinds the roles, so the groups travel as they are.
  const placeholders = [...signerGroups, ...prefillGroups];
  // A template can carry its own chain ("every signed NDA is followed by the
  // onboarding form"). An explicit input wins, including chain: null. The
  // inherited one is best-effort: a chain whose target template has since been
  // deleted or unshared must not block creating this document.
  let chain = input.chain;
  if (chain === undefined && t.Chain?.templateId) {
    chain = await normaliseChain(caller, t.Chain).catch(err => {
      console.log(`documents: dropped the chain inherited from template ${t.objectId}:`, err?.message);
      return undefined;
    });
  }
  return await createDocument(caller, {
    name: input.name || t.Name,
    // Stored on the row, so a retried request finds this document (findByIdempotencyKey).
    idempotencyKey: input.idempotencyKey,
    url: t.URL,
    recipients: ordered,
    placeholders,
    templateId: t.objectId,
    note: input.note ?? t.Note,
    description: input.description ?? t.Description,
    settings: {
      expiryDays: t.TimeToCompleteDays,
      remindEveryDays: t.AutomaticReminders ? t.RemindOnceInEvery : 0,
      sendInOrder: t.SendinOrder,
      strictOrder: t.SendInOrderStrict,
      otp: t.IsEnableOTP,
      notifyOnSignatures: t.NotifyOnSignatures,
      allowModifications: t.AllowModifications,
      redirectUrl: t.RedirectUrl,
      bcc: t.Bcc,
      cc: t.Cc,
      ...(input.settings || {}),
    },
    message: input.message || { subject: t.RequestSubject, body: t.RequestBody },
    send: input.send === true,
    signForMe: input.signForMe === true,
    confirmNameMismatch: input.confirmNameMismatch === true,
    folderId: input.folderId,
    origin: input.origin,
    chain,
    chainedFrom: input.chainedFrom,
  });
}
