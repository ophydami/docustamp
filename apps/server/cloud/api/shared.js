import { isAiEnabled } from '../ai/client.js';
import { assertOwner } from '../lib/documents.js';
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
export async function withIdempotency(caller, scope, key, fn) {
  const raw = String(key || '').trim();
  if (!raw) return await fn();
  if (raw.length > 200) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Idempotency-Key is too long.');
  }
  const id = `${caller?.userId || 'anon'}:${scope}:${raw}`;
  const now = Date.now();
  const hit = inFlight.get(id);
  if (hit && hit.expires > now) return await hit.promise;
  const promise = (async () => await fn())();
  inFlight.set(id, { expires: now + IDEMPOTENCY_TTL_MS, promise });
  if (inFlight.size > IDEMPOTENCY_MAX) {
    for (const [k, v] of inFlight) if (v.expires <= now) inFlight.delete(k);
  }
  try {
    return await promise;
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
  const { document, proposal, needsRecipients, warnings } = await prepareDocumentFlow(
    caller,
    { ...input, signForMe: input.signForMe === true },
    { origin, strict: true, send: input.dryRun !== true }
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
  return {
    document,
    proposal: briefProposal(proposal),
    ...(warnings.length ? { warnings } : {}),
  };
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
