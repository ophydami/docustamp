import { z } from 'zod';
import { aiModel, getAiClient, providerError } from './client.js';
import { extractLayout, findLine, layoutTranscript } from './pdfLayout.js';
import {
  buildPlaceholders,
  PREFILL_ROLE,
  roleColor,
  WIDGET_SPEC,
  WIDGET_TYPES,
} from '../lib/widgets.js';

/**
 * "Look at this PDF and set it up for signing."
 *
 * One Claude call with the PDF (vision) plus the coordinate-annotated text
 * transcript, forced into the `propose_signing_setup` tool. The model names the
 * signer roles it finds, pulls names/emails out of the document when they are
 * printed there, and anchors every field to a text line id. We turn the anchors
 * into PDF-point coordinates and the whole thing into the `Placeholders` array.
 */

/**
 * Bedrock caps one request at 20 MB, and the PDF travels base64-encoded (~1.34x)
 * next to the transcript, the tool schema and the system prompt. So the gate is
 * on the *encoded* payload, with room left for everything else.
 */
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const REQUEST_OVERHEAD_BYTES = 32 * 1024; // system prompt + tool schema + framing
const MAX_PAGES_FOR_VISION = 100;
const MAX_FIELDS = 120;
const MAX_ROLES = 10;
const MAX_SUMMARY = 1200;
const MAX_TITLE = 250;
const MAX_WARNINGS = 20;
const MAX_LABEL = 80;
const MAX_VALUES = 20;

const FIELD_TYPES = WIDGET_TYPES.filter(t => t !== 'draw' && t !== 'text');

/**
 * Deliberately lenient: the response is already paid for by the time it is
 * parsed, and every cap the model can overshoot (a long summary, too many
 * fields, an invented field type) is a cosmetic problem that `shapeProposal`
 * already handles by truncating and warning. Only structurally unusable output
 * (no title, no roles, a field with no page) fails here.
 */
const FieldSchema = z.object({
  role: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional().default(''),
  page: z.number().int().min(1),
  anchor_line: z.string().max(40).optional(),
  placement: z.enum(['on_blank', 'right_of_label', 'below_label', 'absolute']).default('on_blank'),
  blank_index: z.number().int().min(0).max(20).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  required: z.boolean().optional().default(true),
  values: z.array(z.string()).optional(),
});

const ProposalSchema = z.object({
  title: z.string(),
  summary: z.string(),
  document_type: z.string().optional().default(''),
  language: z.string().optional().default('en'),
  roles: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        name: z.string().optional().default(''),
        email: z.string().optional().default(''),
        is_sender: z.boolean().optional().default(false),
      })
    )
    .min(1),
  fields: z.array(FieldSchema),
  signing_order_matters: z.boolean().optional().default(false),
  warnings: z.array(z.string()).optional().default([]),
});

const TOOL = {
  name: 'propose_signing_setup',
  description:
    'Propose who must sign this document and where every signing field goes. Call exactly once with the complete proposal.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {
        type: 'string',
        description: `Short document title for the request (max ${MAX_TITLE} chars).`,
      },
      summary: {
        type: 'string',
        description: `Two or three sentences (max ${MAX_SUMMARY} chars): what the document is and who signs it.`,
      },
      document_type: {
        type: 'string',
        description: 'e.g. "lease", "NDA", "offer letter", "invoice".',
      },
      language: {
        type: 'string',
        description: 'BCP-47 language of the document, e.g. "en", "de".',
      },
      roles: {
        type: 'array',
        maxItems: MAX_ROLES,
        description: `Each party that must sign, in signing order (at most ${MAX_ROLES}). Include the sender as a role only when the document clearly requires the sender to sign too (set is_sender true). Do not invent roles that never sign.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: {
              type: 'string',
              description: 'Stable identifier used by fields, e.g. "tenant".',
            },
            label: {
              type: 'string',
              description: 'Human label, e.g. "Tenant", "Landlord", "Employee".',
            },
            name: {
              type: 'string',
              description: 'Full name if printed in the document, else empty string.',
            },
            email: {
              type: 'string',
              description: 'Email if printed in the document, else empty string.',
            },
            is_sender: { type: 'boolean' },
          },
          required: ['key', 'label', 'name', 'email', 'is_sender'],
        },
      },
      fields: {
        type: 'array',
        maxItems: MAX_FIELDS,
        description: `Every field a signer must fill (at most ${MAX_FIELDS}). Anchor each field to a transcript line id (anchor_line) and say where it goes relative to that line. Use placement "on_blank" when the line has a blank[...] run (the field sits on that underline), "right_of_label" when the field goes just right of the line text, "below_label" when it goes under the line. Use "absolute" with x,y only when no line is close (e.g. empty signature area at the bottom of a page). Never use a page number greater than the page count given below.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: {
              type: 'string',
              description:
                'roles[].key, or "sender_prefill" for values the sender fills before sending.',
            },
            type: { type: 'string', enum: FIELD_TYPES },
            label: {
              type: 'string',
              description: 'Short label as printed, e.g. "Tenant signature".',
            },
            page: { type: 'integer', minimum: 1 },
            anchor_line: {
              type: 'string',
              description:
                'Transcript line id such as "p2l14". Omit only for placement "absolute".',
            },
            placement: {
              type: 'string',
              enum: ['on_blank', 'right_of_label', 'below_label', 'absolute'],
            },
            blank_index: {
              type: 'integer',
              description:
                'When the anchor line lists several blanks (blank0, blank1, ...), which one this field sits on. Defaults to the widest.',
            },
            x: { type: 'number', description: 'PDF points from the left, only for "absolute".' },
            y: {
              type: 'number',
              description: 'PDF points from the TOP of the page, only for "absolute".',
            },
            width: { type: 'number', description: 'Optional width in points.' },
            height: { type: 'number', description: 'Optional height in points.' },
            required: { type: 'boolean' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'Options for dropdown / radio button / checkbox.',
            },
          },
          required: ['role', 'type', 'label', 'page', 'placement', 'required'],
        },
      },
      signing_order_matters: {
        type: 'boolean',
        description: 'True when the document implies one party signs before another.',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything the sender should double check.',
      },
    },
    required: [
      'title',
      'summary',
      'document_type',
      'language',
      'roles',
      'fields',
      'signing_order_matters',
      'warnings',
    ],
  },
};

const SYSTEM_PROMPT = `You prepare PDF documents for electronic signature.

You receive the PDF and a transcript of its text. Every transcript line has an id (like p2l14), a bounding box [x y w h] in PDF points with the origin at the top-left of the page, and sometimes a blank[x w] run where a printed underline or dotted line is waiting to be filled in.

Lines with several blanks list them as blank0, blank1, ... in left-to-right order; use blank_index to say which one a field sits on.

Your job:
1. Work out who has to sign (the roles). Use the document's own words for role labels (Tenant, Landlord, Employee, Contractor, Client, Witness...). When a name or email address for a party is printed in the document, copy it exactly; otherwise leave it empty. Never invent names or emails.
2. Place the fields each signer needs: a "signature" wherever that party signs, "date" next to signature dates, "name" for printed-name lines, "initials" where initials are requested (e.g. page footers, "initial here"), "text input" for blanks a signer must fill by hand, "checkbox" for tick boxes, "email"/"company"/"job title" when such lines exist. Values the sender should fill in before sending (amounts, dates already known to the sender) go to role "sender_prefill" only when clearly the sender's job; when in doubt assign to the signer.
3. Anchor every field to the transcript line it belongs to and choose the placement relative to that line. Prefer "on_blank" when the line has a blank run. Signature fields are 150x60 points by default; use a smaller height (about 40) when the blank area is tight.
4. Be complete but not noisy: every place that must be signed, initialed, dated or filled gets a field; decorative lines, page numbers and already-filled values do not.

Call the propose_signing_setup tool exactly once with the full proposal. Do not answer in prose.`;

/** Caching is a prefix match, so the stable system prompt goes first with a breakpoint. */
function systemBlocks() {
  return [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
}

function userText({ transcript, instructions, recipients, pageCount }) {
  const parts = [];
  parts.push(`The PDF has ${pageCount} page(s).`);
  if (recipients?.length) {
    parts.push(
      'The sender already named these recipients (use them as the roles, in this order, matching by label/name when the document names parties):\n' +
        recipients
          .map(
            (r, i) =>
              `${i + 1}. ${r.name || '(no name)'} <${r.email}>${r.role ? ` as "${r.role}"` : ''}`
          )
          .join('\n')
    );
  }
  if (instructions && instructions.trim()) {
    parts.push(`Instructions from the sender:\n${instructions.trim().slice(0, 4000)}`);
  }
  parts.push('Text transcript with line ids and coordinates:\n' + transcript);
  return parts.join('\n\n');
}

/**
 * Model ids that answered 400 to an explicit `thinking` block. The request holds
 * the whole base64 PDF, so retrying it is a second multi-megabyte upload: learn
 * the answer once per process and leave the parameter out from then on.
 */
const REJECTS_THINKING = new Set();

async function callClaude({ bytes, transcript, layout, instructions, recipients, useVision }) {
  const client = getAiClient();
  const content = [];
  if (useVision) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(bytes).toString('base64'),
      },
      title: 'document.pdf',
    });
  }
  content.push({
    type: 'text',
    text: userText({ transcript, instructions, recipients, pageCount: layout.pageCount }),
  });

  const model = aiModel();
  const request = {
    model,
    max_tokens: 16000,
    system: systemBlocks(),
    messages: [{ role: 'user', content }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    ...(REJECTS_THINKING.has(model) ? {} : { thinking: { type: 'disabled' } }),
  };
  let response;
  try {
    response = await client.messages.create(request);
  } catch (err) {
    // Some Bedrock model ids reject an explicit thinking block; retry without it
    // once, and remember so the next call does not pay for two uploads.
    if (err?.status === 400 && /thinking/i.test(err?.message || '') && request.thinking) {
      REJECTS_THINKING.add(model);
      delete request.thinking;
      try {
        response = await client.messages.create(request);
      } catch (retryErr) {
        throw providerError(retryErr);
      }
    } else {
      throw providerError(err);
    }
  }
  if (response.stop_reason === 'refusal') {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'The AI declined to analyse this document.');
  }
  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === TOOL.name);
  if (!toolUse) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'The AI did not return a proposal. Please try again.'
    );
  }
  const parsed = ProposalSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    const issue = parsed.error.issues?.[0];
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      `The AI proposal was malformed (${issue?.path?.join('.')}: ${issue?.message}). Please try again.`
    );
  }
  return { proposal: parsed.data, usage: response.usage, model: response.model };
}

/** Resolve one field's anchor/placement into a top-left box in PDF points. */
export function resolveFieldBox(field, layout) {
  const spec = WIDGET_SPEC[field.type];
  let width = field.width && field.width > 0 ? field.width : spec.width;
  let height = field.height && field.height > 0 ? field.height : spec.height;
  const hit = field.anchor_line ? findLine(layout, field.anchor_line) : null;
  // No silent fallback to page 1: a field the model put on a page we did not
  // transcribe (or on a page that does not exist) is dropped and counted, never
  // written at those coordinates on a different page.
  const page = hit?.page || layout.pages.find(p => p.number === field.page);
  if (!page) return null;
  let x;
  let y;
  let placement = field.placement;
  if (!hit && placement !== 'absolute') placement = 'absolute';

  if (placement === 'absolute') {
    if (!Number.isFinite(field.x) || !Number.isFinite(field.y)) return null;
    x = field.x;
    y = field.y;
  } else {
    const line = hit.line;
    const isTall =
      field.type === 'signature' ||
      field.type === 'stamp' ||
      field.type === 'initials' ||
      field.type === 'image';
    const blank =
      Number.isInteger(field.blank_index) && line.blanks?.[field.blank_index]
        ? line.blanks[field.blank_index]
        : line.blank;
    if (placement === 'on_blank' && blank) {
      x = blank.x;
      width = Math.max(spec.minWidth, Math.min(width, blank.w));
      // Sit on the underline: the box bottom rests on the line's baseline.
      y = isTall ? line.y + line.h - height + 2 : line.y + line.h - height;
    } else if (placement === 'on_blank' || placement === 'right_of_label') {
      x = line.x + line.w + 6;
      y = isTall ? line.y + line.h - height + 2 : line.y - (height - line.h) / 2;
      const room = page.width - 10 - x;
      if (room < spec.minWidth) {
        // No room to the right: drop below the label instead.
        x = line.x;
        y = line.y + line.h + 3;
      } else {
        width = Math.min(width, room);
      }
    } else {
      x = line.x;
      y = line.y + line.h + 3;
    }
  }
  // Clamp into the page.
  width = Math.min(width, page.width - 10);
  height = Math.min(height, page.height - 10);
  x = Math.max(4, Math.min(x, page.width - width - 4));
  y = Math.max(4, Math.min(y, page.height - height - 4));
  return { page: page.number, x: r2(x), y: r2(y), width: r2(width), height: r2(height) };
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

function overlaps(a, b) {
  return (
    a.page === b.page &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Analyse a PDF and return a proposal ready to turn into a document.
 * @param {Object} input
 * @param {Uint8Array} input.bytes PDF bytes
 * @param {string} [input.instructions]
 * @param {Array<{name?: string, email: string, role?: string}>} [input.recipients] known recipients
 * @returns {Promise<Object>} see `shapeProposal`
 */
export async function analyzePdf({ bytes, instructions = '', recipients = [] }) {
  const layout = await extractLayout(bytes);
  if (!layout.pages.length) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The PDF has no pages.');
  }
  const transcript = layoutTranscript(layout);
  // What the request will actually weigh: the PDF grows by 4/3 in base64.
  const encodedPdfBytes = Math.ceil(bytes.length / 3) * 4;
  const otherBytes =
    Buffer.byteLength(transcript) + Buffer.byteLength(instructions || '') + REQUEST_OVERHEAD_BYTES;
  const useVision =
    layout.pageCount <= MAX_PAGES_FOR_VISION && encodedPdfBytes + otherBytes <= MAX_REQUEST_BYTES;
  if (!useVision && otherBytes > MAX_REQUEST_BYTES) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'This PDF holds too much text for the AI to prepare in one pass. Split it and try again.'
    );
  }
  const { proposal, usage, model } = await callClaude({
    bytes,
    transcript,
    layout,
    instructions,
    recipients,
    useVision,
  });
  return shapeProposal(proposal, layout, { usage, model, usedVision: useVision, recipients });
}

/**
 * Turn the model's proposal into what the rest of the system consumes: resolved
 * fields, roles with colours, and a `Placeholders` array (unbound, i.e.
 * `signerObjId: ""`; `createDocument` binds contacts).
 */
export function shapeProposal(proposal, layout, meta = {}) {
  const warnings = (proposal.warnings || [])
    .slice(0, MAX_WARNINGS)
    .map(w => String(w).slice(0, 300));
  if (layout.truncated) {
    warnings.push(
      `Only the first ${layout.pages.length} of ${layout.pageCount} pages were read for text; fields on later pages may be missing.`
    );
  }
  const roleKeys = new Map();
  if (proposal.roles.length > MAX_ROLES) {
    warnings.push(`Only the first ${MAX_ROLES} signer roles were kept.`);
  }
  const roles = proposal.roles.slice(0, MAX_ROLES).map((r, i) => {
    const key = r.key.trim().toLowerCase();
    // First writer wins, so a duplicate key or label cannot steal another role's fields.
    if (!roleKeys.has(key)) roleKeys.set(key, i);
    const label = r.label.trim().toLowerCase();
    if (!roleKeys.has(label)) roleKeys.set(label, i);
    return {
      index: i,
      key: r.key.slice(0, 60),
      role: r.label.trim().slice(0, 60),
      name: (r.name || '').trim().slice(0, 120),
      email: (r.email || '').trim().toLowerCase().slice(0, 200),
      isSender: r.is_sender === true,
      color: roleColor(i),
      fields: [],
    };
  });
  const prefill = { role: PREFILL_ROLE, isPrefill: true, fields: [] };
  const resolved = [];
  let dropped = 0;
  let unknownType = 0;
  const proposedFields = proposal.fields || [];
  const overflow = Math.max(0, proposedFields.length - MAX_FIELDS);
  for (const f of proposedFields.slice(0, MAX_FIELDS)) {
    // An invented field type is dropped rather than failing the whole proposal.
    if (!FIELD_TYPES.includes(f.type)) {
      unknownType += 1;
      dropped += 1;
      continue;
    }
    if (f.page > layout.pageCount) {
      dropped += 1;
      continue;
    }
    const box = resolveFieldBox(f, layout);
    if (!box) {
      dropped += 1;
      continue;
    }
    const key = String(f.role || '')
      .trim()
      .toLowerCase();
    // A declared role wins over the prefill aliases: a document whose signer
    // role really is keyed "sender" must keep its own fields (§G2-11).
    const declared = roleKeys.has(key) ? roleKeys.get(key) : -1;
    const isPrefill =
      declared < 0 && (key === 'sender_prefill' || key === PREFILL_ROLE || key === 'sender');
    const roleIndex = isPrefill ? -1 : declared;
    if (!isPrefill && roleIndex < 0) {
      dropped += 1;
      continue;
    }
    const candidate = {
      ...box,
      type: f.type,
      label: (f.label || '').trim().slice(0, MAX_LABEL),
      required: f.required !== false,
      values: Array.isArray(f.values)
        ? f.values.slice(0, MAX_VALUES).map(v => String(v).slice(0, MAX_LABEL))
        : undefined,
      roleIndex,
      anchor: f.anchor_line || null,
      placement: f.placement,
    };
    // Two fields of the same type on the same spot is the usual duplication failure.
    if (
      resolved.some(
        o =>
          o.type === candidate.type && o.roleIndex === candidate.roleIndex && overlaps(o, candidate)
      )
    ) {
      continue;
    }
    resolved.push(candidate);
    if (isPrefill) prefill.fields.push(candidate);
    else roles[roleIndex].fields.push(candidate);
  }
  if (dropped) warnings.push(`${dropped} suggested field(s) could not be placed and were skipped.`);
  if (unknownType)
    warnings.push(`${unknownType} field(s) used a field type this server does not know.`);
  if (overflow)
    warnings.push(
      `Only the first ${MAX_FIELDS} suggested fields were kept (${overflow} more were dropped).`
    );

  // Every signer role must end up with at least a signature, or the document
  // cannot complete. The boxes are laid out as a real grid on the document's
  // true last page, go through the same overlap check as everything else, and
  // land in `resolved` so fields[], fieldCount and placeholders agree.
  const last = layout.lastPage || layout.pages[layout.pages.length - 1];
  const missingSignature = roles.filter(r => !r.fields.some(f => f.type === 'signature'));
  const boxW = 150;
  const boxH = 60;
  const gap = 20;
  const perRow = Math.max(1, Math.floor((last.width - 80 + gap) / (boxW + gap)));
  missingSignature.forEach((role, slot) => {
    const col = slot % perRow;
    const row = Math.floor(slot / perRow);
    const box = {
      page: last.number,
      x: r2(40 + col * (boxW + gap)),
      y: r2(Math.max(40, last.height - 110 - row * (boxH + 40))),
      width: boxW,
      height: boxH,
    };
    const candidate = {
      ...box,
      type: 'signature',
      label: `${role.role} signature`,
      required: true,
      values: undefined,
      roleIndex: role.index,
      anchor: null,
      placement: 'absolute',
    };
    if (resolved.some(o => o.type === 'signature' && overlaps(o, candidate))) {
      candidate.y = r2(Math.max(40, candidate.y - (boxH + 40)));
    }
    resolved.push(candidate);
    role.fields.push(candidate);
    warnings.push(
      `No signature line was found for "${role.role}"; a signature box was added on page ${last.number}.`
    );
  });

  const groups = roles.map(r => ({ role: r.role, name: r.name, email: r.email, fields: r.fields }));
  if (prefill.fields.length) groups.push(prefill);
  const placeholders = buildPlaceholders(groups);

  return {
    title: proposal.title.trim().slice(0, MAX_TITLE),
    summary: proposal.summary.trim().slice(0, MAX_SUMMARY),
    documentType: String(proposal.document_type || '').slice(0, 80),
    language: String(proposal.language || 'en').slice(0, 20),
    signingOrderMatters: proposal.signing_order_matters === true,
    pageCount: layout.pageCount,
    // Only the transcribed pages are listed; `pagesTruncated` says so.
    pages: layout.pages.map(p => ({ number: p.number, width: p.width, height: p.height })),
    pagesTruncated: layout.truncated === true,
    roles: roles.map(r => ({
      index: r.index,
      role: r.role,
      name: r.name,
      email: r.email,
      isSender: r.isSender,
      color: r.color,
      fieldCount: r.fields.length,
    })),
    fields: resolved.map(f => ({
      role: f.roleIndex >= 0 ? roles[f.roleIndex].role : PREFILL_ROLE,
      roleIndex: f.roleIndex,
      type: f.type,
      label: f.label,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      values: f.values,
      anchor: f.anchor,
    })),
    placeholders,
    warnings,
    ai: {
      model: meta.model || aiModel(),
      usedVision: meta.usedVision !== false,
      inputTokens: meta.usage?.input_tokens,
      outputTokens: meta.usage?.output_tokens,
      cacheReadTokens: meta.usage?.cache_read_input_tokens,
    },
  };
}
