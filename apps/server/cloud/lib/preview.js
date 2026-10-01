import { isParticipantBasic } from '../../utils/workflowUtils.js';
import { pageBoxFromViewport } from './pageBox.js';
import { loadOwnedDocument, recipientsFromGroups, cleanGroup } from './drafts.js';
import { fetchPdfBytes } from './files.js';
import { loadParticipantDocument } from './inbox.js';
import { PREFILL_ROLE } from './widgets.js';

/**
 * A PNG of one page with the fields drawn on it, so an agent can answer "does
 * this look right?" without the web app.
 *
 * Two modes:
 *  - `overlay` (default): every field as a translucent box in its owner's
 *    colour with a small caption (type, owner), prefilled values and ticked
 *    checkbox options drawn inside. What the editor shows.
 *  - `signer`: what the signer sees: prefilled text, checkbox / radio boxes
 *    with their ticks, dropdown defaults, and every still-empty field as a
 *    light dashed box in its owner's colour (no captions). The prefill layer is
 *    what the stamped PDF will carry.
 *
 * The owner previews any page in either mode (`renderPagePreview`). Someone the
 * document was sent to gets `renderParticipantPreview`: always `signer` mode,
 * on the current PDF, with only the prefill layer and their own fields drawn,
 * so nothing about the other signers' fields (where, what, whose colour) shows.
 *
 * The page is rendered with pdf.js onto an @napi-rs/canvas surface, and the
 * overlays use the same top-left PDF-point system the widgets are stored in
 * (`cloud/lib/pageBox.js`), scaled to the canvas.
 */

const MAX_SCALE = 3;
const MIN_SCALE = 0.5;
const MAX_PIXELS = 4000;

let canvasModule = null;
async function canvas() {
  if (!canvasModule) canvasModule = await import('@napi-rs/canvas');
  return canvasModule;
}

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return await pdfjsPromise;
}

function hexToRgba(hex, alpha) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return `rgba(60,120,200,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Every widget on the page with its owner (index, role, colour). */
export function widgetsOnPage(d, pageNumber) {
  const groups = (d?.Placeholders || []).map(cleanGroup);
  const signerGroups = groups.filter(isParticipantBasic);
  const recipients = recipientsFromGroups(d, signerGroups);
  const out = [];
  for (const g of groups) {
    const isPrefill = g.Role === PREFILL_ROLE;
    const idx = signerGroups.indexOf(g);
    const recipient = isPrefill ? null : recipients[idx];
    for (const p of g.placeHolder || []) {
      if (Number(p.pageNumber) !== Number(pageNumber)) continue;
      for (const w of p.pos || []) {
        out.push({
          key: w.key,
          type: w.type,
          x: Number(w.xPosition) || 0,
          y: Number(w.yPosition) || 0,
          width: Number(w.Width) || 0,
          height: Number(w.Height) || 0,
          options: w.options || {},
          owner: isPrefill
            ? { kind: 'prefill', label: 'prefill', color: g.blockColor || '#94a3b8' }
            : {
                kind: 'signer',
                index: idx,
                contactId: g.signerObjId || '',
                label: recipient?.role || `Role ${idx + 1}`,
                name: recipient?.name || '',
                color: g.blockColor || recipient?.color || '#3b82f6',
              },
        });
      }
    }
  }
  return out;
}

function selectedIndices(w) {
  const values = Array.isArray(w.options.values) ? w.options.values : [];
  const dv = w.options.defaultValue;
  const chosen = new Set();
  const list = Array.isArray(dv) ? dv : dv !== undefined && dv !== '' ? [dv] : [];
  for (const v of list) {
    const i = values.indexOf(v);
    if (i >= 0) chosen.add(i);
    else if (Number.isInteger(v) && v >= 0 && v < values.length) chosen.add(v);
  }
  return chosen;
}

function drawTick(ctx, x, y, size, s) {
  ctx.beginPath();
  ctx.moveTo(x + size * 0.2, y + size * 0.5);
  ctx.lineTo(x + size * 0.42, y + size * 0.76);
  ctx.lineTo(x + size * 0.82, y + size * 0.22);
  ctx.lineWidth = Math.max(1, 1.1 * s);
  ctx.strokeStyle = '#111';
  ctx.stroke();
}

/** Checkbox / radio options laid out the way the stamping code lays them out. */
function drawOptions(ctx, w, s, { boxesOnly = false } = {}) {
  const fontSize = Number(w.options.fontSize) || 12;
  const values = Array.isArray(w.options.values) && w.options.values.length ? w.options.values : [''];
  const horizontal = w.options.layout === 'horizontal';
  const radio = w.type === 'radio button';
  const boxSize = radio ? fontSize : fontSize - 1;
  const gapFromLeft = fontSize + 3.4;
  const verticalGap = fontSize + 5.5;
  const chosen = selectedIndices(w);
  let x = w.x;
  let y = w.y + 2;
  ctx.font = `${fontSize * s}px sans-serif`;
  ctx.textBaseline = 'top';
  values.forEach((label, i) => {
    if (i > 0) {
      if (horizontal) {
        const tw = label && !w.options.isHideLabel ? ctx.measureText(label).width / s : 0;
        x += boxSize + (tw ? gapFromLeft + tw : gapFromLeft - 5);
      } else y += verticalGap;
    }
    ctx.lineWidth = Math.max(1, 0.8 * s);
    ctx.strokeStyle = 'rgba(64,61,56,1)';
    if (radio) {
      ctx.beginPath();
      ctx.arc((x + boxSize / 2) * s, (y + boxSize / 2) * s, (boxSize / 2) * s, 0, Math.PI * 2);
      ctx.stroke();
      if (chosen.has(i)) {
        ctx.beginPath();
        ctx.arc((x + boxSize / 2) * s, (y + boxSize / 2) * s, (boxSize / 4) * s, 0, Math.PI * 2);
        ctx.fillStyle = '#111';
        ctx.fill();
      }
    } else {
      ctx.strokeRect(x * s, y * s, boxSize * s, boxSize * s);
      if (chosen.has(i)) drawTick(ctx, x * s, y * s, boxSize * s, s);
    }
    if (!boxesOnly && label && !w.options.isHideLabel) {
      ctx.fillStyle = '#111';
      ctx.fillText(label, (x + gapFromLeft) * s, (y - 1) * s);
    }
  });
}

function valueText(w) {
  const dv = w.options.defaultValue;
  if (dv === undefined || dv === null || dv === '') return '';
  if (Array.isArray(dv)) return dv.join(', ');
  return String(dv);
}

function drawOverlay(ctx, w, s) {
  const { x, y, width, height, owner } = w;
  ctx.fillStyle = hexToRgba(owner.color, 0.22);
  ctx.fillRect(x * s, y * s, width * s, height * s);
  ctx.lineWidth = Math.max(1, 1 * s);
  ctx.strokeStyle = hexToRgba(owner.color, 0.95);
  ctx.strokeRect(x * s, y * s, width * s, height * s);
  // Caption above the box (inside the page when there is no room above).
  const cap = `${w.type}${w.options.status === 'optional' ? ' (optional)' : ''} · ${owner.label}`;
  const capSize = Math.max(8, 8 * s);
  ctx.font = `${capSize}px sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const capW = ctx.measureText(cap).width + 6;
  const capY = y * s >= capSize + 4 ? y * s - 2 : y * s + capSize + 2;
  ctx.fillStyle = hexToRgba(owner.color, 0.95);
  ctx.fillRect(x * s, capY - capSize - 1, capW, capSize + 3);
  ctx.fillStyle = '#fff';
  ctx.fillText(cap, x * s + 3, capY);

  if (w.type === 'checkbox' || w.type === 'radio button') {
    drawOptions(ctx, w, s);
    return;
  }
  const text = valueText(w);
  if (text) {
    const fontSize = Number(w.options.fontSize) || 12;
    ctx.font = `${fontSize * s}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#111';
    ctx.fillText(text, (x + 2) * s, (y + 2) * s, Math.max(1, (width - 4) * s));
  }
}

function drawSignerView(ctx, w, s) {
  if (w.type === 'checkbox' || w.type === 'radio button') {
    drawOptions(ctx, w, s);
    return;
  }
  const text = valueText(w);
  if (!text) {
    // An unfilled field is what the signer is asked to fill: a light dashed box
    // in the owner's colour, no caption.
    ctx.fillStyle = hexToRgba(w.owner.color, 0.12);
    ctx.fillRect(w.x * s, w.y * s, w.width * s, w.height * s);
    ctx.setLineDash([4 * s, 3 * s]);
    ctx.lineWidth = Math.max(1, 1 * s);
    ctx.strokeStyle = hexToRgba(w.owner.color, 0.9);
    ctx.strokeRect(w.x * s, w.y * s, w.width * s, w.height * s);
    ctx.setLineDash([]);
    return;
  }
  const fontSize = Number(w.options.fontSize) || 12;
  ctx.font = `${fontSize * s}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';
  ctx.fillText(text, (w.x + 2) * s, (w.y + 2) * s, Math.max(1, (w.width - 4) * s));
}

/**
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {{page?: number, scale?: number, mode?: 'overlay'|'signer', source?: 'original'|'signed'}} opts
 * @returns {Promise<{png: Buffer, page: number, pageCount: number, width: number, height: number, scale: number, mode: string, fields: Array<Object>}>}
 */
export async function renderPagePreview(caller, docId, opts = {}) {
  const d = await loadOwnedDocument(caller, docId);
  const source = opts.source === 'signed' && d.SignedUrl ? d.SignedUrl : d.URL;
  const bytes = await fetchPdfBytes(source);
  const out = await renderPreviewFromBytes(bytes, d, opts);
  out.source = source === d.SignedUrl && source !== d.URL ? 'signed' : 'original';
  return out;
}

/**
 * The same page for someone the document was sent to, not its owner.
 *
 * Allowed for a participant only (lib/inbox.js `loadParticipantDocument`; any
 * other caller gets "Document not found."). It renders the current PDF (the
 * copy with every signature so far), always in `signer` mode, and draws only
 * the prefill layer and the caller's own fields: once they have signed, their
 * values are in the PDF itself, so their boxes are no longer drawn either. The
 * field list names the caller's own fields only.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @param {{page?: number, scale?: number}} [opts]
 * @returns {Promise<{png: Buffer, page: number, pageCount: number, width: number, height: number, scale: number, mode: 'signer', source: string, fields: Array<Object>}>}
 */
export async function renderParticipantPreview(caller, docId, opts = {}) {
  const { d, seat } = await loadParticipantDocument(caller, docId);
  const source = d.SignedUrl || d.URL;
  const bytes = await fetchPdfBytes(source);
  const out = await renderPreviewFromBytes(bytes, d, {
    page: opts.page,
    scale: opts.scale,
    mode: 'signer',
    participant: { contactId: seat.contactId, signed: seat.signed },
  });
  out.source = source === d.SignedUrl && source !== d.URL ? 'signed' : 'original';
  return out;
}

/**
 * The render itself, on PDF bytes and a plain document JSON (no loading, no auth).
 * `opts.participant` ({contactId, signed}) limits it to what that signer sees.
 */
export async function renderPreviewFromBytes(bytes, d, opts = {}) {
  const pageNumber = Math.max(1, Number(opts.page) || 1);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(opts.scale) || 1.5));
  const participant = opts.participant?.contactId ? opts.participant : null;
  const mode = participant || opts.mode === 'signer' ? 'signer' : 'overlay';

  const lib = await pdfjs();
  const { createCanvas } = await canvas();
  const task = lib.getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  try {
    if (pageNumber > doc.numPages) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Page ${pageNumber} does not exist: the PDF has ${doc.numPages} page(s).`
      );
    }
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const box = pageBoxFromViewport(base, page.view?.[1], page.rotate);
    let s = scale;
    if (Math.max(base.width, base.height) * s > MAX_PIXELS) {
      s = MAX_PIXELS / Math.max(base.width, base.height);
    }
    const viewport = page.getViewport({ scale: s });
    const surface = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = surface.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, surface.width, surface.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const all = widgetsOnPage(d, pageNumber);
    const isMine = w => w.owner.kind === 'signer' && w.owner.contactId === participant?.contactId;
    const drawn = participant
      ? all.filter(w => w.owner.kind === 'prefill' || (isMine(w) && !participant.signed))
      : all;
    const widgets = participant ? all.filter(isMine) : all;
    for (const w of drawn) {
      if (mode === 'overlay') drawOverlay(ctx, w, s);
      else drawSignerView(ctx, w, s);
    }
    const png = surface.toBuffer('image/png');
    return {
      png,
      page: pageNumber,
      pageCount: doc.numPages,
      width: box.width,
      height: box.height,
      pixelWidth: surface.width,
      pixelHeight: surface.height,
      scale: s,
      mode,
      fields: widgets.map(w => ({
        key: w.key,
        type: w.type,
        recipient: w.owner.label,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        ...(valueText(w) ? { defaultValue: w.options.defaultValue } : {}),
      })),
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
