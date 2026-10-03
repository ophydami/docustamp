import crypto from 'node:crypto';
import { isAiEnabled } from '../ai/client.js';
import { conditionalUpdate } from '../lib/atomic.js';
import { userPointer } from '../lib/context.js';
import { assertOwner, findByIdempotencyKey, getDocument } from '../lib/documents.js';
import { pageSizes } from '../lib/drafts.js';
import { fetchReminderDoc, sendReminderForDoc } from '../parsefunction/sendReminder.js';
import { analyzeDocumentFlow, prepareDocumentFlow } from '../parsefunction/aiFunctions.js';

/**
 * The flows the REST API v1 and the MCP tools share.
 *
 * Both entry points are meant to be the same product with two shapes, so the
 * analyse / quick-send / remind logic, the request-size ceiling, the AI budget
 * and the error mapping live here once instead of drifting apart in two files
 * (that drift is exactly what let the REST reminder route mail a declined
 * document and let `PUT /fields` wipe a draft that the MCP twin protected).
 */

/**
 * Biggest request body either integration accepts, and the same knob the mount
 * in `cloud/routes/customApp.js` uses so the two cannot drift: whichever
 * parser runs first, one number decides. A 50 MB PDF is ~67 MB of base64, hence
 * the default; lower it with `API_BODY_LIMIT` on a small deployment.
 */
export const MAX_API_BODY = process.env.API_BODY_LIMIT || '72mb';
export const MAX_API_BODY_BYTES = bytesFromLimit(MAX_API_BODY, 72 * 1024 * 1024);

function bytesFromLimit(value, fallback) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value).trim());
  if (!m) return fallback;
  const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Math.round(Number(m[1]) * (units[(m[2] || 'b').toLowerCase()] || 1));
}

/** The keys `POST /v1/documents` forwards; anything else is ignored (§G2-24). */
const CREATE_DOCUMENT_KEYS = [
  'name',
  'url',
  'fileName',
  'fileBase64',
  'recipients',
  'fields',
  'placeholders',
  'settings',
  'message',
  'note',
  'description',
  'folderId',
  'send',
  'chain',
];

export function pickCreateDocumentInput(body = {}) {
  const out = {};
  for (const key of CREATE_DOCUMENT_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * Content-Length guard. The body is parsed upstream, so this is a ceiling on
 * what the integrations accept rather than on what express buffers; it answers
 * before any token lookup or database work happens.
 */
export function bodyTooLarge(req) {
  const declared = Number(req?.headers?.['content-length'] || 0);
  return Number.isFinite(declared) && declared > MAX_API_BODY_BYTES;
}

export function httpStatusFor(err) {
  switch (err?.code) {
    case Parse.Error.INVALID_SESSION_TOKEN:
      return 401;
    case Parse.Error.OPERATION_FORBIDDEN:
      return 403;
    case Parse.Error.OBJECT_NOT_FOUND:
      return 404;
    case 155:
      return 429;
    case Parse.Error.VALIDATION_ERROR:
    case Parse.Error.INVALID_JSON:
    case Parse.Error.INVALID_QUERY:
    case Parse.Error.SCRIPT_FAILED:
      return 400;
    default:
      return err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  }
}

/**
 * What a caller may read. Anything that maps to 5xx is an internal or provider
 * failure whose text can name an AWS ARN, an account id or a stack path, so it
 * is logged and replaced.
 */
export function safeErrorMessage(err) {
  if (httpStatusFor(err) >= 500) return 'Internal error.';
  return err?.message || 'Error';
}

/* -------------------------------------------------------------- idempotency */

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 500;
const inFlight = new Map();

/**
 * Replay the answer to a repeated `Idempotency-Key`.
 *
 * HTTP clients and MCP hosts retry a POST that timed out, and these routes mail
 * real signers, so a retry must not create a second signable copy. The record
 * is the in-flight promise itself, so a retry that arrives while the first call
 * is still running waits for it instead of starting a second one.
 *
 * Per process (like every other counter here): it covers the client-retry case
 * on a single-instance deployment, not two instances behind a load balancer.
 */
export async function withIdempotency(caller, scope, key, fn, { keep, onReplay } = {}) {
  const raw = String(key || '').trim();
  if (!raw) return await fn();
  if (raw.length > 200) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Idempotency-Key is too long.');
  }
  const id = `${caller?.userId || 'anon'}:${scope}:${raw}`;
  const now = Date.now();
  const hit = inFlight.get(id);
  if (hit && hit.expires > now) {
    const first = await hit.promise;
    return onReplay ? onReplay(first) : first;
  }
  const promise = (async () => await fn())();
  inFlight.set(id, { expires: now + IDEMPOTENCY_TTL_MS, promise });
  if (inFlight.size > IDEMPOTENCY_MAX) {
    for (const [k, v] of inFlight) if (v.expires <= now) inFlight.delete(k);
  }
  try {
    const result = await promise;
    // `keep` says whether this answer is the request's final one. quick_send
    // that only asks for the missing recipients is not: the follow-up call with
    // them filled in must run, not replay "recipients needed".
    if (keep && !keep(result) && inFlight.get(id)?.promise === promise) inFlight.delete(id);
    return result;
  } catch (err) {
    // A failure is not a result: let the caller retry it.
    inFlight.delete(id);
    throw err;
  }
}

/** Test seam. */
export function resetIdempotency() {
  inFlight.clear();
}

/* ------------------------------------------------------------------- create */

/**
 * Real page geometry for the default field layout. Without it `defaultFieldsFor`
 * lays Letter-sized boxes out on page `pageCount || 1`, i.e. the cover page of
 * every document created without `pageCount`, while the docs promise the bottom
 * of the last page. Best effort: a PDF we cannot read falls back to the old
 * behaviour rather than failing the create.
 */
export async function pageInfoFor(input = {}) {
  const hasLayout =
    (Array.isArray(input.fields) && input.fields.length) ||
    (Array.isArray(input.placeholders) && input.placeholders.length);
  const fallback = { pageCount: Number(input.pageCount) || 1 };
  if (hasLayout || !input.url) return fallback;
  try {
    const pages = await pageSizes(input.url);
    const last = pages[pages.length - 1];
    if (!last) return fallback;
    return { pageCount: pages.length, width: last.width, height: last.height };
  } catch (err) {
    console.log('api: could not read the page sizes, using the default layout:', err?.message);
    return fallback;
  }
}

/* ----------------------------------------------------------------------- AI */

export function requireAiEnabled() {
  if (!isAiEnabled()) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'AI is disabled on this server.');
  }
}

/** The proposal digest returned beside a created document. */
function briefProposal(proposal) {
  return {
    title: proposal.title,
    summary: proposal.summary,
    roles: proposal.roles,
    warnings: proposal.warnings,
    fieldCount: proposal.fields?.length ?? 0,
  };
}

/**
 * `POST /v1/documents/analyze` and the `analyze_document` tool.
 * @param {import('../lib/context.js').Caller} caller
 */
export async function analyzeFlow(caller, input = {}) {
  requireAiEnabled();
  return await analyzeDocumentFlow(caller, input);
}

/**
 * `POST /v1/documents/quick-send` and the `quick_send` tool: analyse, bind, create, mail.
 * With `signForMe`, the caller's agent signs the caller's own seat as it goes
 * out (lib/documents.js sendDocument), so only the others are mailed;
 * `confirmNameMismatch` lets it sign when the document names someone else for
 * the caller's party and the user confirmed.
 *
 * Nothing is mailed to an address that only the document named: those roles come
 * back in `needsRecipients` with a `suggestedEmail` until the caller passes them
 * in `recipients` or sets `acceptExtractedRecipients`. The full proposal is
 * returned on that path so the second call can hand it straight back in
 * `proposal` instead of paying for the analysis twice.
 *
 * @param {import('../lib/context.js').Caller} caller
 * @param {string} origin 'api' or 'mcp'
 */
export async function quickSendFlow(caller, input = {}, origin = 'api') {
  requireAiEnabled();
  // A retry with the same Idempotency-Key (REST) or requestId (MCP) after a
  // restart: the in-memory replay is gone, the key stored on the row is not.
  const replayed = await findByIdempotencyKey(caller, input.idempotencyKey);
  if (replayed) return { document: { ...replayed, mail: null }, idempotentReplay: true };

  const sending = input.dryRun !== true;
  const fingerprint = sending ? sendFingerprint(input) : '';
  const guarded = fingerprint && input.allowDuplicate !== true;
  const flightKey = `${caller?.userId || 'anon'}:${fingerprint}`;
  if (guarded) {
    const earlier = await recentSendWithFingerprint(caller, fingerprint);
    if (earlier) return await duplicateResult(caller, earlier.id);
    // The same send still running (a host that gave up waiting and called
    // again): wait for it rather than start a second one.
    const running = sendsInFlight.get(flightKey);
    if (running) {
      const first = await running.catch(() => null);
      if (first?.document?.objectId) return await duplicateResult(caller, first.document.objectId);
    }
  }

  const run = (async () => {
    const { document, proposal, needsRecipients, warnings } = await prepareDocumentFlow(
      caller,
      { ...input, signForMe: input.signForMe === true },
      { origin, strict: true, send: sending }
    );
    if (needsRecipients.length) {
      return {
        document: null,
        needsRecipients,
        // Full, so it can come back in `proposal` on the next call.
        proposal,
        reusableProposal: true,
      };
    }
    if (fingerprint && document?.objectId) {
      // Best effort: the send has happened, a missing stamp only weakens the
      // duplicate check for this one document.
      await conditionalUpdate('contracts_Document', document.objectId, {}, {
        SendFingerprint: fingerprint,
      }).catch(err => console.log('quick_send: could not record the send fingerprint', err?.message));
    }
    return {
      document,
      proposal: briefProposal(proposal),
      ...(warnings.length ? { warnings } : {}),
    };
  })();
  if (!guarded) return await run;
  sendsInFlight.set(flightKey, run);
  try {
    return await run;
  } finally {
    if (sendsInFlight.get(flightKey) === run) sendsInFlight.delete(flightKey);
  }
}

/* ------------------------------------------------------ duplicate sends */

/**
 * How long an identical quick_send counts as a repeat of the first. A host
 * that timed out waiting for the AI and the mail calls again within seconds;
 * the window only has to cover that, not a deliberate second send next week.
 */
export const DUPLICATE_SEND_WINDOW_MS = 10 * 60 * 1000;
const sendsInFlight = new Map();

/**
 * What makes two quick_send calls the same send: the same file to the same
 * people. The title, message and settings are left out on purpose, since a
 * retry may word them differently. '' when there is no file to compare.
 *
 * @param {Object} input the quick_send input.
 * @returns {string} 32 hex characters, or ''.
 */
export function sendFingerprint(input = {}) {
  let file = '';
  if (typeof input.fileBase64 === 'string' && input.fileBase64.trim()) {
    const bytes = input.fileBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    file = `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
  } else if (typeof input.url === 'string' && input.url.trim()) {
    file = `url:${input.url.trim().split('?')[0]}`;
  }
  if (!file) return '';
  const people = (Array.isArray(input.recipients) ? input.recipients : [])
    .map(r =>
      [
        r?.me === true ? '@me' : String(r?.email || '').trim().toLowerCase(),
        String(r?.role || '').trim().toLowerCase(),
      ].join('|')
    )
    .sort();
  const extracted = input.acceptExtractedRecipients === true;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ file, people, extracted }), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** The caller's live document sent with this fingerprint inside the window, if any. */
async function recentSendWithFingerprint(caller, fingerprint) {
  const query = new Parse.Query('contracts_Document');
  query.equalTo('CreatedBy', userPointer(caller));
  query.equalTo('SendFingerprint', fingerprint);
  query.greaterThanOrEqualTo('DocSentAt', new Date(Date.now() - DUPLICATE_SEND_WINDOW_MS));
  // Voiding sets IsDeclined too: a voided or declined copy may be sent again.
  query.notEqualTo('IsDeclined', true);
  query.notEqualTo('IsArchive', true);
  query.descending('DocSentAt');
  return await query.first({ useMasterKey: true });
}

async function duplicateResult(caller, docId) {
  const document = await getDocument(caller, docId);
  const sentAt = document?.sentAt ? new Date(document.sentAt).getTime() : Date.now();
  const minutes = Math.floor(Math.max(0, Date.now() - sentAt) / 60000);
  const ago =
    minutes < 1 ? 'less than a minute ago' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  return {
    document,
    duplicate: true,
    sent: false,
    message: `This same PDF was already sent to the same people ${ago} (documentId ${docId}). Nothing was sent again. To send a second copy anyway, call quick_send again with allowDuplicate: true.`,
  };
}

/** Test seam. */
export function resetSendsInFlight() {
  sendsInFlight.clear();
}

/* ------------------------------------------------------------------ remind */

/**
 * Every precondition for a reminder, in one place: ownership, sent, and not
 * completed / declined / archived. `fetchReminderDoc` does not filter archived
 * documents the way `loadDoc` does, so a soft-deleted document is caught here.
 */
export function assertRemindable(doc, caller) {
  const d = JSON.parse(JSON.stringify(doc));
  assertOwner(d, caller);
  if (d.IsArchive === true)
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
  if (!d.SignedUrl && !d.DocSentAt)
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has not been sent yet.');
  if (d.IsCompleted)
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is already completed.');
  if (d.IsDeclined) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has been declined.');
  return d;
}

/** `POST /v1/documents/:id/remind` and the `send_reminder` tool. */
export async function remindDocument(caller, docId) {
  const doc = await fetchReminderDoc(docId);
  assertRemindable(doc, caller);
  return await sendReminderForDoc({ doc, by: caller.userId, publicUrl: caller.publicUrl });
}
