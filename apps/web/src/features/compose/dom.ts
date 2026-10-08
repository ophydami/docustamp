/**
 * Between the content model and the DOM. `contentToHtml` renders a Content
 * into the markup the contenteditable sheet edits; `htmlToContent` walks that
 * sheet (or any HTML, such as a paste) back into a Content.
 *
 * The walker is tolerant on purpose: browsers nest and wrap things in their
 * own ways while editing (Chrome puts a new list inside the paragraph it came
 * from, for one), and pasted markup comes from anywhere. Anything it does not
 * know is either walked through as if it were a span or dropped as a leaf.
 */
import {
  cleanText,
  mergeRuns,
  type Align,
  type Block,
  type Content,
  type HeadingBlock,
  type HeadingLevel,
  type ListBlock,
  type PageSize,
  type ParagraphBlock,
  type Run
} from "./model";

/** The non-editable marker that stands for a page break inside the sheet. */
export const PAGE_BREAK_SELECTOR = '[data-block="pageBreak"]';

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

function alignAttr(align: Align | undefined): string {
  return align === "center" || align === "right" ? ` style="text-align:${align}"` : "";
}

function runHtml(run: Run): string {
  let html = escapeHtml(run.text).replace(/\n/g, "<br>");
  if (run.underline) html = `<u>${html}</u>`;
  if (run.italic) html = `<i>${html}</i>`;
  if (run.bold) html = `<b>${html}</b>`;
  return html;
}

/**
 * A block's inline markup. A trailing line break needs a second <br>: the
 * browser treats the last one in a block as its placeholder and never draws
 * it, and the walker strips it again on the way back.
 */
function runsHtml(runs: Run[]): string {
  if (!runs.length) return "<br>";
  const html = runs.map(runHtml).join("");
  return runs[runs.length - 1].text.endsWith("\n") ? `${html}<br>` : html;
}

export function contentToHtml(content: Content, opts: { pageBreakLabel?: string } = {}): string {
  const parts: string[] = [];
  for (const block of content.blocks) {
    switch (block.type) {
      case "heading":
        parts.push(`<h${block.level}${alignAttr(block.align)}>${runsHtml(block.runs)}</h${block.level}>`);
        break;
      case "paragraph":
        parts.push(`<p${alignAttr(block.align)}>${runsHtml(block.runs)}</p>`);
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        parts.push(`<${tag}>${block.items.map((item) => `<li>${runsHtml(item)}</li>`).join("")}</${tag}>`);
        break;
      }
      case "rule":
        parts.push("<hr>");
        break;
      case "pageBreak":
        parts.push(
          `<div data-block="pageBreak" contenteditable="false">${escapeHtml(opts.pageBreakLabel ?? "")}</div>`
        );
        break;
    }
  }
  // The sheet always needs one line to put the caret in.
  if (!parts.length) parts.push("<p><br></p>");
  return parts.join("");
}

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/**
 * "preserve" is the live sheet, which is `white-space: pre-wrap`, so every
 * space and newline in a text node is real. "collapse" is pasted markup,
 * where runs of whitespace are layout.
 */
type Ws = "preserve" | "collapse";

interface Open {
  type: "paragraph" | "heading";
  level: HeadingLevel;
  align?: Align;
  runs: Run[];
  /** Opened for loose text in a wrapper, or a leaf a nested block cut short: dropped again if it stays empty. */
  pending: boolean;
}

interface Ctx {
  blocks: Block[];
  open: Open | null;
}

const PLAIN: Style = { bold: false, italic: false, underline: false };

/** Elements whose content is never text. */
const SKIP = new Set([
  "script", "style", "head", "meta", "title", "link", "template", "noscript", "iframe", "object", "embed",
  "svg", "math", "img", "picture", "video", "audio", "canvas", "input", "select", "textarea", "button", "map", "area"
]);

/** Elements that start a line of their own; an empty one is a blank line. */
const LEAF = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "li", "dd", "dt", "td", "th",
  "figcaption", "address", "summary", "caption"
]);

function styleOf(el: Element, inherited: Style, tag: string): Style {
  let { bold, italic, underline } = inherited;
  if (tag === "b" || tag === "strong") bold = true;
  if (tag === "i" || tag === "em") italic = true;
  if (tag === "u" || tag === "ins") underline = true;
  const style = (el as HTMLElement).style;
  if (style) {
    // Inline styles win over the tag: Google Docs wraps a whole paste in
    // <b style="font-weight:normal">, and Word writes bold as a style on a span.
    const weight = style.fontWeight;
    if (weight) {
      const n = Number.parseInt(weight, 10);
      if (weight === "bold" || weight === "bolder" || n >= 600) bold = true;
      else if (weight === "normal" || weight === "lighter" || n < 600) bold = false;
    }
    const fontStyle = style.fontStyle;
    if (fontStyle === "italic" || fontStyle === "oblique") italic = true;
    else if (fontStyle === "normal") italic = false;
    const decoration = style.textDecorationLine || style.textDecoration;
    if (decoration) {
      if (decoration.includes("underline")) underline = true;
      else if (decoration.includes("none")) underline = false;
    }
  }
  return { bold, italic, underline };
}

function alignOf(el: Element, inherited: Align | undefined, tag: string): Align | undefined {
  const raw = (
    (el as HTMLElement).style?.textAlign ||
    el.getAttribute("align") ||
    (tag === "center" ? "center" : "")
  ).toLowerCase();
  if (raw === "center" || raw === "-webkit-center") return "center";
  if (raw === "right" || raw === "end" || raw === "-webkit-right") return "right";
  if (raw === "left" || raw === "start" || raw === "justify" || raw === "-webkit-left") return "left";
  return inherited;
}

function openParagraph(ctx: Ctx, align: Align | undefined): Open {
  const open: Open = { type: "paragraph", level: 1, align, runs: [], pending: true };
  ctx.open = open;
  return open;
}

function addText(ctx: Ctx, raw: string, style: Style, align: Align | undefined, ws: Ws): void {
  let text = raw.replace(/ /g, " ");
  if (ws === "collapse") {
    text = text.replace(/[ \t\r\n\f]+/g, " ");
    // Whitespace between blocks, or before a block's first word, is layout.
    if (text === " " && (!ctx.open || ctx.open.runs.length === 0)) return;
  }
  text = cleanText(text);
  if (!text) return;
  const open = ctx.open ?? openParagraph(ctx, align);
  open.runs.push({ text, ...style });
}

function addBreak(ctx: Ctx, style: Style, align: Align | undefined): void {
  const open = ctx.open ?? openParagraph(ctx, align);
  open.runs.push({ text: "\n", ...style });
}

function finishRuns(runs: Run[], ws: Ws): Run[] {
  const out = mergeRuns(runs);
  if (!out.length) return out;
  const trimEnd = () => {
    const last = out[out.length - 1];
    if (last && ws === "collapse") last.text = last.text.replace(/ +$/, "");
  };
  if (ws === "collapse") out[0].text = out[0].text.replace(/^ +/, "");
  trimEnd();
  // The last line break in a block is the browser's placeholder, not a line of its own.
  const last = out[out.length - 1];
  if (last && last.text.endsWith("\n")) last.text = last.text.slice(0, -1);
  trimEnd();
  return mergeRuns(out);
}

function close(ctx: Ctx, ws: Ws): void {
  const open = ctx.open;
  if (!open) return;
  ctx.open = null;
  const runs = finishRuns(open.runs, ws);
  if (!runs.length && open.pending) return;
  const block: HeadingBlock | ParagraphBlock =
    open.type === "heading" ? { type: "heading", level: open.level, runs } : { type: "paragraph", runs };
  if (open.align === "center" || open.align === "right") block.align = open.align;
  ctx.blocks.push(block);
}

function walkChildren(el: Node, style: Style, align: Align | undefined, ws: Ws, ctx: Ctx): void {
  for (const child of Array.from(el.childNodes)) walk(child, style, align, ws, ctx);
}

function walk(node: Node, style: Style, align: Align | undefined, ws: Ws, ctx: Ctx): void {
  if (node.nodeType === Node.TEXT_NODE) {
    addText(ctx, node.nodeValue ?? "", style, align, ws);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return;
  if (tag === "br") {
    addBreak(ctx, style, align);
    return;
  }
  if (tag === "hr") {
    close(ctx, ws);
    ctx.blocks.push({ type: "rule" });
    return;
  }
  if (el.getAttribute("data-block") === "pageBreak") {
    close(ctx, ws);
    ctx.blocks.push({ type: "pageBreak" });
    return;
  }
  if (tag === "ul" || tag === "ol") {
    close(ctx, ws);
    walkList(el, tag === "ol", style, ws, ctx);
    return;
  }
  const nextStyle = styleOf(el, style, tag);
  const nextAlign = alignOf(el, align, tag);
  const nextWs: Ws = tag === "pre" ? "preserve" : ws;
  if (LEAF.has(tag)) {
    close(ctx, ws);
    const heading = /^h[1-6]$/.test(tag);
    const open: Open = {
      type: heading ? "heading" : "paragraph",
      level: heading ? (Math.min(3, Number(tag[1])) as HeadingLevel) : 1,
      align: nextAlign,
      runs: [],
      pending: true
    };
    ctx.open = open;
    walkChildren(el, nextStyle, nextAlign, nextWs, ctx);
    // Still the open block, so it is a line of its own even when empty
    // (<p><br></p>). Otherwise a nested block closed it, and any text after
    // that block sits in a pending paragraph which `close` settles.
    if (ctx.open === open) open.pending = false;
    close(ctx, nextWs);
    return;
  }
  // Inline elements and unknown wrappers are transparent.
  walkChildren(el, nextStyle, nextAlign, nextWs, ctx);
}

function walkList(list: Element, ordered: boolean, style: Style, ws: Ws, ctx: Ctx): void {
  let current: ListBlock = { type: "list", ordered, items: [] };
  const flush = () => {
    if (current.items.length) ctx.blocks.push(current);
    current = { type: "list", ordered, items: [] };
  };
  // Blocks found inside an item: a nested list's items join this list, a
  // rule or page break splits it in two around itself.
  const absorb = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === "list") current.items.push(...block.items);
      else if (block.type === "rule" || block.type === "pageBreak") {
        flush();
        ctx.blocks.push(block);
      }
    }
  };
  for (const child of Array.from(list.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Loose text straight inside a list: kept as an item rather than lost.
      const text = cleanText((child.nodeValue ?? "").replace(/ /g, " ")).trim();
      if (text) current.items.push(mergeRuns([{ text, ...style }]));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    const sub: Ctx = { blocks: [], open: null };
    if (tag === "ul" || tag === "ol") {
      walkList(el, tag === "ol", style, ws, sub);
      absorb(sub.blocks);
      continue;
    }
    // Everything else is an item; <li> is the usual case.
    const open = openParagraph(sub, undefined);
    walkChildren(el, styleOf(el, style, tag), undefined, ws, sub);
    if (sub.open === open) open.pending = false;
    close(sub, ws);
    // The item's own lines come first; a <p> inside an <li> (Google Docs)
    // is a line of the item, not a paragraph of its own.
    let item: Run[] | null = null;
    for (const block of sub.blocks) {
      if (block.type === "paragraph" || block.type === "heading") {
        item = item === null ? block.runs : mergeRuns([...item, { text: "\n" }, ...block.runs]);
      } else {
        if (item !== null) {
          current.items.push(item);
          item = null;
        }
        absorb([block]);
      }
    }
    if (item !== null) current.items.push(item);
  }
  flush();
}

/**
 * Serialises an element's content. `collapseWhitespace` is for markup from
 * outside the sheet, where whitespace between tags means nothing; the sheet
 * itself is `pre-wrap`, so what is there is what the user typed.
 */
export function htmlToContent(
  root: HTMLElement,
  pageSize: PageSize,
  opts: { collapseWhitespace?: boolean } = {}
): Content {
  const ws: Ws = opts.collapseWhitespace ? "collapse" : "preserve";
  const ctx: Ctx = { blocks: [], open: null };
  walkChildren(root, PLAIN, undefined, ws, ctx);
  close(ctx, ws);
  return { version: 1, pageSize, blocks: ctx.blocks };
}

/** Pasted HTML into the model. DOMParser never runs scripts or loads anything. */
export function parsePastedHtml(html: string, pageSize: PageSize): Content {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return htmlToContent(doc.body, pageSize, { collapseWhitespace: true });
}
