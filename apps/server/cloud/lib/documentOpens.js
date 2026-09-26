import { assertOwner, loadDoc } from './documents.js';

/**
 * Open tracking: how many times, and when, each signer opened a document.
 *
 * The audit trail (`contracts_Document.AuditTrail`) keeps one entry per signer
 * and every downstream rule keys off it (completion counting, strict order,
 * reminders, the status the API reports), so it records that a signer opened
 * the document, never how often. Two things record the "how often" instead:
 *
 *  - `OpenStats` on the document row: `{ [contactId]: { count, firstAt, lastAt } }`.
 *    Small, written in the same conditional write as the audit entry
 *    (parsefunction/triggerEvent.js), and travels with every document read the
 *    inbox and the document page already make, so the counts cost no extra query.
 *  - `contracts_DocumentOpen`: one row per open (who, when, from which address
 *    and browser), for the full list on the document page and in the API.
 *    Master-key only: the REST `classes/` endpoint must never expose it.
 *
 * Only signing-page opens count. Email opens are deliberately not tracked:
 * mail clients prefetch or block images, so a pixel would be wrong both ways.
 */

export const OPEN_CLASS = 'contracts_DocumentOpen';

/** Rows one call may read; the summary is on the document row regardless. */
const DEFAULT_LIST = 50;
const MAX_LIST = 200;
const MAX_USER_AGENT = 300;

const LOCKED_CLP = Object.freeze({
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

function isLockedDown(clp) {
  const ops = ['get', 'find', 'count', 'create', 'update', 'delete', 'addField'];
  return ops.every(op => Object.keys(clp?.[op] || {}).length === 0);
}

let openSchemaReady = false;

/** Create the class on first use, and lock it down if an older build left it open. */
export async function ensureOpenSchema() {
  if (openSchemaReady) return;
  const schema = new Parse.Schema(OPEN_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (existing) {
    if (!isLockedDown(existing.classLevelPermissions)) {
      schema.setCLP(LOCKED_CLP);
      await schema.update();
    }
    openSchemaReady = true;
    return;
  }
  schema.addPointer('Document', 'contracts_Document');
  schema.addPointer('Contact', 'contracts_Contactbook');
  schema.addPointer('Owner', 'contracts_Users');
  schema.addString('ContactId');
  schema.addString('Email');
  schema.addString('Name');
  schema.addString('IpAddress');
  schema.addString('UserAgent');
  schema.addDate('OpenedAt');
  schema.setCLP(LOCKED_CLP);
  try {
    await schema.save();
  } catch (err) {
    if (!/already exists/i.test(err?.message || '')) throw err;
  }
  openSchemaReady = true;
}

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

function isoOf(value) {
  if (!value) return undefined;
  const raw = value instanceof Date ? value : value?.iso || value;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

/**
 * The per-contact aggregate after one more open. Pure; the caller writes it back.
 *
 * @param {Object|undefined} stats current `OpenStats` (not mutated)
 * @param {string} contactId who opened
 * @param {Date} [at] when
 * @returns {Object} the new `OpenStats`
 */
export function bumpOpenStats(stats, contactId, at = new Date()) {
  const iso = at.toISOString();
  const current = stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
  const previous =
    current[contactId] && typeof current[contactId] === 'object' ? current[contactId] : {};
  return {
    ...current,
    [contactId]: {
      count: (Number(previous.count) || 0) + 1,
      firstAt: previous.firstAt || iso,
      lastAt: iso,
    },
  };
}

/** The signer a contactId names, from the document's own records. */
function signerFor(d, contactId) {
  const contact = (d?.Signers || []).find(s => s?.objectId === contactId);
  const group = (d?.Placeholders || []).find(
    g => (g?.signerObjId || g?.signerPtr?.objectId) === contactId
  );
  return {
    contactId,
    name: contact?.Name || group?.signerPtr?.Name || group?.Name || '',
    email: (contact?.Email || group?.signerPtr?.Email || group?.email || '').toLowerCase(),
    role: group?.Role || undefined,
  };
}

/**
 * Per-signer counts from the document row, most recently opened first.
 *
 * @param {Object} d document as JSON (Signers and Placeholders included when available)
 * @returns {{total: number, bySigner: Array}}
 */
export function openSummary(d) {
  const stats = d?.OpenStats && typeof d.OpenStats === 'object' ? d.OpenStats : {};
  const bySigner = Object.entries(stats)
    .filter(([, s]) => s && typeof s === 'object')
    .map(([contactId, s]) => ({
      ...signerFor(d, contactId),
      count: Number(s.count) || 0,
      firstAt: isoOf(s.firstAt),
      lastAt: isoOf(s.lastAt),
    }))
    .sort((a, b) => (Date.parse(b.lastAt || 0) || 0) - (Date.parse(a.lastAt || 0) || 0));
  return {
    total: bySigner.reduce((n, s) => n + s.count, 0),
    bySigner,
  };
}

/**
 * Append one open to the log. Never throws into the signing flow: a failed log
 * row must not stop a signer from opening the document (the aggregate on the
 * document row is written first and separately).
 *
 * @param {{doc: Object, contactId: string, ip?: string, userAgent?: string, at?: Date}} input
 *   `doc` is the document as JSON (Signers included when available).
 */
export async function recordOpen({ doc, contactId, ip = '', userAgent = '', at = new Date() }) {
  try {
    await ensureOpenSchema();
    const who = signerFor(doc, contactId);
    const row = new Parse.Object(OPEN_CLASS);
    row.set('Document', pointer('contracts_Document', doc.objectId));
    row.set('Contact', pointer('contracts_Contactbook', contactId));
    if (doc?.ExtUserPtr?.objectId)
      row.set('Owner', pointer('contracts_Users', doc.ExtUserPtr.objectId));
    row.set('ContactId', contactId);
    row.set('Email', who.email);
    row.set('Name', who.name);
    row.set('IpAddress', String(ip || ''));
    row.set('UserAgent', String(userAgent || '').slice(0, MAX_USER_AGENT));
    row.set('OpenedAt', at);
    const acl = new Parse.ACL();
    acl.setPublicReadAccess(false);
    acl.setPublicWriteAccess(false);
    row.setACL(acl);
    await row.save(null, { useMasterKey: true });
    return true;
  } catch (err) {
    console.error('documentOpens: could not log an open', doc?.objectId, err?.message || err);
    return false;
  }
}

function openJson(row) {
  const j = typeof row.toJSON === 'function' ? row.toJSON() : row;
  return {
    objectId: j.objectId,
    at: isoOf(j.OpenedAt) || isoOf(j.createdAt),
    contactId: j.ContactId || j.Contact?.objectId || '',
    name: j.Name || '',
    email: (j.Email || '').toLowerCase(),
    ip: j.IpAddress || undefined,
    userAgent: j.UserAgent || undefined,
  };
}

/**
 * The recent opens of one document, newest first. No ownership check: the
 * caller has already established who is asking.
 */
export async function recentOpens(docId, { limit = DEFAULT_LIST } = {}) {
  await ensureOpenSchema();
  const q = new Parse.Query(OPEN_CLASS);
  q.equalTo('Document', pointer('contracts_Document', docId));
  q.descending('OpenedAt');
  q.limit(Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_LIST, 1), MAX_LIST));
  const rows = await q.find({ useMasterKey: true });
  return rows.map(openJson);
}

/**
 * Everything recorded about who opened a document: the per-signer summary and
 * the individual opens, newest first. Owners only.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {{limit?: number}} [opts] how many individual opens to return (default 50, max 200)
 */
export async function listDocumentOpens(caller, docId, { limit = DEFAULT_LIST } = {}) {
  const obj = await loadDoc(docId, { includeAudit: false });
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  const opens = await recentOpens(d.objectId, { limit });
  return {
    documentId: d.objectId,
    name: d.Name,
    ...openSummary(d),
    opens,
  };
}
