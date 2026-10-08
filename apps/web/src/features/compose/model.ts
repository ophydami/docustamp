/**
 * The content model for written documents ("Write it here"). It is shared
 * with the server, which validates the same shape in
 * `apps/server/cloud/lib/textDocument.js`; docs/TEXT_DOCUMENTS.md is the
 * contract between the two and this file is the TypeScript reference.
 */

export type PageSize = "letter" | "a4";
export type Align = "left" | "center" | "right";
export type HeadingLevel = 1 | 2 | 3;

export interface Run {
  /** May contain "\n": a soft line break inside the block. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface HeadingBlock {
  type: "heading";
  level: HeadingLevel;
  runs: Run[];
  align?: Align;
}

export interface ParagraphBlock {
  type: "paragraph";
  /** An empty array is a blank line. */
  runs: Run[];
  align?: Align;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  /** One Run[] per item. */
  items: Run[][];
}

export interface RuleBlock {
  type: "rule";
}

export interface PageBreakBlock {
  type: "pageBreak";
}

export type Block = HeadingBlock | ParagraphBlock | ListBlock | RuleBlock | PageBreakBlock;

export interface Content {
  version: 1;
  /** Missing on older rows means "letter". */
  pageSize: PageSize;
  blocks: Block[];
}

export const CONTENT_MAX_BLOCKS = 600;
export const CONTENT_MAX_CHARS = 120_000;
export const LIST_MAX_ITEMS = 200;
/** The title is the document `Name`, which has the same cap everywhere else. */
export const TITLE_MAX_CHARS = 250;
export const PAGE_SIZES: readonly PageSize[] = ["letter", "a4"];

/**
 * What the "Signing block" button inserts. Kept in English and not in the
 * locale files on purpose: the field editor's auto-detect looks for exactly
 * these labels to turn them into fields.
 */
export const SIGNING_BLOCK_LINES: readonly string[] = [
  "Signature: ____________________",
  "Name: ____________________",
  "Date: ____________________"
];

export function isPageSize(value: unknown): value is PageSize {
  return value === "letter" || value === "a4";
}

/** One empty paragraph, so the editor has a line to put the caret in. */
export function emptyContent(pageSize: PageSize = "letter"): Content {
  return { version: 1, pageSize, blocks: [{ type: "paragraph", runs: [] }] };
}

/**
 * Tolerant shape check for a value read from the server: the version and the
 * blocks array must be there, each block is only checked by `normaliseContent`.
 */
export function isContent(value: unknown): value is Content {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.blocks)) return false;
  if (v.pageSize !== undefined && !isPageSize(v.pageSize)) return false;
  return true;
}

function runsText(runs: Run[]): string {
  let out = "";
  for (const run of runs) out += run.text;
  return out;
}

/** True when any run holds something other than whitespace. */
export function contentHasText(content: Content): boolean {
  for (const block of content.blocks) {
    if (block.type === "list") {
      if (block.items.some((item) => runsText(item).trim() !== "")) return true;
    } else if (block.type === "heading" || block.type === "paragraph") {
      if (runsText(block.runs).trim() !== "") return true;
    }
  }
  return false;
}

/** Plain text, one block per line, list items prefixed with "- " or "1. ". */
export function contentText(content: Content): string {
  const lines: string[] = [];
  for (const block of content.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        lines.push(runsText(block.runs));
        break;
      case "list":
        block.items.forEach((item, i) => {
          lines.push(`${block.ordered ? `${i + 1}. ` : "- "}${runsText(item)}`);
        });
        break;
      case "rule":
      case "pageBreak":
        lines.push("");
        break;
    }
  }
  return lines.join("\n");
}

/** Sum of all run text lengths, the number `CONTENT_MAX_CHARS` caps. */
export function contentCharCount(content: Content): number {
  let n = 0;
  for (const block of content.blocks) {
    if (block.type === "list") {
      for (const item of block.items) for (const run of item) n += run.text.length;
    } else if (block.type === "heading" || block.type === "paragraph") {
      for (const run of block.runs) n += run.text.length;
    }
  }
  return n;
}

export function withPageSize(content: Content, pageSize: PageSize): Content {
  return content.pageSize === pageSize ? content : { ...content, pageSize };
}

/** Everything in C0 and DEL except "\n" and "\t"; the tab is expanded instead. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Tabs become four spaces, control characters other than "\n" go ("\r\n" ends up as "\n"). */
export function cleanText(text: string): string {
  return text.replace(/\t/g, "    ").replace(CONTROL_CHARS, "");
}

function sameStyle(a: Run, b: Run): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

/** Drops empty runs and joins neighbours that share the same styling. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, run)) {
      prev.text += run.text;
      continue;
    }
    const next: Run = { text: run.text };
    if (run.bold) next.bold = true;
    if (run.italic) next.italic = true;
    if (run.underline) next.underline = true;
    out.push(next);
  }
  return out;
}

function normaliseAlign(value: unknown): Align | undefined {
  // Left is the default, so it is left out rather than written.
  return value === "center" || value === "right" ? value : undefined;
}

function normaliseLevel(value: unknown): HeadingLevel {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return (n < 1 ? 1 : n > 3 ? 3 : n) as HeadingLevel;
}

/** Cleans a runs array from untrusted input, spending from the shared character budget. */
function normaliseRuns(input: unknown, budget: { chars: number }): Run[] {
  const runs: Run[] = [];
  if (!Array.isArray(input)) return runs;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== "string") continue;
    let text = cleanText(r.text);
    if (text.length > budget.chars) text = text.slice(0, budget.chars);
    if (!text) continue;
    budget.chars -= text.length;
    runs.push({ text, bold: r.bold === true, italic: r.italic === true, underline: r.underline === true });
  }
  return mergeRuns(runs);
}

/**
 * The contract's normalisation rules, applied client-side: unknown block
 * types and keys are dropped, text is cleaned, `align` and `level` are
 * clamped, runs are merged. Where the server refuses over a limit, this
 * truncates instead (extra blocks, items and characters are cut), so a value
 * that comes back from here always passes the server's check.
 */
export function normaliseContent(input: unknown): Content {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pageSize = isPageSize(src.pageSize) ? src.pageSize : "letter";
  const budget = { chars: CONTENT_MAX_CHARS };
  const blocks: Block[] = [];
  const rawBlocks = Array.isArray(src.blocks) ? src.blocks : [];
  for (const raw of rawBlocks) {
    if (blocks.length >= CONTENT_MAX_BLOCKS) break;
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "heading": {
        const block: HeadingBlock = { type: "heading", level: normaliseLevel(b.level), runs: normaliseRuns(b.runs, budget) };
        const align = normaliseAlign(b.align);
        if (align) block.align = align;
        blocks.push(block);
        break;
      }
      case "paragraph": {
        const block: ParagraphBlock = { type: "paragraph", runs: normaliseRuns(b.runs, budget) };
        const align = normaliseAlign(b.align);
        if (align) block.align = align;
        blocks.push(block);
        break;
      }
      case "list": {
        const items: Run[][] = [];
        if (Array.isArray(b.items)) {
          for (const item of b.items) {
            if (items.length >= LIST_MAX_ITEMS) break;
            if (Array.isArray(item)) items.push(normaliseRuns(item, budget));
          }
        }
        blocks.push({ type: "list", ordered: b.ordered === true, items });
        break;
      }
      case "rule":
        blocks.push({ type: "rule" });
        break;
      case "pageBreak":
        blocks.push({ type: "pageBreak" });
        break;
      default:
        break;
    }
  }
  return { version: 1, pageSize, blocks };
}
