/**
 * Written documents: the content model a user types in the app and the PDF it
 * becomes (docs/TEXT_DOCUMENTS.md).
 *
 * Two jobs live here:
 *
 *   normaliseContent  takes whatever the client sent and returns the one shape
 *                     the rest of the server trusts, or throws VALIDATION_ERROR.
 *                     The web app runs the same rules (features/compose/model.ts),
 *                     so a document round-trips without drifting.
 *   renderTextPdf     lays that content out with IBM Plex Sans and returns the
 *                     PDF bytes. It is a small layout engine on top of pdf-lib:
 *                     greedy word wrap per styled run, headings that keep their
 *                     first lines with them, lists with gutter markers, rules,
 *                     page breaks and a "Page N of M" footer.
 *
 * The renderer never throws on the text itself. Characters the font lacks are
 * drawn as its notdef glyph, a word wider than the line is broken by
 * characters, and empty content still produces one page.
 */
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';

export const CONTENT_MAX_BLOCKS = 600;
export const CONTENT_MAX_CHARS = 120_000;
export const LIST_MAX_ITEMS = 200;
export const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

const ALIGNS = new Set(['left', 'center', 'right']);
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'rule', 'pageBreak']);

/* ------------------------------------------------------------ normalising */

function fail(message) {
  throw new Parse.Error(Parse.Error.VALIDATION_ERROR, message);
}

/**
 * The text of one run, as the renderer will see it.
 *
 * Tabs become four spaces so what the editor shows and what the PDF draws
 * agree on width. `\r\n`, lone `\r` and the Unicode line separators all become
 * `\n`: pdf-lib's own text cleaning would otherwise turn U+2028 into spaces
 * after we had measured it as a break. Remaining control characters are
 * dropped; they have no glyph and a few (form feed) would make pdf-lib split
 * the text behind our back.
 */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return (
    value
      .replace(/\t/g, '    ')
      .replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
  );
}

function normaliseRuns(value) {
  if (!Array.isArray(value)) return [];
  const runs = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const text = cleanText(raw.text);
    if (!text) continue;
    const run = { text };
    if (raw.bold === true) run.bold = true;
    if (raw.italic === true) run.italic = true;
    if (raw.underline === true) run.underline = true;
    const last = runs[runs.length - 1];
    // Adjacent runs with the same styling are one run: the editor emits a new
    // run per DOM text node, and merging keeps word wrap from seeing a break
    // in the middle of a word.
    if (last && sameStyle(last, run)) {
      last.text += text;
    } else {
      runs.push(run);
    }
  }
  return runs;
}

function sameStyle(a, b) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

function normaliseAlign(value) {
  return ALIGNS.has(value) ? value : 'left';
}

function normaliseBlock(raw) {
  if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.has(raw.type)) return null;
  switch (raw.type) {
    case 'heading': {
      const level = Number.isFinite(Number(raw.level)) ? Number(raw.level) : 1;
      return {
        type: 'heading',
        level: Math.min(3, Math.max(1, Math.round(level))),
        runs: normaliseRuns(raw.runs),
        align: normaliseAlign(raw.align),
      };
    }
    case 'paragraph':
      return { type: 'paragraph', runs: normaliseRuns(raw.runs), align: normaliseAlign(raw.align) };
    case 'list': {
      if (!Array.isArray(raw.items)) return null;
      if (raw.items.length > LIST_MAX_ITEMS) {
        fail(`A list can have at most ${LIST_MAX_ITEMS} items.`);
      }
      const items = raw.items.map(normaliseRuns);
      if (!items.length) return null;
      return { type: 'list', ordered: raw.ordered === true, items };
    }
    case 'rule':
      return { type: 'rule' };
    case 'pageBreak':
      return { type: 'pageBreak' };
    default:
      return null;
  }
}

function blockRuns(block) {
  if (block.type === 'list') return block.items.flat();
  return block.runs || [];
}

/**
 * Validates and normalises caller input into a `Content` the renderer and the
 * database can take. Throws `Parse.Error.VALIDATION_ERROR` on a wrong shape or
 * a limit; everything else (unknown blocks and keys, odd alignment, a heading
 * level out of range, a missing page size) is repaired rather than refused.
 *
 * @param {*} input the JSON the client sent.
 * @returns {{version: 1, pageSize: 'letter'|'a4', blocks: Array}}
 */
export function normaliseContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Content must be an object.');
  }
  if (input.version !== 1) fail('Content version must be 1.');
  if (!Array.isArray(input.blocks)) fail('Content needs a list of blocks.');
  if (input.blocks.length > CONTENT_MAX_BLOCKS) {
    fail(`A document can have at most ${CONTENT_MAX_BLOCKS} blocks.`);
  }
  const pageSize = Object.hasOwn(PAGE_SIZES, input.pageSize) ? input.pageSize : 'letter';
  const blocks = [];
  let chars = 0;
  for (const raw of input.blocks) {
    const block = normaliseBlock(raw);
    if (!block) continue;
    for (const run of blockRuns(block)) chars += run.text.length;
    if (chars > CONTENT_MAX_CHARS) {
      fail(`A document can have at most ${CONTENT_MAX_CHARS} characters.`);
    }
    blocks.push(block);
  }
  return { version: 1, pageSize, blocks };
}

/**
 * The document as plain text: one block per line, list items prefixed with
 * "- " or "1. ". Soft breaks inside a run stay as line breaks. A rule or a
 * page break is an empty line, so what separated two paragraphs still does.
 *
 * @param {{blocks?: Array}} content normalised content.
 * @returns {string}
 */
export function contentText(content) {
  const lines = [];
  for (const block of content?.blocks || []) {
    if (block.type === 'list') {
      block.items.forEach((runs, i) => {
        const marker = block.ordered ? `${i + 1}. ` : '- ';
        lines.push(marker + runsText(runs));
      });
    } else if (block.type === 'heading' || block.type === 'paragraph') {
      lines.push(runsText(block.runs));
    } else {
      lines.push('');
    }
  }
  return lines.join('\n');
}

function runsText(runs) {
  return (runs || []).map(run => run.text).join('');
}

/* --------------------------------------------------------------- fonts */

const FONT_FILES = {
  regular: './font/IBMPlexSans-Regular.woff',
  bold: './font/IBMPlexSans-Bold.woff',
  italic: './font/IBMPlexSans-Italic.woff',
  boldItalic: './font/IBMPlexSans-BoldItalic.woff',
};

/**
 * IBM Plex Sans vertical metrics, in em. The baseline of a line sits the
 * ascent below the top of its box once the leading (line height minus the
 * glyph box) is split above and below, so text with a 1.5 line height is
 * centred in its line the way the editor shows it.
 */
const FONT_ASCENT = 1.025;
const FONT_DESCENT = 0.275;

/** Font bytes are read once per process; each PDF embeds its own subset. */
const fontBytesCache = new Map();
function fontBytes(style) {
  if (!fontBytesCache.has(style)) {
    // The Buffer itself, never `.buffer`: Node reads small files into a shared
    // pool, and the ArrayBuffer underneath would hand pdf-lib another file's
    // bytes (see GenerateCertificate.js).
    fontBytesCache.set(style, fs.readFileSync(FONT_FILES[style]));
  }
  return fontBytesCache.get(style);
}

function styleKey(bold, italic) {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

/* -------------------------------------------------------------- layout */

const MARGIN = 72;
const TEXT_COLOR = rgb(0.1, 0.1, 0.1);
const FOOTER_COLOR = rgb(0.45, 0.45, 0.45);
const RULE_COLOR = rgb(0.75, 0.75, 0.75);
const RULE_THICKNESS = 0.75;
const RULE_SPACE = 10;
const UNDERLINE_THICKNESS = 0.6;
const UNDERLINE_OFFSET = 1.6;
const LIST_INDENT = 20;
const LIST_MARKER_GAP = 4;
const FOOTER_SIZE = 9;
const FOOTER_Y = 40;
const BODY_SIZE = 11;
const BODY_LINE_HEIGHT = 1.5;
const BODY_SPACE_AFTER = 7;
const LIST_ITEM_SPACE_AFTER = 3;

/** Size, line height and spacing per element (docs/TEXT_DOCUMENTS.md). */
const TITLE_STYLE = { size: 22, lineHeight: 1.25, before: 0, after: 14 };
const HEADING_STYLES = {
  1: { size: 18, lineHeight: 1.3, before: 14, after: 6 },
  2: { size: 14, lineHeight: 1.3, before: 12, after: 4 },
  3: { size: 11.5, lineHeight: 1.3, before: 10, after: 3 },
};

/**
 * Measuring and drawing go through these two so a string pdf-lib cannot cope
 * with (it has not happened in testing, but the font stack is three libraries
 * deep) costs the odd characters rather than the whole render.
 */
function widthOf(font, text, size) {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return font.widthOfTextAtSize(asciiOnly(text), size);
  }
}

function drawText(page, text, options) {
  try {
    page.drawText(text, options);
  } catch {
    page.drawText(asciiOnly(text), options);
  }
}

function asciiOnly(text) {
  return String(text).replace(/[^\x20-\x7E]/g, '?');
}

/**
 * Lays one list of runs out into lines no wider than `maxWidth`.
 *
 * A word is a sequence of non-space characters and may span several runs
 * ("wo" regular + "rd" bold is still one word), so it is kept as a list of
 * styled segments and measured as their sum. Wrap is greedy on spaces; a
 * word that is wider than the line on its own is broken by characters. `\n`
 * forces a break, and spaces at the start of a line it produced are kept
 * (that is how a tab-indented line looks), while spaces at a wrap point are
 * dropped.
 *
 * @returns {Array<{segs: Array, width: number}>} lines of styled segments.
 */
function wrapRuns(runs, fonts, size, maxWidth, { forceBold = false } = {}) {
  const tokens = tokenise(runs, fonts, size, forceBold);
  const lines = [];
  let line = [];
  let width = 0;
  let wrapped = false;

  const flush = () => {
    while (line.length && line[line.length - 1].space) line.pop();
    lines.push({ segs: line, width: line.reduce((sum, seg) => sum + seg.width, 0) });
    line = [];
    width = 0;
  };

  for (const token of tokens) {
    if (token.kind === 'break') {
      flush();
      wrapped = false;
      continue;
    }
    if (token.kind === 'space') {
      if (wrapped && !line.length) continue;
      line.push(token.seg);
      width += token.seg.width;
      continue;
    }
    const wordWidth = token.segs.reduce((sum, seg) => sum + seg.width, 0);
    if (width + wordWidth <= maxWidth || (!line.length && wordWidth <= maxWidth)) {
      line.push(...token.segs);
      width += wordWidth;
      continue;
    }
    if (line.some(seg => !seg.space)) {
      flush();
      wrapped = true;
    } else {
      // Only spaces so far: the word starts the line whatever its width.
      line = [];
      width = 0;
    }
    if (wordWidth <= maxWidth) {
      line.push(...token.segs);
      width = wordWidth;
      continue;
    }
    // Wider than the whole line: break it by characters, each measured in
    // its own font, and carry the remainder on as the start of the next line.
    for (const seg of token.segs) {
      for (const ch of seg.text) {
        const w = widthOf(seg.font, ch, size);
        if (width + w > maxWidth && line.length) {
          flush();
          wrapped = true;
        }
        line.push({ ...seg, text: ch, width: w });
        width += w;
      }
    }
    line = mergeSegments(line);
    width = line.reduce((sum, seg) => sum + seg.width, 0);
  }
  flush();
  return lines;
}

/** Words, spaces and forced breaks, in order, each carrying its font. */
function tokenise(runs, fonts, size, forceBold) {
  const tokens = [];
  let word = null;
  const endWord = () => {
    if (word) tokens.push(word);
    word = null;
  };
  for (const run of runs) {
    const font = fonts[styleKey(forceBold || run.bold, run.italic)];
    const base = { font, underline: run.underline === true };
    const parts = run.text.split(/(\n| +)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') {
        endWord();
        tokens.push({ kind: 'break' });
      } else if (part[0] === ' ') {
        endWord();
        tokens.push({
          kind: 'space',
          seg: { ...base, text: part, width: widthOf(font, part, size), space: true },
        });
      } else {
        const seg = { ...base, text: part, width: widthOf(font, part, size) };
        if (!word) word = { kind: 'word', segs: [] };
        word.segs.push(seg);
      }
    }
  }
  endWord();
  return tokens;
}

/** Re-joins per-character segments that share a font and underline. */
function mergeSegments(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (
      last &&
      !last.space &&
      !seg.space &&
      last.font === seg.font &&
      last.underline === seg.underline
    ) {
      last.text += seg.text;
      last.width += seg.width;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Every block as the lines the paginator places, with the spacing around it.
 * A list becomes one entry whose lines carry their own indent and marker, so
 * "the first two lines after a heading" means the same thing for every block.
 */
function layoutBlocks(title, content, fonts, contentWidth) {
  const entries = [];
  const textLine = (wrapped, size, lineHeight, extra = {}) => ({
    kind: 'text',
    segs: wrapped.segs,
    width: wrapped.width,
    size,
    height: size * lineHeight,
    indent: 0,
    align: 'left',
    ...extra,
  });

  if (title) {
    const style = TITLE_STYLE;
    const wrapped = wrapRuns([{ text: title }], fonts, style.size, contentWidth, {
      forceBold: true,
    });
    entries.push({
      type: 'title',
      before: 0,
      after: style.after,
      lines: wrapped.map(w => textLine(w, style.size, style.lineHeight)),
    });
  }

  for (const block of content.blocks) {
    if (block.type === 'heading') {
      const style = HEADING_STYLES[block.level] || HEADING_STYLES[1];
      const wrapped = wrapRuns(block.runs, fonts, style.size, contentWidth, { forceBold: true });
      entries.push({
        type: 'heading',
        keepWithNext: true,
        before: style.before,
        after: style.after,
        lines: wrapped.map(w => textLine(w, style.size, style.lineHeight, { align: block.align })),
      });
    } else if (block.type === 'paragraph') {
      const wrapped = wrapRuns(block.runs, fonts, BODY_SIZE, contentWidth);
      entries.push({
        type: 'paragraph',
        before: 0,
        after: BODY_SPACE_AFTER,
        lines: wrapped.map(w => textLine(w, BODY_SIZE, BODY_LINE_HEIGHT, { align: block.align })),
      });
    } else if (block.type === 'list') {
      const lines = [];
      block.items.forEach((runs, index) => {
        const wrapped = wrapRuns(runs, fonts, BODY_SIZE, contentWidth - LIST_INDENT);
        wrapped.forEach((w, lineIndex) => {
          const marker = lineIndex === 0 ? (block.ordered ? `${index + 1}.` : '\u2022') : '';
          lines.push(
            textLine(w, BODY_SIZE, BODY_LINE_HEIGHT, {
              indent: LIST_INDENT,
              marker,
              // Items sit 3 pt apart; the gap after the last one brings the
              // list up to paragraph spacing so the next block is not cramped.
              gapAfter: lineIndex === wrapped.length - 1 ? LIST_ITEM_SPACE_AFTER : 0,
            })
          );
        });
      });
      entries.push({
        type: 'list',
        before: 0,
        after: BODY_SPACE_AFTER - LIST_ITEM_SPACE_AFTER,
        lines,
      });
    } else if (block.type === 'rule') {
      entries.push({
        type: 'rule',
        before: RULE_SPACE,
        after: RULE_SPACE,
        lines: [{ kind: 'rule', height: RULE_THICKNESS }],
      });
    } else if (block.type === 'pageBreak') {
      entries.push({ type: 'pageBreak', before: 0, after: 0, lines: [] });
    }
  }
  return entries;
}

/** Height of the first `count` lines of an entry, with its space before. */
function leadingHeight(entry, count) {
  if (!entry || entry.type === 'pageBreak') return 0;
  let height = entry.before;
  for (const line of entry.lines.slice(0, count)) height += line.height + (line.gapAfter || 0);
  return height;
}

/**
 * Renders the content and reports the page count alongside the bytes.
 *
 * @param {{title?: string, content?: Object}} input `content` is normalised
 *   here as well, so a caller that skipped `normaliseContent` still gets a
 *   valid layout (or its VALIDATION_ERROR).
 * @returns {Promise<{bytes: Uint8Array, pageCount: number}>}
 */
export async function renderTextDocument({ title, content } = {}) {
  const doc = normaliseContent(content ?? { version: 1, blocks: [] });
  const heading = cleanText(title).replace(/\n+/g, ' ').trim();
  const [pageWidth, pageHeight] = PAGE_SIZES[doc.pageSize];
  const contentWidth = pageWidth - 2 * MARGIN;
  const top = pageHeight - MARGIN;
  const bottom = MARGIN;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  pdfDoc.setTitle(heading);
  pdfDoc.setProducer('DocuStamp');
  pdfDoc.setCreator('DocuStamp');

  // Only the faces the document uses are embedded; regular always is, for the
  // footer and the list markers.
  const needed = new Set(['regular']);
  for (const block of doc.blocks) {
    const forceBold = block.type === 'heading';
    for (const run of blockRuns(block)) needed.add(styleKey(forceBold || run.bold, run.italic));
  }
  if (heading) needed.add('bold');
  const fonts = {};
  for (const style of needed) {
    // eslint-disable-next-line no-await-in-loop -- four fonts at most, embedded in order
    fonts[style] = await pdfDoc.embedFont(fontBytes(style), { subset: true });
  }

  const entries = layoutBlocks(heading, doc, fonts, contentWidth);

  let page = null;
  let y = top;
  let pageEmpty = true;
  let pendingBreak = false;
  const newPage = () => {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = top;
    pageEmpty = true;
    pendingBreak = false;
  };
  newPage();

  const drawLine = line => {
    if (line.kind === 'rule') {
      page.drawLine({
        start: { x: MARGIN, y: y - line.height / 2 },
        end: { x: pageWidth - MARGIN, y: y - line.height / 2 },
        thickness: line.height,
        color: RULE_COLOR,
      });
      return;
    }
    const size = line.size;
    const lineHeight = line.height;
    const baseline =
      y - (lineHeight - size * (FONT_ASCENT + FONT_DESCENT)) / 2 - size * FONT_ASCENT;
    const available = contentWidth - line.indent;
    let x = MARGIN + line.indent;
    if (line.align === 'center') x += Math.max(0, (available - line.width) / 2);
    else if (line.align === 'right') x += Math.max(0, available - line.width);
    if (line.marker) {
      // Markers sit in the gutter, right-aligned against the text so "9." and
      // "10." end at the same place.
      const markerWidth = widthOf(fonts.regular, line.marker, size);
      drawText(page, line.marker, {
        x: MARGIN + LIST_INDENT - LIST_MARKER_GAP - markerWidth,
        y: baseline,
        size,
        font: fonts.regular,
        color: TEXT_COLOR,
      });
    }
    for (const seg of line.segs) {
      if (!seg.space) {
        drawText(page, seg.text, { x, y: baseline, size, font: seg.font, color: TEXT_COLOR });
      }
      if (seg.underline) {
        page.drawLine({
          start: { x, y: baseline - UNDERLINE_OFFSET },
          end: { x: x + seg.width, y: baseline - UNDERLINE_OFFSET },
          thickness: UNDERLINE_THICKNESS,
          color: TEXT_COLOR,
        });
      }
      x += seg.width;
    }
  };

  entries.forEach((entry, index) => {
    if (entry.type === 'pageBreak') {
      // Taken lazily, when the next thing is drawn: a break at the top of an
      // empty page, two in a row, or one at the very end add nothing.
      if (!pageEmpty) pendingBreak = true;
      return;
    }
    if (pendingBreak) newPage();
    // Space before an element is dropped at the top of a page.
    const before = pageEmpty ? 0 : entry.before;
    if (entry.keepWithNext && !pageEmpty) {
      // A heading never ends a page: it needs room for itself plus the first
      // two lines of what follows it.
      const own = entry.lines.reduce((sum, line) => sum + line.height, 0) + entry.after;
      const next = leadingHeight(entries[index + 1], 2);
      if (y - before - own - next < bottom) newPage();
    }
    if (!pageEmpty) y -= before;
    for (const line of entry.lines) {
      if (y - line.height < bottom && !pageEmpty) newPage();
      drawLine(line);
      y -= line.height + (line.gapAfter || 0);
      pageEmpty = false;
    }
    y -= entry.after;
  });

  const pages = pdfDoc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `Page ${i + 1} of ${pages.length}`;
      const width = widthOf(fonts.regular, label, FOOTER_SIZE);
      drawText(p, label, {
        x: (pageWidth - width) / 2,
        y: FOOTER_Y,
        size: FOOTER_SIZE,
        font: fonts.regular,
        color: FOOTER_COLOR,
      });
    });
  }

  const bytes = await pdfDoc.save();
  return { bytes, pageCount: pages.length };
}

/**
 * Renders the PDF. `title` is drawn as the document heading when non-empty.
 *
 * @param {{title?: string, content?: Object}} input
 * @returns {Promise<Uint8Array>}
 */
export async function renderTextPdf(input) {
  const { bytes } = await renderTextDocument(input);
  return bytes;
}
