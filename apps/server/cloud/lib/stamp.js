import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { formatInTimeZone } from 'date-fns-tz';
import { isUpright } from './pageBox.js';
import { WIDGET_SPEC } from './widgets.js';

/**
 * Stamping a signer's answers into the PDF, on the server.
 *
 * A person signs in the browser, which flattens the answers into the bytes
 * itself and posts the finished PDF to `signPdf`
 * (apps/web/src/features/signer/pdfEmbed.ts `embedWidgetsToDoc`). An AI agent
 * signing for its user has no browser, so this module is a port of that step,
 * and it keeps the browser's numbers exactly, fudge factors included, so a field
 * an agent fills lands where the same field filled by hand would:
 *
 *  - the page box is the shared rule in `pageBox.js` (CropBox, with the CropBox
 *    y origin folded into the height on an upright page only);
 *  - stored `xPosition`/`yPosition` are PDF points from the page TOP-left, so
 *    `pdfY = pageHeight - (yTop + boxHeight)` (`topLeftToPdf`);
 *  - text-ish widgets are nudged `yPosition + 6` then drawn at `- 4`, i.e. +2 net;
 *  - checkbox boxes sit at `+2`, radio circles at `(+2, +3)`;
 *  - multi-line text advances a flat 18 points per line whatever the font size;
 *  - image answers are letterboxed onto a canvas of exactly the widget box.
 *
 * Keep the two in step. Prefill values are not stamped here, because the
 * browser does not stamp them either (signer/api.ts marks a prefill seat's
 * fields as nobody's).
 *
 * What is new on this side: the signature itself. An agent cannot draw, so it
 * stamps the user's saved signature like any adopted image (lib/savedSignature.js),
 * or, when they have none, their name set in Caveat (the face the web uses for a
 * typed signature, bundled in `font/`). A field can carry a small `note` that is
 * printed inside its box ("Signed via ChatGPT for Jane Doe").
 */

/** Every widget type the signer knows (signer/widgets.ts WIDGET_TYPES). */
const KNOWN_TYPES = new Set(Object.keys(WIDGET_SPEC));

/** Types whose answer is an image (signer/widgets.ts IMAGE_TYPES). */
export const IMAGE_TYPES = new Set(['signature', 'stamp', 'initials', 'image', 'draw']);

/** Types drawn with the `+6 - 4` text nudge (pdfEmbed.ts TEXT_TYPES). */
const TEXT_TYPES = new Set([
  'text',
  'text input',
  'cells',
  'name',
  'company',
  'job title',
  'date',
  'email',
]);

export const DEFAULT_DATE_FORMAT = 'MM/dd/yyyy';

/** `selectFormat` in the old client, as the web maps it (signer/widgets.ts). */
const DATE_FORMATS = {
  'MM/DD/YYYY': 'MM/dd/yyyy',
  'DD-MM-YYYY': 'dd-MM-yyyy',
  'DD/MM/YYYY': 'dd/MM/yyyy',
  LL: 'MMMM dd, yyyy',
  'DD MMM, YYYY': 'dd MMM, yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
  'MM-DD-YYYY': 'MM-dd-yyyy',
  'MM.DD.YYYY': 'MM.dd.yyyy',
  'MMM DD, YYYY': 'MMM dd, yyyy',
  'MMMM DD, YYYY': 'MMMM dd, yyyy',
  'DD MMMM, YYYY': 'dd MMMM, yyyy',
  'DD.MM.YYYY': 'dd.MM.yyyy',
  'DD-MMM-YYYY': 'dd-MMM-yyyy',
};

/** Pen colours by name (signer/widgets.ts FONT_COLORS). */
const FONT_COLORS = {
  red: '#b5412e',
  black: '#1c1b18',
  blue: '#2f4f9f',
  yellow: '#b07a12',
};

/** Ink of a typed signature (signatureImage.ts `typedSignatureToPng`). */
export const SIGNATURE_INK = '#1c1b18';

/**
 * The agent note on a signature box. It goes inside the box, along the bottom,
 * with the signature set above it: printed documents usually carry a label
 * ("Landlord signature") right under the line, and a note under the box ran
 * into it.
 */
const NOTE_SIZE = 6;
const NOTE_MIN_SIZE = 4;
const NOTE_GAP = 1;
const NOTE_PAD = 2;

/**
 * Height kept at the bottom of a box for its note, or 0 when the note goes
 * outside (no note, or a field turned 90/270 degrees, where it stays under the box).
 */
function noteBand(f) {
  if (!f.note || f.rotation === 90 || f.rotation === 270) return 0;
  return Math.min(NOTE_SIZE + NOTE_PAD, f.h * 0.3);
}

/** Device pixels per PDF point for letterboxed images (the browser's 2 x dpr, capped at 4). */
const IMAGE_PX = 4;

const SIGNATURE_FONT_PATH = fileURLToPath(
  new URL('../../font/Caveat-Regular.ttf', import.meta.url)
);
const SIGNATURE_FONT_FAMILY = 'DocuStamp Caveat';

/* ------------------------------------------------------------------ fields */

/** The legacy alias `textbox` (signer/widgets.ts `normalizeWidgetType`). */
export function normalizeWidgetType(type) {
  const t = typeof type === 'string' ? type.trim() : '';
  return t === 'textbox' ? 'text input' : t;
}

/** Default box in PDF points (signer/widgets.ts `defaultSize`). */
function defaultSize(type) {
  const spec = WIDGET_SPEC[type];
  return spec ? { w: spec.width, h: spec.height } : { w: 150, h: 60 };
}

/**
 * One stored widget as the stamping pass reads it: `toField` in signer/api.ts,
 * same defaults. Returns null for a type the signer does not know (the browser
 * drops those too).
 *
 * `response` is left out on purpose: the stamp draws what the caller decided
 * the answer is, so set it on the returned object.
 *
 * @param {Object} w one `Placeholders[].placeHolder[].pos[]` entry.
 * @param {number} page 1-based page number.
 * @returns {Object|null}
 */
export function fieldFromWidget(w, page) {
  const type = normalizeWidgetType(w?.type);
  if (!KNOWN_TYPES.has(type)) return null;
  const o = w?.options || {};
  const size = defaultSize(type);
  return {
    key: w?.key,
    type,
    page: Number(page) || 1,
    required: type === 'signature' || o.status !== 'optional',
    readOnly: o.isReadOnly === true,
    hideLabel: o.isHideLabel === true,
    name: o.name,
    hint: o.hint,
    values: Array.isArray(o.values) ? o.values : [],
    layout: o.layout === 'horizontal' ? 'horizontal' : 'vertical',
    cellCount: typeof o.cellCount === 'number' ? o.cellCount : 5,
    fontSize: typeof o.fontSize === 'number' ? o.fontSize : 12,
    fontColor: typeof o.fontColor === 'string' ? o.fontColor : w?.fontColor || 'black',
    rotation: typeof o.rotation === 'number' ? o.rotation : 0,
    validation: o.validation,
    defaultValue: o.defaultValue,
    storedResponse: o.response === '' ? undefined : o.response,
    x: Number(w?.xPosition) || 0,
    y: Number(w?.yPosition) || 0,
    w: Number(w?.Width) || size.w,
    h: Number(w?.Height) || size.h,
  };
}

/* ------------------------------------------------------------------ dates */

/** A date label as a date-fns pattern, falling back to MM/dd/yyyy (signer/widgets.ts). */
export function dateFnsPattern(label) {
  if (!label) return DEFAULT_DATE_FORMAT;
  if (DATE_FORMATS[label]) return DATE_FORMATS[label];
  return Object.values(DATE_FORMATS).includes(label) ? label : DEFAULT_DATE_FORMAT;
}

/** The pattern a date widget uses: its own `validation.format` wins over the document's. */
export function fieldDatePattern(field, docFormat) {
  if (field?.validation?.type === 'date-format' && field.validation.format) {
    return dateFnsPattern(field.validation.format);
  }
  return dateFnsPattern(docFormat);
}

/** A time zone `date-fns-tz` accepts, or '' (stored values can be free text). */
export function safeTimeZone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return '';
  }
}

/**
 * Today in `pattern`, in `timeZone`. The browser formats in the signer's own
 * clock; on the server that is the signer's profile time zone, else UTC.
 */
export function formatToday(pattern, timeZone, now = new Date()) {
  const zone = safeTimeZone(timeZone) || 'UTC';
  try {
    return formatInTimeZone(now, zone, pattern || DEFAULT_DATE_FORMAT);
  } catch {
    return formatInTimeZone(now, zone, DEFAULT_DATE_FORMAT);
  }
}

/* ------------------------------------------------------------------ geometry */

/**
 * pdfEmbed.ts `topLeftToPdf`: a top-left anchored point in PDF points becomes a
 * bottom-left anchored one, then the page rotation is applied. `boxHeight` is
 * the height of the thing being placed (the font size for text).
 */
export function topLeftToPdf(pageRotation, x, yFromTop, boxHeight, size) {
  const angle = ((pageRotation % 360) + 360) % 360;
  const rads = (angle * Math.PI) / 180;
  const bx = x;
  // Rotated pages measure the flip against the page WIDTH, not the height.
  const by =
    angle === 90 || angle === 270
      ? size.width - (yFromTop + boxHeight)
      : size.height - (yFromTop + boxHeight);
  const cos = Math.cos(rads);
  const sin = Math.sin(rads);
  if (angle === 90) return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos };
  if (angle === 180) {
    return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos + size.height };
  }
  if (angle === 270) return { x: bx * cos - by * sin, y: bx * sin + by * cos + size.height };
  return { x: bx, y: by };
}

/**
 * The page box to stamp against, in pdf-lib user space (never rotated):
 * `pageBoxOfPdfLib(page).stampWidth/stampHeight` in the web. The CropBox y
 * origin is part of the height on an upright page only (see pageBox.js).
 */
export function pageSizeOf(page) {
  let box;
  try {
    box = page.getCropBox?.() ?? page.getMediaBox?.();
  } catch {
    box = undefined;
  }
  if (!box || !box.width || !box.height) {
    box = { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
  }
  const upright = isUpright(page.getRotation()?.angle);
  return { width: box.width, height: box.height + (upright ? box.y : 0) };
}

/* ------------------------------------------------------------------ text */

/** Greedy word wrap, splitting words wider than the box by character (pdfEmbed.ts). */
export function wrapText(text, font, size, maxWidth) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    if (font.widthOfTextAtSize(paragraph, size) <= maxWidth) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      // A single word wider than the box: break it character by character.
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/** The standard 14 fonts are WinAnsi only; drop anything they cannot encode. */
export function winAnsiSafe(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[^\u0000-ÿ]/g, '');
}

/** rgb triple in 0..1 for a pen colour name (signer/widgets.ts `pdfFontColor`). */
export function pdfFontColor(name) {
  const hex = (FONT_COLORS[name ?? 'black'] ?? FONT_COLORS.black).replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/* ------------------------------------------------------------------ images */

let canvasModule = null;
let fontRegistered = false;

/** @napi-rs/canvas, loaded on first use, with the signature face registered once. */
async function canvasLib() {
  if (!canvasModule) canvasModule = await import('@napi-rs/canvas');
  if (!fontRegistered) {
    canvasModule.GlobalFonts.registerFromPath(SIGNATURE_FONT_PATH, SIGNATURE_FONT_FAMILY);
    fontRegistered = true;
  }
  return canvasModule;
}

/** PNG bytes from a Buffer, a Uint8Array, a data URL or bare base64. */
function imageBytes(src) {
  if (Buffer.isBuffer(src)) return src;
  if (src instanceof Uint8Array) return Buffer.from(src);
  const raw = String(src || '');
  const comma = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  return Buffer.from(comma >= 0 ? raw.slice(comma + 1) : raw, 'base64');
}

/**
 * Crops fully transparent margins off a canvas, keeping `pad` pixels
 * (signatureImage.ts `trimTransparent`).
 */
function trimTransparent(lib, canvas, pad) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 24) continue;
      const bright = data[i] > 242 && data[i + 1] > 242 && data[i + 2] > 242;
      if (bright) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0 || bottom < 0) return canvas;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = lib.createCanvas(right - left + 1, bottom - top + 1);
  out
    .getContext('2d')
    .drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * `text` set in the handwriting face on a transparent PNG sized to the glyphs,
 * at 2x (signatureImage.ts `typedSignatureToPng`, same proportions).
 *
 * @param {string} text the name (or initials) to write.
 * @param {{color?: string, height?: number}} [opts]
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function typedSignaturePng(text, { color = SIGNATURE_INK, height = 120 } = {}) {
  const lib = await canvasLib();
  const dpr = 2;
  const fontSize = Math.round(height * 0.62);
  const font = `${fontSize}px "${SIGNATURE_FONT_FAMILY}"`;
  const measure = lib.createCanvas(10, 10).getContext('2d');
  measure.font = font;
  const width = Math.max(40, Math.ceil(measure.measureText(text || ' ').width) + 24);
  const canvas = lib.createCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(String(text || ''), width / 2, height / 2 + fontSize * 0.04);
  return trimTransparent(lib, canvas, 8).toBuffer('image/png');
}

/** Initials from a full name: "Jane Q Doe" -> "JD" (signatureImage.ts `initialsFrom`). */
export function initialsFrom(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Width and height of an image in pixels. Throws when the canvas cannot read
 * it, so a stored image that is not one fails before anything is stamped: the
 * stamp skips an image it cannot embed, which would leave the box empty.
 *
 * @param {Buffer|Uint8Array|string} src image bytes or a data URL.
 * @returns {Promise<{width: number, height: number}>}
 */
export async function imageSize(src) {
  const lib = await canvasLib();
  const img = await lib.loadImage(imageBytes(src));
  if (!img?.width || !img?.height) throw new Error('The image is empty.');
  return { width: img.width, height: img.height };
}

/**
 * Letterboxes an image onto a transparent canvas of exactly `w` x `h` PDF
 * points, so the drawn rect is always the full box and the aspect ratio is kept
 * by transparent padding (pdfEmbed.ts `renderToWidgetBox`).
 *
 * @param {Buffer|Uint8Array|string} src PNG bytes or a data URL.
 * @param {number} w box width in points.
 * @param {number} h box height in points.
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function renderToWidgetBox(src, w, h) {
  const lib = await canvasLib();
  const img = await lib.loadImage(imageBytes(src));
  const ratio = Math.min(w / img.width, h / img.height, 1);
  const drawW = img.width * ratio;
  const drawH = img.height * ratio;
  const canvas = lib.createCanvas(
    Math.max(1, Math.ceil(w * IMAGE_PX)),
    Math.max(1, Math.ceil(h * IMAGE_PX))
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(IMAGE_PX, IMAGE_PX);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
  return canvas.toBuffer('image/png');
}

/**
 * Stretches a signature to the fixed 300 x 120 the completion certificate
 * wants (pdfEmbed.ts `certificateSignature`).
 *
 * @param {Buffer|Uint8Array|string} src PNG bytes or a data URL.
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function certificateSignature(src) {
  const lib = await canvasLib();
  const img = await lib.loadImage(imageBytes(src));
  const canvas = lib.createCanvas(300, 120);
  canvas.getContext('2d').drawImage(img, 0, 0, 300, 120);
  return canvas.toBuffer('image/png');
}

/* ------------------------------------------------------------------ embed */

/** pdfEmbed.ts `textContentOf`: the text a text-ish field prints. */
function textContentOf(f, docFormat, timeZone) {
  const raw = f.response ?? f.defaultValue;
  if (raw === undefined || raw === null) return '';
  if (Array.isArray(raw)) return '';
  const s = String(raw);
  if (f.type === 'date' && s === 'today') {
    return formatToday(fieldDatePattern(f, docFormat), timeZone);
  }
  return s;
}

function drawRotatedImage(page, img, f, size, angle) {
  const widgetRotation = f.rotation || 0;
  const swapped = widgetRotation === 90 || widgetRotation === 270;
  const width = swapped ? f.h : f.w;
  const height = swapped ? f.w : f.h;
  const p = topLeftToPdf(angle, f.x, f.y, height, size);
  const opt = { x: p.x, y: p.y, width, height, rotate: degrees(angle) };
  if (widgetRotation) {
    opt.rotate = degrees(angle - widgetRotation);
    if (swapped) {
      opt.width = height;
      opt.height = width;
    }
    if (widgetRotation === 90) opt.y += height;
    else if (widgetRotation === 180) {
      opt.x += opt.width;
      opt.y += opt.height;
    } else if (widgetRotation === 270) opt.x += width;
  }
  page.drawImage(img, opt);
}

function selectedIndices(f) {
  if (Array.isArray(f.response)) return f.response;
  if (Array.isArray(f.defaultValue)) return f.defaultValue;
  return [];
}

function drawCheckboxGroup(page, f, size, angle, font, fontSize, color) {
  const horizontal = f.layout === 'horizontal';
  const boxSize = fontSize - 1;
  const gapFromLeft = fontSize + 3.4;
  const verticalGap = fontSize + 5.5;
  const chosen = new Set(selectedIndices(f));
  const values = f.values.length ? f.values : [''];
  let x = f.x;
  let y = f.y + 2;
  let horizontalGap = 0;

  values.forEach((label, i) => {
    if (i > 0) {
      if (horizontal) x += horizontalGap;
      else y += verticalGap;
    }
    const box = topLeftToPdf(angle, x, y, boxSize, size);
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: boxSize,
      height: boxSize,
      borderColor: rgb(0.25, 0.24, 0.22),
      borderWidth: 0.8,
      rotate: degrees(angle),
    });
    if (chosen.has(i)) {
      // A tick, drawn as two strokes inside the box.
      page.drawLine({
        start: { x: box.x + boxSize * 0.2, y: box.y + boxSize * 0.5 },
        end: { x: box.x + boxSize * 0.42, y: box.y + boxSize * 0.24 },
        thickness: 1.1,
        color,
      });
      page.drawLine({
        start: { x: box.x + boxSize * 0.42, y: box.y + boxSize * 0.24 },
        end: { x: box.x + boxSize * 0.82, y: box.y + boxSize * 0.78 },
        thickness: 1.1,
        color,
      });
    }
    if (!f.hideLabel && label) {
      // label position mirrors the old embed: gap to the right, 3pt up
      const lp = topLeftToPdf(angle, x + gapFromLeft, y - 3, fontSize, size);
      page.drawText(winAnsiSafe(label), {
        x: lp.x,
        y: lp.y,
        size: fontSize,
        font,
        color,
        rotate: degrees(angle),
      });
    }
    const textWidth =
      label && !f.hideLabel ? font.widthOfTextAtSize(winAnsiSafe(label), fontSize) : 0;
    horizontalGap = boxSize + (textWidth ? gapFromLeft + textWidth : gapFromLeft - 5);
  });
}

function drawRadioGroup(page, f, size, angle, font, fontSize, color) {
  const horizontal = f.layout === 'horizontal';
  const gapFromLeft = fontSize + 3;
  const radioSize = fontSize;
  const verticalGap = fontSize + 5;
  const chosen =
    typeof f.response === 'string'
      ? f.response
      : typeof f.defaultValue === 'string'
        ? f.defaultValue
        : '';
  const values = f.values.length ? f.values : [''];
  let x = f.x + 2;
  let y = f.y + 3;
  let horizontalGap = 0;

  values.forEach((label, i) => {
    if (i > 0) {
      if (horizontal) x += horizontalGap;
      else y += verticalGap;
    }
    const box = topLeftToPdf(angle, x, y, radioSize, size);
    const cx = box.x + radioSize / 2;
    const cy = box.y + radioSize / 2;
    page.drawCircle({
      x: cx,
      y: cy,
      size: radioSize / 2,
      borderColor: rgb(0.25, 0.24, 0.22),
      borderWidth: 0.8,
    });
    if (label && label.trim() === chosen.trim()) {
      page.drawCircle({ x: cx, y: cy, size: radioSize / 4, color });
    }
    if (label && !f.hideLabel) {
      const lp = topLeftToPdf(angle, x + gapFromLeft, y - 2, fontSize, size);
      page.drawText(winAnsiSafe(label), {
        x: lp.x,
        y: lp.y,
        size: fontSize,
        font,
        color,
        rotate: degrees(angle),
      });
    }
    const textWidth =
      label && !f.hideLabel ? font.widthOfTextAtSize(winAnsiSafe(label), fontSize) : 0;
    horizontalGap = radioSize + (textWidth ? gapFromLeft + textWidth : gapFromLeft - 6);
  });
}

function drawCells(page, f, text, size, angle, font, fontSize, color) {
  const safe = winAnsiSafe(text);
  const cellCount = f.cellCount || safe.length || 1;
  const charWidth = f.w / cellCount;
  const y = f.y + 6 - 4;
  for (let i = 0; i < cellCount; i++) {
    const ch = safe[i];
    if (!ch) continue;
    const charX = f.x + charWidth * i + (charWidth - font.widthOfTextAtSize(ch, fontSize)) / 2;
    const p = topLeftToPdf(angle, charX, y, fontSize, size);
    page.drawText(ch, { x: p.x, y: p.y, size: fontSize, font, color, rotate: degrees(angle) });
  }
}

/**
 * The small line that says an agent signed a box. With a `band` it sits inside
 * the box along the bottom edge; otherwise (a turned field) it goes under the
 * box, or above it when there is no room under it on the page. Shrinks to fit
 * the box width, down to 4pt.
 */
function drawNote(page, f, size, angle, font, band = 0) {
  const text = winAnsiSafe(f.note).trim();
  if (!text) return;
  const swapped = f.rotation === 90 || f.rotation === 270;
  const boxW = swapped ? f.h : f.w;
  const boxH = swapped ? f.w : f.h;
  const inside = band > 0;
  const maxW = inside ? boxW - 2 * NOTE_PAD : boxW;
  let fontSize = inside ? Math.min(NOTE_SIZE, band - 1) : NOTE_SIZE;
  while (fontSize > NOTE_MIN_SIZE && font.widthOfTextAtSize(text, fontSize) > maxW) {
    fontSize -= 0.5;
  }
  const pageHeight = angle === 90 || angle === 270 ? size.width : size.height;
  let x = f.x;
  let yTop;
  if (inside) {
    x = f.x + NOTE_PAD;
    yTop = f.y + boxH - band + (band - fontSize) / 2;
  } else {
    yTop = f.y + boxH + NOTE_GAP;
    if (yTop + fontSize > pageHeight) yTop = Math.max(0, f.y - NOTE_GAP - fontSize);
  }
  const p = topLeftToPdf(angle, x, yTop, fontSize, size);
  page.drawText(text, {
    x: p.x,
    y: p.y,
    size: fontSize,
    font,
    color: rgb(0.36, 0.36, 0.38),
    rotate: degrees(angle),
  });
}

/**
 * Stamp `fields` into `pdfBytes` (pdfEmbed.ts `embedWidgetsToDoc`).
 *
 * A field is the object `fieldFromWidget` returns with `response` set: a string
 * for text, dropdown, radio, cells and dates ("today" is formatted here), an
 * array of option indices for a checkbox, and PNG bytes (or a data URL) for an
 * image field. An optional `note` is printed along the bottom of the box.
 *
 * @param {Object} opts
 * @param {Uint8Array|Buffer|ArrayBuffer} opts.pdfBytes the PDF to stamp (the current `SignedUrl`).
 * @param {Object[]} opts.fields only the fields to stamp.
 * @param {string} [opts.dateFormat] the document's date format label.
 * @param {string} [opts.timeZone] for "today".
 * @returns {Promise<Uint8Array>} the stamped PDF.
 */
export async function embedWidgetsToDoc({ pdfBytes, fields = [], dateFormat, timeZone }) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  // Every image answer is prepared up front, like the browser does, one at a
  // time (they all go into the one document).
  const imageByField = new Map();
  /* eslint-disable no-await-in-loop */
  for (const f of fields) {
    if (!IMAGE_TYPES.has(f.type) || !f.response || Array.isArray(f.response)) continue;
    try {
      const boxed = await renderToWidgetBox(f.response, f.w, f.h - noteBand(f));
      imageByField.set(f, await doc.embedPng(boxed));
    } catch (err) {
      console.warn('stamp: could not embed image for widget', f.key, err?.message);
    }
  }
  /* eslint-enable no-await-in-loop */

  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const size = pageSizeOf(page);
    const rotation = page.getRotation();
    const angle = rotation.angle ?? 0;
    const [r, g, b] = pdfFontColor(f.fontColor);
    const color = rgb(r, g, b);
    const fontSize = f.fontSize || 12;

    try {
      if (IMAGE_TYPES.has(f.type)) {
        const img = imageByField.get(f);
        if (!img) continue;
        const band = noteBand(f);
        drawRotatedImage(page, img, band ? { ...f, h: f.h - band } : f, size, angle);
        if (f.note) drawNote(page, f, size, angle, font, band);
        continue;
      }
      if (f.type === 'checkbox') {
        drawCheckboxGroup(page, f, size, angle, font, fontSize, color);
        continue;
      }
      if (f.type === 'radio button') {
        drawRadioGroup(page, f, size, angle, font, fontSize, color);
        continue;
      }
      const text = textContentOf(f, dateFormat, timeZone);
      if (!text) continue;
      if (f.type === 'cells') {
        drawCells(page, f, text, size, angle, font, fontSize, color);
        continue;
      }
      // dropdown and every text-ish widget draw as plain text.
      const yTop = (TEXT_TYPES.has(f.type) ? f.y + 6 : f.y) - 4;
      const lines = wrapText(winAnsiSafe(text), font, fontSize, f.w);
      let y = yTop;
      for (const line of lines) {
        const p = topLeftToPdf(angle, f.x, y, fontSize, size);
        page.drawText(line, { x: p.x, y: p.y, size: fontSize, font, color, rotate: rotation });
        y += 18; // flat line height, matching the old embed
      }
    } catch (err) {
      // Skip one widget rather than fail the document, but never silently.
      console.warn('stamp: could not draw widget', f.type, f.key, err?.message);
    }
  }

  return await doc.save({ useObjectStreams: false });
}
