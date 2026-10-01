import { appName } from '../../Utils.js';
import {
  findPendingPriorSigner,
  findPlaceholderIndex,
  isParticipantBasic,
} from '../../utils/workflowUtils.js';
import PDF, { assertSignable, isBaseChangedError } from '../parsefunction/pdf/PDF.js';
import sendSystemMail from '../parsefunction/sendSystemMail.js';
import { isDocumentOwner } from './acl.js';
import { agentIdentity, agentLabel, verifiedIdentityProblem } from './agentIdentity.js';
import { readFresh } from './atomic.js';
import { normaliseEmail } from './email.js';
import { fetchPdfBytes } from './files.js';
import { renderMail, strong } from './mailShell.js';
import {
  pendingRequestRecipients,
  resolveAppOrigin,
  sendSignatureRequestMails,
} from './requestMail.js';
import {
  IMAGE_TYPES,
  certificateSignature,
  embedWidgetsToDoc,
  fieldDatePattern,
  fieldFromWidget,
  formatToday,
  initialsFrom,
  safeTimeZone,
  typedSignaturePng,
} from './stamp.js';

/**
 * An AI agent signing for the person who connected it.
 *
 * Signing links stay for people. An agent gets its own way in: it may only sign
 * the seat that belongs to its own user (the contact on the document bound to
 * that account and that verified address), only when it is that seat's turn,
 * and only with values the server decides: the name, email, company and job
 * title come from the profile, dates are today in the document's format, the
 * signature is the user's name set in a handwriting face with a small "Signed
 * via ChatGPT for Jane Doe" line under it, and the agent supplies just the
 * free-form answers (`fields`). The stamping is the browser's, ported
 * (lib/stamp.js), and the signature goes through the same `signPdf` code as a
 * person's, called as master with an `agent` record for the audit trail.
 *
 * A document the user created is signed straight away and the user is mailed a
 * "signed for you" notice with a way to void it, so a misled model cannot sign
 * quietly. A document someone else sent needs the user's approval first
 * (`allowedBy.via` 'web' or 'chat', recorded with the approval).
 */

/** How the signature was allowed, as recorded in `AuditTrail[].AllowedBy.via`. */
const ALLOWED_VIA = new Set(['own_document', 'web', 'chat']);

/** Base PDF moved under us (a co-signer landed): re-stamp from the new one. */
const MAX_STAMP_ATTEMPTS = 3;

/** Longest free-text answer accepted for one field. */
const MAX_TEXT = 2000;

/** Plain labels for the field types, for messages and approval screens. */
const TYPE_LABELS = {
  signature: 'Signature',
  stamp: 'Stamp',
  initials: 'Initials',
  'text input': 'Text input',
  name: 'Name',
  'job title': 'Job title',
  company: 'Company',
  email: 'Email',
  date: 'Date',
  text: 'Text',
  cells: 'Cells',
  checkbox: 'Checkbox',
  dropdown: 'Dropdown',
  'radio button': 'Radio button',
  image: 'Image',
  draw: 'Drawing',
};

/** Types filled from the signer's own profile. */
const IDENTITY_TYPES = new Set(['name', 'email', 'company', 'job title']);
/** Identity types an agent may not change: they say who signed. */
const LOCKED_IDENTITY = new Set(['name', 'email']);

let ownerMailer = async params => await sendSystemMail({ params });
/** Test seam: replace the transport the "signed for you" notice goes through. */
export function setAgentSignMailTransport(fn) {
  ownerMailer = fn || (async params => await sendSystemMail({ params }));
}

function fail(message, code = Parse.Error.SCRIPT_FAILED) {
  return new Parse.Error(code, message);
}

/* ------------------------------------------------------------------ lookups */

async function loadDocJson(docId) {
  const query = new Parse.Query('contracts_Document');
  query.include('ExtUserPtr');
  query.include('ExtUserPtr.TenantId');
  query.include('CreatedBy');
  query.include('Signers');
  query.include('Placeholders.signerPtr');
  query.notEqualTo('IsArchive', true);
  let obj;
  try {
    obj = await query.get(String(docId || ''), { useMasterKey: true });
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND) {
      throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
    }
    throw err;
  }
  return JSON.parse(JSON.stringify(obj));
}

function contactIdOf(placeholder) {
  return placeholder?.signerObjId || placeholder?.signerPtr?.objectId || '';
}

/** True when the caller created this document. */
export function isOwnDocument(docJson, caller) {
  return isDocumentOwner(docJson, caller?.userId);
}

/**
 * The caller's own seat: the placeholder whose contact is bound to the caller's
 * account (`Signers[i].UserId`) and carries the caller's address. Either alone
 * is not enough: an owner's address book holds contacts of other people bound
 * to their own accounts, and an address can be typed onto any contact.
 *
 * @param {Object} docJson document JSON with `Signers` included.
 * @param {Object} caller from lib/context.js loadCaller.
 * @returns {{contactId: string, placeholder: Object}|null}
 */
export function findAgentSeat(docJson, caller) {
  const email = normaliseEmail(caller?.email);
  if (!caller?.userId || !email) return null;
  const mine = (docJson?.Signers || []).filter(
    c => c?.UserId?.objectId === caller.userId && normaliseEmail(c?.Email) === email
  );
  for (const contact of mine) {
    const placeholder = (docJson?.Placeholders || []).find(
      p => isParticipantBasic(p) && contactIdOf(p) === contact.objectId
    );
    if (placeholder) return { contactId: contact.objectId, placeholder };
  }
  return null;
}

/**
 * Refuse a signature out of turn. Every `SendinOrder` document counts, not only
 * the strict ones: a person ahead in the line is mailed first and an agent must
 * not jump them.
 */
export function assertAgentTurn(docJson, contactId) {
  if (docJson?.SendinOrder !== true) return;
  const placeholders = (docJson?.Placeholders || []).filter(isParticipantBasic);
  const idx = findPlaceholderIndex(placeholders, contactId);
  if (idx <= 0) return;
  const pendingId = findPendingPriorSigner(placeholders, idx, docJson?.AuditTrail);
  if (!pendingId) return;
  const waitingOn = (docJson?.Signers || []).find(s => s?.objectId === pendingId);
  const who = waitingOn?.Name || 'an earlier signer';
  throw fail(
    `It is not your turn yet: this document is signed in order and is waiting on ${who}.`,
    Parse.Error.OPERATION_FORBIDDEN
  );
}

/* ------------------------------------------------------------------ values */

function labelOf(f) {
  return f.hint || TYPE_LABELS[f.type] || f.type;
}

/** `getRegexForType` as the signer page applies it (signer/widgets.ts). */
function builtInPattern(validation) {
  switch (validation?.type) {
    case 'email':
      return {
        re: /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        says: 'a valid email address',
      };
    case 'number':
      return { re: /^\d+(?:\.\d+)?$/, says: 'a number' };
    case 'text':
      return { re: /^[a-zA-Z ]+$/, says: 'letters and spaces only' };
    case 'ssn':
      return {
        re: /^(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/,
        says: 'a social security number (123-45-6789)',
      };
    default:
      // A sender's own pattern is not run on the server: it is arbitrary
      // code-shaped input, and a pathological one would stall the process.
      return null;
  }
}

function matchOption(values, wanted) {
  const needle = String(wanted).trim();
  return (
    values.find(v => String(v).trim() === needle) ??
    values.find(v => String(v).trim().toLowerCase() === needle.toLowerCase())
  );
}

function optionList(values) {
  return values.map(v => `"${v}"`).join(', ');
}

/** Checkbox input (boolean, label, labels or indices) as option indices. */
function checkboxIndices(f, input) {
  const values = f.values.length ? f.values : [''];
  if (typeof input === 'boolean') {
    if (values.length === 1) return { indices: input ? [0] : [] };
    return { problem: `Give the options to tick by label: ${optionList(values)}.` };
  }
  const list = Array.isArray(input) ? input : [input];
  const indices = [];
  for (const item of list) {
    let index = -1;
    if (typeof item === 'number' && Number.isInteger(item)) index = item;
    else if (typeof item === 'string') {
      const hit = matchOption(values, item);
      index = hit === undefined ? -1 : values.indexOf(hit);
    }
    if (index < 0 || index >= values.length) {
      return { problem: `"${item}" is not an option. Options: ${optionList(values)}.` };
    }
    if (!indices.includes(index)) indices.push(index);
  }
  return { indices: indices.sort((a, b) => a - b) };
}

function profileValue(type, caller) {
  if (type === 'name') return String(caller?.name || '').trim();
  if (type === 'email') return normaliseEmail(caller?.email);
  if (type === 'company') return String(caller?.company || caller?.extUser?.Company || '').trim();
  return String(caller?.extUser?.JobTitle || '').trim();
}

/** The fields of one seat, in reading order (page, then top to bottom, then left to right). */
function seatFields(placeholder) {
  const out = [];
  for (const page of placeholder?.placeHolder || []) {
    for (const w of page?.pos || []) {
      const f = fieldFromWidget(w, page?.pageNumber);
      if (f) out.push(f);
    }
  }
  return out.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

function zoneFor(caller, doc) {
  return (
    safeTimeZone(caller?.extUser?.Timezone) ||
    safeTimeZone(doc?.Timezone) ||
    safeTimeZone(doc?.ExtUserPtr?.Timezone) ||
    'UTC'
  );
}

function dateFormatOf(doc) {
  return doc?.DateFormat || doc?.ExtUserPtr?.DateFormat || '';
}

/**
 * Decide every value on the seat, the way the signer page would seed and
 * validate it, with the agent's `fields` as the signer's own edits.
 *
 * @returns {{values: Object[], missing: Object[], stamp: Object[]}} `stamp` is
 *   the fields to draw; signature and initials carry a marker the caller swaps
 *   for the rendered image.
 */
function decideValues(caller, doc, seat, input) {
  const fields = seatFields(seat.placeholder);
  const byRef = new Map();
  for (const f of fields) {
    byRef.set(String(f.key), f);
    if (f.name && !byRef.has(String(f.name))) byRef.set(String(f.name), f);
  }
  const given = new Map();
  for (const [ref, value] of Object.entries(input || {})) {
    const f = byRef.get(String(ref));
    if (!f) {
      throw fail(
        `Field "${ref}" is not one of your fields on this document.`,
        Parse.Error.VALIDATION_ERROR
      );
    }
    if (value !== undefined && value !== null) given.set(f, value);
  }

  const name = profileValue('name', caller);
  const docFormat = dateFormatOf(doc);
  const timeZone = zoneFor(caller, doc);
  const values = [];
  const missing = [];
  const stamp = [];
  const problem = (f, reason) =>
    missing.push({ key: f.key, type: f.type, label: labelOf(f), reason });

  for (const f of fields) {
    const has = given.has(f);
    const raw = given.get(f);
    const row = { key: f.key, type: f.type, label: labelOf(f), required: f.required, page: f.page };

    if (has && f.readOnly) {
      problem(f, 'This field is read-only.');
      continue;
    }

    if (f.type === 'signature' || f.type === 'initials') {
      if (has) {
        problem(
          f,
          'Signatures and initials are drawn from your profile name; leave this field out.'
        );
        continue;
      }
      const text = f.type === 'signature' ? name : initialsFrom(name);
      values.push({ ...row, value: text });
      stamp.push({ ...f, response: f.type });
      continue;
    }

    if (IMAGE_TYPES.has(f.type)) {
      if (has) problem(f, 'An agent cannot add an image, stamp or drawing.');
      else if (f.required) {
        problem(
          f,
          'This needs an image, stamp or drawing, which an agent cannot add. Sign in DocuStamp instead.'
        );
      } else values.push({ ...row, value: null });
      continue;
    }

    if (f.type === 'checkbox') {
      let indices = Array.isArray(f.storedResponse)
        ? f.storedResponse
        : Array.isArray(f.defaultValue)
          ? f.defaultValue
          : [];
      if (has) {
        const parsed = checkboxIndices(f, raw);
        if (parsed.problem) {
          problem(f, parsed.problem);
          continue;
        }
        indices = parsed.indices;
      }
      const chosen = indices.length;
      const min = f.validation?.minRequiredCount;
      const max = f.validation?.maxRequiredCount;
      if (!f.readOnly) {
        if (typeof min === 'number' && chosen < min) {
          problem(f, `Tick at least ${min}.`);
          continue;
        }
        if (typeof max === 'number' && max > 0 && chosen > max) {
          problem(f, `Tick at most ${max}.`);
          continue;
        }
        if (f.required && typeof min !== 'number' && chosen === 0) {
          problem(f, 'Tick at least one option.');
          continue;
        }
      }
      const labels = f.values.length ? f.values : [''];
      values.push({ ...row, value: indices.map(i => labels[i] || 'Checked') });
      stamp.push({ ...f, response: indices });
      continue;
    }

    // Everything else is one string.
    let value;
    if (IDENTITY_TYPES.has(f.type)) {
      const fallback = typeof f.defaultValue === 'string' ? f.defaultValue : '';
      value =
        typeof f.storedResponse === 'string'
          ? f.storedResponse
          : profileValue(f.type, caller) || fallback;
      if (has) {
        const asked = String(raw).trim();
        const same =
          f.type === 'email' ? normaliseEmail(asked) === normaliseEmail(value) : asked === value;
        if (LOCKED_IDENTITY.has(f.type) && !same) {
          problem(
            f,
            `Your ${f.type} comes from your DocuStamp profile and cannot be changed here.`
          );
          continue;
        }
        value = asked;
      }
    } else if (f.type === 'date') {
      value =
        typeof f.storedResponse === 'string'
          ? f.storedResponse
          : formatToday(fieldDatePattern(f, docFormat), timeZone);
      if (has) {
        if (typeof raw === 'object') {
          problem(f, 'Give this date as text, or "today".');
          continue;
        }
        value = String(raw).trim();
      }
      if (value === 'today') value = formatToday(fieldDatePattern(f, docFormat), timeZone);
    } else {
      const stored = f.storedResponse;
      value =
        typeof stored === 'string' || typeof stored === 'number'
          ? String(stored)
          : typeof f.defaultValue === 'string'
            ? f.defaultValue
            : '';
      if (has) {
        if (typeof raw === 'object') {
          problem(f, 'Give this field a text value.');
          continue;
        }
        value = String(raw);
      }
    }

    if (value.length > MAX_TEXT) {
      problem(f, `Keep this under ${MAX_TEXT} characters.`);
      continue;
    }
    if ((f.type === 'radio button' || f.type === 'dropdown') && value.trim() && f.values.length) {
      const hit = matchOption(f.values, value);
      if (hit === undefined) {
        problem(f, `Choose one of: ${optionList(f.values)}.`);
        continue;
      }
      value = String(hit);
    }
    const filled = value.trim().length > 0;
    if (!f.readOnly) {
      if (f.required && !filled) {
        problem(f, 'A value is required.');
        continue;
      }
      // The name and email are the verified profile's own; the email pattern
      // would refuse a perfectly good "jane+work@" address.
      const pattern = filled && !LOCKED_IDENTITY.has(f.type) ? builtInPattern(f.validation) : null;
      if (pattern && !pattern.re.test(value)) {
        problem(f, `This must be ${pattern.says}.`);
        continue;
      }
      if (f.type === 'cells' && value.length > f.cellCount) {
        problem(f, `This fits at most ${f.cellCount} characters.`);
        continue;
      }
    }
    values.push({ ...row, value: filled ? value : '' });
    // The signer page stamps answered fields, plus every checkbox and radio
    // group (drawn as empty boxes when nothing is picked).
    if (filled) stamp.push({ ...f, response: value });
    else if (f.type === 'radio button') stamp.push({ ...f, response: '' });
  }

  return { values, missing, stamp, fieldCount: fields.length };
}

/* ------------------------------------------------------------------ prepare */

/**
 * Everything an agent signature would put on the document, without writing
 * anything: the seat, every value it would fill, and what is missing.
 *
 * Refuses (with a plain message) a document the caller cannot see, one with no
 * signers, a draft, one that can no longer be signed, and a document where the
 * caller has no seat.
 *
 * `allowDraft` checks a draft the caller owns as if it were being sent now
 * ("sign for me and send" refuses missing values before anything goes out).
 * Its stored deadline is ignored: sending sets a new one.
 *
 * @param {Object} caller from lib/context.js loadCaller.
 * @param {string} docId
 * @param {{fields?: Object, allowDraft?: boolean}} [opts] `fields` are the
 *   agent's answers, keyed by field key.
 * @returns {Promise<{doc: Object, seat: {contactId: string, role: string},
 *   values: Object[], missing: Object[]}>}
 */
export async function prepareAgentSignature(caller, docId, { fields = {}, allowDraft = false } = {}) {
  const prepared = await prepare(caller, docId, fields, { allowDraft });
  return {
    doc: prepared.doc,
    seat: prepared.seatInfo,
    values: prepared.values,
    missing: prepared.missing,
  };
}

async function prepare(caller, docId, input, { allowDraft = false } = {}) {
  if (
    input !== undefined &&
    input !== null &&
    (typeof input !== 'object' || Array.isArray(input))
  ) {
    throw fail('`fields` must be an object keyed by field key.', Parse.Error.VALIDATION_ERROR);
  }
  const doc = await loadDocJson(docId);
  const own = isOwnDocument(doc, caller);
  const seat = findAgentSeat(doc, caller);
  if (!own && !seat) throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
  if (!(doc.Signers?.length > 0)) {
    throw fail(
      'This document has no signers. An agent cannot sign a document you sign by yourself yet; open it in DocuStamp.'
    );
  }
  const draft = !doc.SignedUrl && !doc.DocSentAt;
  if (draft && !(allowDraft && own)) {
    throw fail('This document has not been sent yet. Send it first, then sign your part.');
  }
  if (!seat) {
    throw fail(
      'You are not a signer on this document, so your agent has nothing to sign.',
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  assertSignable(draft ? { ...doc, ExpiryDate: undefined } : doc, seat.contactId, {
    kind: 'signer',
  });
  if (!profileValue('name', caller)) {
    throw fail('Add your name to your DocuStamp profile first: it is what your signature shows.');
  }
  const decided = decideValues(caller, doc, seat, input);
  if (!decided.fieldCount) {
    throw fail('There are no fields for you on this document.');
  }
  return {
    doc,
    own,
    seat,
    seatInfo: { contactId: seat.contactId, role: seat.placeholder?.Role || '' },
    ...decided,
  };
}

/* ------------------------------------------------------------------ sign */

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value?.iso || value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function allowedByRecord(caller, allowedBy, own) {
  const via = allowedBy?.via || (own ? 'own_document' : '');
  if (!via) {
    throw fail(
      'This document was sent to you by someone else, so you have to approve the signature first.',
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  if (!ALLOWED_VIA.has(via)) throw fail(`Unknown approval "${via}".`, Parse.Error.VALIDATION_ERROR);
  if (via === 'own_document' && !own) {
    throw fail(
      'Only documents you created are signed without your approval.',
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  const record = {
    via,
    name: String(allowedBy?.name || caller?.name || ''),
    email: normaliseEmail(allowedBy?.email || caller?.email),
    at: toDate(allowedBy?.at) || new Date(),
    signingEnabledAt: toDate(allowedBy?.signingEnabledAt ?? caller?.oauth?.signingEnabledAt),
  };
  if (allowedBy?.approvalId) record.approvalId = String(allowedBy.approvalId);
  return record;
}

/** A stored agent identity in the audit trail's shape. */
function recordedAgent(agent) {
  return {
    kind: agent?.kind === 'oauth' ? 'oauth' : 'api_token',
    clientId: String(agent?.clientId || ''),
    name: String(agent?.name || '').trim() || 'AI app',
    host: String(agent?.host || '').trim(),
  };
}

/** The images every signature and initials field gets, rendered once. */
async function signatureImages(name) {
  const signature = await typedSignaturePng(name);
  const initials = await typedSignaturePng(initialsFrom(name));
  return { signature, initials, certificate: await certificateSignature(signature) };
}

/** Who still has to sign, in order. */
function outstanding(doc) {
  return pendingRequestRecipients({ ...doc, SendinOrder: false });
}

function waitingLine(pending) {
  if (!pending.length) return 'Everyone has signed, so the document is complete.';
  const names = pending.map(p => p.name || p.email);
  return names.length === 1
    ? `It now waits on ${names[0]}.`
    : `It now waits on ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
}

function signedForYouHtml({ doc, agent, name, pending, url }) {
  const done = !pending.length;
  return renderMail({
    title: `${agent.name} signed for you`,
    preheader: `${agent.name} signed ${doc.Name} for you`,
    greeting: name ? `Hi ${name},` : '',
    paragraphs: [
      `${strong(agentLabel(agent))} signed ${strong(doc.Name)} for you, as ${strong(name)}.`,
      done
        ? 'Everyone has signed, so the document is complete.'
        : `${waitingLine(pending)} If you did not ask for this, void the document now.`,
    ],
    details: [
      { label: 'Document', value: doc.Name },
      { label: 'Signed via', value: agentLabel(agent) },
      ...(done
        ? []
        : [{ label: 'Waiting on', value: pending.map(p => p.name || p.email).join(', ') }]),
    ],
    cta: { url, label: done ? 'Review document' : 'Review or void' },
  });
}

async function mailOwner(caller, doc, agent, pending) {
  const origin = resolveAppOrigin(caller?.publicUrl);
  const recipient = normaliseEmail(caller?.email) || normaliseEmail(doc?.ExtUserPtr?.Email);
  if (!recipient) return;
  try {
    const res = await ownerMailer({
      extUserId: doc?.ExtUserPtr?.objectId,
      from: appName,
      recipient,
      subject: `${agent.name} signed "${doc.Name}" for you`,
      html: signedForYouHtml({
        doc,
        agent,
        name: caller?.name || '',
        pending,
        url: `${origin}/documents/${doc.objectId}`,
      }),
    });
    if (res?.status !== 'success') {
      console.log('agentSign: owner notice not sent', res?.reason || res?.message || res?.status);
    }
  } catch (err) {
    console.log('agentSign: owner notice not sent', err?.message || err);
  }
}

async function mailNextSigner(caller, doc, next) {
  try {
    const res = await sendSignatureRequestMails({
      doc,
      publicUrl: caller?.publicUrl,
      only: [next.email],
    });
    if (!res.sent.length) {
      console.log('agentSign: next signer not mailed', res.failed[0]?.reason || 'mail_failed');
    }
  } catch (err) {
    console.log('agentSign: next signer not mailed', err?.message || err);
  }
}

/**
 * Sign the caller's seat on `docId` as their agent.
 *
 * @param {Object} caller from loadCaller, with `oauth` for a connected app and
 *   `ip` for the audit trail.
 * @param {string} docId
 * @param {Object} [opts]
 * @param {Object} [opts.fields] the agent's answers, keyed by field key (see get_draft).
 * @param {Object} [opts.allowedBy] how the signature was allowed: `{via:
 *   'own_document'|'web'|'chat', name?, email?, at?, signingEnabledAt?, approvalId?}`.
 *   Defaults to `own_document` on the caller's own document.
 * @param {boolean} [opts.notifyOwner] mail the "signed for you" notice (own documents).
 * @param {Object} [opts.agent] the agent to record, `{kind, clientId, name, host}`:
 *   an approved request signs as the agent that asked, even when the user
 *   approved in a DocuStamp session. Defaults to `agentIdentity(caller)`.
 * @returns {Promise<{status: 'signed', documentId: string, completed: boolean,
 *   signer: {name: string, email: string, contactId: string},
 *   nextSigner: {name: string, email: string}|null}>}
 */
export async function agentSignDocument(caller, docId, opts = {}) {
  const { fields = {}, allowedBy, notifyOwner = true, agent: asAgent } = opts || {};
  const identityProblem = verifiedIdentityProblem(caller);
  if (identityProblem) throw fail(identityProblem, Parse.Error.OPERATION_FORBIDDEN);

  const prepared = await prepare(caller, docId, fields);
  const { doc, own, seat } = prepared;
  assertAgentTurn(doc, seat.contactId);
  if (prepared.missing.length) {
    const list = prepared.missing.map(m => `${m.label} (field ${m.key}): ${m.reason}`).join(' ');
    throw fail(`Your agent cannot sign yet. ${list}`, Parse.Error.VALIDATION_ERROR);
  }

  const agent = asAgent ? recordedAgent(asAgent) : agentIdentity(caller);
  const allowed = allowedByRecord(caller, allowedBy, own);
  const contact = (doc.Signers || []).find(s => s?.objectId === seat.contactId) || {};
  const name = String(caller.name || '').trim();
  const note = `Signed via ${agent.name} for ${name}`;
  const images = await signatureImages(name);
  const stampFields = prepared.stamp.map(f => {
    if (f.response === 'signature') return { ...f, response: images.signature, note };
    if (f.response === 'initials') return { ...f, response: images.initials };
    return f;
  });
  const record = {
    Method: 'agent',
    Agent: agent,
    OnBehalfOf: { name, email: normaliseEmail(caller.email), userId: caller.userId },
    AllowedBy: allowed,
  };

  let signed = false;
  // One attempt at a time on purpose: each one stamps the file the last one lost to.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 1; attempt <= MAX_STAMP_ATTEMPTS && !signed; attempt++) {
    // The stored url, not a query result: the afterFind trigger presigns it,
    // and `signPdf` compares against what is stored.
    const fresh = await readFresh('contracts_Document', doc.objectId, ['SignedUrl', 'URL']);
    const baseUrl = fresh?.SignedUrl || fresh?.URL;
    if (!baseUrl) throw fail('This document has no file to sign.');
    const pdfBytes = await fetchPdfBytes(baseUrl);
    const stamped = await embedWidgetsToDoc({
      pdfBytes,
      fields: stampFields,
      dateFormat: dateFormatOf(doc),
      timeZone: zoneFor(caller, doc),
    });
    try {
      await PDF({
        master: true,
        params: {
          docId: doc.objectId,
          userId: seat.contactId,
          pdfFile: Buffer.from(stamped).toString('base64'),
          signature: images.certificate.toString('base64'),
          agent: record,
          baseUrl,
        },
        headers: { 'x-real-ip': caller.ip || '', public_url: caller.publicUrl || '' },
      });
      signed = true;
    } catch (err) {
      if (!isBaseChangedError(err)) throw err;
      if (attempt === MAX_STAMP_ATTEMPTS) {
        throw fail('Someone else is signing this document right now. Please try again.');
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  const after = await loadDocJson(doc.objectId);
  const completed = after.IsCompleted === true;
  const pending = completed ? [] : outstanding(after);
  const next = pending[0] || null;
  // The signer page mails the next person on a sequential document itself
  // (sendmailv3 'next_signer'); with no browser, the server does.
  if (after.SendinOrder === true && next?.email) await mailNextSigner(caller, after, next);
  if (allowed.via === 'own_document' && notifyOwner !== false) {
    await mailOwner(caller, after, agent, pending);
  }

  return {
    status: 'signed',
    documentId: doc.objectId,
    completed,
    signer: {
      name: contact.Name || name,
      email: normaliseEmail(contact.Email || caller.email),
      contactId: seat.contactId,
    },
    // Another sender's co-signers are not the caller's business beyond a name.
    nextSigner: next ? { name: next.name, email: own ? next.email : '' } : null,
  };
}
