import crypto from 'node:crypto';
import { appName } from '../../Utils.js';
import { isAiEnabled } from '../ai/client.js';
import { reviewDocument } from '../ai/review.js';
import { safeErrorMessage } from '../api/shared.js';
import { checkRateLimit } from '../parsefunction/authGuard.js';
import sendSystemMail from '../parsefunction/sendSystemMail.js';
import {
  agentSignDocument,
  assertAgentTurn,
  isOwnDocument,
  prepareAgentSignature,
} from './agentSign.js';
import { agentIdentity, agentLabel, verifiedIdentityProblem } from './agentIdentity.js';
import { conditionalUpdate, readFresh } from './atomic.js';
import { extUserPointer, userPointer } from './context.js';
import { normaliseEmail } from './email.js';
import { getParticipantDocument } from './inbox.js';
import { renderMail, strong } from './mailShell.js';
import { signingScopeProblem } from './oauth.js';
import { renderParticipantPreview } from './preview.js';
import { resolveAppOrigin } from './requestMail.js';

/**
 * "Your agent wants to sign this for you": the approval an agent needs before
 * it signs a document someone else sent its user.
 *
 * `sign_document` on such a document does not sign. It checks everything a
 * signature would need (lib/agentSign.js `prepareAgentSignature`), stores what
 * would be filled in, asks the AI for a read of the terms, emails the user and
 * returns the request. The user then approves or declines:
 *  - in DocuStamp (`/approvals/:id`, a signed-in session), or
 *  - in the chat card, only in hosts that keep the tool result's `_meta` from
 *    the model (CHAT_APPROVAL_HOSTS, ChatGPT first). The card gets a single-use
 *    code there; only its hash is stored, it expires after a day, it is tied to
 *    the app that asked, and any decision spends it.
 *
 * Deciding claims the row with a conditional write (pending -> approving), so a
 * web click and a chat click racing each other sign at most once. Approving
 * re-checks the seat, the turn and the values, then signs the current copy
 * with the agent that asked recorded, and how the user allowed it.
 *
 * A request goes stale by itself, checked on every read: the document ended
 * (completed, declined, voided, expired or deleted), the user signed some other
 * way, or the file, the seats or the signers changed since it was made. A
 * co-signer signing does not count: the fingerprint leaves the signed copy out.
 *
 * Rows are master-key only (class permissions and an empty ACL on every row).
 */

export const APPROVAL_CLASS = 'contracts_SignApproval';

/** What `Status` holds. `approving` is the short claim while the signature is made. */
export const APPROVAL_STATUSES = Object.freeze([
  'pending',
  'approving',
  'signed',
  'declined',
  'failed',
  'expired',
]);

const DECISIONS = new Set(['approve', 'decline']);
const VIA = new Set(['web', 'chat']);

/** How long the chat card's approval code works. The web page works until the request ends. */
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim this old with no outcome is a signature that never reported back. */
const STUCK_CLAIM_MS = 5 * 60 * 1000;
/** New requests per user per minute (each one may cost an AI review and an email). */
const CREATE_PER_MIN = 10;
/** How long sign_document waits for the AI review before answering without it. */
const REVIEW_WAIT_MS = 25 * 1000;
const LIST_LIMIT = 100;
const WAIT_MAX_SECONDS = 55;
const WAIT_POLL_MS = 1500;
const PAGE_SCALE = 1.25;

/** Hosts whose apps may approve in the chat when nothing is configured. */
const DEFAULT_CHAT_HOSTS = 'chatgpt.com';

const LOCKED_CLP = {
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
};

/** The document columns a request is checked against, read raw (no afterFind). */
const DOC_KEYS = [
  'URL',
  'Placeholders',
  'Signers',
  'AuditTrail',
  'IsCompleted',
  'IsDeclined',
  'IsVoided',
  'IsArchive',
  'ExpiryDate',
];

let approvalMailer = async params => await sendSystemMail({ params });
/** Test seam: replace the transport the "wants to sign for you" email goes through. */
export function setApprovalMailTransport(fn) {
  approvalMailer = fn || (async params => await sendSystemMail({ params }));
}

function fail(message, code = Parse.Error.SCRIPT_FAILED) {
  return new Parse.Error(code, message);
}

function notFound() {
  return fail('Approval not found.', Parse.Error.OBJECT_NOT_FOUND);
}

/* ------------------------------------------------------------------ schema */

let schemaReady = false;

/**
 * Create the class, locked, before the first write. The migration
 * (databases/migrations/20261001120000-create_contracts_signapproval.cjs) does
 * the same; this covers a server that has not run it yet, because a class that
 * a master-key save creates on its own gets public permissions.
 */
async function ensureApprovalSchema() {
  if (schemaReady) return;
  const schema = new Parse.Schema(APPROVAL_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (!existing) {
    schema.addPointer('Document', 'contracts_Document');
    schema.addString('ContactId');
    schema.addPointer('User', '_User');
    schema.addPointer('ExtUserPtr', 'contracts_Users');
    schema.addObject('Agent');
    schema.addDate('SigningEnabledAt');
    schema.addObject('Fields');
    schema.addArray('Values');
    schema.addObject('DocumentInfo');
    schema.addObject('Review');
    schema.addString('Fingerprint');
    schema.addString('Status');
    schema.addString('NonceHash');
    schema.addDate('NonceExpiresAt');
    schema.addString('NonceClientId');
    schema.addDate('ExpiresAt');
    schema.addDate('DecidedAt');
    schema.addString('DecidedVia');
    schema.addString('Error');
    schema.setCLP(LOCKED_CLP);
    try {
      await schema.save();
    } catch (err) {
      if (!/already exists/i.test(err?.message || '')) throw err;
    }
  }
  schemaReady = true;
}

/* ------------------------------------------------------------------ helpers */

function hashNonce(nonce) {
  return crypto.createHash('sha256').update(String(nonce), 'utf8').digest('hex');
}

function mintNonce() {
  const nonce = crypto.randomBytes(32).toString('base64url');
  return { nonce, hash: hashNonce(nonce) };
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value?.iso || value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOf(value) {
  return toDate(value)?.toISOString() || null;
}

function contactIdOf(group) {
  return group?.signerObjId || group?.signerPtr?.objectId || '';
}

/** Hosts (lower case) whose apps may approve in the chat; `none` turns it off. */
export function chatApprovalHosts() {
  const raw = String(process.env.CHAT_APPROVAL_HOSTS || '').trim() || DEFAULT_CHAT_HOSTS;
  if (raw.toLowerCase() === 'none') return [];
  return raw
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether this caller's app may approve in the chat: an OAuth app whose sign-in
 * redirected to a host known to keep the tool result's `_meta` from the model.
 * Anywhere else the code would sit where the model can read it and press the
 * button itself, so the card sends the user to DocuStamp instead.
 */
export function canApproveInChat(caller) {
  const host = String(caller?.oauth?.redirectHost || '').toLowerCase();
  return Boolean(caller?.oauth && host && chatApprovalHosts().includes(host));
}

/** The approval's page in the web app. */
export function approvalUrl(caller, approvalId) {
  return `${resolveAppOrigin(caller?.publicUrl)}/approvals/${approvalId}`;
}

/**
 * What a request is checked against: the file, the seats and the signers. Not
 * the signed copy or the audit trail, which move every time a co-signer signs.
 */
export function approvalFingerprint(raw) {
  const seats = (Array.isArray(raw?.Placeholders) ? raw.Placeholders : []).map(g => [
    String(g?.Id ?? ''),
    String(g?.Role ?? ''),
    contactIdOf(g),
  ]);
  const signers = (Array.isArray(raw?.Signers) ? raw.Signers : []).map(s => s?.objectId || '');
  const url = String(raw?.URL || '').split('?')[0];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ url, seats, signers }), 'utf8')
    .digest('hex');
}

/** The agent's answers in one stable form, so two requests can be compared. */
function canonicalFields(fields) {
  const out = {};
  for (const key of Object.keys(fields || {}).sort()) {
    const value = fields[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function sameFields(a, b) {
  return JSON.stringify(canonicalFields(a)) === JSON.stringify(canonicalFields(b));
}

function missingMessage(missing) {
  const list = missing.map(m => `${m.label} (field ${m.key}): ${m.reason}`).join(' ');
  return `Your agent cannot sign this yet, so nothing was sent for approval. ${list}`;
}

/* ------------------------------------------------------------------ shape */

/**
 * The approval as the web app, the chat card and the model see it. Never the
 * approval code or its hash.
 *
 * @param {Parse.Object} row
 * @returns {Object} the contract's `Approval`.
 */
export function approvalJson(row) {
  const info = row.get('DocumentInfo') || {};
  const agent = row.get('Agent') || {};
  return {
    id: row.id,
    status: row.get('Status'),
    createdAt: isoOf(row.createdAt),
    decidedAt: isoOf(row.get('DecidedAt')),
    decidedVia: row.get('DecidedVia') || null,
    error: row.get('Error') || null,
    expiresAt: isoOf(row.get('ExpiresAt')),
    document: {
      id: row.get('Document')?.id || '',
      title: info.title || '',
      senderName: info.senderName || '',
      senderCompany: info.senderCompany || '',
      senderEmail: info.senderEmail || '',
      pageCount: info.pageCount || undefined,
    },
    agent: { name: agent.name || 'AI agent', host: agent.host || '', kind: agent.kind || '' },
    values: (row.get('Values') || []).map(v => ({
      key: String(v.key),
      type: v.type,
      label: v.label,
      value: v.value ?? null,
      page: v.page,
    })),
    review: row.get('Review') || null,
  };
}

/* ------------------------------------------------------------------ reads */

async function loadRow(approvalId) {
  await ensureApprovalSchema();
  const id = String(approvalId || '').trim();
  if (!id || id.length > 64) throw notFound();
  const query = new Parse.Query(APPROVAL_CLASS);
  try {
    return await query.get(id, { useMasterKey: true });
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND) throw notFound();
    throw err;
  }
}

/** The caller's own approval; anybody else's reads as not found. */
async function loadOwnRow(caller, approvalId) {
  const row = await loadRow(approvalId);
  if (!caller?.userId || row.get('User')?.id !== caller.userId) throw notFound();
  return row;
}

function signedContactIds(raw) {
  const ids = new Set();
  for (const entry of Array.isArray(raw?.AuditTrail) ? raw.AuditTrail : []) {
    if (entry?.Activity === 'Signed' && entry?.UserPtr?.objectId) ids.add(entry.UserPtr.objectId);
  }
  return ids;
}

/** Why a pending request can no longer be approved, or null while it still can. */
async function staleReason(row) {
  const raw = await readFresh('contracts_Document', row.get('Document')?.id, DOC_KEYS);
  if (!raw || raw.IsArchive === true) return 'The document is no longer available.';
  if (raw.IsDeclined === true && raw.IsVoided === true) return 'The sender voided the document.';
  if (raw.IsDeclined === true) return 'The document was declined.';
  if (raw.IsCompleted === true) return 'The document is already completed.';
  const now = Date.now();
  const docExpiry = toDate(raw.ExpiryDate);
  if (docExpiry && docExpiry.getTime() < now) return 'The document has expired.';
  const expiresAt = toDate(row.get('ExpiresAt'));
  if (expiresAt && expiresAt.getTime() < now) return 'The document has expired.';
  if (signedContactIds(raw).has(row.get('ContactId'))) {
    return 'You have already signed this document.';
  }
  if (approvalFingerprint(raw) !== row.get('Fingerprint')) {
    return 'The document changed after your agent asked, so your agent has to ask again.';
  }
  return null;
}

/**
 * Bring a row up to date before anyone reads it: a pending request whose
 * document moved on expires, and a claim that never reported back is settled
 * from the audit trail. Both are conditional writes, so a decision landing at
 * the same moment wins.
 */
async function settle(row) {
  const status = row.get('Status');
  if (status === 'pending') {
    const reason = await staleReason(row);
    if (!reason) return row;
    await conditionalUpdate(
      APPROVAL_CLASS,
      row.id,
      { Status: 'pending' },
      { Status: 'expired', Error: reason, NonceHash: null, NonceExpiresAt: null }
    );
    return await loadRow(row.id);
  }
  if (status === 'approving' && Date.now() - row.updatedAt.getTime() > STUCK_CLAIM_MS) {
    const raw = await readFresh('contracts_Document', row.get('Document')?.id, DOC_KEYS);
    const signed = signedContactIds(raw).has(row.get('ContactId'));
    await conditionalUpdate(
      APPROVAL_CLASS,
      row.id,
      { Status: 'approving' },
      signed
        ? { Status: 'signed' }
        : { Status: 'failed', Error: 'Signing did not finish. Ask your agent to try again.' }
    );
    return await loadRow(row.id);
  }
  return row;
}

/** Pending requests for one seat, oldest first, each settled. */
async function pendingForSeat(docId, contactId) {
  await ensureApprovalSchema();
  const query = new Parse.Query(APPROVAL_CLASS);
  query.equalTo('Document', { __type: 'Pointer', className: 'contracts_Document', objectId: docId });
  query.equalTo('ContactId', contactId);
  query.equalTo('Status', 'pending');
  query.ascending('createdAt');
  query.limit(20);
  const rows = await query.find({ useMasterKey: true });
  const settled = await Promise.all(rows.map(settle));
  return settled.filter(r => r.get('Status') === 'pending');
}

async function expireAsReplaced(row) {
  await conditionalUpdate(
    APPROVAL_CLASS,
    row.id,
    { Status: 'pending' },
    {
      Status: 'expired',
      Error: 'Your agent asked again with different values, so this request was replaced.',
      NonceHash: null,
      NonceExpiresAt: null,
    }
  );
}

/**
 * The caller's requests, newest first.
 *
 * @param {import('./context.js').Caller} caller
 * @param {{status?: 'pending'|'all'}} [opts]
 * @returns {Promise<Object[]>} Approval[]
 */
export async function listApprovals(caller, { status = 'pending' } = {}) {
  const bucket = status || 'pending';
  if (bucket !== 'pending' && bucket !== 'all') {
    throw fail('status must be "pending" or "all".', Parse.Error.VALIDATION_ERROR);
  }
  await ensureApprovalSchema();
  const query = new Parse.Query(APPROVAL_CLASS);
  query.equalTo('User', userPointer(caller));
  if (bucket === 'pending') query.equalTo('Status', 'pending');
  query.descending('createdAt');
  query.limit(LIST_LIMIT);
  const rows = await Promise.all((await query.find({ useMasterKey: true })).map(settle));
  return rows
    .filter(row => bucket === 'all' || row.get('Status') === 'pending')
    .map(approvalJson);
}

/**
 * One of the caller's requests.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} approvalId
 */
export async function getApproval(caller, approvalId) {
  return approvalJson(await settle(await loadOwnRow(caller, approvalId)));
}

/**
 * One page of the document as the user will sign it, for the approval page.
 * Only the user's own fields are drawn (lib/preview.js `renderParticipantPreview`).
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} approvalId
 * @param {number} [page]
 * @returns {Promise<{image: string, page: number, pageCount: number}>}
 */
export async function getApprovalPage(caller, approvalId, page) {
  const row = await loadOwnRow(caller, approvalId);
  const problem = verifiedIdentityProblem(caller);
  if (problem) throw fail(problem, Parse.Error.OPERATION_FORBIDDEN);
  const out = await renderParticipantPreview(caller, row.get('Document')?.id, {
    page,
    scale: PAGE_SCALE,
  });
  return {
    image: `data:image/png;base64,${Buffer.from(out.png).toString('base64')}`,
    page: out.page,
    pageCount: out.pageCount,
  };
}

/**
 * Wait until the user decides (or the request ends), for up to `waitSec`.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} approvalId
 * @param {{waitSec?: number}} [opts]
 * @returns {Promise<{approval: Object, decided: boolean, waitedMs: number, timedOut?: boolean}>}
 */
export async function waitForApproval(caller, approvalId, { waitSec = 30 } = {}) {
  const started = Date.now();
  const limit = Math.min(WAIT_MAX_SECONDS, Math.max(0, Number(waitSec) || 0)) * 1000;
  let approval = await getApproval(caller, approvalId);
  const open = a => a.status === 'pending' || a.status === 'approving';
  /* eslint-disable no-await-in-loop -- a long poll, one read at a time */
  while (open(approval) && Date.now() - started + WAIT_POLL_MS <= limit) {
    await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
    approval = await getApproval(caller, approvalId);
  }
  /* eslint-enable no-await-in-loop */
  const decided = !open(approval);
  return {
    approval,
    decided,
    waitedMs: Date.now() - started,
    ...(decided ? {} : { timedOut: true }),
  };
}

/* ------------------------------------------------------------------ create */

/** The AI's read of the terms, or null (AI off, over budget, or it failed). Never throws. */
async function reviewOrNull(caller, docId) {
  if (!isAiEnabled()) return null;
  try {
    return await reviewDocument(caller, docId);
  } catch (err) {
    console.log('approvals: review skipped', err?.message || err);
    return null;
  }
}

function senderLine(info) {
  const who = info.senderName || info.senderEmail || 'Someone';
  return info.senderCompany && info.senderCompany !== who ? `${who} (${info.senderCompany})` : who;
}

function approvalMailHtml({ caller, agent, info, url }) {
  const title = info.title || 'a document';
  return renderMail({
    title: `${agent.name} wants to sign for you`,
    preheader: `${agent.name} wants to sign ${title} for you. Nothing is signed until you approve.`,
    greeting: caller.name ? `Hi ${caller.name},` : '',
    paragraphs: [
      `${strong(agentLabel(agent))} asked to sign ${strong(title)} for you. ${strong(senderLine(info))} sent it to you.`,
      'Nothing is signed until you approve. Check the document and what will be filled in, then approve or decline.',
    ],
    details: [
      { label: 'Document', value: title },
      { label: 'From', value: senderLine(info) },
      { label: 'Asked by', value: agentLabel(agent) },
    ],
    cta: { url, label: 'Review and approve' },
  });
}

async function mailUser(caller, row) {
  const recipient = normaliseEmail(caller?.email);
  if (!recipient) return;
  const agent = row.get('Agent') || {};
  const info = row.get('DocumentInfo') || {};
  try {
    const res = await approvalMailer({
      extUserId: caller.extUserId,
      from: appName,
      recipient,
      subject: `${agent.name} wants to sign "${info.title}" for you`,
      html: approvalMailHtml({ caller, agent, info, url: approvalUrl(caller, row.id) }),
    });
    if (res?.status !== 'success') {
      console.log('approvals: request mail not sent', res?.reason || res?.message || res?.status);
    }
  } catch (err) {
    console.log('approvals: request mail not sent', err?.message || err);
  }
}

/** A fresh approval code on a pending row, or null when the row was decided meanwhile. */
async function rotateNonce(row, caller) {
  const { nonce, hash } = mintNonce();
  const won = await conditionalUpdate(
    APPROVAL_CLASS,
    row.id,
    { Status: 'pending' },
    {
      NonceHash: hash,
      NonceExpiresAt: new Date(Date.now() + NONCE_TTL_MS),
      NonceClientId: String(caller.oauth?.clientId || ''),
    }
  );
  return won ? nonce : null;
}

/**
 * Ask the user to approve a signature on a document someone else sent them.
 *
 * Refuses, with the reason, everything that would make the signature fail
 * later (the app may not sign, the email is not verified, it is not the user's
 * turn, a required value is missing), so the user is never asked to approve
 * something that cannot be signed. An open request for the same seat is
 * returned again (with a new approval code) when the agent asks with the same
 * values, and replaced when the values differ.
 *
 * @param {import('./context.js').Caller} caller the agent's connection.
 * @param {string} docId
 * @param {{fields?: Object}} [opts] the agent's answers, as for sign_document.
 * @returns {Promise<{approval: Object, chatApproval: boolean, nonce: string|null,
 *   appUrl: string, created: boolean}>} `nonce` only when `chatApproval`; it goes
 *   to the chat card in the tool result's `_meta`, nowhere else.
 */
export async function createSignApproval(caller, docId, { fields = {} } = {}) {
  const scopeProblem = signingScopeProblem(caller);
  if (scopeProblem) throw fail(scopeProblem, Parse.Error.OPERATION_FORBIDDEN);
  const identityProblem = verifiedIdentityProblem(caller);
  if (identityProblem) throw fail(identityProblem, Parse.Error.OPERATION_FORBIDDEN);
  checkRateLimit('sign-approval', `u:${caller.userId}`, CREATE_PER_MIN);

  const prepared = await prepareAgentSignature(caller, docId, { fields });
  const { doc, seat } = prepared;
  if (isOwnDocument(doc, caller)) {
    throw fail('This is your own document: sign_document signs it without an approval.');
  }
  assertAgentTurn(doc, seat.contactId);
  if (prepared.missing.length) {
    throw fail(missingMessage(prepared.missing), Parse.Error.VALIDATION_ERROR);
  }

  const chatApproval = canApproveInChat(caller);
  const agent = agentIdentity(caller);
  const input = canonicalFields(fields);

  const open = await pendingForSeat(doc.objectId, seat.contactId);
  for (const row of open) {
    const theirs = row.get('Agent') || {};
    const same =
      sameFields(row.get('Fields'), input) &&
      theirs.kind === agent.kind &&
      theirs.clientId === agent.clientId;
    if (!same) {
      // eslint-disable-next-line no-await-in-loop -- at most one open request per seat
      await expireAsReplaced(row);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const nonce = chatApproval ? await rotateNonce(row, caller) : null;
    // eslint-disable-next-line no-await-in-loop
    const now = await loadRow(row.id);
    return {
      approval: approvalJson(now),
      chatApproval: chatApproval && Boolean(nonce),
      nonce,
      appUrl: approvalUrl(caller, row.id),
      created: false,
    };
  }

  const reviewing = reviewOrNull(caller, doc.objectId);
  const [raw, participant, review] = await Promise.all([
    readFresh('contracts_Document', doc.objectId, DOC_KEYS),
    getParticipantDocument(caller, doc.objectId),
    Promise.race([
      reviewing.then(value => ({ value })),
      new Promise(resolve => setTimeout(() => resolve(null), REVIEW_WAIT_MS).unref?.()),
    ]),
  ]);

  await ensureApprovalSchema();
  const minted = chatApproval ? mintNonce() : null;
  const row = new Parse.Object(APPROVAL_CLASS);
  row.set('Document', { __type: 'Pointer', className: 'contracts_Document', objectId: doc.objectId });
  row.set('ContactId', seat.contactId);
  row.set('User', userPointer(caller));
  row.set('ExtUserPtr', extUserPointer(caller));
  row.set('Agent', agent);
  const enabledAt = toDate(caller.oauth?.signingEnabledAt);
  if (enabledAt) row.set('SigningEnabledAt', enabledAt);
  row.set('Fields', input);
  row.set(
    'Values',
    prepared.values.map(v => ({
      key: String(v.key),
      type: v.type,
      label: v.label,
      value: v.value ?? null,
      page: v.page,
    }))
  );
  row.set('DocumentInfo', {
    title: participant.title || doc.Name || '',
    senderName: participant.sender?.name || '',
    senderCompany: participant.sender?.company || '',
    senderEmail: participant.sender?.email || '',
    pageCount: participant.pageCount || null,
  });
  row.set('Review', review?.value || null);
  row.set('Fingerprint', approvalFingerprint(raw));
  row.set('Status', 'pending');
  if (minted) {
    row.set('NonceHash', minted.hash);
    row.set('NonceExpiresAt', new Date(Date.now() + NONCE_TTL_MS));
    row.set('NonceClientId', String(caller.oauth?.clientId || ''));
  }
  const expiresAt = toDate(doc.ExpiryDate);
  if (expiresAt) row.set('ExpiresAt', expiresAt);
  row.setACL(new Parse.ACL()); // nothing granted: master key only
  await row.save(null, { useMasterKey: true });

  // Two requests for one seat at the same moment: the newest stands.
  const racing = await pendingForSeat(doc.objectId, seat.contactId);
  await Promise.all(racing.filter(r => r.id !== row.id).map(expireAsReplaced));

  if (!review) {
    // The review was slow: the request goes out now and the review joins it
    // when it lands (the card and the web page fetch the request again).
    reviewing
      .then(late =>
        late ? conditionalUpdate(APPROVAL_CLASS, row.id, {}, { Review: late }) : undefined
      )
      .catch(err => console.log('approvals: late review not saved', err?.message || err));
  }
  await mailUser(caller, row);

  return {
    approval: approvalJson(await loadRow(row.id)),
    chatApproval: Boolean(minted),
    nonce: minted?.nonce || null,
    appUrl: approvalUrl(caller, row.id),
    created: true,
  };
}

/* ------------------------------------------------------------------ decide */

function decidedMessage(row) {
  const status = row.get('Status');
  if (status === 'expired') {
    return `This request has expired: ${row.get('Error') || 'the document changed.'}`;
  }
  if (status === 'approving') return 'This request is being signed right now.';
  return `This request was already decided (${status}).`;
}

/** The chat card's code: right hash, not expired, issued to this app. */
function assertChatNonce(row, caller, nonce) {
  if (!canApproveInChat(caller)) {
    throw fail(
      `Approving in the chat is not available in this app. Approve in ${appName} instead.`,
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  const scopeProblem = signingScopeProblem(caller);
  if (scopeProblem) throw fail(scopeProblem, Parse.Error.OPERATION_FORBIDDEN);
  const invalid = () =>
    fail(
      `This approval code is not valid. Approve in ${appName} instead.`,
      Parse.Error.OPERATION_FORBIDDEN
    );
  if (typeof nonce !== 'string' || !nonce || nonce.length > 200) throw invalid();
  if (!sameHash(hashNonce(nonce), row.get('NonceHash'))) throw invalid();
  const expires = toDate(row.get('NonceExpiresAt'));
  if (!expires || expires.getTime() < Date.now()) throw invalid();
  if (!caller.oauth?.clientId || row.get('NonceClientId') !== caller.oauth.clientId) {
    throw invalid();
  }
}

/**
 * Approve or decline a request.
 *
 * `via: 'web'` is the user's own DocuStamp session; `via: 'chat'` is the chat
 * card, through the app's connection, with the approval code the card was
 * given. Exactly one decision wins (pending -> approving / declined, a
 * conditional write), and any decision spends the code.
 *
 * Approving signs with the request's stored values and the agent that asked,
 * on the copy as it is now, after checking the seat, the turn and the values
 * again. The outcome is `signed`, or `failed` with the reason.
 *
 * @param {Object} opts
 * @param {string} opts.approvalId
 * @param {'approve'|'decline'} opts.decision
 * @param {'web'|'chat'} opts.via
 * @param {import('./context.js').Caller} opts.caller the session's caller (web)
 *   or the app's connection (chat); either way the request must be theirs.
 * @param {string} [opts.nonce] the chat card's approval code.
 * @returns {Promise<Object>} the Approval after the decision.
 */
export async function decideApproval({ approvalId, decision, via, caller, nonce } = {}) {
  if (!DECISIONS.has(decision)) {
    throw fail('decision must be "approve" or "decline".', Parse.Error.VALIDATION_ERROR);
  }
  if (!VIA.has(via)) throw fail('Unknown way of approving.', Parse.Error.VALIDATION_ERROR);
  let row = await settle(await loadOwnRow(caller, approvalId));
  if (row.get('Status') !== 'pending') throw fail(decidedMessage(row), Parse.Error.OPERATION_FORBIDDEN);
  if (via === 'chat') assertChatNonce(row, caller, nonce);
  if (decision === 'approve') {
    const problem = verifiedIdentityProblem(caller);
    if (problem) throw fail(problem, Parse.Error.OPERATION_FORBIDDEN);
  }

  const decidedAt = new Date();
  const where = { Status: 'pending' };
  // A code rotated (the agent asked again) between the check and the claim loses.
  if (via === 'chat') where.NonceHash = row.get('NonceHash');
  const won = await conditionalUpdate(APPROVAL_CLASS, row.id, where, {
    Status: decision === 'approve' ? 'approving' : 'declined',
    DecidedAt: decidedAt,
    DecidedVia: via,
    NonceHash: null,
    NonceExpiresAt: null,
  });
  if (!won) {
    row = await loadRow(row.id);
    if (via === 'chat' && row.get('Status') === 'pending') {
      throw fail(
        `This approval code is not valid. Approve in ${appName} instead.`,
        Parse.Error.OPERATION_FORBIDDEN
      );
    }
    throw fail(decidedMessage(row), Parse.Error.OPERATION_FORBIDDEN);
  }
  if (decision === 'decline') return approvalJson(await loadRow(row.id));

  const docId = row.get('Document')?.id;
  const fields = row.get('Fields') || {};
  let outcome;
  try {
    const prepared = await prepareAgentSignature(caller, docId, { fields });
    if (prepared.missing.length) {
      throw fail(missingMessage(prepared.missing), Parse.Error.VALIDATION_ERROR);
    }
    const raw = await readFresh('contracts_Document', docId, DOC_KEYS);
    if (approvalFingerprint(raw) !== row.get('Fingerprint')) {
      throw fail('The document changed after your agent asked, so your agent has to ask again.');
    }
    await agentSignDocument(caller, docId, {
      fields,
      agent: row.get('Agent'),
      allowedBy: {
        via,
        name: caller.name,
        email: caller.email,
        at: decidedAt,
        signingEnabledAt: row.get('SigningEnabledAt') || null,
        approvalId: row.id,
      },
      notifyOwner: false,
    });
    outcome = { Status: 'signed' };
  } catch (err) {
    console.log('approvals: signing after approval failed', err?.message || err);
    outcome = { Status: 'failed', Error: safeErrorMessage(err) };
  }
  await conditionalUpdate(APPROVAL_CLASS, row.id, { Status: 'approving' }, outcome);
  return approvalJson(await loadRow(row.id));
}
