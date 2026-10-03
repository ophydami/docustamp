import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { appName, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../../Utils.js';
import { resolveTenantBranding } from '../parsefunction/tenantBranding.js';
import { MESSAGE_WITHOUT_LINK, hasSigningLinkMarker, senderDisplayName } from './requestMail.js';
import { setDocumentCount } from '../../utils/CountUtils.js';
import { isParticipantBasic } from '../../utils/workflowUtils.js';
import { analyzePdf } from '../ai/analyze.js';
import { isAiEnabled } from '../ai/client.js';
import { recipientsFromProposal } from '../parsefunction/aiFunctions.js';
import { readFresh } from './atomic.js';
import { ensureContact } from './contacts.js';
import { extUserPointer, userPointer } from './context.js';
import { isValidEmail } from './email.js';
import {
  assertFolder,
  assertOwner,
  assertSettingsInput,
  cachedPageSizes,
  documentStatus,
  groupFieldsByRecipient,
  loadDoc,
  normaliseChain,
  normaliseRecipients,
  normaliseSettings,
  pointerOrEmpty,
  settingsFromDoc,
  summariseDocument,
} from './documents.js';
import { API_URL_TTL, assertStoredFileUrl, fetchPdfBytes, resolveFileUrl } from './files.js';
import { pageBox } from './pageBox.js';
import { scheduleFieldsFor } from './schedule.js';
import {
  PREFILL_ROLE,
  countFields,
  createWidget,
  fieldKeysIn,
  heightForOptions,
  normaliseDefaultValue,
  normaliseWidgetType,
  presentDefaultValue,
  randomKey,
  reseedAutofillDefaults,
  resetPlaceholdersForCopy,
  roleColor,
  specFor,
} from './widgets.js';

/**
 * Everything an API caller (MCP tool or REST route) may do to a draft: read it
 * in full, review it for problems, change title/recipients/settings/message/file,
 * add, move, edit and remove fields, let the AI lay it out again, keep a version
 * history and roll back, duplicate, soft-delete and restore.
 *
 * Every mutation first snapshots the draft into `contracts_DocumentVersion`, so
 * "put it back the way it was" is always one call away (`undoDraftChange` or
 * `restoreDraftVersion`). Only drafts (not yet sent) are editable; anything that
 * has gone out to signers is read-only here, and `duplicateDocument` gives an
 * editable copy of it.
 *
 * Every function that touches a document returns the same document summary
 * `getDraft` returns (objectId, status, signers, recipients, fields...) at the top
 * level, with call-specific extras (`changed`, `removed`, `restored`, `copiedFrom`...)
 * beside it, so callers can always read `objectId` from the result.
 *
 * Writes are plain field sets on `contracts_Document` with the master key, the
 * same fields the web app's send page writes (`draftPatch` in apps/web), so a
 * draft edited here opens in the editor exactly as if it had been edited there.
 */

export const VERSION_CLASS = 'contracts_DocumentVersion';
export const MAX_VERSIONS_PER_DOC = 40;

const SIGNING_TYPES = new Set(['signature', 'initials', 'stamp', 'draw']);
const LIST_TYPES = new Set(['dropdown', 'radio button', 'checkbox']);
const TEXT_TYPES = new Set([
  'text input',
  'text',
  'name',
  'email',
  'company',
  'job title',
  'date',
  'cells',
]);

/** Fields a version snapshot carries and a restore writes back (besides Placeholders/Signers/ExpiryDate/Folder). */
const STATE_SCALARS = [
  'Name',
  'Note',
  'Description',
  'URL',
  'SendinOrder',
  'SendInOrderStrict',
  'IsEnableOTP',
  'NotifyOnSignatures',
  'AllowModifications',
  'RedirectUrl',
  'Bcc',
  'Cc',
  'AutomaticReminders',
  'RemindOnceInEvery',
  'TimeToCompleteDays',
  'RequestSubject',
  'RequestBody',
  'Chain',
];
const RESTORABLE_FIELDS = [...STATE_SCALARS, 'Placeholders', 'Signers', 'ExpiryDate', 'Folder'];

function fail(message, code = Parse.Error.VALIDATION_ERROR) {
  return new Parse.Error(code, message);
}

/* ------------------------------------------------------------------ loading */

export async function loadOwnedDocument(caller, docId) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  if (d.Type === 'Folder') throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
  return d;
}

export async function loadDraft(caller, docId) {
  const d = await loadOwnedDocument(caller, docId);
  const status = documentStatus(d);
  if (status !== 'draft') {
    throw fail(
      `This document is ${status.replace('_', ' ')}, so it can no longer be edited. Use duplicate_document to get an editable draft copy.`,
      Parse.Error.SCRIPT_FAILED
    );
  }
  return d;
}

/* ------------------------------------------------------------------ shapes */

function cleanPointer(p, className) {
  const id = p?.objectId || p?.id;
  return id ? { __type: 'Pointer', className: p.className || className, objectId: id } : null;
}

/** A Placeholders group as it should be persisted (pointers de-included, empty pages dropped). */
export function cleanGroup(g) {
  const signerObjId = g?.signerObjId || g?.signerPtr?.objectId || '';
  const out = {
    ...g,
    signerObjId,
    signerPtr: signerObjId ? pointerOrEmpty(signerObjId) : {},
    email: String(g?.email || '').toLowerCase(),
  };
  const pages = (g?.placeHolder || [])
    .map(p => ({
      pageNumber: Number(p?.pageNumber) || 1,
      pos: Array.isArray(p?.pos) ? [...p.pos] : [],
    }))
    .filter(p => p.pos.length)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  if (pages.length) out.placeHolder = pages;
  else delete out.placeHolder;
  return out;
}

function splitGroups(d) {
  const all = (d?.Placeholders || []).map(cleanGroup);
  return {
    signerGroups: all.filter(isParticipantBasic),
    prefillGroups: all.filter(g => g.Role === PREFILL_ROLE),
  };
}

function signersFor(signerGroups) {
  return signerGroups.filter(g => g.signerObjId).map(g => pointerOrEmpty(g.signerObjId));
}

function contactFor(d, group) {
  const id = group?.signerObjId || group?.signerPtr?.objectId || '';
  if (!id) return null;
  const fromSigners = (d?.Signers || []).find(s => s?.objectId === id);
  if (fromSigners) return fromSigners;
  const raw = (d?.Placeholders || []).find(g => g?.signerPtr?.objectId === id)?.signerPtr;
  return raw && raw.Email ? raw : null;
}

/** Recipients as the API sees them, derived from the groups (index-parallel with signerGroups). */
export function recipientsFromGroups(d, signerGroups) {
  return signerGroups.map((g, i) => {
    const contact = contactFor(d, g);
    return {
      order: i + 1,
      role: g.Role || `Role ${i + 1}`,
      name: contact?.Name || g.Name || '',
      email: (contact?.Email || g.email || '').toLowerCase(),
      phone: contact?.Phone || undefined,
      contactId: g.signerObjId || undefined,
      color: g.blockColor,
    };
  });
}

export function fieldJson(w, page, recipient) {
  const o = w?.options || {};
  const type = w?.type;
  const out = {
    key: w?.key,
    name: o.name,
    type,
    recipient,
    page,
    x: w?.xPosition,
    y: w?.yPosition,
    width: w?.Width,
    height: w?.Height,
    required: o.status !== 'optional',
  };
  if (o.hint) out.label = o.hint;
  if (LIST_TYPES.has(type) && Array.isArray(o.values)) out.values = o.values;
  if (
    o.defaultValue !== undefined &&
    o.defaultValue !== '' &&
    !(Array.isArray(o.defaultValue) && !o.defaultValue.length)
  ) {
    out.defaultValue = presentDefaultValue(type, o.values, o.defaultValue);
  }
  if (o.isReadOnly === true) out.readOnly = true;
  if (LIST_TYPES.has(type) && o.isHideLabel === true) out.hideLabel = true;
  if (type === 'date' && o.validation?.format) out.dateFormat = o.validation.format;
  return out;
}

function fieldsOfGroup(g, recipientLabel) {
  const out = [];
  for (const p of g?.placeHolder || []) {
    for (const w of p.pos || []) out.push(fieldJson(w, p.pageNumber, recipientLabel));
  }
  return out;
}

/**
 * The document fields a settings change writes.
 *
 * `ExpiryDate` and `NextReminderDate` are derived here (from the same helper the
 * afterSave trigger uses) rather than left to the trigger, which only ever ran
 * on insert: changing expiryDays used to move nothing the server acts on, and
 * turning reminders on never produced the `NextReminderDate` the reminder sweep
 * queries, so those reminders silently never fired.
 *
 * The dates are only rewritten when the settings that drive them actually
 * changed, so toggling `otp` no longer touches the deadline, and they are
 * anchored on DocSentAt/createdAt (never on "now"), which is the same anchor the
 * afterSave trigger and both mail builders use.
 *
 * @param {Object} settings normalised settings.
 * @param {Object} [doc] the document being changed, for the schedule anchor.
 * @param {Object} [previous] the settings the document had, to spot a real change.
 * @returns {Object} the patch.
 */
function settingsPatch(settings, doc, previous = {}) {
  const scheduleChanged =
    settings.expiryDays !== previous.expiryDays ||
    settings.remindEveryDays !== previous.remindEveryDays;
  const dates = scheduleChanged
    ? scheduleFieldsFor({
        DocSentAt: doc?.DocSentAt,
        createdAt: doc?.createdAt,
        TimeToCompleteDays: settings.expiryDays,
        AutomaticReminders: settings.remindEveryDays > 0,
        RemindOnceInEvery: settings.remindEveryDays || 5,
      })
    : {};
  return {
    TimeToCompleteDays: settings.expiryDays,
    ...(scheduleChanged
      ? { ExpiryDate: dates.ExpiryDate, NextReminderDate: dates.NextReminderDate }
      : {}),
    AutomaticReminders: settings.remindEveryDays > 0,
    RemindOnceInEvery: settings.remindEveryDays || 5,
    SendinOrder: settings.sendInOrder,
    SendInOrderStrict: settings.strictOrder,
    IsEnableOTP: settings.otp,
    NotifyOnSignatures: settings.notifyOnSignatures,
    AllowModifications: settings.allowModifications,
    RedirectUrl: settings.redirectUrl || null,
    Bcc: settings.bcc.length ? settings.bcc : null,
    Cc: settings.cc.length ? settings.cc : null,
    DateFormat: settings.dateFormat || null,
    Timezone: settings.timezone || null,
    Is12HourTime: typeof settings.is12HourTime === 'boolean' ? settings.is12HourTime : null,
  };
}

/**
 * The document's page geometry, read from the PDF at most once per file.
 *
 * `review_draft` and `get_draft { pages: true }` used to download and parse the
 * whole PDF on every call, so an agent looping review/fix/review over a 30 MB
 * contract made the server fetch and parse it five times. The geometry only
 * changes when the URL does, so it is cached on the row under the url it belongs
 * to (and `sendDocument` can use it to refuse an off-page layout for free).
 *
 * @param {Object} d plain document JSON.
 * @returns {Promise<Array<{number: number, width: number, height: number}>>}
 */
export async function ensurePageSizes(d) {
  const cached = cachedPageSizes(d);
  if (cached) return cached;
  const pages = await pageSizes(d.URL);
  try {
    const update = new Parse.Object('contracts_Document');
    update.id = d.objectId;
    update.set('PageSizes', { url: d.URL, pages });
    await update.save(null, { useMasterKey: true });
    d.PageSizes = { url: d.URL, pages };
  } catch (err) {
    // Caching is an optimisation; never fail a read over it.
    console.log('drafts: could not cache page sizes', err?.message);
  }
  return pages;
}

/**
 * Page sizes in PDF points (top-left system, CropBox offset folded in).
 *
 * The arithmetic lives in `cloud/lib/pageBox.js`, which is the single formula
 * this file, the AI layout extractor and the web overlay all use; only the way
 * the four numbers are pulled out of a page differs (pdf-lib here, pdf.js
 * there).
 */
export async function pageSizes(url) {
  const bytes = await fetchPdfBytes(url);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return pdf.getPages().map((page, i) => {
    const { y, width, height } = page.getCropBox();
    const box = pageBox({ y, width, height, rotation: page.getRotation().angle });
    return { number: i + 1, width: box.width, height: box.height };
  });
}

/**
 * The full picture of a document for an editor-like client: summary, settings,
 * message, every recipient with their fields, prefill fields, version count.
 */
export async function draftDetail(caller, d, { pages = false } = {}) {
  const summary = summariseDocument(d, caller, { links: false });
  const { signerGroups, prefillGroups } = splitGroups(d);
  const base = recipientsFromGroups(d, signerGroups);
  const recipients = base.map((r, i) => ({ ...r, fields: fieldsOfGroup(signerGroups[i], r.role) }));
  const prefillFields = prefillGroups.flatMap(g => fieldsOfGroup(g, PREFILL_ROLE));
  const out = {
    ...summary,
    editable: summary.status === 'draft',
    // Pass it back to send_document to send exactly what the user was shown.
    revision: draftRevision(d),
    url: d.URL,
    settings: settingsFromDoc(d),
    message: { subject: d.RequestSubject || '', body: d.RequestBody || '' },
    recipients,
    prefillFields,
    fieldCount: countFields(d.Placeholders),
    versions: await countVersions(d.objectId),
    urls: {
      original: await resolveFileUrl(d.URL, { ttl: API_URL_TTL }),
      app: caller.publicUrl ? `${caller.publicUrl}/documents/${d.objectId}` : undefined,
      editor:
        caller.publicUrl && summary.status === 'draft'
          ? `${caller.publicUrl}/editor/${d.objectId}`
          : undefined,
      send:
        caller.publicUrl && summary.status === 'draft'
          ? `${caller.publicUrl}/send/${d.objectId}`
          : undefined,
    },
  };
  if (pages) {
    try {
      out.pages = await ensurePageSizes(d);
    } catch (err) {
      out.pages = [];
      out.pagesError = err?.message || String(err);
    }
  }
  return out;
}

export async function getDraft(caller, docId, opts = {}) {
  return await draftDetail(caller, await loadOwnedDocument(caller, docId), opts);
}

/* ------------------------------------------------------------------ versions */

let versionSchemaReady = false;

/**
 * The history class is master-key only: nobody can read another user's drafts
 * through the REST `classes/` endpoint. Created on first use (and by the
 * migration in databases/migrations) so a fresh server needs no manual step.
 */
const LOCKED_CLP = Object.freeze({
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

/** True when every operation on the class is closed to everyone but the master key. */
function isLockedDown(clp) {
  const ops = ['get', 'find', 'count', 'create', 'update', 'delete', 'addField'];
  return ops.every(op => Object.keys(clp?.[op] || {}).length === 0);
}

export async function ensureVersionSchema() {
  if (versionSchemaReady) return;
  const schema = new Parse.Schema(VERSION_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (existing) {
    // The lockdown used to be applied on the create path only, so a class made
    // by an earlier build or restored from a dump with a permissive CLP stayed
    // permissive for ever, and `State` holds a complete copy of every draft.
    if (!isLockedDown(existing.classLevelPermissions)) {
      schema.setCLP(LOCKED_CLP);
      await schema.update();
    }
    versionSchemaReady = true;
    return;
  }
  schema.addPointer('Document', 'contracts_Document');
  schema.addPointer('CreatedBy', '_User');
  schema.addNumber('Version');
  schema.addString('Reason');
  schema.addString('Label');
  schema.addString('Origin');
  schema.addString('Name');
  schema.addNumber('FieldCount');
  schema.addArray('Recipients');
  schema.addBoolean('Checkpoint');
  schema.addObject('State');
  schema.setCLP(LOCKED_CLP);
  try {
    await schema.save();
  } catch (err) {
    if (!/already exists/i.test(err?.message || '')) throw err;
  }
  versionSchemaReady = true;
}

function docPointer(docId) {
  return { __type: 'Pointer', className: 'contracts_Document', objectId: docId };
}

/** What a snapshot stores: everything that defines the draft, in persistable form. */
export function draftState(d) {
  const state = {};
  for (const f of STATE_SCALARS) if (d?.[f] !== undefined && d?.[f] !== null) state[f] = d[f];
  state.Placeholders = (d?.Placeholders || []).map(cleanGroup);
  state.Signers = (d?.Signers || [])
    .map(s => cleanPointer(s, 'contracts_Contactbook'))
    .filter(Boolean);
  // The people, not just their ids: a version is rendered against the live
  // document, so a recipient who has since been replaced used to come back with
  // the right email and an empty name, as if the name had been cleared.
  state.Contacts = (d?.Signers || [])
    .filter(s => s?.objectId)
    .map(s => ({
      objectId: s.objectId,
      Name: s.Name || '',
      Email: (s.Email || '').toLowerCase(),
      Phone: s.Phone || undefined,
    }));
  if (d?.ExpiryDate?.iso) state.ExpiryDate = { __type: 'Date', iso: d.ExpiryDate.iso };
  const folder = cleanPointer(d?.Folder, 'contracts_Document');
  if (folder) state.Folder = folder;
  return state;
}

/** A query string that signs a file url rather than meaning anything. */
const SIGNED_QUERY = /(?:^|&)(?:X-Amz-[A-Za-z-]+|token)=/;

/**
 * A short fingerprint of everything that defines the draft (the same state a
 * snapshot stores), so an agent can show the user a draft and then send exactly
 * that draft: send_document refuses a `revision` that no longer matches.
 *
 * Stored file urls can come back signed (an S3 presign, or the `?token=` of a
 * local `/files/` url), with a signature and an expiry that change on every
 * read, so those query strings are dropped first: two reads of an unchanged
 * draft give the same revision. Any other query string (a redirect url's) counts.
 *
 * @param {Object} d the document as plain JSON.
 * @returns {string} 16 hex characters.
 */
export function draftRevision(d) {
  const json = JSON.stringify(draftState(d)).replace(
    /(https?:\/\/[^"?\s]*)\?([^"\s]*)/g,
    (all, bare, query) => (SIGNED_QUERY.test(query) ? bare : all)
  );
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Refuse to go on when the draft is no longer the one the user was shown.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {string} [revision] what get_draft or review_draft returned; nothing to check when absent.
 */
export async function assertDraftRevision(caller, docId, revision) {
  if (revision === undefined || revision === null || revision === '') return;
  const current = draftRevision(await loadOwnedDocument(caller, docId));
  if (String(revision) !== current) {
    throw fail(
      `This draft changed after it was shown (revision ${revision}, now ${current}). Show the user the current draft with get_draft and ask again before sending.`
    );
  }
}

function versionJson(v) {
  const j = typeof v?.toJSON === 'function' ? v.toJSON() : v;
  return {
    versionId: j.objectId,
    version: j.Version,
    label: j.Label || undefined,
    reason: j.Reason || '',
    origin: j.Origin || undefined,
    name: j.Name || '',
    fieldCount: j.FieldCount ?? 0,
    recipients: j.Recipients || [],
    createdAt: j.createdAt,
  };
}

/**
 * How many snapshots a document has, or `undefined` when the history could not
 * be read. Reporting 0 for a broken history read as "there is nothing to undo"
 * while snapshots were in fact being written on every change.
 */
async function countVersions(docId) {
  try {
    await ensureVersionSchema();
    const q = new Parse.Query(VERSION_CLASS);
    q.equalTo('Document', docPointer(docId));
    return await q.count({ useMasterKey: true });
  } catch (err) {
    console.log('drafts: countVersions failed', err?.message);
    return undefined;
  }
}

async function latestVersion(docId) {
  const q = new Parse.Query(VERSION_CLASS);
  q.equalTo('Document', docPointer(docId));
  q.descending('Version');
  return await q.first({ useMasterKey: true });
}

async function latestVersionNumber(docId) {
  const top = await latestVersion(docId);
  return top ? Number(top.get('Version')) || 0 : 0;
}

/**
 * Drop the snapshots past `MAX_VERSIONS_PER_DOC`.
 *
 * Pure housekeeping, so it can never fail the edit it is cleaning up after: a
 * `destroyAll` rejecting on a row a concurrent prune already removed used to
 * propagate out of `updateDraft` and lose the user's change.
 */
async function pruneVersions(docId) {
  try {
    const q = new Parse.Query(VERSION_CLASS);
    q.equalTo('Document', docPointer(docId));
    q.descending('Version');
    q.skip(MAX_VERSIONS_PER_DOC);
    q.limit(200);
    const old = await q.find({ useMasterKey: true });
    if (old.length) await Parse.Object.destroyAll(old, { useMasterKey: true });
  } catch (err) {
    console.log('drafts: pruning old versions failed', err?.message);
  }
}

/**
 * Snapshot the document as it is right now. Called before every mutation, and
 * directly by `save_draft_version` for a named checkpoint.
 */
export async function saveDraftVersion(
  caller,
  d,
  { reason = 'manual', label = '', origin = '', checkpoint = false } = {}
) {
  await ensureVersionSchema();
  const { signerGroups } = splitGroups(d);
  const version = (await latestVersionNumber(d.objectId)) + 1;
  const v = new Parse.Object(VERSION_CLASS);
  v.set('Document', docPointer(d.objectId));
  v.set('CreatedBy', userPointer(caller));
  v.set('Version', version);
  v.set('Reason', String(reason || 'manual').slice(0, 200));
  // A checkpoint records the state the draft is *in*, not the state a mutation
  // replaced, so undo has to skip it (it used to restore the state the draft
  // already had and report success).
  if (checkpoint) v.set('Checkpoint', true);
  if (label) v.set('Label', String(label).slice(0, 120));
  if (origin) v.set('Origin', String(origin).slice(0, 40));
  v.set('Name', d.Name || '');
  v.set('FieldCount', countFields(d.Placeholders));
  v.set(
    'Recipients',
    recipientsFromGroups(d, signerGroups).map(r => r.email || r.role)
  );
  v.set('State', draftState(d));
  const acl = new Parse.ACL();
  acl.setReadAccess(caller.userId, true);
  acl.setWriteAccess(caller.userId, true);
  v.setACL(acl);
  await v.save(null, { useMasterKey: true });
  // Housekeeping only every so often: the write path already costs a query, a
  // save and a document write, and the cap is a soft one.
  if (version % 10 === 0 || version > MAX_VERSIONS_PER_DOC) await pruneVersions(d.objectId);
  return versionJson(v);
}

/**
 * A named checkpoint. Only a draft can be checkpointed: `restoreDraftVersion`
 * refuses anything else, so offering a checkpoint on a sent document promised a
 * rollback that could never happen.
 */
export async function snapshotDraft(caller, docId, { label = '', origin = '' } = {}) {
  const d = await loadDraft(caller, docId);
  const version = await saveDraftVersion(caller, d, {
    reason: label ? `checkpoint: ${label}` : 'checkpoint',
    label,
    origin,
    checkpoint: true,
  });
  return { ...version, total: await countVersions(docId) };
}

/** Consecutive web saves closer together than this share one version entry. */
export const WEB_EDIT_COALESCE_MS = 2 * 60 * 1000;

/** How a changed field reads in a version's `reason`. */
function editLabel(field) {
  switch (field) {
    case 'Name':
      return 'name';
    case 'Note':
      return 'note';
    case 'Description':
      return 'description';
    case 'URL':
      return 'file';
    case 'Placeholders':
      return 'fields';
    case 'Signers':
      return 'recipients';
    case 'RequestSubject':
    case 'RequestBody':
      return 'message';
    case 'Folder':
      return 'folder';
    default:
      return 'settings';
  }
}

/** A comparable rendering of one field value (pointers and Parse objects by id). */
function fingerprint(value) {
  const plain = v => {
    if (v && typeof v.toPointer === 'function') return v.id;
    if (v && v.__type === 'Pointer') return v.objectId;
    if (v && v.__type === 'Date') return v.iso;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = plain(v[k]);
      return out;
    }
    return v ?? null;
  };
  return JSON.stringify(plain(value));
}

/**
 * The previous state of a document as `saveDraftVersion` needs it: the trigger's
 * `original` carries Signers as bare pointers, and a version rendered from bare
 * pointers would show every recipient with an empty name (see `draftState`).
 */
async function inflateOriginal(original) {
  const d = JSON.parse(JSON.stringify(original.toJSON()));
  d.objectId = original.id;
  const ids = (d.Signers || []).map(s => s?.objectId || s?.id).filter(Boolean);
  if (ids.length) {
    const q = new Parse.Query('contracts_Contactbook');
    q.containedIn('objectId', ids);
    q.limit(ids.length);
    const contacts = await q.find({ useMasterKey: true });
    const byId = new Map(contacts.map(c => [c.id, JSON.parse(JSON.stringify(c.toJSON()))]));
    d.Signers = ids.map(id => byId.get(id) || { objectId: id });
  }
  return d;
}

/**
 * Record an edit that did not come through this module in the draft's history.
 *
 * Every mutation here snapshots the draft first (`commit`), but the web app
 * writes the same fields with a plain PUT, so a change made in the browser left
 * no entry at all: a message edited on the send page between versions 10 and 11
 * could not be told apart from version 11, and nothing said who made it or when.
 * Called from the `contracts_Document` afterSave trigger; only a save made with
 * a session (`request.user`, i.e. the web app or a cloud function it called)
 * counts, because master-key writes are this module's own and already recorded.
 *
 * The web autosaves a couple of seconds after every keystroke pause, so saves by
 * the same person within `WEB_EDIT_COALESCE_MS` of the last web entry share it:
 * the stored state stays the one before the burst began (which is what undo
 * should restore) and the entry's reason grows to name every field touched.
 *
 * @param {Object} request the afterSave request (original, object, user).
 * @returns {Promise<Object|null>} the version written or updated, null when nothing was recorded.
 */
export async function recordExternalEdit(request) {
  const original = request?.original;
  const object = request?.object;
  const user = request?.user;
  if (!original || !object || !user?.id) return null;
  if (original.get('SignedUrl') || original.get('DocSentAt')) return null;
  if (original.get('Type') === 'Folder' || original.get('IsArchive') === true) return null;
  const changed = RESTORABLE_FIELDS.filter(
    f => fingerprint(original.get(f)) !== fingerprint(object.get(f))
  );
  if (!changed.length) return null;
  const labels = [...new Set(changed.map(editLabel))];

  await ensureVersionSchema();
  const latest = await latestVersion(original.id);
  const latestAt = latest?.createdAt ? new Date(latest.createdAt).getTime() : 0;
  if (
    latest &&
    latest.get('Origin') === 'web' &&
    latest.get('CreatedBy')?.id === user.id &&
    Date.now() - latestAt < WEB_EDIT_COALESCE_MS
  ) {
    const seen = String(latest.get('Reason') || '')
      .replace(/^web: edited\s*/, '')
      .split(/,\s*/)
      .filter(Boolean);
    const merged = [...new Set([...seen, ...labels])];
    if (merged.length !== seen.length) {
      latest.set('Reason', `web: edited ${merged.join(', ')}`.slice(0, 200));
      await latest.save(null, { useMasterKey: true });
    }
    return versionJson(latest);
  }

  const previous = await inflateOriginal(original);
  return await saveDraftVersion({ userId: user.id }, previous, {
    reason: `web: edited ${labels.join(', ')}`,
    origin: 'web',
  });
}

export async function listDraftVersions(caller, docId, { limit = 50 } = {}) {
  await loadOwnedDocument(caller, docId);
  await ensureVersionSchema();
  const q = new Parse.Query(VERSION_CLASS);
  q.equalTo('Document', docPointer(docId));
  q.descending('Version');
  q.limit(Math.min(Math.max(1, Number(limit) || 50), 200));
  const rows = await q.find({ useMasterKey: true });
  return rows.map(versionJson);
}

async function findVersion(docId, ref, { skipCheckpoints = false } = {}) {
  await ensureVersionSchema();
  const q = new Parse.Query(VERSION_CLASS);
  q.equalTo('Document', docPointer(docId));
  const asNumber = Number(ref);
  if (
    ref !== undefined &&
    ref !== null &&
    ref !== '' &&
    Number.isInteger(asNumber) &&
    String(ref).trim() === String(asNumber)
  ) {
    q.equalTo('Version', asNumber);
  } else if (ref) {
    q.equalTo('objectId', String(ref));
  } else {
    if (skipCheckpoints) q.notEqualTo('Checkpoint', true);
    q.descending('Version');
  }
  const v = await q.first({ useMasterKey: true });
  if (!v)
    throw fail(
      ref ? `Version ${ref} not found for this document.` : 'This document has no history yet.',
      Parse.Error.OBJECT_NOT_FOUND
    );
  return v;
}

/** One version with the state rendered the same way `getDraft` renders the live draft. */
export async function getDraftVersion(caller, docId, ref) {
  const d = await loadOwnedDocument(caller, docId);
  const v = await findVersion(docId, ref);
  const state = v.toJSON().State || {};
  // The people as they were when the snapshot was taken, falling back to the
  // live document for snapshots written before Contacts was stored.
  const contacts =
    Array.isArray(state.Contacts) && state.Contacts.length ? state.Contacts : d.Signers;
  const ghost = { ...d, ...state, Signers: contacts };
  const { signerGroups, prefillGroups } = splitGroups(ghost);
  const recipients = recipientsFromGroups(ghost, signerGroups).map((r, i) => ({
    ...r,
    fields: fieldsOfGroup(signerGroups[i], r.role),
  }));
  return {
    ...versionJson(v),
    state: {
      name: state.Name,
      note: state.Note || undefined,
      description: state.Description || undefined,
      url: state.URL,
      settings: settingsFromDoc(state),
      message: { subject: state.RequestSubject || '', body: state.RequestBody || '' },
      recipients,
      prefillFields: prefillGroups.flatMap(g => fieldsOfGroup(g, PREFILL_ROLE)),
      fieldCount: countFields(state.Placeholders),
      folderId: state.Folder?.objectId || undefined,
    },
  };
}

function applyState(update, state) {
  for (const f of RESTORABLE_FIELDS) {
    let value = state?.[f];
    if (f === 'ExpiryDate' && value?.iso) value = new Date(value.iso);
    if (value === undefined || value === null) update.unset(f);
    else update.set(f, value);
  }
}

/**
 * Put a draft back to a saved version. The current state is snapshotted first,
 * so a restore is itself undoable.
 */
export async function restoreDraftVersion(
  caller,
  docId,
  ref,
  { origin = '', skipCheckpoints = false } = {}
) {
  const d = await loadDraft(caller, docId);
  const v = await findVersion(docId, ref, { skipCheckpoints });
  const target = versionJson(v);
  await saveDraftVersion(caller, d, {
    reason: `before restore of version ${target.version}`,
    origin,
  });
  const update = new Parse.Object('contracts_Document');
  update.id = d.objectId;
  applyState(update, v.toJSON().State || {});
  await update.save(null, { useMasterKey: true });
  return { ...(await getDraft(caller, docId)), restored: target };
}

/**
 * Undo the most recent change: restore the latest snapshot of a state that was
 * replaced. Named checkpoints are skipped, because they record the state the
 * draft is already in and undoing to one is a no-op that reports success.
 * Calling undo twice in a row redoes.
 */
export async function undoDraftChange(caller, docId, { origin = '' } = {}) {
  return await restoreDraftVersion(caller, docId, undefined, { origin, skipCheckpoints: true });
}

/* ------------------------------------------------------------------ mutations */

/**
 * Refuse to write a draft that moved since it was read.
 *
 * Every mutation here builds a whole replacement `Placeholders` array from the
 * snapshot it loaded, so two writers (parallel agent tool calls, a retry, the
 * web editor saving while an MCP tool edits) used to silently lose one edit.
 * The read is trigger-free and happens immediately before the write, so the
 * window is as small as it gets without bypassing the afterSave trigger that
 * rebuilds the document ACL when the signers change.
 */
async function assertUnchanged(d) {
  let fresh;
  try {
    fresh = await readFresh('contracts_Document', d.objectId, ['updatedAt']);
  } catch (err) {
    console.log('drafts: could not re-read the document before writing', err?.message);
    return;
  }
  const seen = d?.updatedAt ? new Date(d.updatedAt).getTime() : 0;
  const now = fresh?.updatedAt ? new Date(fresh.updatedAt).getTime() : 0;
  if (seen && now && seen !== now) {
    throw fail(
      'This draft changed while you were editing it. Read it again with get_draft and reapply the change.',
      Parse.Error.SCRIPT_FAILED
    );
  }
}

/**
 * Snapshot, then write `patch` (null/undefined values unset the field) and
 * return the fresh draft.
 */
async function commit(caller, d, patch, { reason, origin = '', label = '' }) {
  await saveDraftVersion(caller, d, { reason, origin, label });
  await assertUnchanged(d);
  const update = new Parse.Object('contracts_Document');
  update.id = d.objectId;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) update.unset(k);
    else update.set(k, v);
  }
  await update.save(null, { useMasterKey: true });
  return await getDraft(caller, d.objectId);
}

/**
 * Work out the new signer groups for a recipients list: an existing group is
 * kept (with its fields) when it matches by contact, email, role, or position,
 * otherwise a fresh empty group is created. Removed recipients lose their fields.
 */
async function planRecipients(caller, d, rawRecipients) {
  const raw = Array.isArray(rawRecipients) ? rawRecipients : [];
  const recipients = normaliseRecipients(raw);
  const explicitRole = raw.map(r =>
    Boolean(typeof r === 'object' && r?.role && String(r.role).trim())
  );
  const { signerGroups, prefillGroups } = splitGroups(d);
  const contacts = [];
  for (const r of recipients) contacts.push(await ensureContact(caller, r));

  const used = new Set();
  const existingEmail = signerGroups.map(g =>
    (contactFor(d, g)?.Email || g.email || '').toLowerCase()
  );
  const pick = (r, i) => {
    const tests = [
      j => signerGroups[j].signerObjId && signerGroups[j].signerObjId === contacts[i].objectId,
      j => existingEmail[j] && existingEmail[j] === r.email,
      j =>
        explicitRole[i] &&
        String(signerGroups[j].Role || '').toLowerCase() === r.role.toLowerCase(),
      // Same slot in a same-length list: the person changed, the role's fields stay,
      // unless the caller gave this slot a different role label (then it is a new role).
      j =>
        signerGroups.length === recipients.length &&
        j === i &&
        (!explicitRole[i] ||
          String(signerGroups[j].Role || '').toLowerCase() === r.role.toLowerCase()),
    ];
    for (const test of tests) {
      const j = signerGroups.findIndex((_, idx) => !used.has(idx) && test(idx));
      if (j !== -1) return j;
    }
    return -1;
  };

  const groups = recipients.map((r, i) => {
    const j = pick(r, i);
    if (j !== -1) used.add(j);
    const base = j !== -1 ? signerGroups[j] : {};
    const group = {
      Id: base.Id ?? randomKey(8),
      // An explicit role label wins; otherwise a matched group keeps its label.
      Role: explicitRole[i] ? r.role : base.Role || r.role,
      blockColor: roleColor(i),
      signerObjId: contacts[i].objectId,
      signerPtr: pointerOrEmpty(contacts[i].objectId),
      email: r.email,
    };
    if (base.placeHolder?.length) {
      group.placeHolder = base.placeHolder;
      // The slot keeps its fields but the person in it may have changed, and the
      // name/email/company/job title boxes carry the previous signer's details in
      // their defaultValue. The legacy signer view prefers defaultValue over the
      // live identity, so the new signer used to see (and sign under) the old
      // person's name.
      if (base.signerObjId !== contacts[i].objectId) {
        reseedAutofillDefaults(group, { ...contacts[i], name: contacts[i].name || r.name });
      }
    }
    return group;
  });
  const dropped = signerGroups.reduce((n, g, idx) => (used.has(idx) ? n : n + countFields([g])), 0);
  return { signerGroups: groups, prefillGroups, recipients, contacts, dropped };
}

/**
 * Change any of: name, note, description, settings (partial), message, folderId,
 * url (replace the PDF; fields are kept), recipients (full list; fields follow
 * matching recipients), chain (the follow-up sent on completion; null removes it).
 */
export async function updateDraft(caller, docId, input = {}, { origin = '' } = {}) {
  const d = await loadDraft(caller, docId);
  const patch = {};
  const changed = [];
  let dropped = 0;

  if (input.name !== undefined) {
    const name = String(input.name || '')
      .trim()
      .slice(0, MAX_NAME_LENGTH);
    if (!name) throw fail('name cannot be empty.');
    patch.Name = name;
    changed.push('name');
  }
  if (input.note !== undefined) {
    const note = String(input.note || '')
      .trim()
      .slice(0, MAX_NOTE_LENGTH);
    patch.Note = note || null;
    changed.push('note');
  }
  if (input.description !== undefined) {
    const description = String(input.description || '')
      .trim()
      .slice(0, MAX_DESCRIPTION_LENGTH);
    patch.Description = description || null;
    changed.push('description');
  }
  if (input.settings !== undefined && Object.keys(input.settings || {}).length) {
    // `settings: {}` contributes nothing, so it no longer counts as a change,
    // takes a version slot or rewrites the schedule.
    const current = settingsFromDoc(d);
    assertSettingsInput(input.settings, current);
    const merged = normaliseSettings({ ...current, ...(input.settings || {}) });
    if (merged.remindEveryDays > 0 && merged.expiryDays / merged.remindEveryDays > 15) {
      throw fail('At most 15 automatic reminders: raise remindEveryDays or lower expiryDays.');
    }
    Object.assign(patch, settingsPatch(merged, d, current));
    changed.push('settings');
  }
  if (input.message !== undefined) {
    const m = input.message || {};
    let touched = false;
    if (m.subject !== undefined) {
      patch.RequestSubject = String(m.subject || '').slice(0, 998) || null;
      touched = true;
    }
    if (m.body !== undefined) {
      patch.RequestBody = String(m.body || '').slice(0, 20000) || null;
      touched = true;
    }
    if (input.message === null) {
      patch.RequestSubject = null;
      patch.RequestBody = null;
      touched = true;
    }
    if (touched) changed.push('message');
  }
  if (input.folderId !== undefined) {
    patch.Folder = input.folderId ? await assertFolder(caller, input.folderId) : null;
    changed.push('folder');
  }
  if (input.url !== undefined) {
    const url = String(input.url || '').trim();
    if (!url) throw fail('url cannot be empty.');
    // Only a url of ours ever reaches the row; an external one is copied first.
    patch.URL = await assertStoredFileUrl(url, caller, { fileName: input.fileName });
    changed.push('file');
  }
  if (input.recipients !== undefined) {
    const plan = await planRecipients(caller, d, input.recipients);
    patch.Placeholders = [...plan.signerGroups, ...plan.prefillGroups];
    patch.Signers = signersFor(plan.signerGroups);
    dropped = plan.dropped;
    changed.push('recipients');
  }
  if (input.chain !== undefined) {
    // null clears (commit unsets null patch values); an object is validated
    // against the target template the same way create_document validates it.
    patch.Chain = await normaliseChain(caller, input.chain);
    changed.push('chain');
  }
  if (!changed.length)
    throw fail(
      'Nothing to change: pass at least one of name, note, description, settings, message, folderId, url, recipients, chain.'
    );

  // A replacement PDF can be shorter than the one the fields were placed on.
  // Nothing used to look: the document sent cleanly with widgets on pages that
  // no longer existed, the signer saw only some of the required fields and it
  // could never complete.
  let offPage = 0;
  if (patch.URL && patch.URL !== d.URL) {
    try {
      const pages = await pageSizes(patch.URL);
      patch.PageSizes = { url: patch.URL, pages };
      const groups = (patch.Placeholders || d.Placeholders || []).map(cleanGroup);
      for (const g of groups) {
        const all = g.placeHolder || [];
        const kept = all.filter(p => Number(p.pageNumber) <= pages.length);
        offPage += all
          .filter(p => Number(p.pageNumber) > pages.length)
          .reduce((n, p) => n + (p.pos || []).length, 0);
        if (kept.length) g.placeHolder = kept;
        else delete g.placeHolder;
      }
      if (offPage) {
        patch.Placeholders = groups;
        patch.Signers = signersFor(groups.filter(isParticipantBasic));
      }
    } catch (err) {
      // An unreadable replacement is the caller's problem to see, not a reason
      // to refuse the swap; review_draft reports it as pdf_unreadable.
      console.log('drafts: could not measure the replacement PDF', err?.message);
    }
  }

  const draft = await commit(caller, d, patch, { reason: `update ${changed.join(', ')}`, origin });
  const linkWarning = changed.includes('message') ? messageLint(draft.message) : null;
  return {
    ...draft,
    changed,
    droppedFields: dropped + offPage || undefined,
    droppedOffPageFields: offPage || undefined,
    ...(linkWarning ? { warnings: [linkWarning] } : {}),
  };
}

/**
 * The one thing a custom message can get wrong that costs the signer the mail:
 * a body that never places `{{signing_url}}`. The server appends the link then
 * (see requestMail.js `ensureSigningLink`), so this is a warning, not an error,
 * but the author should hear it: `review_draft` lists it and `update_draft`
 * returns it with the change.
 * @param {{subject?: string, body?: string}} message
 * @returns {{code: string, message: string}|null}
 */
export function messageLint(message) {
  const body = String(message?.body || '').trim();
  if (!body || hasSigningLinkMarker(body)) return null;
  return { ...MESSAGE_WITHOUT_LINK };
}

/* ------------------------------------------------------------------ fields */

function maxZ(groups) {
  let z = 0;
  for (const g of groups)
    for (const p of g.placeHolder || [])
      for (const w of p.pos || []) z = Math.max(z, Number(w.zIndex) || 0);
  return z;
}

function typeCounts(group) {
  const counts = new Map();
  for (const p of group.placeHolder || [])
    for (const w of p.pos || []) counts.set(w.type, (counts.get(w.type) || 0) + 1);
  return counts;
}

function pushWidget(group, page, widget) {
  const pages = group.placeHolder || [];
  let entry = pages.find(p => p.pageNumber === page);
  if (!entry) {
    entry = { pageNumber: page, pos: [] };
    pages.push(entry);
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }
  entry.pos.push(widget);
  group.placeHolder = pages;
}

function dropEmptyPages(group) {
  const pages = (group.placeHolder || []).filter(p => (p.pos || []).length);
  if (pages.length) group.placeHolder = pages;
  else delete group.placeHolder;
}

/**
 * Append createWidget inputs (+ page) to a group, numbering and z-ordering like
 * the editor. `defaultValue` and `readOnly` are handled by createWidget itself,
 * so the create path and this one produce the same widget.
 */
function addFieldsToGroup(group, fields, signer, zRef, usedKeys) {
  const counts = typeCounts(group);
  for (const f of fields) {
    const type = normaliseWidgetType(f.type);
    if (!type) throw fail(`Unknown field type "${f.type}".`);
    const count = (counts.get(type) || 0) + 1;
    counts.set(type, count);
    zRef.z += 1;
    const widget = createWidget({ ...f, type, count, zIndex: zRef.z, signer, usedKeys });
    pushWidget(group, Math.max(1, Math.floor(Number(f.page) || 1)), widget);
  }
}

function newPrefillGroup() {
  return {
    Id: randomKey(8),
    Role: PREFILL_ROLE,
    Name: 'Prefill by owner',
    blockColor: roleColor(0, true),
    signerObjId: '',
    signerPtr: {},
    email: '',
  };
}

/**
 * Replace (default) or append fields. `fields` use the same shape as
 * create_document: `{ recipient, type, page, x, y, width?, height?, label?, required?, values?, defaultValue? }`.
 */
export async function setDraftFields(
  caller,
  docId,
  fields,
  { mode = 'replace', origin = '', clearAll = false } = {}
) {
  const d = await loadDraft(caller, docId);
  const list = Array.isArray(fields) ? fields : [];
  if (mode !== 'replace' && mode !== 'append') throw fail('mode must be "replace" or "append".');
  if (mode === 'append' && !list.length) throw fail('Give at least one field to append.');
  // Replacing with a `fields` that never arrived (dropped by a caller, sent as
  // an object, lost in a retry) used to wipe the whole layout in silence. An
  // explicit empty array, or clearAll, is the only way to clear everything here
  // (remove_draft_fields { all: true } does the same).
  if (mode === 'replace' && !Array.isArray(fields) && clearAll !== true) {
    throw fail(
      'fields must be an array. Pass an explicit [] (or clearAll: true) to remove every field.'
    );
  }
  const { signerGroups, prefillGroups } = splitGroups(d);
  const recipients = recipientsFromGroups(d, signerGroups);
  if (
    !signerGroups.length &&
    list.some(f => ![PREFILL_ROLE, 'sender', 'owner'].includes(f?.recipient))
  ) {
    throw fail(
      'This draft has no recipients yet. Add them with update_draft { recipients } first.'
    );
  }
  const grouped = groupFieldsByRecipient(list, recipients);
  if (mode === 'replace') for (const g of [...signerGroups, ...prefillGroups]) delete g.placeHolder;
  const zRef = { z: maxZ([...signerGroups, ...prefillGroups]) };
  const usedKeys = fieldKeysIn([...signerGroups, ...prefillGroups]);
  signerGroups.forEach((g, i) => {
    if (!grouped.perRecipient[i].length) return;
    const r = recipients[i];
    addFieldsToGroup(g, grouped.perRecipient[i], { name: r.name, email: r.email }, zRef, usedKeys);
  });
  if (grouped.prefill.length) {
    if (!prefillGroups.length) prefillGroups.push(newPrefillGroup());
    addFieldsToGroup(prefillGroups[0], grouped.prefill, {}, zRef, usedKeys);
  }
  const kept = prefillGroups.filter(g => g.placeHolder?.length || mode === 'append');
  const draft = await commit(
    caller,
    d,
    { Placeholders: [...signerGroups, ...kept], Signers: signersFor(signerGroups) },
    { reason: `${mode} fields (${list.length})`, origin }
  );
  return { ...draft, added: list.length, mode };
}

function locateField(groups, ref) {
  const asNumber = Number(ref);
  const hits = [];
  for (const [gi, g] of groups.entries()) {
    for (const [pi, p] of (g.placeHolder || []).entries()) {
      for (const [wi, w] of (p.pos || []).entries()) {
        if (
          (Number.isFinite(asNumber) && Number(w.key) === asNumber) ||
          (w.options?.name && w.options.name === ref)
        ) {
          hits.push({ gi, pi, wi, widget: w, page: p.pageNumber });
        }
      }
    }
  }
  if (!hits.length)
    throw fail(`Field "${ref}" not found. Keys are in get_draft.`, Parse.Error.OBJECT_NOT_FOUND);
  if (hits.length > 1) {
    // Editing the first of several fields with the same key while remove would
    // take all of them is worse than saying so.
    throw fail(
      `Field "${ref}" matches ${hits.length} fields on this document; remove the duplicates first.`
    );
  }
  return hits[0];
}

function resolveGroupRef(signerGroups, recipients, ref) {
  if (ref === PREFILL_ROLE || ref === 'sender' || ref === 'owner') return PREFILL_ROLE;
  if (typeof ref === 'number') {
    if (ref < 0 || ref >= signerGroups.length) throw fail(`Recipient ${ref} not found.`);
    return ref;
  }
  const needle = String(ref || '')
    .trim()
    .toLowerCase();
  let idx = recipients.findIndex(r => r.email === needle || r.role.toLowerCase() === needle);
  if (idx === -1 && /^\d+$/.test(needle)) idx = Number(needle);
  if (idx < 0 || idx >= signerGroups.length) throw fail(`Recipient "${ref}" not found.`);
  return idx;
}

/**
 * Change one field in place: move it (x, y, page), resize it, relabel it, make
 * it optional/required, change its options, hand it to another recipient, or
 * change its type. The field keeps its key.
 */
export async function updateDraftField(
  caller,
  docId,
  fieldRef,
  changes = {},
  { origin = '' } = {}
) {
  const d = await loadDraft(caller, docId);
  const { signerGroups, prefillGroups } = splitGroups(d);
  const recipients = recipientsFromGroups(d, signerGroups);
  const all = [...signerGroups, ...prefillGroups];
  const found = locateField(all, fieldRef);
  let widget = { ...found.widget, options: { ...(found.widget.options || {}) } };
  const c = changes || {};
  const touched = [];

  if (c.type !== undefined) {
    const type = normaliseWidgetType(c.type);
    if (!type) throw fail(`Unknown field type "${c.type}".`);
    if (type !== widget.type) {
      const fresh = createWidget({
        type,
        x: widget.xPosition,
        y: widget.yPosition,
        width: widget.Width,
        height: widget.Height,
        count: 1,
        zIndex: widget.zIndex,
        label: widget.options.hint,
        required: widget.options.status !== 'optional',
      });
      widget = { ...fresh, key: widget.key };
      touched.push('type');
    }
  }
  // By stored type, aliases and legacy names included: a widget saved as
  // "textbox" used to make every width/height edit throw a bare TypeError.
  const spec = specFor(widget.type);
  if (c.x !== undefined) {
    widget.xPosition = Math.round(Number(c.x) * 100) / 100;
    touched.push('x');
  }
  if (c.y !== undefined) {
    widget.yPosition = Math.round(Number(c.y) * 100) / 100;
    touched.push('y');
  }
  if (c.width !== undefined) {
    widget.Width =
      Math.round(Math.max(spec.minWidth, Number(c.width) || spec.minWidth) * 100) / 100;
    widget.IsResize = true;
    touched.push('width');
  }
  if (c.height !== undefined) {
    widget.Height =
      Math.round(Math.max(spec.minHeight, Number(c.height) || spec.minHeight) * 100) / 100;
    widget.IsResize = true;
    touched.push('height');
  }
  if (c.label !== undefined) {
    const hint = String(c.label || '')
      .trim()
      .slice(0, 40);
    if (hint) widget.options.hint = hint;
    else delete widget.options.hint;
    touched.push('label');
  }
  if (c.required !== undefined) {
    widget.options.status =
      c.required === false && widget.type !== 'signature' ? 'optional' : 'required';
    touched.push('required');
  }
  const storedType = normaliseWidgetType(widget.type) || widget.type;
  const previousValues = Array.isArray(widget.options?.values) ? [...widget.options.values] : [];
  if (c.values !== undefined) {
    if (!LIST_TYPES.has(storedType))
      throw fail(
        `values only apply to dropdown, radio button and checkbox fields (this is a ${widget.type}).`
      );
    const values = [
      ...new Set(
        (Array.isArray(c.values) ? c.values : []).map(v => String(v).trim()).filter(Boolean)
      ),
    ];
    if (!values.length) throw fail('values cannot be empty.');
    widget.options.values = values;
    if (c.height === undefined) widget.Height = heightForOptions(storedType, values.length);
    touched.push('values');
  }
  if (c.defaultValue !== undefined) {
    widget.options.defaultValue = normaliseDefaultValue(
      storedType,
      widget.options.values,
      c.defaultValue
    );
    touched.push('defaultValue');
  } else if (c.values !== undefined && LIST_TYPES.has(storedType)) {
    // New options: a stored default that no longer fits is dropped rather than
    // pointing at the wrong option.
    try {
      widget.options.defaultValue = normaliseDefaultValue(
        storedType,
        widget.options.values,
        presentDefaultValue(storedType, previousValues, widget.options.defaultValue)
      );
    } catch {
      widget.options.defaultValue = storedType === 'checkbox' ? [] : '';
    }
  }
  if (c.readOnly !== undefined) {
    widget.options.isReadOnly = c.readOnly === true;
    touched.push('readOnly');
  }
  if (c.hideLabel !== undefined) {
    if (!LIST_TYPES.has(storedType)) throw fail('hideLabel only applies to checkbox, radio button and dropdown fields.');
    widget.options.isHideLabel = c.hideLabel === true;
    touched.push('hideLabel');
  }
  if (c.dateFormat !== undefined && storedType === 'date') {
    widget.options.validation = { type: 'date-format', format: String(c.dateFormat) };
    touched.push('dateFormat');
  }
  if (!Number.isFinite(widget.xPosition) || !Number.isFinite(widget.yPosition))
    throw fail('x and y must be numbers.');

  let targetGroupIndex = found.gi;
  if (c.recipient !== undefined) {
    const ref = resolveGroupRef(signerGroups, recipients, c.recipient);
    if (ref === PREFILL_ROLE) {
      if (!prefillGroups.length) prefillGroups.push(newPrefillGroup());
      targetGroupIndex = signerGroups.length; // first prefill group (all = signers + prefill)
    } else {
      targetGroupIndex = ref;
    }
    touched.push('recipient');
  }
  const page = c.page !== undefined ? Math.max(1, Math.floor(Number(c.page) || 1)) : found.page;
  if (c.page !== undefined) touched.push('page');
  if (!touched.length)
    throw fail(
      'Nothing to change: pass at least one of x, y, page, width, height, label, required, values, defaultValue, readOnly, hideLabel, recipient, type, dateFormat.'
    );

  // Remove from the old spot, insert at the new one.
  const groupsNow = [...signerGroups, ...prefillGroups];
  const from = groupsNow[found.gi];
  from.placeHolder[found.pi].pos.splice(found.wi, 1);
  dropEmptyPages(from);
  pushWidget(groupsNow[targetGroupIndex], page, widget);

  const draft = await commit(
    caller,
    d,
    { Placeholders: groupsNow, Signers: signersFor(signerGroups) },
    { reason: `edit field ${widget.key} (${touched.join(', ')})`, origin }
  );
  const owner =
    targetGroupIndex < signerGroups.length ? recipients[targetGroupIndex]?.role : PREFILL_ROLE;
  return { ...draft, field: fieldJson(widget, page, owner), changed: touched };
}

/**
 * Remove fields by key, or every field matching recipient / type / page, or all
 * of them. At least one selector is required.
 */
export async function removeDraftFields(caller, docId, selector = {}, { origin = '' } = {}) {
  const d = await loadDraft(caller, docId);
  const { signerGroups, prefillGroups } = splitGroups(d);
  const recipients = recipientsFromGroups(d, signerGroups);
  const s = selector || {};
  const keys = new Set(
    (Array.isArray(s.keys) ? s.keys : s.key !== undefined ? [s.key] : []).map(k => String(k))
  );
  const type = s.type !== undefined ? normaliseWidgetType(s.type) : undefined;
  if (s.type !== undefined && !type) throw fail(`Unknown field type "${s.type}".`);
  const page = s.page !== undefined ? Number(s.page) : undefined;
  const groupRef =
    s.recipient !== undefined ? resolveGroupRef(signerGroups, recipients, s.recipient) : undefined;
  if (
    !keys.size &&
    type === undefined &&
    page === undefined &&
    groupRef === undefined &&
    s.all !== true
  ) {
    throw fail('Say what to remove: keys, recipient, type, page, or all: true.');
  }
  let removed = 0;
  const all = [...signerGroups, ...prefillGroups];
  all.forEach((g, gi) => {
    const isPrefill = gi >= signerGroups.length;
    if (groupRef !== undefined && !(groupRef === PREFILL_ROLE ? isPrefill : gi === groupRef))
      return;
    for (const p of g.placeHolder || []) {
      if (page !== undefined && Number(p.pageNumber) !== page) continue;
      const before = p.pos.length;
      p.pos = p.pos.filter(w => {
        if (keys.size && !keys.has(String(w.key)) && !keys.has(String(w.options?.name || '')))
          return true;
        // Compare normalised types, or a widget stored under a legacy name
        // ("textbox") could never be selected by type at all.
        if (type !== undefined && (normaliseWidgetType(w.type) || w.type) !== type) return true;
        return false;
      });
      removed += before - p.pos.length;
    }
    dropEmptyPages(g);
  });
  if (!removed) throw fail('No field matched.', Parse.Error.OBJECT_NOT_FOUND);
  const draft = await commit(
    caller,
    d,
    { Placeholders: all, Signers: signersFor(signerGroups) },
    { reason: `remove ${removed} field(s)`, origin }
  );
  return { ...draft, removed };
}

/* ------------------------------------------------------------------ AI layout */

function widgetsOfGroup(g) {
  const out = [];
  for (const p of g?.placeHolder || [])
    for (const w of p.pos || []) out.push({ page: Number(p.pageNumber) || 1, widget: w });
  return out;
}

/**
 * Which AI role belongs to which of the draft's recipients.
 *
 * The model is only asked in the prompt to keep the recipient order, and nothing
 * used to check that it did: role 0's widgets went to recipient 0 whatever the
 * proposal called them, so a model that listed the roles in document order
 * handed the tenant every landlord field, signature included, and review_draft
 * saw nothing wrong. Email is proof, the role label is strong evidence, and
 * position is only used for the slots neither of them claimed.
 *
 * @param {Array<{role: string, email: string}>} aiRoles proposal.roles.
 * @param {Array<{role: string, email: string}>} current the draft's recipients.
 * @returns {{forRecipient: number[], unmatchedAi: number[]}} indexes into aiRoles.
 */
export function pairAiRoles(aiRoles, current) {
  const forRecipient = current.map(() => -1);
  const takenAi = new Set();
  const pass = test => {
    current.forEach((r, i) => {
      if (forRecipient[i] !== -1) return;
      const a = aiRoles.findIndex((role, idx) => !takenAi.has(idx) && test(role, r));
      if (a === -1) return;
      forRecipient[i] = a;
      takenAi.add(a);
    });
  };
  pass(
    (role, r) =>
      Boolean(role?.email) && Boolean(r?.email) && String(role.email).toLowerCase() === r.email
  );
  pass(
    (role, r) =>
      Boolean(role?.role) &&
      Boolean(r?.role) &&
      String(role.role).toLowerCase() === String(r.role).toLowerCase()
  );
  const free = aiRoles.map((_, i) => i).filter(i => !takenAi.has(i));
  current.forEach((_, i) => {
    if (forRecipient[i] !== -1) return;
    const a = free.shift();
    if (a === undefined) return;
    forRecipient[i] = a;
    takenAi.add(a);
  });
  return { forRecipient, unmatchedAi: aiRoles.map((_, i) => i).filter(i => !takenAi.has(i)) };
}

/**
 * Run the AI over the draft's PDF again and apply its layout: the roles it finds
 * bind to the draft's recipients by email, then by role label, then by position
 * (or to `recipients` when given, which replaces the list first). `mode:
 * "replace"` (default) drops the current fields, `"append"` keeps them. When the
 * AI finds more roles than there are recipients and cannot infer their emails,
 * the layout is not applied and `needsRecipients` says which are missing.
 */
export async function aiLayoutDraft(
  caller,
  docId,
  { instructions = '', recipients, mode = 'replace', origin = '' } = {}
) {
  if (!isAiEnabled()) throw fail('AI is disabled on this server.', Parse.Error.SCRIPT_FAILED);
  if (mode !== 'replace' && mode !== 'append') throw fail('mode must be "replace" or "append".');
  let d = await loadDraft(caller, docId);
  let dropped = 0;
  let recipientsApplied = false;
  if (recipients !== undefined) {
    // The recipient change is independently valid and already snapshotted, so it
    // is committed before the model runs: it used to be thrown away whenever the
    // proposal turned out to need a recipient, leaving the caller with new
    // contacts, a model bill and the old recipient list.
    const plan = await planRecipients(caller, d, recipients);
    await commit(
      caller,
      d,
      {
        Placeholders: [...plan.signerGroups, ...plan.prefillGroups],
        Signers: signersFor(plan.signerGroups),
      },
      { reason: 'update recipients (ai layout)', origin }
    );
    dropped = plan.dropped;
    recipientsApplied = true;
    d = await loadDraft(caller, docId);
  }
  const { signerGroups, prefillGroups } = splitGroups(d);
  // Built from the reloaded document, so the names the caller just gave are the
  // ones the model is told about (they used to all resolve to "").
  const current = recipientsFromGroups(d, signerGroups).map(r => ({
    name: r.name,
    email: r.email,
    role: r.role,
  }));

  const bytes = await fetchPdfBytes(d.URL);
  const proposal = await analyzePdf({
    bytes,
    instructions: String(instructions || ''),
    recipients: current,
  });
  const aiRoles = proposal.roles || [];
  const { forRecipient, unmatchedAi } = pairAiRoles(aiRoles, current);
  // Bind in the proposal's own role order, so the emails follow the pairing.
  const perRole = aiRoles.map(() => null);
  forRecipient.forEach((a, i) => {
    if (a !== -1) perRole[a] = current[i];
  });
  const { recipients: bound, missing } = recipientsFromProposal(proposal, perRole, caller);
  const brief = {
    title: proposal.title,
    summary: proposal.summary,
    roles: proposal.roles,
    warnings: proposal.warnings,
    fieldCount: proposal.fields?.length ?? 0,
  };
  if (missing.length) {
    return {
      ...(await draftDetail(caller, d)),
      applied: false,
      recipientsApplied,
      needsRecipients: missing,
      proposal: brief,
    };
  }

  const aiSigner = (proposal.placeholders || []).filter(g => g?.Role !== PREFILL_ROLE);
  const aiPrefill = (proposal.placeholders || []).filter(g => g?.Role === PREFILL_ROLE);
  const zRef = { z: mode === 'append' ? maxZ([...signerGroups, ...prefillGroups]) : 0 };
  const usedKeys = fieldKeysIn([...signerGroups, ...prefillGroups]);
  const restamp = w => ({ ...w, key: randomKey(8, usedKeys), zIndex: ++zRef.z });

  const nextGroups = [];
  signerGroups.forEach((existing, i) => {
    const a = forRecipient[i];
    const group = { ...existing, blockColor: roleColor(i) };
    if (/^Role \d+$/.test(String(group.Role || '')) && aiSigner[a]?.Role)
      group.Role = aiSigner[a].Role;
    if (mode === 'replace') delete group.placeHolder;
    else group.placeHolder = (group.placeHolder || []).map(p => ({ ...p, pos: [...p.pos] }));
    for (const { page, widget } of widgetsOfGroup(aiSigner[a]))
      pushWidget(group, page, restamp(widget));
    nextGroups.push(group);
  });
  for (const a of unmatchedAi) {
    const index = nextGroups.length;
    const contact = await ensureContact(caller, bound[a]);
    const group = {
      Id: randomKey(8),
      Role: bound[a].role,
      blockColor: roleColor(index),
      signerObjId: contact.objectId,
      signerPtr: pointerOrEmpty(contact.objectId),
      email: bound[a].email,
    };
    for (const { page, widget } of widgetsOfGroup(aiSigner[a]))
      pushWidget(group, page, restamp(widget));
    nextGroups.push(group);
  }
  let nextPrefill = prefillGroups;
  if (mode === 'replace') nextPrefill = [];
  if (aiPrefill.length) {
    if (!nextPrefill.length) nextPrefill = [newPrefillGroup()];
    for (const g of aiPrefill)
      for (const { page, widget } of widgetsOfGroup(g))
        pushWidget(nextPrefill[0], page, restamp(widget));
  }
  const patch = { Placeholders: [...nextGroups, ...nextPrefill], Signers: signersFor(nextGroups) };
  if (proposal.signingOrderMatters && nextGroups.length > 1 && !d.SendinOrder)
    patch.SendinOrder = true;
  const draft = await commit(caller, d, patch, { reason: `ai layout (${mode})`, origin });
  return {
    ...draft,
    applied: true,
    mode,
    recipientsApplied,
    droppedFields: dropped || undefined,
    proposal: brief,
  };
}

/* ------------------------------------------------------------------ review */

/**
 * The name a request from this caller goes out under, when it would be the
 * platform's own name: no workspace sender name, no company on the profile and
 * "use my name as sender" off. That is exactly how a customer receives an
 * unbranded mail, so review_draft and send_document point it out.
 */
export async function unbrandedSenderWarning(caller) {
  try {
    const branding = await resolveTenantBranding({ extUserId: caller?.extUserId });
    if (branding.senderName) return null;
    const effective = senderDisplayName({
      senderName: caller?.name,
      company: caller?.company,
      useNameAsSender: caller?.useNameAsSender,
    });
    if (effective !== appName) return null;
    return {
      code: 'unbranded_sender',
      message: `Emails will go out as "${appName}": set a company on your profile, turn on "use my name as sender", or set the workspace sender name (update_branding { senderName }).`,
    };
  } catch {
    return null;
  }
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Readiness check: what is wrong (blocks sending), what looks off (worth a
 * look), and what is just informational. Works on any owned document, but only
 * a draft can be fixed.
 */
export async function reviewDraft(caller, docId) {
  const d = await loadOwnedDocument(caller, docId);
  const detail = await draftDetail(caller, d, { pages: true });
  const errors = [];
  const warnings = [];
  const info = [];
  const add = (list, code, message, extra = {}) => list.push({ code, message, ...extra });

  if (detail.status !== 'draft')
    add(
      info,
      'not_a_draft',
      `Document is ${detail.status.replace('_', ' ')}: it can be reviewed but not edited.`
    );
  if (!detail.name || detail.name === 'Untitled document')
    add(warnings, 'untitled', 'Give the document a meaningful title.');
  if (detail.pagesError)
    add(errors, 'pdf_unreadable', `The PDF could not be read: ${detail.pagesError}`);
  const pageCount = detail.pages?.length || 0;

  if (!detail.recipients.length) add(errors, 'no_recipients', 'Add at least one recipient.');
  const seen = new Map();
  for (const r of detail.recipients) {
    const who = r.role + (r.email ? ` <${r.email}>` : '');
    if (!r.email)
      add(errors, 'recipient_without_email', `${r.role} has no email address.`, {
        recipient: r.role,
      });
    else if (!isValidEmail(r.email))
      add(errors, 'recipient_bad_email', `${who}: "${r.email}" is not a valid email.`, {
        recipient: r.role,
      });
    if (r.email && seen.has(r.email))
      add(
        errors,
        'duplicate_recipient',
        `${r.email} appears twice (${seen.get(r.email)} and ${r.role}).`
      );
    seen.set(r.email, r.role);
    if (!r.contactId)
      add(
        errors,
        'recipient_not_bound',
        `${who} is not linked to a contact; set the recipients again with update_draft.`,
        { recipient: r.role }
      );
    if (!r.fields.length)
      add(warnings, 'recipient_without_fields', `${who} has no fields to fill or sign.`, {
        recipient: r.role,
      });
    else if (!r.fields.some(f => SIGNING_TYPES.has(f.type))) {
      add(
        warnings,
        'recipient_without_signature',
        `${who} has fields but no signature, initials or stamp field.`,
        { recipient: r.role }
      );
    }
  }
  // Prefill boxes are the owner's own, so they do not count here: a draft whose
  // only fields were prefill used to report ready to send while every signer got
  // a link with nothing to do.
  const signerFieldCount = detail.recipients.reduce((n, r) => n + r.fields.length, 0);
  if (!signerFieldCount) {
    add(
      errors,
      'no_fields',
      detail.fieldCount
        ? 'Every field belongs to the sender: place at least one field for a signer.'
        : 'Place at least one field.'
    );
  }

  const allFields = [...detail.recipients.flatMap(r => r.fields), ...detail.prefillFields];
  for (const f of allFields) {
    const label = `${f.type} field ${f.key} (${f.recipient}, page ${f.page})`;
    if (pageCount && f.page > pageCount) {
      add(
        errors,
        'field_off_document',
        `${label} is on page ${f.page} but the PDF has ${pageCount} page(s).`,
        { key: f.key }
      );
      continue;
    }
    const pg = detail.pages?.[f.page - 1];
    if (pg) {
      const slack = 1;
      if (
        f.x < -slack ||
        f.y < -slack ||
        f.x + f.width > pg.width + slack ||
        f.y + f.height > pg.height + slack
      ) {
        add(
          errors,
          'field_outside_page',
          `${label} sits outside the page (${pg.width} x ${pg.height} pt): x=${f.x}, y=${f.y}, ${f.width} x ${f.height}.`,
          { key: f.key }
        );
      }
    }
    if (f.recipient === PREFILL_ROLE && f.defaultValue === undefined) {
      const fillable = TEXT_TYPES.has(f.type) || LIST_TYPES.has(f.type);
      if (fillable && f.required) {
        add(
          warnings,
          'prefill_required_empty',
          `Required prefill ${f.type} field ${f.key} has no value; it goes to the signer unfilled.` +
            (f.type === 'checkbox'
              ? ' Set defaultValue to the option(s) to tick.'
              : ' Set defaultValue.'),
          { key: f.key }
        );
      } else if (TEXT_TYPES.has(f.type)) {
        add(
          info,
          'prefill_empty',
          `Prefill ${f.type} field ${f.key} has no value yet; set defaultValue before sending or the signer sees a blank.`,
          { key: f.key }
        );
      }
    }
    if (
      f.recipient !== PREFILL_ROLE &&
      !f.required &&
      TEXT_TYPES.has(f.type) &&
      f.defaultValue === undefined
    ) {
      add(
        warnings,
        'optional_text_field',
        `Optional ${f.type} field ${f.key} (${f.recipient}): if the signer leaves it empty it prints as a blank line. Make it required or give it a defaultValue if that matters.`,
        { key: f.key }
      );
    }
  }
  for (const r of detail.recipients) {
    const hasSignature = r.fields.some(f => SIGNING_TYPES.has(f.type));
    const hasDate = r.fields.some(f => f.type === 'date');
    if (hasSignature && !hasDate) {
      add(
        warnings,
        'signature_without_date',
        `${r.role}${r.email ? ` <${r.email}>` : ''} signs but has no date field next to the signature.`,
        { recipient: r.role }
      );
    }
  }
  for (let i = 0; i < allFields.length; i++) {
    for (let j = i + 1; j < allFields.length; j++) {
      const a = allFields[i];
      const b = allFields[j];
      if (a.page !== b.page) continue;
      if (boxesOverlap(a, b)) {
        add(
          warnings,
          'fields_overlap',
          `${a.type} ${a.key} (${a.recipient}) and ${b.type} ${b.key} (${b.recipient}) overlap on page ${a.page}.`,
          { keys: [a.key, b.key] }
        );
      }
    }
  }

  const s = detail.settings;
  if (s.remindEveryDays > 0 && s.expiryDays / s.remindEveryDays > 15) {
    add(
      errors,
      'too_many_reminders',
      `expiryDays ${s.expiryDays} / remindEveryDays ${s.remindEveryDays} would send more than 15 reminders.`
    );
  }
  if (s.sendInOrder && detail.recipients.length < 2)
    add(info, 'order_single_recipient', 'Signing order is on but there is only one recipient.');
  if (s.otp) add(info, 'otp_on', 'Signers must enter an email one-time code before signing.');
  if (detail.message.subject && detail.message.subject.length > 200)
    add(warnings, 'long_subject', 'The email subject is very long.');
  const linkWarning = messageLint(detail.message);
  if (linkWarning) add(warnings, linkWarning.code, linkWarning.message);
  const unbranded = await unbrandedSenderWarning(caller);
  if (unbranded) add(warnings, unbranded.code, unbranded.message);

  return {
    objectId: detail.objectId,
    name: detail.name,
    status: detail.status,
    revision: detail.revision,
    readyToSend: detail.status === 'draft' && !errors.length,
    errors,
    warnings,
    info,
    summary: {
      recipients: detail.recipients.length,
      fields: detail.fieldCount,
      prefillFields: detail.prefillFields.length,
      pages: pageCount || undefined,
      versions: detail.versions,
    },
    recipients: detail.recipients.map(r => ({
      order: r.order,
      role: r.role,
      name: r.name,
      email: r.email,
      fields: r.fields.length,
      signatureFields: r.fields.filter(f => SIGNING_TYPES.has(f.type)).length,
    })),
    urls: detail.urls,
  };
}

/* ------------------------------------------------------------------ copy, delete */

/**
 * What a completed signing run leaves on a placeholder group or a widget: the
 * signature image url and the moment it was captured. A copy must carry none of
 * it, or the new draft ships with the previous signer's signature already on it.
 */
/**
 * Placeholders in the grouped shape.
 *
 * A self-signed document stores a flat `[{pageNumber, pos}]` array with no
 * signer wrapper (the older copy paths special-case it). Left alone, every
 * helper here reads it as a list of role groups with no fields, so a copy came
 * out with zero fields, nameless recipients and no way to send it.
 */
function groupedPlaceholders(d) {
  const list = d?.Placeholders || [];
  const flat =
    list.length > 0 &&
    list.every(entry => entry?.pageNumber !== undefined && Array.isArray(entry?.pos));
  if (!flat) return list;
  return [
    {
      Id: randomKey(8),
      Role: PREFILL_ROLE,
      Name: 'Prefill by owner',
      blockColor: roleColor(0, true),
      signerObjId: '',
      signerPtr: {},
      email: '',
      placeHolder: list.map(p => ({
        pageNumber: Number(p.pageNumber) || 1,
        pos: [...(p.pos || [])],
      })),
    },
  ];
}

/** A new draft that copies an owned document (any status): file, recipients, fields, settings, message. */
export async function duplicateDocument(caller, docId, { name, origin = '' } = {}) {
  const d = await loadOwnedDocument(caller, docId);
  const source = { ...d, Placeholders: groupedPlaceholders(d) };
  const { signerGroups, prefillGroups } = splitGroups(source);
  // Nothing of the previous signing run travels into the copy: no captured
  // response, no signature image, no per-signer signed url. One helper does that
  // for every copy path in the product (`lib/widgets.resetPlaceholdersForCopy`);
  // fresh field keys so the copy and the original can be edited independently.
  const placeholders = resetPlaceholdersForCopy([...signerGroups, ...prefillGroups], {
    newKeys: true,
  })
    .map(g => (isParticipantBasic(g) ? reseedAutofillDefaults(g, contactFor(source, g) || {}) : g))
    .map(cleanGroup);
  const doc = new Parse.Object('contracts_Document');
  doc.set(
    'Name',
    String(name || `${d.Name || 'Untitled document'} (copy)`)
      .trim()
      .slice(0, MAX_NAME_LENGTH)
  );
  doc.set('URL', d.URL);
  doc.set('ExtUserPtr', extUserPointer(caller));
  doc.set('CreatedBy', userPointer(caller));
  if (d.Note) doc.set('Note', d.Note);
  if (d.Description) doc.set('Description', d.Description);
  doc.set('SentToOthers', false);
  doc.set('IsTourEnabled', false);
  for (const f of [
    'SendinOrder',
    'SendInOrderStrict',
    'IsEnableOTP',
    'AllowModifications',
    'AutomaticReminders',
    'NotifyOnSignatures',
  ]) {
    if (typeof d[f] === 'boolean') doc.set(f, d[f]);
  }
  doc.set('RemindOnceInEvery', Number(d.RemindOnceInEvery) || 5);
  doc.set('TimeToCompleteDays', Number(d.TimeToCompleteDays) || 15);
  // Same helper as everywhere else: the copy's clock starts now and re-anchors
  // on DocSentAt when it goes out.
  const { ExpiryDate, NextReminderDate } = scheduleFieldsFor({
    TimeToCompleteDays: Number(d.TimeToCompleteDays) || 15,
    AutomaticReminders: d.AutomaticReminders === true,
    RemindOnceInEvery: Number(d.RemindOnceInEvery) || 5,
  });
  if (ExpiryDate) doc.set('ExpiryDate', ExpiryDate);
  if (NextReminderDate) doc.set('NextReminderDate', NextReminderDate);
  if (d.RedirectUrl) doc.set('RedirectUrl', d.RedirectUrl);
  if (Array.isArray(d.Bcc) && d.Bcc.length) doc.set('Bcc', d.Bcc);
  if (Array.isArray(d.Cc) && d.Cc.length) doc.set('Cc', d.Cc);
  if (d.RequestSubject) doc.set('RequestSubject', d.RequestSubject);
  if (d.RequestBody) doc.set('RequestBody', d.RequestBody);
  if (d.SignatureType) doc.set('SignatureType', d.SignatureType);
  const folder = cleanPointer(d.Folder, 'contracts_Document');
  if (folder) doc.set('Folder', folder);
  if (d.TemplateId?.objectId)
    doc.set('TemplateId', cleanPointer(d.TemplateId, 'contracts_Template'));
  doc.set('Placeholders', placeholders);
  doc.set('Signers', signersFor(signerGroups));
  // Same file, so the page geometry is already known.
  if (d.PageSizes?.url === d.URL) doc.set('PageSizes', d.PageSizes);
  if (origin) doc.set('CreatedVia', String(origin).slice(0, 40));
  const saved = await doc.save(null, { useMasterKey: true });
  setDocumentCount(caller.extUserId);
  return { ...(await getDraft(caller, saved.id)), copiedFrom: d.objectId };
}

/**
 * Soft delete (the same `IsArchive` flag the web app's delete uses). Drafts by
 * default; `force: true` archives a sent/completed document too. Undo with
 * `restoreDeletedDocument`.
 */
export async function deleteDocument(caller, docId, { force = false } = {}) {
  const d = await loadOwnedDocument(caller, docId);
  const status = documentStatus(d);
  if (status !== 'draft' && !force) {
    throw fail(
      `This document is ${status.replace('_', ' ')}. Pass force: true to archive it anyway.`,
      Parse.Error.SCRIPT_FAILED
    );
  }
  const update = new Parse.Object('contracts_Document');
  update.id = d.objectId;
  update.set('IsArchive', true);
  await update.save(null, { useMasterKey: true });
  return { objectId: d.objectId, name: d.Name, status, deleted: true, restorable: true };
}

export async function restoreDeletedDocument(caller, docId) {
  const q = new Parse.Query('contracts_Document');
  q.include('CreatedBy');
  q.include('ExtUserPtr');
  let obj;
  try {
    obj = await q.get(String(docId || ''), { useMasterKey: true });
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND)
      throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
    throw err;
  }
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  if (d.IsArchive !== true) throw fail('This document is not deleted.', Parse.Error.SCRIPT_FAILED);
  const update = new Parse.Object('contracts_Document');
  update.id = d.objectId;
  update.unset('IsArchive');
  await update.save(null, { useMasterKey: true });
  return { ...(await getDraft(caller, d.objectId)), restored: true };
}

export async function listDeletedDocuments(caller, { limit = 25 } = {}) {
  const q = new Parse.Query('contracts_Document');
  q.equalTo('CreatedBy', userPointer(caller));
  q.equalTo('IsArchive', true);
  q.doesNotExist('Type');
  q.descending('updatedAt');
  q.limit(Math.min(Math.max(1, Number(limit) || 25), 200));
  const rows = await q.find({ useMasterKey: true });
  return rows.map(r => {
    const d = JSON.parse(JSON.stringify(r));
    return {
      objectId: d.objectId,
      name: d.Name,
      status: documentStatus(d),
      deletedAt: d.updatedAt,
      fieldCount: countFields(d.Placeholders),
    };
  });
}
