/**
 * Documents other people sent to the caller, for an agent acting for them.
 *
 * This is the server side of the web inbox's "needs you" report (`4Hhwbp482K`
 * in parsefunction/reportsJson.js), with the "is it my turn" rule the web app
 * computes in the browser (apps/web/src/features/inbox/api.ts `toDocument`)
 * done here instead: an agent has no browser to do it for it.
 *
 * A participant is a contact in the document's `Signers` whose `UserId` is the
 * caller's `_User`, with a seat (a non-prefill `Placeholders` group) bound to
 * that contact. Queries run with the master key, so that rule is the access
 * check, and everything that fails it (a stranger, an archived row, a draft
 * nobody was sent) reads as "Document not found." rather than "forbidden", so a
 * caller cannot probe which ids exist.
 *
 * What a participant gets is what the signing page would show them and no more:
 * the title, who sent it, every signer's name and progress, their own seat and
 * fields, and a short-lived link to the current PDF. Never another signer's
 * email, a signing link or token, the owner's note, webhooks or settings.
 */
import { findPendingPriorSigner, isParticipantBasic } from '../../utils/workflowUtils.js';
import { userPointer } from './context.js';
import { documentStatus, loadDoc } from './documents.js';
import { pageSizes } from './drafts.js';
import { API_URL_TTL, resolveFileUrl } from './files.js';
import { presentDefaultValue } from './widgets.js';

export const INBOX_STATUSES = Object.freeze(['needs_you', 'waiting', 'completed', 'all']);

/**
 * Open documents read per call when the bucket needs the turn rule, which the
 * database cannot evaluate (it depends on the audit trail and the seat order).
 * The page is cut from these after filtering.
 */
const OPEN_SCAN_LIMIT = 500;

/** Address-book rows that may point at one account (one per sender who added them). */
const MAX_CONTACTS = 1000;

/**
 * Columns the list reads. `URL` and `CertificateUrl` are left out, so the
 * afterFind trigger has nothing to presign for them; `SignedUrl` stays because
 * it is what marks a row as sent.
 */
const LIST_KEYS = [
  'Name',
  'SignedUrl',
  'DocSentAt',
  'ExpiryDate',
  'IsCompleted',
  'IsDeclined',
  'IsVoided',
  'SendinOrder',
  'Signers',
  'Placeholders',
  'AuditTrail',
  'ExtUserPtr',
  'DeclineBy',
  'DeclineByContact',
  'updatedAt',
];

const LIST_TYPES = new Set(['checkbox', 'radio button', 'dropdown']);

function notFound() {
  return new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isoOf(value) {
  if (!value) return undefined;
  const raw = typeof value === 'string' ? value : value.iso || value;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

/**
 * A display name that is never an address. Contacts created from a bare email
 * can carry the address as their name, and other signers' addresses are not
 * the caller's to see, so only the part before the `@` is kept.
 */
function safeName(name) {
  const text = String(name || '').trim();
  return text.includes('@') ? text.split('@')[0] : text;
}

function contactIdOf(group) {
  return group?.signerObjId || group?.signerPtr?.objectId || '';
}

/** Contacts in `Signers` (included) that are the caller's own account. */
function myContactIds(d, caller) {
  const ids = new Set();
  if (!caller?.userId) return ids;
  for (const s of d?.Signers || []) {
    if (s?.objectId && s?.UserId?.objectId === caller.userId) ids.add(s.objectId);
  }
  return ids;
}

function signedContactIds(d) {
  const ids = new Set();
  for (const entry of d?.AuditTrail || []) {
    if (entry?.Activity === 'Signed' && entry?.UserPtr?.objectId) ids.add(entry.UserPtr.objectId);
  }
  return ids;
}

function hasDeclined(d, contactId, contact) {
  if (!contactId) return false;
  const inTrail = (d?.AuditTrail || []).some(
    e => e?.Activity === 'Declined' && e?.UserPtr?.objectId === contactId
  );
  if (inTrail) return true;
  if (!d?.IsDeclined) return false;
  if (d?.DeclineByContact?.objectId === contactId) return true;
  const userId = contact?.UserId?.objectId;
  return Boolean(userId && d?.DeclineBy?.objectId === userId);
}

/**
 * The caller's seat on a document, or null when they have none.
 *
 * `index` is the group's position in the full `Placeholders` array (prefill
 * groups included), which is what `findPendingPriorSigner` counts in. When the
 * same person holds two seats, the first one they still have to sign wins.
 *
 * @param {Object} d plain document JSON with `Signers` included.
 * @param {{userId: string}} caller
 * @returns {{index: number, contactId: string, role: string, signed: boolean, group: Object}|null}
 */
export function participantSeat(d, caller) {
  const mine = myContactIds(d, caller);
  if (!mine.size) return null;
  const signed = signedContactIds(d);
  const seats = [];
  let order = 0;
  (Array.isArray(d?.Placeholders) ? d.Placeholders : []).forEach((group, index) => {
    if (!isParticipantBasic(group)) return;
    order += 1;
    const contactId = contactIdOf(group);
    if (!contactId || !mine.has(contactId)) return;
    seats.push({
      index,
      contactId,
      role: group?.Role || `Role ${order}`,
      signed: signed.has(contactId),
      group,
    });
  });
  if (!seats.length) return null;
  return seats.find(s => !s.signed) || seats[0];
}

/** On a sequential document, every earlier seat must have signed first. */
function isMyTurn(d, seat) {
  if (d?.SendinOrder !== true) return true;
  return findPendingPriorSigner(d.Placeholders, seat.index, d.AuditTrail) === null;
}

/**
 * Where the caller stands on this document:
 *  - `signed`: their seat carries a `Signed` audit entry;
 *  - `declined`: the document was declined or voided before they signed, so
 *    nothing more is asked of them;
 *  - `needs_you`: the document is live and it is their turn;
 *  - `waiting`: anything else (an earlier signer first, or the document
 *    expired; the document `status` says which).
 */
function myStatusFor(d, seat) {
  if (seat.signed) return 'signed';
  if (d?.IsDeclined) return 'declined';
  if (documentStatus(d) === 'in_progress' && isMyTurn(d, seat)) return 'needs_you';
  return 'waiting';
}

/** Every bound seat with a name and progress only: no address, no contact id. */
function signersJson(d) {
  const signed = signedContactIds(d);
  const out = [];
  let order = 0;
  for (const group of d?.Placeholders || []) {
    if (!isParticipantBasic(group)) continue;
    order += 1;
    const contactId = contactIdOf(group);
    if (!contactId) continue;
    const contact = (d?.Signers || []).find(s => s?.objectId === contactId);
    out.push({
      name: safeName(contact?.Name || group?.Name),
      role: group?.Role || `Role ${order}`,
      status: signed.has(contactId)
        ? 'signed'
        : hasDeclined(d, contactId, contact)
          ? 'declined'
          : 'pending',
    });
  }
  return out;
}

/** The owner as the recipient sees them in the request mail. */
function senderOf(d) {
  const ext = d?.ExtUserPtr?.__type === 'Pointer' ? null : d?.ExtUserPtr;
  const user = d?.CreatedBy?.__type === 'Pointer' ? null : d?.CreatedBy;
  return {
    name: ext?.Name || user?.name || '',
    company: ext?.Company || '',
    email: String(ext?.Email || user?.email || '').toLowerCase(),
  };
}

function inboxItem(d, seat) {
  return {
    id: d.objectId,
    title: d.Name || '',
    status: documentStatus(d),
    sender: senderOf(d),
    sentAt: isoOf(d.DocSentAt),
    expiresAt: isoOf(d.ExpiryDate),
    myStatus: myStatusFor(d, seat),
    myRole: seat.role,
    signers: signersJson(d),
  };
}

function fieldLabel(w) {
  const hint = String(w?.options?.hint || '').trim();
  if (hint) return hint;
  const type = String(w?.type || 'field');
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * The caller's own fields, keyed exactly as `get_draft` keys them (the widget
 * `key`), so the same keys can be handed back to `sign_document { fields }`.
 */
function seatFields(group) {
  const out = [];
  for (const page of group?.placeHolder || []) {
    for (const w of page?.pos || []) {
      const o = w?.options || {};
      const field = {
        key: w?.key,
        type: w?.type,
        label: fieldLabel(w),
        required: o.status !== 'optional',
        page: Number(page?.pageNumber) || 1,
      };
      if (LIST_TYPES.has(w?.type) && Array.isArray(o.values)) field.options = o.values;
      const dv = o.defaultValue;
      if (dv !== undefined && dv !== null && dv !== '' && !(Array.isArray(dv) && !dv.length)) {
        field.defaultValue = presentDefaultValue(w?.type, o.values, dv);
      }
      if (o.isReadOnly === true) field.readOnly = true;
      if (w?.type === 'date' && o.validation?.format) field.dateFormat = o.validation.format;
      out.push(field);
    }
  }
  return out.sort((a, b) => a.page - b.page);
}

/**
 * Pages in the PDF: the cached geometry when it belongs to this file, else
 * read from the file (without writing the cache to someone else's document),
 * else the highest page any field sits on.
 */
async function pageCountOf(d) {
  const bare = url => String(url || '').split('?')[0];
  const cache = d?.PageSizes;
  if (
    cache &&
    Array.isArray(cache.pages) &&
    cache.pages.length &&
    bare(cache.url) === bare(d.URL)
  ) {
    return cache.pages.length;
  }
  try {
    return (await pageSizes(d.URL)).length;
  } catch (err) {
    console.log('inbox: could not count pages', err?.message);
    const pages = (d?.Placeholders || [])
      .flatMap(g => g?.placeHolder || [])
      .map(p => Number(p?.pageNumber) || 0);
    return pages.length ? Math.max(...pages) : undefined;
  }
}

/** Pointers to every address-book row that is the caller's account. */
async function myContactPointers(caller) {
  const query = new Parse.Query('contracts_Contactbook');
  query.equalTo('UserId', userPointer(caller));
  query.select('objectId');
  query.limit(MAX_CONTACTS);
  const rows = await query.find({ useMasterKey: true });
  return rows.map(r => r.toPointer());
}

/**
 * Documents sent to the caller.
 *
 * Buckets:
 *  - `needs_you` (default): live, not expired, and it is the caller's turn;
 *  - `waiting`: live, and the caller has signed or an earlier signer goes first;
 *  - `completed`: every signer is done;
 *  - `all`: everything sent to the caller, declined and expired included.
 *
 * A document the caller owns shows up only when they are also one of its
 * signers. Drafts never show up: nobody has been sent them yet.
 *
 * @param {import('./context.js').Caller} caller
 * @param {{status?: string, limit?: number, skip?: number}} [opts]
 * @returns {Promise<{documents: Array<Object>}>}
 */
export async function listInbox(caller, { status = 'needs_you', limit = 50, skip = 0 } = {}) {
  const bucket = status || 'needs_you';
  if (!INBOX_STATUSES.includes(bucket)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `status must be one of ${INBOX_STATUSES.join(', ')}.`
    );
  }
  const take = clampInt(limit, 1, 200, 50);
  const from = clampInt(skip, 0, 100000, 0);
  const contacts = await myContactPointers(caller);
  if (!contacts.length) return { documents: [] };

  const doc = () => new Parse.Query('contracts_Document');
  const base = doc();
  base.containedIn('Signers', contacts);
  base.notEqualTo('Type', 'Folder');
  base.notEqualTo('IsArchive', true);
  base.exists('SignedUrl');

  const live = bucket === 'needs_you' || bucket === 'waiting';
  let query = base;
  if (live) {
    base.notEqualTo('IsCompleted', true);
    base.notEqualTo('IsDeclined', true);
    const notExpired = Parse.Query.or(
      doc().doesNotExist('ExpiryDate'),
      doc().greaterThan('ExpiryDate', new Date())
    );
    query = Parse.Query.and(base, notExpired);
  } else if (bucket === 'completed') {
    base.equalTo('IsCompleted', true);
    base.notEqualTo('IsDeclined', true);
  }
  query.include('Signers');
  query.include('ExtUserPtr');
  query.select(...LIST_KEYS);
  query.descending('updatedAt');
  if (live) {
    query.limit(OPEN_SCAN_LIMIT);
  } else {
    query.limit(take);
    query.skip(from);
  }

  const rows = await query.find({ useMasterKey: true });
  const documents = [];
  for (const row of rows) {
    const d = JSON.parse(JSON.stringify(row));
    const seat = participantSeat(d, caller);
    if (!seat) continue;
    const item = inboxItem(d, seat);
    if (bucket === 'needs_you' && item.myStatus !== 'needs_you') continue;
    if (bucket === 'waiting' && item.myStatus === 'needs_you') continue;
    documents.push(item);
  }
  return { documents: live ? documents.slice(from, from + take) : documents };
}

/**
 * A sent document the caller is a participant on, with their seat.
 * Shared with the participant page preview (lib/preview.js).
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @returns {Promise<{d: Object, seat: Object}>} plain document JSON and the seat.
 */
export async function loadParticipantDocument(caller, docId) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  if (d.Type === 'Folder' || !d.SignedUrl) throw notFound();
  const seat = participantSeat(d, caller);
  if (!seat) throw notFound();
  return { d, seat };
}

/**
 * One document sent to the caller, as its recipient sees it: enough for an
 * agent to read it, review it and know what signing will ask for.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @returns {Promise<Object>}
 */
export async function getParticipantDocument(caller, docId) {
  const { d, seat } = await loadParticipantDocument(caller, docId);
  const item = inboxItem(d, seat);
  return {
    id: item.id,
    title: item.title,
    role: 'signer',
    status: item.status,
    sender: item.sender,
    sentAt: item.sentAt,
    expiresAt: item.expiresAt,
    myStatus: item.myStatus,
    mySeat: { contactId: seat.contactId, role: seat.role },
    myFields: seatFields(seat.group),
    signers: item.signers,
    sendInOrder: d.SendinOrder === true,
    pageCount: await pageCountOf(d),
    urls: {
      file: await resolveFileUrl(d.SignedUrl || d.URL, { ttl: API_URL_TTL }),
      app: caller.publicUrl ? `${caller.publicUrl}/inbox` : undefined,
    },
  };
}
