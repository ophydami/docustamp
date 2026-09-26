/**
 * Text layout extraction with pdf.js, for grounding the AI's field placement.
 *
 * The model is good at reading a PDF and deciding *what* goes where, but asking it
 * for pixel coordinates is unreliable. So we hand it a transcript in which every
 * text line carries an id and its bounding box in PDF points (top-left origin, the
 * same system the widgets are stored in), and ask it to anchor fields to line ids.
 * The server then turns anchors into coordinates deterministically.
 */

import { pageBoxFromViewport } from '../lib/pageBox.js';

export const MAX_PAGES = 60;
const MAX_LINES_PER_PAGE = 400;
const RUN_RE = /^[_—–.·\s]{4,}$/;

/**
 * Character budget for the transcript. It is sent whole on every call next to
 * the PDF itself, so a dense 60-page schedule would otherwise cost several
 * dollars per click (roughly 4 characters per token: 320k chars is about 80k
 * tokens). Past the budget only lines with a blank run are kept, since those
 * are the ones fields anchor to; past the hard cap the transcript stops.
 */
const TRANSCRIPT_BUDGET_CHARS = 320 * 1000;
const TRANSCRIPT_HARD_CAP_CHARS = 400 * 1000;

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return await pdfjsPromise;
}

/**
 * @typedef {Object} LayoutLine
 * @property {string} id e.g. "p2l14"
 * @property {number} x left, PDF points
 * @property {number} y top, PDF points (from the page top)
 * @property {number} w width
 * @property {number} h height
 * @property {string} text
 * @property {{x: number, w: number}|null} blank widest underline run on the line, if any
 */

/**
 * The size of one page in the top-left system the widgets are stored in.
 *
 * The arithmetic (including where the CropBox y offset does and does not apply)
 * is `cloud/lib/pageBox.js`, shared with `drafts.pageSizes` so the geometry the
 * model is grounded on and the geometry `review_draft` checks against are the
 * same numbers. Only the reading differs: pdf.js here, pdf-lib there.
 */
function pageBoxOf(page) {
  const viewport = page.getViewport({ scale: 1 });
  const box = pageBoxFromViewport(viewport, page.view?.[1], page.rotate);
  return { viewport, width: box.width, height: box.height, rotation: box.rotation };
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{pageCount: number, pages: Array<{number: number, width: number, height: number, rotation: number, lines: LayoutLine[]}>, truncated: boolean, lastPage: {number: number, width: number, height: number}}>}
 */
export async function extractLayout(bytes) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    // pdf.js talks about "PasswordException" and internal stream offsets; the
    // caller uploaded a file, so answer in those terms instead.
    await task.destroy().catch(() => undefined);
    const name = String(err?.name || '');
    const message = String(err?.message || '');
    if (name === 'PasswordException' || /password/i.test(message)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        'This PDF is password protected. Remove the password and upload it again.'
      );
    }
    console.log('ai: could not read the PDF:', message);
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'This PDF could not be read. It may be corrupt or not a PDF at all.'
    );
  }
  const pages = [];
  const limit = Math.min(doc.numPages, MAX_PAGES);
  let lastPage = null;
  try {
    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n);
      const { viewport, width, height, rotation } = pageBoxOf(page);
      const content = await page.getTextContent();
      const sideways = rotation === 90 || rotation === 270;
      const items = [];
      for (const raw of content.items) {
        if (!('str' in raw) || typeof raw.str !== 'string' || !raw.str.trim()) continue;
        const m = lib.Util.transform(viewport.transform, raw.transform);
        // `raw.width` is already the run's length in viewport units, so the
        // transform only supplies its *direction*: on a rotated page the text
        // runs down the screen, and the ascent (m[2], m[3]) points sideways.
        const runLength = raw.width || 0;
        const runScale = Math.hypot(m[0], m[1]) || 1;
        const runX = (m[0] / runScale) * runLength;
        const runY = (m[1] / runScale) * runLength;
        // (m[2], m[3]) already carries the ascent's direction *and* height. A
        // degenerate text matrix would give a zero-height box, so fall back to
        // the item's own height, pointing up the page.
        const ascent = Math.hypot(m[2], m[3]);
        const upX = ascent ? m[2] : 0;
        const upY = ascent ? m[3] : -(raw.height || 10);
        const xs = [m[4], m[4] + runX, m[4] + upX, m[4] + runX + upX];
        const ys = [m[5], m[5] + runY, m[5] + upY, m[5] + runY + upY];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const boxW = Math.max(...xs) - x;
        const boxH = Math.max(...ys) - y;
        items.push({
          text: raw.str,
          x,
          y,
          w: boxW,
          h: boxH,
          // Where the item sits along the reading direction, and on which line.
          along: sideways ? y : x,
          alongEnd: sideways ? y + boxH : x + boxW,
          across: sideways ? m[4] : m[5],
          thickness: sideways ? boxW : boxH,
          // Underline runs are measured along the item's x extent, which only
          // matches the reading direction on an upright page.
          blanks: sideways ? [] : blankRunsIn({ text: raw.str, x, w: boxW, h: boxH }),
        });
      }
      let lines = groupLines(items)
        .slice(0, MAX_LINES_PER_PAGE)
        .map((l, i) => ({ ...l, id: `p${n}l${i + 1}` }));
      // Printed rules that are drawn (a border-bottom from an HTML-to-PDF
      // converter, a ruled line) rather than typed as underscores.
      if (!sideways) {
        const rules = await vectorRules(lib, page, viewport).catch(err => {
          console.log('ai: could not read the page drawing operators:', err?.message);
          return [];
        });
        lines = attachRules(lines, rules, n);
      }
      pages.push({ number: n, width: round(width), height: round(height), rotation, lines });
    }
    // The real last page, so a fallback box lands on it even past the limit.
    if (doc.numPages > limit) {
      const page = await doc.getPage(doc.numPages);
      const box = pageBoxOf(page);
      lastPage = { number: doc.numPages, width: round(box.width), height: round(box.height) };
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  const tail = pages[pages.length - 1];
  return {
    pageCount: doc.numPages,
    pages,
    truncated: doc.numPages > limit,
    lastPage:
      lastPage || (tail ? { number: tail.number, width: tail.width, height: tail.height } : null),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Operator numbers from pdf.js (`OPS`), read off the library so a bump cannot silently shift them. */
function opsOf(lib) {
  return lib.OPS;
}

/** Apply a 2x3 matrix to a point. */
function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The 2x3 product a*b (apply b, then a), as pdf.js does it. */
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const RULE_MIN_WIDTH = 30;
const RULE_MAX_THICKNESS = 2.5;
const MAX_RULES_PER_PAGE = 400;

/**
 * Horizontal rules drawn on the page: stroked horizontal segments and thin
 * filled rectangles, in the top-left point system of the page. Read from the
 * operator list with the CTM tracked through save / restore / transform; the
 * path data is pdf.js's own compact form (DrawOPS codes followed by
 * coordinates), the same one its canvas renderer decodes.
 *
 * @returns {Promise<Array<{x: number, y: number, w: number}>>} y is the rule's
 *   own line (its bottom edge for a rectangle).
 */
export async function vectorRules(lib, page, viewport) {
  const OPS = opsOf(lib);
  const opList = await page.getOperatorList();
  const draw = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
  const paintOps = new Set([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  const toPage = (x, y) => {
    const [ux, uy] = applyMatrix(ctm, x, y);
    return applyMatrix(viewport.transform, ux, uy);
  };
  const pushRule = (x1, y1, x2, y2) => {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    if (right - left < RULE_MIN_WIDTH || bottom - top > RULE_MAX_THICKNESS) return;
    out.push({ x: round(left), y: round(bottom), w: round(right - left) });
  };
  for (let i = 0; i < opList.fnArray.length && out.length < MAX_RULES_PER_PAGE; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && Array.isArray(args)) ctm = multiply(ctm, args);
    else if (fn === OPS.constructPath && args) {
      const [op, wrapped] = args;
      // pdf.js hands the path as `[Float32Array]` (its canvas code does `let [path] = data`).
      const data = Array.isArray(wrapped) ? wrapped[0] : wrapped;
      if (!paintOps.has(op) || !data || typeof data.length !== 'number') continue;
      // Walk the subpaths: a horizontal segment is a rule; a closed subpath of
      // 4 / 5 points whose height is tiny is a rule drawn as a rectangle.
      let cur = null;
      let sub = [];
      const flush = () => {
        if (sub.length >= 4) {
          const xs = sub.map(p => p[0]);
          const ys = sub.map(p => p[1]);
          pushRule(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
        }
        sub = [];
      };
      for (let k = 0; k < data.length; ) {
        const code = data[k++];
        if (code === draw.moveTo) {
          flush();
          cur = toPage(data[k++], data[k++]);
          sub = [cur];
        } else if (code === draw.lineTo) {
          const next = toPage(data[k++], data[k++]);
          if (cur && Math.abs(next[1] - cur[1]) <= RULE_MAX_THICKNESS) pushRule(cur[0], cur[1], next[0], next[1]);
          cur = next;
          sub.push(next);
        } else if (code === draw.curveTo) {
          k += 6;
          cur = null;
          sub = [];
        } else if (code === draw.quadraticCurveTo) {
          k += 4;
          cur = null;
          sub = [];
        } else if (code === draw.closePath) {
          flush();
        } else break;
      }
      flush();
    }
  }
  // The same rule is often both filled and stroked, or drawn per table cell.
  const seen = new Set();
  return out.filter(r => {
    const key = `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.w)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Put each drawn rule on the text line it underlines, as a `blanks` entry, so
 * `detect_fields`, `find_text` and the AI transcript see it exactly like a typed
 * "_____". A rule with no text on its row becomes a text-less line of its own
 * (id `p<n>r<k>`), so it is still addressable.
 */
function attachRules(lines, rules, pageNumber) {
  if (!rules.length) return lines;
  const out = lines.map(l => ({ ...l, blanks: [...(l.blanks || [])] }));
  const orphans = [];
  for (const r of rules) {
    let best = null;
    let bestGap = Infinity;
    for (const l of out) {
      const baseline = l.y + l.h;
      const gap = r.y - baseline; // rule just under the text: small positive
      const tolerance = Math.max(6, l.h * 0.9);
      if (gap < -l.h * 0.6 || gap > tolerance) continue;
      // Same row: the rule starts at or after the line's start, or overlaps it.
      if (r.x + r.w < l.x - 2 || r.x > l.x + l.w + 400) continue;
      const d = Math.abs(gap) + (r.x >= l.x ? 0 : 1);
      if (d < bestGap) {
        bestGap = d;
        best = l;
      }
    }
    if (best) {
      if (!best.blanks.some(b => Math.abs(b.x - r.x) < 3 && Math.abs(b.w - r.w) < 3)) {
        best.blanks.push({ x: r.x, w: r.w, drawn: true });
      }
    } else {
      orphans.push(r);
    }
  }
  for (const l of out) {
    if (!l.blanks.length) continue;
    l.blanks.sort((a, b) => a.x - b.x);
    l.blank = l.blanks.reduce((a, b) => (b.w > a.w ? b : a), l.blanks[0]);
  }
  orphans.forEach((r, k) => {
    out.push({
      id: `p${pageNumber}r${k + 1}`,
      x: r.x,
      y: round(r.y - 10),
      w: r.w,
      h: 10,
      text: '',
      blank: { x: r.x, w: r.w, drawn: true },
      blanks: [{ x: r.x, w: r.w, drawn: true }],
      drawnRule: true,
    });
  });
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Merge the text items that share a baseline into lines, in reading order.
 *
 * "Baseline" and "reading order" are the item's `across` and `along`
 * coordinates, which the caller already resolved for the page's rotation, so
 * this works the same for an upright page (left to right) and a sideways one
 * (top to bottom). The line's box is the union of its items' boxes.
 */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.across - b.across || a.along - b.along);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (
      last &&
      Math.abs(last.across - it.across) <= Math.max(3, Math.min(last.thickness, it.thickness) * 0.5)
    ) {
      last.items.push(it);
      last.thickness = Math.max(last.thickness, it.thickness);
    } else {
      lines.push({ across: it.across, thickness: it.thickness, items: [it] });
    }
  }
  return lines.map(line => {
    const parts = line.items.sort((a, b) => a.along - b.along);
    let text = '';
    let lastEnd = null;
    const blanks = [];
    let x = Infinity;
    let y = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const p of parts) {
      const gap = lastEnd === null ? 0 : p.along - lastEnd;
      if (lastEnd !== null) text += gap > p.thickness * 0.25 ? ' ' : '';
      text += p.text;
      lastEnd = p.alongEnd;
      blanks.push(...(p.blanks || []));
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
      right = Math.max(right, p.x + p.w);
      bottom = Math.max(bottom, p.y + p.h);
    }
    blanks.sort((a, b) => a.x - b.x);
    const blank = blanks.length
      ? blanks.reduce((best, b) => (b.w > best.w ? b : best), blanks[0])
      : null;
    return {
      x: round(x),
      y: round(y),
      w: round(right - x),
      h: round(bottom - y),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 300),
      blank,
      blanks,
      // The items the line was built from, for anything that needs to know
      // where a word sits (a long gap between two labels on one row makes the
      // per-character estimate over the whole line useless).
      spans: parts.map(p => ({ x: round(p.x), w: round(p.w), text: p.text })),
    };
  });
}

/**
 * The underline runs inside one text item, as x/width spans. A run that is the
 * whole item keeps the item's box; runs embedded in a label ("Name: ______") are
 * estimated proportionally by character count, which is close enough for the
 * monospaced-ish underscores printed forms use.
 */
function blankRunsIn(item) {
  const t = item.text;
  const trimmed = t.trim();
  if (!trimmed || item.w < 30) return [];
  if (RUN_RE.test(trimmed)) return [{ x: round(item.x), w: round(item.w) }];
  const perChar = item.w / Math.max(1, t.length);
  const out = [];
  for (const m of t.matchAll(/_{4,}|[.·]{6,}/g)) {
    const w = m[0].length * perChar;
    if (w < 30) continue;
    out.push({ x: round(item.x + m.index * perChar), w: round(w) });
  }
  return out;
}

/**
 * The transcript the model reads. Compact on purpose: it is sent on every call,
 * and under a character budget so one dense document cannot blow up the request
 * (or the bill). Lines that carry a blank run survive longest, because those are
 * the ones fields anchor to.
 */
export function layoutTranscript(layout) {
  const out = [];
  let chars = 0;
  let skipped = 0;
  let stopped = false;
  for (const page of layout.pages) {
    if (stopped) break;
    const header = `=== page ${page.number} (${page.width} x ${page.height} pt${page.rotation ? `, rotated ${page.rotation} degrees` : ''}) ===`;
    out.push(header);
    chars += header.length + 1;
    for (const l of page.lines) {
      const hasBlank = Boolean(l.blank || l.blanks?.length);
      if (chars > TRANSCRIPT_HARD_CAP_CHARS) {
        stopped = true;
        break;
      }
      if (chars > TRANSCRIPT_BUDGET_CHARS && !hasBlank) {
        skipped += 1;
        continue;
      }
      const blanks = (l.blanks || [])
        .map((b, i) => ` blank${i}[x=${b.x} w=${b.w}${b.drawn ? ' drawn' : ''}]`)
        .join('');
      const row = `${l.id} [x=${l.x} y=${l.y} w=${l.w} h=${l.h}]${blanks} ${l.text}`;
      out.push(row);
      chars += row.length + 1;
    }
  }
  if (skipped || stopped) {
    out.push(
      `(transcript shortened to stay inside the size budget: ${skipped} plain text line(s) omitted${stopped ? ', and it stops early' : ''}; fields can still be anchored to the lines listed above)`
    );
  }
  if (layout.truncated)
    out.push(`(transcript truncated after ${MAX_PAGES} pages; the PDF has ${layout.pageCount})`);
  return out.join('\n');
}

export function findLine(layout, id) {
  for (const page of layout.pages) {
    const line = page.lines.find(l => l.id === id);
    if (line) return { page, line };
  }
  return null;
}
