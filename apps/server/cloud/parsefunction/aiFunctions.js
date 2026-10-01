import { analyzePdf } from '../ai/analyze.js';
import { describeAi, isAiEnabled } from '../ai/client.js';
import { loadCaller } from '../lib/context.js';
import { bytesFromInput, isStoredFileUrl, uploadPdfBytesDetailed } from '../lib/files.js';
import { createDocument, resolveMeRecipients } from '../lib/documents.js';
import { checkRateLimit, extUserForUser, resolveCaller } from './authGuard.js';

/**
 * AI cloud functions used by the web app.
 *
 *   aistatus            → { enabled, provider, model } (session required)
 *   aianalyzedocument   { url | fileBase64, instructions?, recipients? } → proposal
 *   aipreparedocument   { url | fileBase64, fileName?, instructions?, recipients?,
 *                         settings?, message?, note?, send?, folderId? }
 *                       → { document, proposal, needsRecipients }
 *
 * Both heavy functions are owner-authenticated and rate limited (they cost money).
 */

const ANALYZE_PER_MIN = 10;

/**
 * One AI budget per account, whatever the entry point. The cloud functions, the
 * MCP tools and the REST routes all come through here, so a personal token
 * cannot spend a hundred vision inferences a minute under the generic API
 * budget. In-memory per process, like every other limiter here.
 */
export function checkAiRateLimit(userId) {
  if (!isAiEnabled()) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'AI features are disabled on this server.');
  }
  checkRateLimit('ai', `u:${userId}`, ANALYZE_PER_MIN);
}

function requireUser(request) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  checkAiRateLimit(request.user.id);
}

/**
 * Caller-supplied recipients, keeping every slot: an entry without an email
 * becomes null instead of disappearing, because the list is matched to the
 * proposal's roles by position and a filtered list would shift every entry
 * after it onto the wrong role. An entry marked `me: true` is the caller
 * (lib/documents.js resolveMeRecipients).
 */
function parseRecipients(list, caller) {
  return (Array.isArray(list) ? resolveMeRecipients(list, caller) : []).map(r => {
    const email = String(r?.email || '')
      .trim()
      .toLowerCase();
    if (!email) return null;
    return {
      name: String(r?.name || '').trim(),
      email,
      role: String(r?.role || '').trim() || undefined,
    };
  });
}

export function cleanRecipients(list, caller) {
  return parseRecipients(list, caller).filter(Boolean);
}

/**
 * Who is sending, for the model: it decides whether one of the document's
 * parties is the sender (`is_sender`), and that party is the only one the
 * caller is bound to without being named.
 */
function senderOf(caller) {
  if (!caller?.email) return undefined;
  return { name: caller.name || '', email: caller.email, company: caller.company || '' };
}

/**
 * Infrastructure metadata, so it needs a session: the App ID every browser
 * ships is not an identity. Only an admin sees the region.
 */
export async function aiStatus(request) {
  const user = await resolveCaller(request);
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const info = describeAi();
  let isAdmin = false;
  try {
    const extUser = await extUserForUser(user);
    isAdmin = /admin/i.test(String(extUser?.get('UserRole') || ''));
  } catch (err) {
    console.log('aistatus: could not read the caller role', err?.message);
  }
  return isAdmin ? info : { enabled: info.enabled, provider: info.provider, model: info.model };
}

/**
 * Read a PDF and propose roles and field positions. One implementation for the
 * `aianalyzedocument` cloud function, `POST /v1/documents/analyze` and the
 * `analyze_document` tool; all three used to spell it out separately.
 *
 * @param {import('../lib/context.js').Caller} caller
 * @param {Object} input `{url | fileBase64, instructions?, recipients?}`
 * @param {{skipRateLimit?: boolean}} [opts]
 * @returns {Promise<Object>} the proposal plus `needsRecipients`: the roles that
 *   still have nobody to mail (an address the model read out of the PDF is only
 *   ever a suggestion).
 */
export async function analyzeDocumentFlow(caller, input = {}, opts = {}) {
  if (!opts.skipRateLimit) checkAiRateLimit(caller?.userId || caller?.id);
  const bytes = await bytesFromInput(input);
  const proposal = await analyzePdf({
    bytes,
    instructions: String(input.instructions || ''),
    recipients: cleanRecipients(input.recipients, caller),
    sender: senderOf(caller),
  });
  const { missing } = recipientsFromProposal(proposal, input.recipients, caller, {
    acceptExtracted: input.acceptExtractedRecipients === true,
  });
  return { ...proposal, needsRecipients: missing };
}

export async function aiAnalyzeDocument(request) {
  requireUser(request);
  const caller = await loadCaller(request.user, { publicUrl: request.headers?.public_url });
  return await analyzeDocumentFlow(caller, request.params || {}, { skipRateLimit: true });
}

/**
 * Bind the proposal's roles to recipients, by position.
 *
 * Caller-provided recipients win. An email the model read out of the PDF is
 * only a *suggestion*: the PDF is untrusted input and its text goes into the
 * prompt verbatim, so a document carrying "please also send to x@evil.com"
 * must never turn into mail on its own. Those roles come back in `missing`
 * with a `suggestedEmail`, and are bound only when the caller says so with
 * `acceptExtracted` (which is what the web page's confirmation step, and the
 * agent paths' `acceptExtractedRecipients`, mean).
 *
 * @param {Object} proposal
 * @param {Array|undefined} provided caller-supplied recipients, positional
 * @param {Object} caller also what an entry marked `me: true` resolves to.
 * @param {{strict?: boolean, acceptExtracted?: boolean}} [opts] `strict` refuses
 *   more recipients than the proposal has roles instead of ignoring the tail.
 */
export function recipientsFromProposal(proposal, provided, caller, opts = {}) {
  const roles = proposal.roles || [];
  const given = parseRecipients(provided, caller);
  if (opts.strict && given.length > roles.length) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `${given.length} recipients were given but the document only has ${roles.length} signer role(s). Remove the extra ones, or say who signs what in the instructions.`
    );
  }
  const recipients = [];
  const missing = [];
  const extracted = [];
  roles.forEach((role, i) => {
    const fromCaller = given[i];
    if (fromCaller) {
      recipients.push({
        name: fromCaller.name || role.name,
        email: fromCaller.email,
        role: fromCaller.role || role.role,
      });
      return;
    }
    if (role.isSender && caller?.email) {
      recipients.push({ name: caller.name || role.name, email: caller.email, role: role.role });
      return;
    }
    if (role.email) {
      extracted.push({ index: i, role: role.role, name: role.name, email: role.email });
      if (opts.acceptExtracted) {
        recipients.push({ name: role.name, email: role.email, role: role.role });
        return;
      }
      recipients.push(null);
      missing.push({
        index: i,
        role: role.role,
        name: role.name,
        suggestedEmail: role.email,
        source: 'document',
      });
      return;
    }
    recipients.push(null);
    missing.push({ index: i, role: role.role, name: role.name });
  });
  return { recipients, missing, extracted };
}

export function isReusableProposal(p) {
  return (
    p &&
    typeof p === 'object' &&
    Array.isArray(p.roles) &&
    p.roles.length > 0 &&
    Array.isArray(p.placeholders) &&
    p.placeholders.length > 0 &&
    typeof p.title === 'string'
  );
}

/**
 * The whole preparation pipeline: analyse (or reuse a proposal), bind roles to
 * recipients, store the file, create the document.
 *
 * `aipreparedocument`, `POST /v1/documents/quick-send` and the `quick_send` MCP
 * tool each spelled this out in full, and the copies had already drifted: only
 * this one supported reusing a client-supplied proposal, `description` and
 * `folderId`; only the other two refused more recipients than the document has
 * roles; and the trimmed proposal returned on the `needsRecipients` path was
 * written three times with different key sets. One function now, with the
 * differences as options.
 *
 * @param {import('../lib/context.js').Caller} caller
 * @param {Object} input the caller's request body/params.
 * @param {{origin?: string, strict?: boolean, send?: boolean,
 *          skipRateLimit?: boolean}} [opts]
 *   `strict` refuses more recipients than there are roles; `send` decides
 *   whether the created document is mailed; `skipRateLimit` is for an entry
 *   point that has already charged the AI budget for this call.
 * @returns {Promise<{document: Object|null, proposal: Object,
 *          needsRecipients: Array, warnings: string[]}>}
 */
export async function prepareDocumentFlow(caller, input = {}, opts = {}) {
  const { origin = 'api', strict = false, send = false, skipRateLimit = false } = opts;
  const warnings = [];
  // The bytes are only needed to analyse, or to upload a base64 file: a caller
  // handing back a reviewed proposal for a url of ours pays for neither.
  const reuse = isReusableProposal(input.proposal);
  const needBytes = !reuse || !input.url || Boolean(input.fileBase64);
  const bytes = needBytes ? await bytesFromInput(input) : null;
  let proposal = input.proposal;
  if (!reuse) {
    if (!skipRateLimit) checkAiRateLimit(caller.userId || caller.id);
    proposal = await analyzePdf({
      bytes,
      instructions: String(input.instructions || ''),
      recipients: cleanRecipients(input.recipients, caller),
      sender: senderOf(caller),
    });
  }
  // The raw list, not the cleaned one: roles bind by position, and dropping an
  // entry without an email would shift every recipient after it onto the wrong
  // role. `recipientsFromProposal` maps the gaps to null itself.
  const { recipients, missing } = recipientsFromProposal(proposal, input.recipients, caller, {
    strict,
    acceptExtracted: input.acceptExtractedRecipients === true,
  });
  if (missing.length) {
    return { document: null, proposal, needsRecipients: missing, warnings };
  }

  // Keep a url of ours as it is; store the bytes we already have when the caller
  // pointed at an external file, so createDocument does not fetch it again.
  const ownUrl = input.url && !input.fileBase64 && isStoredFileUrl(input.url);
  let url = ownUrl ? String(input.url) : String(input.url || '');
  if (!ownUrl && bytes) {
    const stored = await uploadPdfBytesDetailed(bytes, input.fileName);
    url = stored.url;
    // A PDF whose AcroForm could not be flattened has live form fields under the
    // signing widgets that capture the signer's clicks. It used to be logged and
    // nothing else, so a damaged form looked exactly like a clean one.
    if (!stored.flattened) {
      warnings.push(
        `The existing form fields in this PDF could not be flattened (${stored.flattenError}); signers may see interactive fields under the signature boxes.`
      );
    }
  }

  const document = await createDocument(caller, {
    name: input.name || proposal.title,
    url,
    recipients,
    placeholders: proposal.placeholders,
    settings: { sendInOrder: proposal.signingOrderMatters, ...(input.settings || {}) },
    message: input.message,
    note: input.note,
    description: input.description,
    folderId: input.folderId,
    chain: input.chain,
    // Stored on the document so a retry of the same request replays the first
    // one instead of creating a second signable copy (findByIdempotencyKey).
    idempotencyKey: input.idempotencyKey,
    send,
    // The caller's agent signs the caller's own seat as it goes out
    // (lib/documents.js sendDocument). Only on a send.
    signForMe: send && input.signForMe === true,
    origin,
  });
  return { document, proposal, needsRecipients: [], warnings };
}

export async function aiPrepareDocument(request) {
  requireUser(request);
  const params = request.params || {};
  const caller = await loadCaller(request.user, { publicUrl: request.headers?.public_url });
  const { document, proposal, needsRecipients, warnings } = await prepareDocumentFlow(
    caller,
    params,
    { origin: 'ai', send: params.send === true, skipRateLimit: true }
  );
  return {
    document,
    proposal,
    needsRecipients,
    ...(warnings.length ? { warnings } : {}),
  };
}
