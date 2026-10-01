import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from '@modelcontextprotocol/ext-apps/server';
import { appName } from '../../Utils.js';
import { verifiedIdentityProblem } from '../lib/agentIdentity.js';
import { decideApproval, getApproval } from '../lib/approvals.js';
import { getDocument, listDocuments } from '../lib/documents.js';
import { getDraft, reviewDraft } from '../lib/drafts.js';
import { getParticipantDocument, loadParticipantDocument } from '../lib/inbox.js';
import { renderPagePreview, renderParticipantPreview } from '../lib/preview.js';
import { resolveWebRoot } from '../lib/webApp.js';
import { SCOPE_WRITE } from '../lib/oauth.js';
import { safeErrorMessage } from '../api/shared.js';

/**
 * The DocuStamp app inside ChatGPT, Claude and other MCP Apps hosts.
 *
 * One HTML page (built from apps/web/src/mcp-app/ into `mcp-app.html` next to
 * the web app) is registered as an MCP Apps UI resource, and a handful of
 * tools point at it:
 *
 *   open_docustamp     the sidebar app (ChatGPT "global" entrypoint): documents
 *                      waiting on signers, drafts, completed
 *   open_review_panel  the panel beside a conversation ("thread" entrypoint):
 *                      the drafts to check and send
 *   show_document      a card in the chat for one document; a draft shows its
 *                      pages and a Send button, so the user sends it themselves.
 *                      A document someone else sent the user shows what it asks
 *                      of them (the participant view)
 *   show_documents     a short list card in the chat
 *   sign_document      (registered in ./server.js) the "signed for you" card, or
 *                      the approval card for a document someone else sent
 *   app_home, app_document, app_page, app_approval, app_decide_approval
 *                      data and actions the page uses as the user moves around;
 *                      hidden from the model (`visibility: ["app"]`)
 *
 * The page acts through the ordinary tools (send_document, send_reminder,
 * void_document, extend_expiry), so it can do nothing the connection could not
 * already do, and a read-only connection gets `canWrite: false` and no buttons.
 * The one exception is app_decide_approval, the approval card's buttons, which
 * needs the single-use code only the card holds (lib/approvals.js).
 *
 * The model reads a one-line summary (`content`), and in ChatGPT it also reads
 * `structuredContent`, so nothing secret goes there. The result's `_meta` is
 * the page's alone: hosts on the CHAT_APPROVAL_HOSTS list keep it from the
 * model, which is the only reason the approval code may travel in it. Page
 * images only ever go to the page (`app_page`).
 */

/** Bump the version when the page and the data it expects change incompatibly: hosts cache by uri. */
export const APP_RESOURCE_URI = 'ui://docustamp/app-v1';

const LIST_LIMIT = 25;
const CARD_LIST_LIMIT = 6;
const PAGE_SCALE = 1.25;

const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${appName}</title></head>
<body style="font-family:system-ui,sans-serif;padding:16px">The ${appName} app is not built on this server. Run <code>npm run build</code> in apps/web.</body></html>`;

let cachedHtml = null;

/**
 * The built page. Looked up in order: MCP_APP_HTML, then `mcp-app.html` in the web
 * app this process serves (the Docker image), then a development checkout's
 * apps/web/dist. A server without either answers a placeholder page, so the
 * tools still work.
 */
export function appHtml() {
  // Read once in production; on every call elsewhere, so a rebuilt page shows up without a restart.
  if (cachedHtml !== null && process.env.NODE_ENV === 'production') return cachedHtml;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = resolveWebRoot();
  const candidates = [
    process.env.MCP_APP_HTML?.trim(),
    webRoot && path.join(webRoot, 'mcp-app.html'),
    path.join(here, '..', '..', '..', 'web', 'dist', 'mcp-app.html'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      cachedHtml = fs.readFileSync(file, 'utf8');
      return cachedHtml;
    } catch {
      // try the next one
    }
  }
  cachedHtml = FALLBACK_HTML;
  return cachedHtml;
}

/**
 * The DocuStamp mark, one colour, following the host's text colour. Hosts show
 * it in the sidebar. It is the server icon (MCP_SERVER_INFO in ./server.js)
 * rather than a per-tool icon, because the SDK's registerTool drops `icons`.
 */
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 4 40 56"><path fill="currentColor" fill-rule="evenodd" d="M16 4H38V18H52V56A4 4 0 0 1 48 60H16A4 4 0 0 1 12 56V8A4 4 0 0 1 16 4ZM29.4 29.84L28.4 36.5H21A2 2 0 0 0 19 38.5V41A2 2 0 0 0 21 43H43A2 2 0 0 0 45 41V38.5A2 2 0 0 0 43 36.5H35.6L34.6 29.84A4.8 4.8 0 1 0 29.4 29.84ZM22.3 44.3A0.8 0.8 0 0 0 21.5 45.1V46A0.8 0.8 0 0 0 22.3 46.8H41.7A0.8 0.8 0 0 0 42.5 46V45.1A0.8 0.8 0 0 0 41.7 44.3ZM20.75 50.5A1.75 1.75 0 0 0 20.75 54H43.25A1.75 1.75 0 0 0 43.25 50.5Z"/><path fill="currentColor" d="M40.5 4L52 15.5H42.5A2 2 0 0 1 40.5 13.5Z"/></svg>';
export const APP_ICON = Object.freeze({
  src: `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`,
  mimeType: 'image/svg+xml',
  sizes: ['any'],
});

/**
 * `_meta` for a tool registered with plain `server.registerTool` that renders
 * the app (sign_document, in ./server.js): what `registerAppTool` would set,
 * the legacy resource key included.
 */
export function appToolMeta() {
  return { ...uiMeta(), [RESOURCE_URI_META_KEY]: APP_RESOURCE_URI };
}

/** `_meta` for a tool that renders the app, with optional ChatGPT entrypoints. */
function uiMeta(entrypoints = [], { appOnly = false } = {}) {
  return {
    ui: { resourceUri: APP_RESOURCE_URI, ...(appOnly ? { visibility: ['app'] } : {}) },
    'openai/ui': { entrypoints },
    'openai/iconStyle': 'monochrome',
  };
}

const APP_ONLY = { ui: { visibility: ['app'] } };

function canWrite(caller) {
  return !caller.scopes || caller.scopes.includes(SCOPE_WRITE);
}

/** What a list row needs; the full summary carries much more. */
function rowOf(doc) {
  return {
    objectId: doc.objectId,
    name: doc.name,
    status: doc.status,
    updatedAt: doc.updatedAt,
    sentAt: doc.sentAt,
    expiresAt: doc.expiresAt,
    completedAt: doc.completedAt,
    fieldCount: doc.fieldCount,
    signers: (doc.signers || []).map(s => ({
      name: s.name,
      email: s.email,
      role: s.role,
      status: s.status,
      signedAt: s.signedAt,
    })),
  };
}

async function homeData(caller) {
  const [waiting, drafts, completed] = await Promise.all([
    listDocuments(caller, { status: 'in_progress', limit: LIST_LIMIT }),
    listDocuments(caller, { status: 'draft', limit: LIST_LIMIT }),
    listDocuments(caller, { status: 'completed', limit: LIST_LIMIT }),
  ]);
  return {
    account: { name: caller.name, email: caller.email, company: caller.company || undefined },
    appUrl: caller.publicUrl || undefined,
    canWrite: canWrite(caller),
    waiting: waiting.map(rowOf),
    drafts: drafts.map(rowOf),
    completed: completed.map(rowOf),
    limit: LIST_LIMIT,
  };
}

/** The first page that carries a field: where a preview should open, not on a cover page. */
async function firstFieldPage(caller, documentId) {
  try {
    const draft = await getDraft(caller, documentId);
    const pages = [
      ...(draft?.recipients || []).flatMap(r => r.fields || []),
      ...(draft?.prefillFields || []),
    ]
      .map(f => Number(f.page))
      .filter(n => n > 0);
    return pages.length ? Math.min(...pages) : 1;
  } catch {
    return 1;
  }
}

async function documentData(caller, documentId) {
  const document = await getDocument(caller, documentId, { urls: true });
  const [review, previewPage] = await Promise.all([
    document.status === 'draft' ? reviewDraft(caller, documentId) : undefined,
    firstFieldPage(caller, documentId),
  ]);
  return {
    canWrite: canWrite(caller),
    appUrl: caller.publicUrl || undefined,
    previewPage,
    document,
    review: review
      ? {
          readyToSend: review.readyToSend,
          errors: review.errors,
          warnings: review.warnings,
          pages: review.summary?.pages,
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ participants */

const NOT_OWNER = 'You do not own this document.';

/**
 * Refuse a document read by someone who does not own it, unless their address
 * is verified: an account opened in someone else's name must not read what was
 * sent to that address. Only someone the document was sent to is told why;
 * anyone else gets `strangerError`, the answer they got before.
 *
 * @param {import('../lib/context.js').Caller} caller
 * @param {string} documentId
 * @param {() => Parse.Error} [strangerError]
 */
export async function assertParticipantMayRead(
  caller,
  documentId,
  strangerError = () => new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, NOT_OWNER)
) {
  const problem = verifiedIdentityProblem(caller);
  if (!problem) return;
  const sentToThem = await loadParticipantDocument(caller, documentId).then(
    () => true,
    () => false
  );
  if (sentToThem) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, problem);
  throw strangerError();
}

/**
 * The owner's view of a document, or, for someone it was sent to, theirs.
 * The owner path runs first and unchanged; only its "you do not own this"
 * answer falls through to the participant path (lib/inbox.js), which needs a
 * verified address and answers "Document not found." to anyone else.
 */
export async function ownerOrParticipant(caller, documentId, asOwner, asParticipant) {
  try {
    return await asOwner();
  } catch (err) {
    if (err?.code !== Parse.Error.OPERATION_FORBIDDEN || err?.message !== NOT_OWNER) throw err;
  }
  await assertParticipantMayRead(caller, documentId);
  return await asParticipant();
}

/** A document someone else sent the user, for the document view (`role: 'signer'`). */
async function participantData(caller, documentId) {
  const document = await getParticipantDocument(caller, documentId);
  const pages = (document.myFields || []).map(f => Number(f.page)).filter(n => n > 0);
  return {
    canWrite: canWrite(caller),
    appUrl: caller.publicUrl || undefined,
    previewPage: pages.length ? Math.min(...pages) : 1,
    document,
  };
}

/**
 * The document view's data (what show_document shows), for the owner or for
 * someone the document was sent to.
 *
 * @param {import('../lib/context.js').Caller} caller
 * @param {string} documentId
 */
export async function documentView(caller, documentId) {
  return await ownerOrParticipant(
    caller,
    documentId,
    () => documentData(caller, documentId),
    () => participantData(caller, documentId)
  );
}

const MY_STATUS = {
  needs_you: 'it needs their signature',
  waiting: 'others sign before them',
  signed: 'they have signed',
  declined: 'it was declined',
};

/** One line about a document view, for the model. */
function documentSummary(data) {
  const d = data.document;
  if (d.role === 'signer') {
    const from = d.sender?.name || d.sender?.email || 'someone';
    return `Showing "${d.title}" to the user: sent to them by ${from}, ${MY_STATUS[d.myStatus] || d.status}.`;
  }
  const signed = d.signers.filter(s => s.status === 'signed').length;
  const state =
    d.status === 'draft'
      ? data.review?.readyToSend
        ? 'draft, ready to send'
        : `draft, not ready to send (${plural(data.review?.errors?.length || 0, 'problem')})`
      : `${d.status.replace('_', ' ')}, ${signed} of ${d.signers.length} signed`;
  return `Showing "${d.name}" to the user: ${state}.`;
}

/* ------------------------------------------------------------------ approvals */

/**
 * The sign_document result for a document someone else sent: nothing is
 * signed, the approval card shows. The approval code goes in `_meta` only,
 * and only when this host may approve in the chat.
 *
 * @param {{approval: Object, chatApproval: boolean, nonce: string|null, appUrl: string, created: boolean}} out
 *   lib/approvals.js createSignApproval
 */
export function approvalResult(out) {
  const { approval, chatApproval, nonce, appUrl } = out;
  const where = chatApproval
    ? `with the Approve button on the card shown in this chat, or in ${appName} at ${appUrl}`
    : `in ${appName} at ${appUrl} (the card has a button that opens it)`;
  const message = [
    `Nothing is signed yet. "${approval.document.title}" was sent to the user by someone else, so ${appName} needs the user's approval before you sign it for them.`,
    `They approve or decline ${where}; they were also emailed a link.`,
    `Then call get_approval with approvalId "${approval.id}" to wait for the decision.`,
    out.created
      ? ''
      : 'This request was already open, so it was shown again instead of a new one.',
    'Do not ask the user for an approval code and do not call sign_document again while the request is pending.',
  ]
    .filter(Boolean)
    .join(' ');
  const summary = {
    status: 'awaiting_approval',
    approvalId: approval.id,
    documentId: approval.document.id,
    title: approval.document.title,
    chatApproval,
    appUrl,
    message,
  };
  return result(
    JSON.stringify(summary, null, 2),
    { view: 'approval', approval, chatApproval, appUrl },
    chatApproval && nonce ? { 'docustamp/approvalNonce': nonce } : undefined
  );
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A tool result. `_meta` is for the page only (see the top of this file). */
function result(summary, structuredContent, _meta) {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent,
    ...(_meta ? { _meta } : {}),
  };
}

function failure(err) {
  console.log('mcp app tool error:', err?.message || err);
  return {
    isError: true,
    content: [
      { type: 'text', text: `Error${err?.code ? ` (${err.code})` : ''}: ${safeErrorMessage(err)}` },
    ],
  };
}

function guardedView(fn) {
  return async (args, extra) => {
    try {
      return await fn(args || {}, extra);
    } catch (err) {
      return failure(err);
    }
  };
}

const LIST_FILTERS = { waiting: 'in_progress', draft: 'draft', completed: 'completed', all: 'all' };

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('../lib/context.js').Caller} caller
 */
export function registerAppViews(server, caller) {
  registerAppResource(
    server,
    `${appName} app`,
    APP_RESOURCE_URI,
    { description: `Documents, drafts and signing status in ${appName}.` },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: appHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              // Everything the page shows comes through tool calls; it loads
              // nothing from the network itself.
              csp: { connectDomains: [], resourceDomains: [] },
            },
            'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          },
        },
      ],
    })
  );

  registerAppTool(
    server,
    'open_docustamp',
    {
      title: appName,
      description: `Open the ${appName} app: documents waiting on signers, drafts, and completed documents, with reminders, deadlines and sending. Interactive; for plain data use list_documents.`,
      inputSchema: {},
      _meta: uiMeta([{ type: 'global' }]),
    },
    guardedView(async () => {
      const data = await homeData(caller);
      return result(
        `${appName}: ${plural(data.waiting.length, 'document')} waiting on signers, ${plural(data.drafts.length, 'draft')}, ${data.completed.length} completed recently.`,
        { view: 'home', ...data }
      );
    })
  );

  registerAppTool(
    server,
    'open_review_panel',
    {
      title: 'Review and send',
      description:
        'Open the panel beside this conversation that lists the drafts to check and send, and the documents still waiting on signers.',
      inputSchema: {},
      _meta: uiMeta([{ type: 'thread' }]),
    },
    guardedView(async () => {
      const data = await homeData(caller);
      return result(
        `${plural(data.drafts.length, 'draft')} to review, ${plural(data.waiting.length, 'document')} waiting on signers.`,
        { view: 'panel', ...data }
      );
    })
  );

  registerAppTool(
    server,
    'show_document',
    {
      title: 'Show a document',
      description:
        'Show the user one document as a card in the chat. A draft shows its pages with the fields drawn on them, what still blocks sending, and a Send button, so the user checks it and sends it themselves: after create_document (or quick_send with dryRun) call this instead of send_document when the user should confirm first. A sent document shows who has signed, with a reminder button. A document someone else sent the user (list_inbox) shows what it asks of them.',
      inputSchema: { documentId: z.string() },
      _meta: uiMeta(),
    },
    guardedView(async ({ documentId }) => {
      const data = await documentView(caller, documentId);
      return result(documentSummary(data), { view: 'document', ...data });
    })
  );

  registerAppTool(
    server,
    'show_documents',
    {
      title: 'Show documents',
      description:
        'Show the user a short list card of their documents: waiting (sent, not finished), draft, completed, or all. For data to reason over, use list_documents.',
      inputSchema: { filter: z.enum(['waiting', 'draft', 'completed', 'all']).optional() },
      _meta: uiMeta(),
    },
    guardedView(async ({ filter = 'waiting' }) => {
      const rows = (
        await listDocuments(caller, { status: LIST_FILTERS[filter], limit: CARD_LIST_LIMIT + 1 })
      ).map(rowOf);
      const items = rows.slice(0, CARD_LIST_LIMIT);
      return result(
        `Showing ${plural(items.length, 'document')} (${filter}) to the user${rows.length > items.length ? ', more in the app' : ''}.`,
        {
          view: 'list',
          filter,
          items,
          more: rows.length > items.length,
          canWrite: canWrite(caller),
        }
      );
    })
  );

  server.registerTool(
    'app_home',
    {
      title: 'App: documents home',
      description: `Data for the ${appName} app's home view.`,
      inputSchema: {},
      _meta: APP_ONLY,
    },
    guardedView(async () => result('Home data.', { view: 'home', ...(await homeData(caller)) }))
  );

  server.registerTool(
    'app_document',
    {
      title: 'App: one document',
      description: `Data for the ${appName} app's document view.`,
      inputSchema: { documentId: z.string() },
      _meta: APP_ONLY,
    },
    guardedView(async ({ documentId }) =>
      result('Document data.', { view: 'document', ...(await documentView(caller, documentId)) })
    )
  );

  server.registerTool(
    'app_page',
    {
      title: 'App: page image',
      description: `One page of a document as an image, with its fields drawn on it, for the ${appName} app.`,
      inputSchema: {
        documentId: z.string(),
        page: z.number().int().min(1).optional(),
        source: z.enum(['original', 'signed']).optional(),
      },
      _meta: APP_ONLY,
    },
    guardedView(async ({ documentId, page, source }) => {
      // Someone the document was sent to sees the current copy, their own fields only.
      const { png, ...rest } = await ownerOrParticipant(
        caller,
        documentId,
        () => renderPagePreview(caller, documentId, { page, source, scale: PAGE_SCALE }),
        () => renderParticipantPreview(caller, documentId, { page, scale: PAGE_SCALE })
      );
      return result(`Page ${rest.page} of ${rest.pageCount}.`, {
        page: rest.page,
        pageCount: rest.pageCount,
        width: rest.width,
        height: rest.height,
        source: rest.source,
        image: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      });
    })
  );

  server.registerTool(
    'app_approval',
    {
      title: 'App: approval',
      description: `The current state of a request to sign, for the ${appName} app's approval card.`,
      inputSchema: { approvalId: z.string() },
      _meta: APP_ONLY,
    },
    guardedView(async ({ approvalId }) => {
      const approval = await getApproval(caller, approvalId);
      return result(`Approval ${approval.status}.`, { approval });
    })
  );

  server.registerTool(
    'app_decide_approval',
    {
      title: 'App: approve or decline',
      description: `The approval card's Approve and Decline buttons. Needs the single-use code the card was given; it works only in apps that keep that code from the model.`,
      inputSchema: {
        approvalId: z.string(),
        nonce: z.string(),
        decision: z.enum(['approve', 'decline']),
      },
      _meta: APP_ONLY,
    },
    guardedView(async ({ approvalId, nonce, decision }) => {
      const approval = await decideApproval({ approvalId, decision, via: 'chat', caller, nonce });
      const said =
        approval.status === 'signed'
          ? `The user approved and ${appName} signed "${approval.document.title}" for them.`
          : approval.status === 'declined'
            ? `The user declined: do not sign "${approval.document.title}".`
            : `The user approved, but signing failed: ${approval.error || 'no reason given.'}`;
      return result(said, { approval });
    })
  );
}
