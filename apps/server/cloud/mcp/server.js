import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appName } from '../../Utils.js';
import { describeAi } from '../ai/client.js';
import { ensureContact, listContacts } from '../lib/contacts.js';
import {
  createDocument,
  createDocumentFromTemplate,
  getDocument,
  listDocuments,
  listTemplates,
  sendDocument,
  signingLinks,
} from '../lib/documents.js';
import {
  aiLayoutDraft,
  deleteDocument,
  duplicateDocument,
  getDraft,
  getDraftVersion,
  listDeletedDocuments,
  listDraftVersions,
  removeDraftFields,
  restoreDeletedDocument,
  restoreDraftVersion,
  reviewDraft,
  setDraftFields,
  snapshotDraft,
  undoDraftChange,
  updateDraft,
  updateDraftField,
} from '../lib/drafts.js';
import { bytesFromInput, uploadPdfBytesDetailed } from '../lib/files.js';
import { BRANDING_FIELDS, getBranding, updateBranding } from '../lib/branding.js';
import { getAuditTrail, verifyDocumentCopy } from '../lib/audit.js';
import { detectFields, findText, placeFieldAtText } from '../lib/anchors.js';
import { renderPagePreview } from '../lib/preview.js';
import { createTemplate, deleteTemplate, saveDocumentAsTemplate } from '../lib/templates.js';
import { deleteContact, updateContact } from '../lib/contacts.js';
import { createFolder, listFolders } from '../lib/folders.js';
import { deleteWebhook, listWebhooks, registerWebhook, testWebhook, WEBHOOK_EVENTS } from '../lib/webhooks.js';
import { completeUpload, createUpload, mergeAndStore } from '../lib/uploads.js';
import { DATE_FORMATS } from '../lib/documents.js';
import {
  extendExpiry,
  replaceSigner,
  resendTo,
  setDocumentChain,
  voidDocument,
  waitForDocument,
} from '../lib/lifecycle.js';
import { unbrandedSenderWarning } from '../lib/drafts.js';
import { checkAiRateLimit } from '../parsefunction/aiFunctions.js';
import { SCOPE_READ, SCOPE_WRITE } from '../lib/oauth.js';
import { sanitisePlaceholders } from '../lib/widgets.js';
import {
  analyzeFlow,
  pageInfoFor,
  quickSendFlow,
  remindDocument,
  requireAiEnabled,
  safeErrorMessage,
} from '../api/shared.js';

/**
 * The DocuStamp MCP server. Stateless: a fresh instance is built for every HTTP
 * request around the caller resolved from the API token, so tools never look at
 * headers or sessions themselves. The same library functions back the REST API.
 */

export const MCP_SERVER_INFO = { name: 'docustamp', version: '1.2.0' };

const RecipientSchema = z.object({
  name: z.string().optional().describe('Full name. Defaults to the part of the email before @.'),
  email: z.string().describe('Email address of the signer.'),
  role: z
    .string()
    .optional()
    .describe('Role label such as "Tenant" or "Client". Defaults to "Role N".'),
  phone: z.string().optional(),
});

const FieldSchema = z.object({
  recipient: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe(
      'Which recipient owns the field: index (0-based), email, or role label. Use "prefill" for values the sender fills before sending. Defaults to 0.'
    ),
  type: z
    .string()
    .describe(
      'signature | initials | stamp | date | name | email | company | "job title" | "text input" | checkbox | dropdown | "radio button" | cells | image'
    ),
  page: z.number().int().min(1).describe('1-based page number.'),
  x: z.number().describe('Left edge in PDF points (1/72 inch) from the left of the page.'),
  y: z.number().describe('Top edge in PDF points from the TOP of the page.'),
  width: z.number().optional(),
  height: z.number().optional(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  values: z
    .array(z.string())
    .optional()
    .describe('Options for dropdown / radio button / checkbox.'),
  defaultValue: z
    .union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))])
    .optional()
    .describe('Pre-filled value (text types) or pre-selected option(s) for checkbox / radio / dropdown, as option labels (or 0-based indexes). Stored and read back as labels.'),
  readOnly: z.boolean().optional(),
  hideLabel: z
    .boolean()
    .optional()
    .describe('checkbox / radio / dropdown: do not print the option label next to the box (for a tick box placed over a printed label). place_field_at_text defaults it to true for single-option boxes.'),
});

/**
 * One role group of the `Placeholders` array `analyze_document` returns.
 *
 * This was `z.any()`, so a malformed group reached `createDocument` unchecked
 * and only `sanitisePlaceholders` (which the tool did not call) stood between a
 * widget with `xPosition: "abc"` and a stored document that blows up at stamping
 * time, after the signer has signed. The shape is deliberately permissive about
 * extra keys: the analyzer adds its own and `sanitisePlaceholders` is what
 * actually normalises them.
 */
const PlaceholderWidgetSchema = z
  .object({
    type: z.string(),
    xPosition: z.number(),
    yPosition: z.number(),
    Width: z.number().optional(),
    Height: z.number().optional(),
    key: z.union([z.number(), z.string()]).optional(),
    options: z.record(z.any()).optional(),
  })
  .passthrough();

const PlaceholderPageSchema = z
  .object({
    pageNumber: z.number().int().min(1),
    pos: z.array(PlaceholderWidgetSchema),
  })
  .passthrough();

const PlaceholderGroupSchema = z
  .object({
    Role: z.string().optional(),
    Id: z.union([z.number(), z.string()]).optional(),
    email: z.string().optional(),
    placeHolder: z.array(PlaceholderPageSchema),
  })
  .passthrough();

const RecipientRefSchema = z
  .union([z.number().int(), z.string()])
  .describe(
    'A recipient: index (0-based), email, or role label. "prefill" = fields the sender fills before sending.'
  );

const FieldChangesSchema = z.object({
  x: z.number().optional().describe('New left edge (PDF points from the left).'),
  y: z.number().optional().describe('New top edge (PDF points from the top).'),
  page: z.number().int().min(1).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  label: z.string().optional().describe('Hint shown in the box; "" clears it.'),
  required: z.boolean().optional(),
  values: z
    .array(z.string())
    .optional()
    .describe('New options for dropdown / radio button / checkbox.'),
  defaultValue: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]).optional(),
  readOnly: z.boolean().optional(),
  hideLabel: z.boolean().optional(),
  recipient: RecipientRefSchema.optional().describe(
    'Hand the field to another recipient (or "prefill").'
  ),
  type: z.string().optional().describe('Change the field type (keeps position and size).'),
  dateFormat: z
    .string()
    .optional()
    .describe('Date fields only, e.g. "MM/dd/yyyy" or "dd-MM-yyyy".'),
});

const SettingsSchema = z
  .object({
    expiryDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Days until the request expires (default 15).'),
    remindEveryDays: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe('Automatic reminder cadence; 0 disables (default).'),
    sendInOrder: z
      .boolean()
      .optional()
      .describe('Signers sign one after the other in recipient order.'),
    strictOrder: z.boolean().optional(),
    otp: z.boolean().optional().describe('Require an email one-time code before signing.'),
    notifyOnSignatures: z.boolean().optional(),
    allowModifications: z.boolean().optional(),
    redirectUrl: z.string().optional(),
    bcc: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    dateFormat: z
      .string()
      .optional()
      .describe(`Date format for this document's date fields and certificate (default: the account setting). One of ${DATE_FORMATS.join(', ')}.`),
    timezone: z.string().optional().describe('IANA timezone for the certificate times (default: the account setting), e.g. "America/Chicago".'),
    is12HourTime: z.boolean().optional(),
  })
  .optional();

const MessageSchema = z
  .object({
    subject: z
      .string()
      .optional()
      .describe(
        'Email subject. Supports {{document_title}}, {{receiver_name}}, {{sender_name}}, {{signing_url}}, {{expiry_date}}.'
      ),
    body: z
      .string()
      .optional()
      .describe(
        'Email body (plain text or HTML), same {{variables}}. Put {{signing_url}} where the signing link should go; without it the link is appended after your text and review_draft warns (message_without_link).'
      ),
  })
  .optional();

const ChainSchema = z
  .object({
    templateId: z.string().describe('The template the follow-up document is created from.'),
    recipients: z
      .array(RecipientSchema)
      .optional()
      .describe(
        "Signers of the follow-up, one per template role. Leave out to reuse the completed document's signers, in order."
      ),
    name: z.string().optional().describe('Title of the follow-up (default: the template name).'),
    note: z.string().optional(),
    message: MessageSchema,
  })
  .nullable()
  .optional()
  .describe(
    'Chaining: when this document completes, automatically create a document from the given template and send it. The follow-up reports chainedFrom, this document reports chainResult once it fires, and the "chained" webhook event carries the outcome. Pass null to remove a chain.'
  );

const FileInputShape = {
  url: z
    .string()
    .optional()
    .describe(
      `URL of a PDF already uploaded to ${appName} (from upload_document), or a PDF on a public https host: an external file is downloaded once and copied into ${appName} storage. URLs on private or internal hosts are refused.`
    ),
  fileBase64: z
    .string()
    .optional()
    .describe('Base64 of the PDF bytes, when the file is local to you.'),
};

function text(data) {
  return {
    content: [
      { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(err) {
  // Provider and internal failures name AWS ARNs, account ids and file paths;
  // the real text is logged in `guarded`, the agent gets the safe version.
  const message = safeErrorMessage(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error${err?.code ? ` (${err.code})` : ''}: ${message}` }],
  };
}

/** Like `guarded`, for tools whose result is an image plus a JSON text part. */
function guardedImage(fn) {
  return async (args, extra) => {
    try {
      const { png, ...rest } = await fn(args || {}, extra);
      return {
        content: [
          { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(rest, null, 2) },
        ],
      };
    } catch (err) {
      console.log('mcp tool error:', err?.message || err);
      return errorResult(err);
    }
  };
}

function guarded(fn) {
  return async (args, extra) => {
    try {
      return text(await fn(args || {}, extra));
    } catch (err) {
      console.log('mcp tool error:', err?.message || err);
      return errorResult(err);
    }
  };
}

/**
 * Safety labels for every tool (MCP tool annotations). Hosts use them to decide
 * what needs the user's confirmation: ChatGPT asks before running a tool marked
 * destructive, and its plugin review requires every tool to be labelled.
 *
 *   READ         looks, changes nothing
 *   WRITE        changes something in this account that can be put back:
 *                every draft edit is snapshotted first (undo_draft_change)
 *   DESTRUCTIVE  deletes, overwrites workspace-wide settings, or cannot be
 *                undone from here
 *   OUTREACH     emails people or posts to an outside url: sending, reminding,
 *                voiding, chaining, webhooks. Destructive, because a sent
 *                email cannot be taken back
 *
 * `openWorldHint` is also set on the tools that may download a PDF from a
 * public url (the `url` input of FileInputShape).
 *
 * Every registered tool must have an entry: `buildMcpServer` refuses to
 * register one without, so a new tool cannot ship unlabelled.
 */
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const READ_URL = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const WRITE_URL = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
const OUTREACH = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });

export const TOOL_ANNOTATIONS = Object.freeze({
  whoami: READ,
  get_branding: READ,
  update_branding: DESTRUCTIVE,
  upload_document: WRITE_URL,
  analyze_document: READ_URL,
  create_document: WRITE_URL,
  merge_documents: WRITE_URL,
  create_upload: WRITE,
  complete_upload: WRITE,
  register_webhook: WRITE_URL,
  list_webhooks: READ,
  test_webhook: WRITE_URL,
  delete_webhook: DESTRUCTIVE,
  quick_send: OUTREACH,
  send_document: OUTREACH,
  list_documents: READ,
  get_document: READ,
  void_document: OUTREACH,
  replace_signer: OUTREACH,
  resend_to: OUTREACH,
  extend_expiry: WRITE,
  set_chain: OUTREACH,
  wait_for: READ,
  get_audit_trail: READ,
  verify_document: READ_URL,
  get_signing_links: READ,
  send_reminder: OUTREACH,
  list_contacts: READ,
  add_contact: WRITE,
  list_templates: READ,
  create_document_from_template: WRITE,
  get_draft: READ,
  review_draft: READ,
  update_draft: WRITE_URL,
  set_draft_fields: WRITE,
  update_draft_field: WRITE,
  remove_draft_fields: WRITE,
  ai_layout_draft: WRITE,
  preview_page: READ,
  find_text: READ,
  detect_fields: READ,
  place_field_at_text: WRITE,
  create_template: WRITE_URL,
  save_as_template: WRITE,
  delete_template: DESTRUCTIVE,
  update_contact: WRITE,
  delete_contact: DESTRUCTIVE,
  list_folders: READ,
  create_folder: WRITE,
  save_draft_version: WRITE,
  list_draft_versions: READ,
  get_draft_version: READ,
  restore_draft_version: WRITE,
  undo_draft_change: WRITE,
  duplicate_document: WRITE,
  delete_draft: DESTRUCTIVE,
  restore_deleted_document: WRITE,
});

/**
 * Wrap `server.registerTool` so every tool gets its safety labels and the
 * OAuth scope it needs (`securitySchemes`, which ChatGPT reads), and so a
 * connection that was only allowed to read (an OAuth grant without
 * documents:write) never sees the tools that change anything. API tokens carry
 * no scopes and get every tool.
 *
 * @param {McpServer} server
 * @param {import('../lib/context.js').Caller} caller
 */
function labelTools(server, caller) {
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, cb) => {
    const annotations = TOOL_ANNOTATIONS[name];
    if (!annotations) throw new Error(`MCP tool "${name}" has no entry in TOOL_ANNOTATIONS`);
    const scope = annotations.readOnlyHint ? SCOPE_READ : SCOPE_WRITE;
    if (caller.scopes && !caller.scopes.includes(scope)) return undefined;
    return register(
      name,
      {
        ...config,
        annotations: { ...annotations, ...config.annotations },
        _meta: { ...config._meta, securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
      },
      cb
    );
  };
}

/**
 * @param {import('../lib/context.js').Caller} caller
 */
export function buildMcpServer(caller) {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: [
      `${appName} e-signature tools for ${caller.name || caller.email}.`,
      "Typical flow: upload_document (or pass fileBase64 directly) -> analyze_document to let AI find the signers and field positions -> create_document (with the proposal's placeholders, or your own fields) -> send_document. quick_send does all of it in one call.",
      'Drafts are fully editable until sent: get_draft shows everything (recipients, every field with its key and coordinates, settings, message); review_draft lists what blocks sending; update_draft changes title, note, recipients, settings, message, folder or the PDF; set_draft_fields / update_draft_field / remove_draft_fields edit the fields; ai_layout_draft lets the AI place the fields again. Every change is snapshotted first: undo_draft_change reverts the last one, list_draft_versions + restore_draft_version go back further, save_draft_version stores a named checkpoint. duplicate_document copies any document into a new draft; delete_draft / restore_deleted_document soft-delete and bring back.',
      'Coordinates are PDF points with the origin at the top-left of the page. Documents are drafts until sent; sending emails every signer a signing link.',
      'get_branding shows how the workspace\'s emails are branded (sender display name, reply-to, footer, logo, Powered-by line, default request and completion subject/body); update_branding changes any of them (workspace admins only; null clears a field).',
    ].join(' '),
  });
  labelTools(server, caller);

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: `The ${appName} account this token belongs to, and whether AI preparation is available.`,
      inputSchema: {},
    },
    guarded(async () => ({
      name: caller.name,
      email: caller.email,
      company: caller.company || undefined,
      ai: describeAi(),
      appUrl: caller.publicUrl || undefined,
    }))
  );

  server.registerTool(
    'get_branding',
    {
      title: 'Email branding',
      description: `How this workspace's emails are branded: the sender display name every mail goes out under (and the name requests would use without one), reply-to, footer text, logo url, whether the "Sent via ${appName}" line is hidden, and the default request / completion mail subject and body with the {{variables}} they accept. canEdit says whether this account may change them.`,
      inputSchema: {},
    },
    guarded(async () => await getBranding(caller))
  );

  server.registerTool(
    'update_branding',
    {
      title: 'Change email branding',
      description: `Change the workspace's email branding (workspace admins only). Pass only the fields to change; null or "" clears one. Fields: ${BRANDING_FIELDS.join(', ')}. Subject/body pairs are only applied together. Returns the branding after the change, like get_branding.`,
      inputSchema: {
        senderName: z
          .string()
          .nullable()
          .optional()
          .describe('Display name every mail from the workspace goes out under (max 80 chars, plain text). Clear it to fall back to each sender\'s company.'),
        replyTo: z
          .string()
          .nullable()
          .optional()
          .describe('Reply-to address for every mail; defaults to the sender\'s own address.'),
        footer: z
          .string()
          .nullable()
          .optional()
          .describe('Plain-text footer under every mail (max 500 chars, line breaks kept).'),
        logoUrl: z
          .string()
          .nullable()
          .optional()
          .describe('Url of a logo already uploaded to this server (upload_document, or the web app).'),
        hidePoweredBy: z
          .boolean()
          .nullable()
          .optional()
          .describe(`Hide the "Sent via ${appName}" line.`),
        workspaceName: z.string().optional().describe('The workspace name (max 100 chars).'),
        requestSubject: z
          .string()
          .nullable()
          .optional()
          .describe('Default signature-request subject. Supports {{document_title}}, {{sender_name}}, {{receiver_name}}, {{expiry_date}}, {{company_name}}...'),
        requestBody: z
          .string()
          .nullable()
          .optional()
          .describe('Default signature-request body (plain text or HTML; {{signing_url}} places the link).'),
        completionSubject: z.string().nullable().optional().describe('Default "everyone signed" subject.'),
        completionBody: z.string().nullable().optional().describe('Default "everyone signed" body.'),
      },
    },
    guarded(async changes => await updateBranding(caller, changes))
  );

  server.registerTool(
    'upload_document',
    {
      title: 'Upload a PDF',
      description: `Upload PDF bytes (base64) to ${appName} storage. Returns the url to pass to analyze_document / create_document.`,
      inputSchema: {
        fileBase64: z.string().describe('Base64 of the PDF bytes.'),
        fileName: z.string().optional().describe('Original file name, e.g. "lease.pdf".'),
        keepOriginal: z.boolean().optional().describe('Store the bytes untouched (no AcroForm flattening), e.g. a signed copy you will pass to verify_document by url.'),
      },
    },
    guarded(async ({ fileBase64, fileName, keepOriginal }) => {
      const bytes = await bytesFromInput({ fileBase64 });
      // The detailed variant, so a PDF whose AcroForm could not be flattened is
      // reported rather than silently uploaded: its live form fields sit under
      // the signing widgets and capture the signer's clicks.
      const stored = await uploadPdfBytesDetailed(bytes, fileName, { flatten: keepOriginal !== true });
      return {
        url: stored.url,
        bytes: bytes.length,
        flattened: stored.flattened,
        ...(stored.flattened
          ? {}
          : {
              warnings: [
                `The existing form fields in this PDF could not be flattened (${stored.flattenError}); signers may see interactive fields under the signature boxes.`,
              ],
            }),
      };
    })
  );

  server.registerTool(
    'analyze_document',
    {
      title: 'Analyze a PDF with AI',
      description:
        'Ask Claude to read the PDF and propose the signer roles (with names/emails if printed in the document), every field (signature, date, initials, text, checkbox...) with exact page coordinates, and a title/summary. Returns a proposal whose `placeholders` can be passed straight to create_document, and `roles` that tell you which recipients are still missing an email.',
      inputSchema: {
        ...FileInputShape,
        instructions: z
          .string()
          .optional()
          .describe(
            'Free-text guidance, e.g. "the landlord is me, only the tenant signs, add initials on every page".'
          ),
        recipients: z
          .array(RecipientSchema)
          .optional()
          .describe(
            'Recipients you already know; the AI maps them onto the roles it finds, in order.'
          ),
      },
    },
    guarded(async args => await analyzeFlow(caller, args))
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create a document',
      description:
        'Create a signing request (a draft unless send=true). Give `placeholders` from analyze_document, or explicit `fields`; with neither, each recipient gets a signature + date box at the bottom of the last page. Recipients become contacts automatically.',
      inputSchema: {
        name: z.string().describe('Document title shown to signers.'),
        url: z
          .string()
          .describe(
            'Stored PDF url (from upload_document or analyze_document input). A public external url works too and is copied into storage first.'
          ),
        recipients: z.array(RecipientSchema).min(1),
        fields: z.array(FieldSchema).optional(),
        placeholders: z
          .array(PlaceholderGroupSchema)
          .optional()
          .describe(
            'The `placeholders` array returned by analyze_document. Roles bind to recipients by position.'
          ),
        settings: SettingsSchema,
        message: MessageSchema,
        note: z
          .string()
          .optional()
          .describe('Short note shown in the request email (max 200 chars).'),
        description: z.string().optional(),
        folderId: z.string().optional(),
        send: z
          .boolean()
          .optional()
          .describe('Send immediately (emails every signer). Default false = draft.'),
        chain: ChainSchema,
        pageCount: z
          .number()
          .int()
          .optional()
          .describe(
            'Page count for the default field layout. Optional: the PDF is read for it when neither fields nor placeholders are given.'
          ),
        attachments: z
          .array(z.object({ url: z.string().optional(), fileBase64: z.string().optional(), fileName: z.string().optional() }))
          .optional()
          .describe('More PDFs to append after `url` (an MSA + BAA + ACH as one envelope): merged into one file, signed under one link and one OTP. The result reports `parts` with each file\'s first page, so field page numbers can be offset.'),
      },
    },
    guarded(async args => {
      let merged;
      if (Array.isArray(args.attachments) && args.attachments.length) {
        merged = await mergeAndStore([{ url: args.url }, ...args.attachments], `${args.name || 'envelope'}.pdf`);
        args = { ...args, url: merged.url };
      }
      const created = await createDocument(caller, {
        ...args,
        ...(merged ? { envelopeParts: merged.parts } : {}),
        // The same check `createDocument` runs, applied here so a malformed
        // group is refused with the tool's own error rather than after the
        // upload work. `z.any()` used to let anything through.
        ...(args.placeholders ? { placeholders: sanitisePlaceholders(args.placeholders) } : {}),
        pageInfo: await pageInfoFor(args),
        origin: 'mcp',
      });
      return merged ? { ...created, envelope: { pageCount: merged.pageCount, parts: merged.parts } } : created;
    })
  );

  server.registerTool(
    'merge_documents',
    {
      title: 'Merge PDFs into one',
      description:
        'Concatenate several PDFs (urls or base64) into one stored file and report where each starts (parts: firstPage, pageCount). Use the returned url with create_document / analyze_document for a multi-file envelope signed under one link.',
      inputSchema: {
        files: z.array(z.object({ url: z.string().optional(), fileBase64: z.string().optional(), fileName: z.string().optional() })).min(1).max(20),
        fileName: z.string().optional(),
      },
    },
    guarded(async ({ files, fileName }) => await mergeAndStore(files, fileName))
  );

  server.registerTool(
    'create_upload',
    {
      title: 'Start a large upload',
      description:
        'For big PDFs: returns a presigned PUT url on object storage (valid 15 minutes). PUT the raw bytes there (curl -T file.pdf), then call complete_upload with the uploadId to get the stored url for create_document / analyze_document. On a server that stores files on its own disk it answers mode "direct" (use upload_document or a public url instead).',
      inputSchema: { fileName: z.string().optional(), size: z.number().int().optional() },
    },
    guarded(async ({ fileName, size }) => await createUpload(caller, { fileName, size }))
  );

  server.registerTool(
    'complete_upload',
    {
      title: 'Finish a large upload',
      description: 'After PUTting the file to the create_upload url: checks it is a PDF, flattens and stores it, returns the url.',
      inputSchema: {
        uploadId: z.string(),
        fileName: z.string().optional(),
        keepOriginal: z.boolean().optional().describe('Store the bytes untouched (no flattening); needed for a signed copy you will verify by url.'),
      },
    },
    guarded(
      async ({ uploadId, fileName, keepOriginal }) =>
        await completeUpload(caller, { uploadId, fileName, keepOriginal })
    )
  );

  server.registerTool(
    'register_webhook',
    {
      title: 'Register a webhook',
      description: `POST document events to your https url: ${WEBHOOK_EVENTS.join(', ')} (or "*"). Each delivery is JSON {id, event, createdAt, document, signer?, reason?} with X-DocuStamp-Event, X-DocuStamp-Delivery and X-DocuStamp-Signature: sha256=HMAC_SHA256(secret, body); three attempts. The secret is returned once (or pass your own). Registering the same url again updates it.`,
      inputSchema: {
        url: z.string(),
        events: z.array(z.string()).optional().describe('Default ["*"].'),
        secret: z.string().optional(),
        description: z.string().optional(),
      },
    },
    guarded(async input => await registerWebhook(caller, input))
  );

  server.registerTool(
    'list_webhooks',
    {
      title: 'List webhooks',
      description: 'Your webhooks with their last delivery status. showSecrets: true includes the secrets.',
      inputSchema: { showSecrets: z.boolean().optional() },
    },
    guarded(async ({ showSecrets }) => ({ webhooks: await listWebhooks(caller, { showSecrets }) }))
  );

  server.registerTool(
    'test_webhook',
    {
      title: 'Send a test delivery',
      description: 'POST a signed "ping" to one webhook and report the response status.',
      inputSchema: { webhookId: z.string() },
    },
    guarded(async ({ webhookId }) => await testWebhook(caller, webhookId))
  );

  server.registerTool(
    'delete_webhook',
    {
      title: 'Delete a webhook',
      description: 'Stop deliveries to one webhook.',
      inputSchema: { webhookId: z.string() },
    },
    guarded(async ({ webhookId }) => await deleteWebhook(caller, webhookId))
  );

  server.registerTool(
    'quick_send',
    {
      title: 'Upload, prepare with AI and send',
      description:
        'One call: takes a PDF (url or base64), lets AI find roles and place the fields, binds the recipients you give, creates the request and emails the signers. If a role has no email, nothing is sent and `needsRecipients` lists what is missing (with `suggestedEmail` when the address is printed in the document itself, which is only a suggestion because the PDF is untrusted): call again with `recipients` filled in, or with acceptExtractedRecipients=true to use the suggestions. Pass the returned `proposal` back on that second call to skip a second AI analysis. Set dryRun=true to create a draft instead of sending.',
      inputSchema: {
        ...FileInputShape,
        fileName: z.string().optional(),
        instructions: z.string().optional(),
        recipients: z.array(RecipientSchema).optional(),
        name: z.string().optional().describe('Override the AI-proposed title.'),
        settings: SettingsSchema,
        message: MessageSchema,
        note: z.string().optional(),
        chain: ChainSchema,
        dryRun: z.boolean().optional().describe('Create as a draft instead of sending.'),
        acceptExtractedRecipients: z
          .boolean()
          .optional()
          .describe(
            'Bind and mail the email addresses the AI read out of the PDF itself. Only set this after showing the user the `suggestedEmail` values from a previous call.'
          ),
        proposal: z
          .any()
          .optional()
          .describe(
            'The full proposal returned by a previous quick_send or analyze_document call, to reuse instead of analysing the PDF again.'
          ),
      },
    },
    guarded(async args => await quickSendFlow(caller, args, 'mcp'))
  );

  server.registerTool(
    'send_document',
    {
      title: 'Send a draft',
      description:
        'Mark a draft as sent and email every signer their signing link. Use resend=true to email the links again for a document that was already sent (resend_to mails one signer). Signing urls and tokens are only returned with includeLinks: true.',
      inputSchema: {
        documentId: z.string(),
        resend: z.boolean().optional(),
        includeLinks: z.boolean().optional().describe('Include each signer\'s signing url and token in the result (secret material; default false).'),
      },
    },
    guarded(async ({ documentId, resend, includeLinks }) => {
      const result = await sendDocument(caller, documentId, { resend: resend === true });
      if (!includeLinks && result?.mail) {
        const { signingLinks, ...mail } = result.mail;
        result.mail = mail;
        result.signers = (result.signers || []).map(({ signingUrl, ...rest }) => rest);
      }
      // Sent, but as the platform's own name: say so, the mail is already out.
      const unbranded = await unbrandedSenderWarning(caller);
      if (!unbranded) return result;
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      return { ...result, warnings: [...warnings, unbranded.message] };
    })
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'Your documents, newest first. status: all | draft | in_progress | completed | declined | expired.',
      inputSchema: {
        status: z
          .enum(['all', 'draft', 'in_progress', 'completed', 'declined', 'voided', 'expired'])
          .optional(),
        search: z.string().optional().describe('Case-insensitive match on the title.'),
        limit: z.number().int().min(1).max(200).optional(),
        skip: z.number().int().min(0).optional(),
      },
    },
    guarded(async args => await listDocuments(caller, args))
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get a document',
      description:
        'Status, signers (who has signed, who is pending) and download urls (original, signed PDF once completed, certificate; valid about an hour). includeLinks: true adds each pending signer\'s signing url (secret material; get_signing_links does the same).',
      inputSchema: { documentId: z.string(), includeLinks: z.boolean().optional() },
    },
    guarded(
      async ({ documentId, includeLinks }) =>
        await getDocument(caller, documentId, { links: includeLinks === true })
    )
  );

  server.registerTool(
    'void_document',
    {
      title: 'Void a sent document',
      description:
        'Withdraw a sent document that is not completed: its status becomes "voided" (recorded as a decline by the sender, pending signers read "voided"), the signing links stop working, and (by default) every signer who has not signed yet is emailed that the request was withdrawn. This is what delete_draft { force: true } is not: that only archives.',
      inputSchema: {
        documentId: z.string(),
        reason: z.string().optional(),
        notifySigners: z.boolean().optional().describe('Email the pending signers (default true).'),
      },
    },
    guarded(
      async ({ documentId, reason, notifySigners }) =>
        await voidDocument(caller, documentId, { reason, notifySigners: notifySigners !== false })
    )
  );

  server.registerTool(
    'replace_signer',
    {
      title: 'Replace a signer',
      description:
        'Put a different person in the seat of a signer who has not signed yet (a bounced address, a different approver). Their fields stay. The new signer is mailed when it is their turn (immediately unless signing is in order and someone before them is still pending).',
      inputSchema: {
        documentId: z.string(),
        signer: z.string().describe('The current signer: email, contactId, role label, or 0-based index.'),
        email: z.string().describe('The new signer\'s email.'),
        name: z.string().optional(),
        phone: z.string().optional(),
        notify: z.boolean().optional().describe('Mail the new signer (default true).'),
      },
    },
    guarded(
      async ({ documentId, ...rest }) => await replaceSigner(caller, documentId, rest)
    )
  );

  server.registerTool(
    'resend_to',
    {
      title: 'Resend to one signer',
      description:
        'Email the signing request again to one pending signer (send_document { resend: true } mails everybody who is pending).',
      inputSchema: {
        documentId: z.string(),
        signer: z.string().describe('Email, contactId, role label, or 0-based index.'),
      },
    },
    guarded(async ({ documentId, signer }) => await resendTo(caller, documentId, { signer }))
  );

  server.registerTool(
    'extend_expiry',
    {
      title: 'Extend the deadline',
      description: 'Move the expiry of a sent document: days from now, or an absolute expiresAt.',
      inputSchema: {
        documentId: z.string(),
        days: z.number().int().min(1).max(365).optional(),
        expiresAt: z.string().optional().describe('ISO date-time.'),
      },
    },
    guarded(
      async ({ documentId, days, expiresAt }) =>
        await extendExpiry(caller, documentId, { days, expiresAt })
    )
  );

  server.registerTool(
    'set_chain',
    {
      title: 'Set the follow-up chain',
      description:
        'Set, change or remove the chain on an existing document: when it completes, a document is created from chain.templateId and sent automatically. Works on drafts and on sent documents nobody has finished yet (a completed, declined or voided document is refused: the chain would never fire). Pass chain: null (or omit it) to remove the chain. create_document and update_draft take the same chain input at creation/edit time.',
      inputSchema: {
        documentId: z.string(),
        chain: ChainSchema,
      },
    },
    guarded(
      async ({ documentId, chain }) =>
        await setDocumentChain(caller, documentId, chain ?? null, { origin: 'mcp' })
    )
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Wait for a document to change',
      description:
        'Long-poll: blocks until the document reaches one of the given statuses (completed, declined, expired, in_progress), or, with no status, until anything changes (a signature lands, status flips), for up to timeoutSec (max 55). Returns the document summary with reached / timedOut. Cheaper than calling get_document in a loop.',
      inputSchema: {
        documentId: z.string(),
        status: z.array(z.enum(['draft', 'in_progress', 'completed', 'declined', 'voided', 'expired'])).optional(),
        timeoutSec: z.number().int().min(1).max(55).optional(),
      },
    },
    guarded(
      async ({ documentId, status, timeoutSec }) =>
        await waitForDocument(caller, documentId, { status, timeoutSec })
    )
  );

  server.registerTool(
    'get_audit_trail',
    {
      title: 'Audit trail and certificate data',
      description:
        'Everything recorded about a document: the audit entries (activity, who {kind, name, email, contactId, role}, at, ip: viewed, signed, approved, declined, voided), how often each signer opened their link (opens: total, bySigner with count/firstAt/lastAt, and the 20 most recent opens with ip and browser), the lifecycle dates (created, sent, expires, completed, declined with reason), the draft version history (what changed before sending, by which origin), and for a completed document the certificate data as JSON (sha256 of the signed copy, signer table with viewed/signed times, opens and IPs, certificate url).',
      inputSchema: {
        documentId: z.string(),
        versionsLimit: z.number().int().min(1).max(200).optional(),
      },
    },
    guarded(
      async ({ documentId, versionsLimit }) =>
        await getAuditTrail(caller, documentId, { versionsLimit })
    )
  );

  server.registerTool(
    'verify_document',
    {
      title: 'Verify a copy',
      description:
        'Check a PDF you were handed against the sha256 recorded when a document completed (the same check as the web app\'s "Verify a copy"). With documentId the file is compared to that document; without it the hash is looked up across your completed documents. Also reports whether the file carries a digital signature (sealed). The hash is over the exact bytes: pass fileBase64, or a url of an untouched copy (upload_document / complete_upload with keepOriginal: true; the default upload flattens the PDF and changes the bytes).',
      inputSchema: {
        documentId: z.string().optional(),
        ...FileInputShape,
      },
    },
    guarded(async input => await verifyDocumentCopy(caller, input))
  );

  server.registerTool(
    'get_signing_links',
    {
      title: 'Signing links',
      description:
        'The signing link for every recipient of a sent document, so you can share it yourself.',
      inputSchema: { documentId: z.string() },
    },
    guarded(async ({ documentId }) => await signingLinks(caller, documentId))
  );

  server.registerTool(
    'send_reminder',
    {
      title: 'Send a reminder',
      description:
        'Email every signer who still has to sign (respects signing order). Refused for a document that was never sent, or is completed, declined or deleted.',
      inputSchema: { documentId: z.string() },
    },
    guarded(async ({ documentId }) => await remindDocument(caller, documentId))
  );

  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description:
        'Your contact book (people you have sent documents to). Page past the first `limit` rows with `skip`.',
      inputSchema: {
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        skip: z.number().int().min(0).optional(),
      },
    },
    guarded(async args => await listContacts(caller, args))
  );

  server.registerTool(
    'add_contact',
    {
      title: 'Add a contact',
      description: 'Create a contact (no-op if the email already exists).',
      inputSchema: {
        name: z.string(),
        email: z.string(),
        phone: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
      },
    },
    guarded(async args => await ensureContact(caller, args))
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'Your templates with their signer roles, for create_document_from_template. Page past the first `limit` rows with `skip`.',
      inputSchema: {
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        skip: z.number().int().min(0).optional(),
      },
    },
    guarded(async args => await listTemplates(caller, args))
  );

  server.registerTool(
    'create_document_from_template',
    {
      title: 'Create from template',
      description:
        'Create (and optionally send) a document from one of your templates. Recipients map to the template roles in order, or by matching `role` label.',
      inputSchema: {
        templateId: z.string(),
        recipients: z.array(RecipientSchema).min(1),
        name: z.string().optional(),
        note: z.string().optional(),
        settings: SettingsSchema,
        message: MessageSchema,
        send: z.boolean().optional(),
        chain: ChainSchema.describe(
          "Chaining for the new document (default: inherited from the template's own chain; null = no chain even if the template has one)."
        ),
      },
    },
    guarded(
      async ({ templateId, ...rest }) =>
        await createDocumentFromTemplate(caller, templateId, { ...rest, origin: 'mcp' })
    )
  );

  /* ---------------------------------------------------------------- drafts */

  server.registerTool(
    'get_draft',
    {
      title: 'Get a draft in full',
      description:
        "Everything about a document for editing: status, recipients (with contact ids and their fields: key, type, page, x, y, width, height, label, required, values, defaultValue), prefill fields, settings, email message, note, folder, version count and editor links. Works on any of your documents; only drafts are editable. pages=true also returns each page's size in PDF points.",
      inputSchema: {
        documentId: z.string(),
        pages: z.boolean().optional().describe('Include page sizes (loads the PDF).'),
      },
    },
    guarded(
      async ({ documentId, pages }) => await getDraft(caller, documentId, { pages: pages === true })
    )
  );

  server.registerTool(
    'review_draft',
    {
      title: 'Review a draft',
      description:
        'Check a draft before sending: errors (block sending: no recipients, missing or duplicate emails, no fields, fields off the page, bad reminder settings), warnings (recipient without a signature field, overlapping fields, untitled, message body without {{signing_url}}) and info. Returns readyToSend plus a per-recipient field count.',
      inputSchema: { documentId: z.string() },
    },
    guarded(async ({ documentId }) => await reviewDraft(caller, documentId))
  );

  server.registerTool(
    'update_draft',
    {
      title: 'Edit a draft',
      description:
        'Change any of: name, note, description, settings (partial: only the keys you pass change), message (email subject/body), folderId (null = root), the PDF (url of an uploaded file, or fileBase64), recipients (the full new list: a recipient that matches an existing one by contact, email, role or position keeps its fields; removed recipients lose theirs), chain (the follow-up sent automatically on completion; null removes it). The previous state is saved as a version first.',
      inputSchema: {
        documentId: z.string(),
        name: z.string().optional(),
        note: z.string().optional().describe('Max 200 chars; "" clears it.'),
        description: z.string().optional(),
        settings: SettingsSchema,
        message: MessageSchema,
        folderId: z.string().nullable().optional(),
        url: z
          .string()
          .optional()
          .describe(
            'Replace the PDF with an already uploaded file (upload_document); a public external url is copied into storage first. Fields are kept.'
          ),
        fileBase64: z
          .string()
          .optional()
          .describe('Replace the PDF with these bytes (uploaded for you).'),
        fileName: z.string().optional(),
        recipients: z.array(RecipientSchema).optional(),
        chain: ChainSchema,
      },
    },
    guarded(async ({ documentId, fileBase64, fileName, ...rest }) => {
      const input = { ...rest };
      if (fileBase64) {
        const stored = await uploadPdfBytesDetailed(await bytesFromInput({ fileBase64 }), fileName);
        input.url = stored.url;
        if (!stored.flattened) {
          console.log('mcp update_draft: pdf was not flattened -', stored.flattenError);
        }
      }
      return await updateDraft(caller, documentId, input, { origin: 'mcp' });
    })
  );

  server.registerTool(
    'set_draft_fields',
    {
      title: 'Set or add fields',
      description:
        'mode "replace" (default) swaps every field on the draft for the ones given (an empty list clears the draft); mode "append" adds to what is there. Fields use the create_document shape: recipient (index, email, role, or "prefill"), type, page, x, y, width?, height?, label?, required?, values?, defaultValue?.',
      inputSchema: {
        documentId: z.string(),
        fields: z.array(FieldSchema),
        mode: z.enum(['replace', 'append']).optional(),
      },
    },
    guarded(
      async ({ documentId, fields, mode }) =>
        await setDraftFields(caller, documentId, fields, { mode: mode || 'replace', origin: 'mcp' })
    )
  );

  server.registerTool(
    'update_draft_field',
    {
      title: 'Edit one field',
      description:
        'Move, resize, relabel, require/unrequire, change options or default value, hand to another recipient, or change the type of a single field, identified by its key (from get_draft). The field keeps its key.',
      inputSchema: {
        documentId: z.string(),
        field: z
          .union([z.number(), z.string()])
          .describe('The field key (number) or its internal name.'),
        changes: FieldChangesSchema,
      },
    },
    guarded(
      async ({ documentId, field, changes }) =>
        await updateDraftField(caller, documentId, field, changes, { origin: 'mcp' })
    )
  );

  server.registerTool(
    'remove_draft_fields',
    {
      title: 'Remove fields',
      description:
        'Remove fields by key, or every field of a recipient / type / page (selectors combine with AND), or all: true to clear the draft.',
      inputSchema: {
        documentId: z.string(),
        keys: z.array(z.union([z.number(), z.string()])).optional(),
        recipient: RecipientRefSchema.optional(),
        type: z.string().optional(),
        page: z.number().int().min(1).optional(),
        all: z.boolean().optional(),
      },
    },
    guarded(
      async ({ documentId, ...selector }) =>
        await removeDraftFields(caller, documentId, selector, { origin: 'mcp' })
    )
  );

  server.registerTool(
    'ai_layout_draft',
    {
      title: 'Let AI place the fields again',
      description:
        'Run the AI over the draft\'s PDF and apply its layout. Roles it finds bind to the draft\'s recipients in order (pass recipients to replace the list first). mode "replace" (default) drops the current fields, "append" keeps them. If a role has no recipient and no email can be inferred, nothing changes and needsRecipients says what is missing.',
      inputSchema: {
        documentId: z.string(),
        instructions: z
          .string()
          .optional()
          .describe('Guidance, e.g. "initials on every page, the buyer also dates".'),
        recipients: z.array(RecipientSchema).optional(),
        mode: z.enum(['replace', 'append']).optional(),
      },
    },
    guarded(async ({ documentId, ...rest }) => {
      requireAiEnabled();
      checkAiRateLimit(caller.userId);
      return await aiLayoutDraft(caller, documentId, { ...rest, origin: 'mcp' });
    })
  );

  server.registerTool(
    'preview_page',
    {
      title: 'Preview a page as an image',
      description:
        'A PNG of one page of the document with its fields drawn on it, so you can check placement and prefill state without the web app. mode "overlay" (default) draws every field as a box in its owner\'s colour with a caption, prefilled values and ticked options inside; mode "signer" draws no boxes, only what a signer sees before filling anything in (prefilled text, checkbox/radio boxes with their ticks). source "signed" renders the latest signed copy of a sent document instead of the original. Returns the image and a JSON list of the fields on that page.',
      inputSchema: {
        documentId: z.string(),
        page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
        mode: z.enum(['overlay', 'signer']).optional(),
        scale: z.number().min(0.5).max(3).optional().describe('Pixels per PDF point (default 1.5).'),
        source: z.enum(['original', 'signed']).optional(),
      },
    },
    guardedImage(
      async ({ documentId, page, mode, scale, source }) =>
        await renderPagePreview(caller, documentId, { page, mode, scale, source })
    )
  );

  server.registerTool(
    'find_text',
    {
      title: 'Find text on the pages',
      description:
        'Where a phrase is printed in the PDF (no AI): page, line id, the line box and the span of the phrase inside it (PDF points, top-left origin), plus any blank underline runs on that line. Use it to anchor fields deterministically with place_field_at_text, or to check which of two identical labels is which.',
      inputSchema: {
        documentId: z.string(),
        query: z.string().describe('Phrase to find; case-insensitive, whitespace folded.'),
        page: z.number().int().min(1).optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
      },
    },
    guarded(
      async ({ documentId, query, page, maxResults }) =>
        await findText(caller, documentId, { query, page, maxResults })
    )
  );

  server.registerTool(
    'detect_fields',
    {
      title: 'Detect printed form fields',
      description:
        'Candidate fields from the printed-form idiom "Label: ________" (no AI): one candidate per underline run, typed from its label (signature, initials, date, name, email, company, job title, text input), with coordinates sitting on the rule. Same as the editor\'s "Auto-detect fields". Nothing is written: feed the ones you want to set_draft_fields { mode: "append" } with a recipient each.',
      inputSchema: { documentId: z.string(), page: z.number().int().min(1).optional() },
    },
    guarded(async ({ documentId, page }) => await detectFields(caller, documentId, { page }))
  );

  server.registerTool(
    'place_field_at_text',
    {
      title: 'Place a field after a phrase',
      description:
        'Find a phrase and append one field right after it on the same line (no AI). Width comes from the blank underline run on the line when there is one, from the distance to widthToNextAnchor (a second phrase on the same line), or from width / the type default. Text-like fields centre on the line, signature-like fields sit on it; align "below"/"above" puts the field under or over the line instead. occurrence picks the Nth match. Returns the draft plus the placed field and how it was derived.',
      inputSchema: {
        documentId: z.string(),
        anchor: z.string().describe('The printed phrase to place after, e.g. "Tenant signature:".'),
        recipient: RecipientRefSchema.optional().describe('Owner of the field (default 0).'),
        type: z.string().optional().describe('Field type (default "text input").'),
        page: z.number().int().min(1).optional(),
        occurrence: z.number().int().min(1).optional(),
        offsetX: z.number().optional().describe('Points to the right of the phrase end (default 4).'),
        offsetY: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        widthToNextAnchor: z.string().optional().describe('Stretch the field up to this phrase on the same line.'),
        useBlank: z.boolean().optional().describe('Use the blank run after the phrase for x/width (default true).'),
        align: z.enum(['line', 'below', 'above']).optional(),
        label: z.string().optional(),
        required: z.boolean().optional(),
        values: z.array(z.string()).optional(),
        defaultValue: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]).optional(),
        readOnly: z.boolean().optional(),
        hideLabel: z.boolean().optional().describe('Default true for a single-option checkbox / radio (the label is already printed).'),
      },
    },
    guarded(async ({ documentId, ...spec }) => await placeFieldAtText(caller, documentId, spec))
  );

  server.registerTool(
    'create_template',
    {
      title: 'Create a template',
      description:
        'A reusable template from a PDF, a list of roles (no emails: they bind when a document is created from it with create_document_from_template) and fields (same shape as create_document; recipient = role index, role label, or "prefill"), plus settings and the default email message.',
      inputSchema: {
        name: z.string(),
        ...FileInputShape,
        fileName: z.string().optional(),
        roles: z
          .array(z.union([z.string(), z.object({ role: z.string() })]))
          .describe('Role labels in signing order, e.g. ["Customer", "Provider"].'),
        fields: z.array(FieldSchema).optional(),
        settings: SettingsSchema,
        message: MessageSchema,
        note: z.string().optional(),
        description: z.string().optional(),
        chain: ChainSchema.describe(
          'Chaining every document created from this template inherits: when such a document completes, a follow-up is created from chain.templateId and sent.'
        ),
      },
    },
    guarded(async input => {
      const url = input.url || (input.fileBase64 ? (await uploadPdfBytesDetailed(await bytesFromInput({ fileBase64: input.fileBase64 }), input.fileName)).url : undefined);
      return await createTemplate(caller, { ...input, url, origin: 'mcp' });
    })
  );

  server.registerTool(
    'save_as_template',
    {
      title: 'Save a document as a template',
      description:
        "The web app's \"Save as template\" for any of your documents (draft, sent or completed): layout, roles, settings and message are copied; recipients and answers are dropped. Optionally under a new name.",
      inputSchema: { documentId: z.string(), name: z.string().optional() },
    },
    guarded(
      async ({ documentId, name }) => await saveDocumentAsTemplate(caller, documentId, { name })
    )
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete a template',
      description: 'Soft-delete one of your templates (the web app\'s delete). Documents already created from it are not affected.',
      inputSchema: { templateId: z.string() },
    },
    guarded(async ({ templateId }) => await deleteTemplate(caller, templateId))
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update a contact',
      description: 'Change a contact\'s name, email, phone, company or job title. Only the keys given change.',
      inputSchema: {
        contactId: z.string(),
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().nullable().optional(),
        company: z.string().nullable().optional(),
        jobTitle: z.string().nullable().optional(),
      },
    },
    guarded(async ({ contactId, ...changes }) => await updateContact(caller, contactId, changes))
  );

  server.registerTool(
    'delete_contact',
    {
      title: 'Delete a contact',
      description: 'Soft-delete a contact (the web app\'s delete). Documents that already name the contact keep working.',
      inputSchema: { contactId: z.string() },
    },
    guarded(async ({ contactId }) => await deleteContact(caller, contactId))
  );

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description: 'Your folders (name, parentId, document count), for the folderId that create_document / update_draft accept. parentId narrows to one folder\'s children.',
      inputSchema: { parentId: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    },
    guarded(async ({ parentId, limit }) => ({ folders: await listFolders(caller, { parentId, limit }) }))
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create a folder',
      description: 'Create a folder (optionally inside parentId). An existing folder with the same name in the same place is returned instead of duplicated.',
      inputSchema: { name: z.string(), parentId: z.string().optional() },
    },
    guarded(async ({ name, parentId }) => await createFolder(caller, { name, parentId }))
  );

  server.registerTool(
    'save_draft_version',
    {
      title: 'Save a named checkpoint',
      description:
        'Store the draft as it is now under a label you can come back to with restore_draft_version. (Every edit also stores the state it replaced automatically.)',
      inputSchema: { documentId: z.string(), label: z.string().optional() },
    },
    guarded(
      async ({ documentId, label }) =>
        await snapshotDraft(caller, documentId, { label, origin: 'mcp' })
    )
  );

  server.registerTool(
    'list_draft_versions',
    {
      title: 'Version history',
      description:
        'Saved states of a document, newest first: version number, label, what change it preceded, field count, recipients, time. Pass a version to get_draft_version for its full content.',
      inputSchema: { documentId: z.string(), limit: z.number().int().min(1).max(200).optional() },
    },
    guarded(async ({ documentId, limit }) => ({
      versions: await listDraftVersions(caller, documentId, { limit }),
    }))
  );

  server.registerTool(
    'get_draft_version',
    {
      title: 'Inspect a version',
      description:
        'The full content (recipients, fields, settings, message) of one saved version, so you can compare before restoring.',
      inputSchema: {
        documentId: z.string(),
        version: z.union([z.number().int(), z.string()]).describe('Version number or versionId.'),
      },
    },
    guarded(async ({ documentId, version }) => await getDraftVersion(caller, documentId, version))
  );

  server.registerTool(
    'restore_draft_version',
    {
      title: 'Restore a version',
      description:
        'Put the draft back to a saved version (number or versionId). The current state is saved first, so this is itself undoable.',
      inputSchema: { documentId: z.string(), version: z.union([z.number().int(), z.string()]) },
    },
    guarded(
      async ({ documentId, version }) =>
        await restoreDraftVersion(caller, documentId, version, { origin: 'mcp' })
    )
  );

  server.registerTool(
    'undo_draft_change',
    {
      title: 'Undo the last change',
      description:
        'Return the draft to the state before the most recent change (from any tool, the web app excluded). Calling it again redoes.',
      inputSchema: { documentId: z.string() },
    },
    guarded(async ({ documentId }) => await undoDraftChange(caller, documentId, { origin: 'mcp' }))
  );

  server.registerTool(
    'duplicate_document',
    {
      title: 'Duplicate into a new draft',
      description:
        'Copy any of your documents (draft, sent or completed) into a new editable draft with the same PDF, recipients, fields, settings and message.',
      inputSchema: { documentId: z.string(), name: z.string().optional() },
    },
    guarded(
      async ({ documentId, name }) =>
        await duplicateDocument(caller, documentId, { name, origin: 'mcp' })
    )
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft',
      description:
        "Soft-delete a draft (same as the web app's delete). force=true also archives a sent or completed document. Undo with restore_deleted_document.",
      inputSchema: { documentId: z.string(), force: z.boolean().optional() },
    },
    guarded(
      async ({ documentId, force }) =>
        await deleteDocument(caller, documentId, { force: force === true })
    )
  );

  server.registerTool(
    'restore_deleted_document',
    {
      title: 'Restore a deleted document',
      description:
        'Bring back a soft-deleted document. Without documentId, lists your deleted documents.',
      inputSchema: {
        documentId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    guarded(async ({ documentId, limit }) =>
      documentId
        ? await restoreDeletedDocument(caller, documentId)
        : { deleted: await listDeletedDocuments(caller, { limit }) }
    )
  );

  return server;
}
