import { extractLayout } from '../ai/pdfLayout.js';
import { loadDraft, loadOwnedDocument, setDraftFields } from './drafts.js';
import { fetchPdfBytes } from './files.js';
import { WIDGET_SPEC, normaliseWidgetType } from './widgets.js';

/**
 * Deterministic, AI-free field placement from the PDF's own text.
 *
 *  - `findText`: where a phrase is printed (page, line, box, and the span of
 *    the phrase inside the line), with any blank runs ("_____") on that line.
 *  - `detectFields`: the printed-form idiom of a label followed by an underline
 *    run, typed from the label (the editor's "Auto-detect fields", server side).
 *  - `placeFieldAtText`: "find this phrase, put a field after it", with the
 *    width taken from the blank run on the line, from the distance to a second
 *    phrase, or given explicitly.
 *
 * Everything is in PDF points from the top-left of the page box, the stored
 * coordinate system, and comes from `ai/pdfLayout.extractLayout`, the same
 * reading the AI is grounded on.
 */

const RUN_RE = /^[_—–.·\s]{4,}$/;

const LABEL_RULES = [
  { test: /\binitial/i, type: 'initials' },
  { test: /\b(sign(ature|ed by)?|signer)\b/i, type: 'signature' },
  { test: /\bdate\b/i, type: 'date' },
  { test: /\be-?mail\b/i, type: 'email' },
  { test: /\b(company|organi[sz]ation|firm|employer)\b/i, type: 'company' },
  { test: /\b(title|position|role|designation)\b/i, type: 'job title' },
  { test: /\b(printed name|full name|name)\b/i, type: 'name' },
];

export function typeForLabel(label) {
  for (const rule of LABEL_RULES) if (rule.test.test(label)) return rule.type;
  return 'text input';
}

function normalise(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The PDF's text layout, read from the document's current file. */
export async function layoutForDocument(d) {
  const bytes = await fetchPdfBytes(d.URL);
  return await extractLayout(bytes);
}

/**
 * Where a phrase sits inside a line, estimated proportionally by character
 * position (the line box is the union of its items; per-character metrics are
 * not kept). Good to a few points on ordinary body text.
 */
function spanInLine(line, query) {
  const needle = normalise(query);
  const out = [];
  if (!needle) return out;
  // Inside a single text item the per-character estimate is close; prefer it.
  for (const sp of line.spans || []) {
    const hay = normalise(sp.text);
    let from = 0;
    while (hay && from <= hay.length) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      const perChar = hay.length ? sp.w / hay.length : 0;
      out.push({
        x: round2(sp.x + i * perChar),
        w: round2(needle.length * perChar),
        end: round2(sp.x + (i + needle.length) * perChar),
      });
      from = i + Math.max(1, needle.length);
    }
  }
  if (out.length) return out.sort((a, b) => a.x - b.x);
  // A phrase spanning several items: estimate over the whole line.
  const hay = normalise(line.text);
  let from = 0;
  while (from <= hay.length) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    const perChar = hay.length ? line.w / hay.length : 0;
    out.push({
      x: round2(line.x + i * perChar),
      w: round2(needle.length * perChar),
      end: round2(line.x + (i + needle.length) * perChar),
    });
    from = i + Math.max(1, needle.length);
  }
  return out;
}

/**
 * @param {Object} layout from extractLayout
 * @param {string} query phrase, matched case-insensitively with whitespace folded
 * @param {{page?: number, maxResults?: number}} opts
 * @returns {Array<Object>} matches in reading order
 */
export function findTextInLayout(layout, query, { page, maxResults = 50 } = {}) {
  const out = [];
  for (const pg of layout.pages) {
    if (page && pg.number !== Number(page)) continue;
    for (const line of pg.lines) {
      for (const span of spanInLine(line, query)) {
        out.push({
          page: pg.number,
          lineId: line.id,
          lineText: line.text,
          line: { x: line.x, y: line.y, width: line.w, height: line.h },
          match: { x: span.x, width: span.w, end: span.end },
          blanks: (line.blanks || []).map(b => ({ x: b.x, width: b.w })),
          pageSize: { width: pg.width, height: pg.height },
        });
        if (out.length >= maxResults) return out;
      }
    }
  }
  return out;
}

export async function findText(caller, docId, { query, page, maxResults } = {}) {
  if (!query || !String(query).trim()) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Give the text to find.');
  }
  const d = await loadOwnedDocument(caller, docId);
  const layout = await layoutForDocument(d);
  const matches = findTextInLayout(layout, query, { page, maxResults });
  return {
    documentId: d.objectId,
    query: String(query),
    pageCount: layout.pageCount,
    truncated: layout.truncated,
    matches,
  };
}

/**
 * Candidate fields from underline runs, typed from the label to their left on
 * the same line (or the text just above). Mirrors the editor's auto-detect.
 */
export function detectFieldsInLayout(layout, { page } = {}) {
  const out = [];
  for (const pg of layout.pages) {
    if (page && pg.number !== Number(page)) continue;
    const lines = pg.lines;
    for (const [li, line] of lines.entries()) {
      for (const blank of line.blanks || []) {
        if (blank.w < 30) continue;
        // Label: the text on this row to the left of the run (by item position
        // when the line keeps its items), or the previous line.
        let label;
        if (Array.isArray(line.spans) && line.spans.length) {
          // Items wholly left of the run, plus the part of an item the run
          // starts inside ("Tenant name: ______" is one item).
          const parts = [];
          for (const sp of line.spans) {
            if (sp.x >= blank.x + 4) continue;
            if (sp.x + sp.w <= blank.x + 4) {
              parts.push(sp.text);
              continue;
            }
            const perChar = sp.text.length ? sp.w / sp.text.length : 0;
            const chars = perChar ? Math.round((blank.x - sp.x) / perChar) : 0;
            parts.push(sp.text.slice(0, Math.max(0, chars)));
          }
          label = parts
            .join(' ')
            .replace(/[_—–.·]+$/g, '')
            .trim();
        } else {
          const hay = line.text;
          const perChar = hay.length ? line.w / hay.length : 0;
          const charsBefore = perChar ? Math.round((blank.x - line.x) / perChar) : 0;
          label = hay
            .slice(0, Math.max(0, charsBefore))
            .replace(/[_—–.·]+$/g, '')
            .trim();
        }
        // A line that is all rule: look at the nearest line above it, close by.
        if (!label || RUN_RE.test(label)) {
          const above = lines
            .slice(0, li)
            .reverse()
            .find(l => line.y - (l.y + l.h) < l.h * 1.6 && !RUN_RE.test(l.text));
          label = above?.text.trim() || '';
        }
        // Keep the last clause of a long label: "Tenant name: ____" -> "Tenant name",
        // and on a row with two labels ("Customer signature: ____ Date: ____")
        // the one right before this run.
        const clauses = label.split(/[:,;|]\s*/).map(t => t.trim()).filter(Boolean);
        const tail = clauses[clauses.length - 1] || label;
        const type = typeForLabel(tail);
        const spec = WIDGET_SPEC[type];
        const width = Math.min(Math.max(blank.w, spec.minWidth), pg.width - 20);
        // Signature-like boxes keep their default height; everything else takes
        // its height from the row it sits on (an initials box on a 9 pt line is
        // 20 pt, not 50).
        const height =
          type === 'signature' ? spec.height : Math.max(spec.minHeight, Math.min(spec.height, line.h + 8) || spec.height);
        // Sit on the rule: the run's own baseline is the line bottom.
        const y = Math.max(0, Math.min(line.y + line.h - height, pg.height - height));
        out.push({
          page: pg.number,
          lineId: line.id,
          type,
          x: round2(Math.max(0, Math.min(blank.x, pg.width - width))),
          y: round2(y),
          width: round2(width),
          height: round2(height),
          label: tail.replace(/[:\s]+$/, '').slice(0, 40),
          lineText: line.text,
        });
      }
    }
  }
  // Runs split across items produce overlapping candidates; merge neighbours.
  const merged = [];
  for (const f of out.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.page === f.page &&
      Math.abs(prev.y - f.y) < 4 &&
      f.x <= prev.x + prev.width + 6 &&
      prev.type === f.type
    ) {
      prev.width = round2(Math.max(prev.width, f.x + f.width - prev.x));
      continue;
    }
    merged.push(f);
  }
  return merged;
}

export async function detectFields(caller, docId, { page } = {}) {
  const d = await loadOwnedDocument(caller, docId);
  const layout = await layoutForDocument(d);
  const fields = detectFieldsInLayout(layout, { page });
  return {
    documentId: d.objectId,
    pageCount: layout.pageCount,
    truncated: layout.truncated,
    candidates: fields,
    hint: 'Pass the candidates you want (with a recipient each) to set_draft_fields { mode: "append" }, or place one at a time with place_field_at_text.',
  };
}

/**
 * Resolve one placement against the layout. Pure, so it is testable without a
 * document: returns the field input for setDraftFields plus how it was derived.
 */
export function resolvePlacement(layout, spec) {
  const {
    anchor,
    page,
    occurrence = 1,
    type = 'text input',
    offsetX = 4,
    offsetY = 0,
    width,
    height,
    widthToNextAnchor,
    useBlank = true,
    align = 'line',
  } = spec;
  const wtype = normaliseWidgetType(type);
  if (!wtype) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Unknown field type "${type}".`);
  const matches = findTextInLayout(layout, anchor, { page });
  if (!matches.length) {
    throw new Parse.Error(
      Parse.Error.OBJECT_NOT_FOUND,
      `"${anchor}" was not found${page ? ` on page ${page}` : ''}. Try find_text with a shorter phrase.`
    );
  }
  const n = Math.max(1, Number(occurrence) || 1);
  if (n > matches.length) {
    throw new Parse.Error(
      Parse.Error.OBJECT_NOT_FOUND,
      `"${anchor}" occurs ${matches.length} time(s)${page ? ` on page ${page}` : ''}, not ${n}.`
    );
  }
  const m = matches[n - 1];
  const wspec = WIDGET_SPEC[wtype];
  const derived = {};

  let x = m.match.end + (Number(offsetX) || 0);
  let w = Number(width) || 0;

  // 1. A blank run right after the anchor on the same line is the printed box.
  const blank = useBlank
    ? m.blanks.find(b => b.x >= m.match.end - 2 && b.x - m.match.end < 60)
    : null;
  if (blank && !w) {
    x = blank.x + (Number(offsetX) || 0) - 4; // the default offset is for text; sit on the rule
    w = blank.width;
    derived.width = 'blank run on the line';
  }
  // 2. The distance to a second phrase on the same line.
  if (widthToNextAnchor && !w) {
    const target =
      typeof widthToNextAnchor === 'string'
        ? spanInLine(
            { text: m.lineText, x: m.line.x, w: m.line.width },
            widthToNextAnchor
          ).find(sp => sp.x > m.match.end)
        : null;
    if (target) {
      const gap = target.x - x - 4;
      if (gap < wspec.minWidth) {
        throw new Parse.Error(
          Parse.Error.VALIDATION_ERROR,
          `Only ${Math.max(0, Math.round(gap))} pt between the end of "${anchor}" and "${widthToNextAnchor}" on that line; a ${wtype} needs at least ${wspec.minWidth} pt. Give width / offsetX, or anchor elsewhere (find_text shows the spans).`
        );
      }
      w = gap;
      derived.width = `up to "${widthToNextAnchor}"`;
    } else if (typeof widthToNextAnchor === 'string') {
      throw new Parse.Error(
        Parse.Error.OBJECT_NOT_FOUND,
        `"${widthToNextAnchor}" was not found after "${anchor}" on the same line.`
      );
    }
  }
  if (!w) {
    w = wspec.width;
    derived.width = 'type default';
  }
  // Never past the right edge.
  w = Math.max(wspec.minWidth, Math.min(w, m.pageSize.width - x - 2));

  // Anchored to a line, the field's height comes from the line (the printed
  // form's row), not from the type's free-standing default: a 50 pt initials
  // box on a 9 pt line would sit over the text above. Signature / stamp / draw
  // keep their default height (they need the room) unless a height is given.
  const tall = wtype === 'signature' || wtype === 'stamp' || wtype === 'draw';
  const h = Number(height) || (tall ? wspec.height : Math.max(wspec.minHeight, m.line.height + 8));
  if (!height) derived.height = tall ? 'type default' : 'line height + 8';
  // Vertical placement: text-like fields centred on the line, signatures sit on it.
  let y;
  if (align === 'below') y = m.line.y + m.line.height + 2;
  else if (align === 'above') y = m.line.y - h - 2;
  else if (tall) y = m.line.y + m.line.height - h + 4;
  else y = m.line.y + (m.line.height - h) / 2;
  y += Number(offsetY) || 0;
  y = Math.max(0, Math.min(y, m.pageSize.height - h));

  return {
    field: { type: wtype, page: m.page, x: round2(x), y: round2(y), width: round2(w), height: round2(h) },
    anchor: { page: m.page, lineId: m.lineId, lineText: m.lineText, match: m.match },
    derived,
  };
}

/**
 * Place one field after a phrase and append it to the draft.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {Object} spec anchor, recipient, type, page?, occurrence?, offsetX?, offsetY?, width?, height?, widthToNextAnchor?, useBlank?, align?, label?, required?, values?, defaultValue?
 */
export async function placeFieldAtText(caller, docId, spec = {}) {
  if (!spec.anchor || !String(spec.anchor).trim()) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Give the anchor text to place the field after.');
  }
  const d = await loadDraft(caller, docId);
  const layout = await layoutForDocument(d);
  const placed = resolvePlacement(layout, spec);
  const singleOption =
    ['checkbox', 'radio button'].includes(placed.field.type) &&
    (!Array.isArray(spec.values) || spec.values.length <= 1);
  const field = {
    ...placed.field,
    recipient: spec.recipient ?? 0,
    // A single tick box placed over a printed box: the label is already on the
    // page, so do not print it again next to the box.
    ...(spec.hideLabel !== undefined ? { hideLabel: spec.hideLabel } : singleOption ? { hideLabel: true } : {}),
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.required !== undefined ? { required: spec.required } : {}),
    ...(spec.values !== undefined ? { values: spec.values } : {}),
    ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
    ...(spec.readOnly !== undefined ? { readOnly: spec.readOnly } : {}),
  };
  const result = await setDraftFields(caller, docId, [field], { mode: 'append', origin: 'mcp' });
  return { ...result, placed: { ...placed, field } };
}
