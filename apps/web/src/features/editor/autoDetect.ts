import { Util, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import i18next from "i18next";
import { WIDGET_BY_TYPE } from "./constants";
import type { PageSize, WidgetType } from "./types";

/**
 * Client-side field detection.
 *
 * There is no server function for this: neither the cloud functions nor the old
 * frontend detect fields, and the upload pipeline actively flattens any AcroForm
 * before the PDF is stored (`flattenPdf`), so real form fields never survive to
 * this point. Instead we scan the pdf.js text layer for the printed-form idiom of a
 * long underline run, and infer the type from the label sitting nearest to its left.
 */

export interface DetectedField {
  page: number;
  type: WidgetType;
  /** Top-left in PDF points, matching the stored coordinate system. */
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

interface Item {
  text: string;
  x: number;
  /** Baseline y, top-left origin, y down. */
  y: number;
  width: number;
  height: number;
}

/** A run of at least 4 underscores, dots or the box-drawing dash people paste into forms. */
const RUN = /^[_—–.·\s]{4,}$/;
const HAS_UNDERSCORES = /_{4,}/;

const LABEL_RULES: Array<{ test: RegExp; type: WidgetType }> = [
  { test: /\binitial/i, type: "initials" },
  { test: /\b(sign(ature|ed by)?|signer)\b/i, type: "signature" },
  { test: /\bdate\b/i, type: "date" },
  { test: /\b(e-?mail)\b/i, type: "email" },
  { test: /\b(company|organi[sz]ation|firm|employer)\b/i, type: "company" },
  { test: /\b(title|position|role|designation)\b/i, type: "job title" },
  { test: /\b(printed name|full name|name)\b/i, type: "name" }
];

function typeForLabel(label: string): WidgetType {
  for (const rule of LABEL_RULES) if (rule.test.test(label)) return rule.type;
  return "text input";
}

export async function detectFields(doc: PDFDocumentProxy, pages: PageSize[]): Promise<DetectedField[]> {
  const out: DetectedField[] = [];
  for (const info of pages) {
    const page = await doc.getPage(info.number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || typeof raw.str !== "string" || !raw.str.trim()) continue;
      const m = Util.transform(viewport.transform, raw.transform);
      const height = Math.abs(Math.hypot(m[2], m[3])) || raw.height || 10;
      items.push({ text: raw.str, x: m[4], y: m[5], width: raw.width || 0, height });
    }

    for (const item of items) {
      const trimmed = item.text.trim();
      if (!(RUN.test(trimmed) || HAS_UNDERSCORES.test(trimmed))) continue;
      if (item.width < 40) continue;

      // The label is the nearest text on the same baseline, to the left, that is not
      // itself a rule. Fall back to anything directly above the run.
      const label = nearestLabel(items, item);
      const type = typeForLabel(label);
      const spec = WIDGET_BY_TYPE[type];
      const width = Math.min(Math.max(item.width, spec.minWidth), info.width - 20);
      const height = type === "signature" || type === "initials" ? spec.height : Math.max(spec.height, item.height * 1.4);
      const y = Math.max(0, Math.min(item.y - height, info.height - height));
      out.push({
        page: info.number,
        type,
        x: Math.max(0, Math.min(item.x, info.width - width)),
        y,
        width,
        height,
        label: label || i18next.t("editor.autoDetect.fallbackLabel")
      });
    }
  }
  return dedupe(out);
}

function nearestLabel(items: Item[], run: Item): string {
  let best: Item | null = null;
  for (const it of items) {
    if (it === run) continue;
    const sameLine = Math.abs(it.y - run.y) <= Math.max(4, run.height * 0.6);
    const toLeft = it.x + it.width <= run.x + 2;
    if (!sameLine || !toLeft) continue;
    if (RUN.test(it.text.trim())) continue;
    if (!best || it.x > best.x) best = it;
  }
  if (best) return best.text.trim();

  for (const it of items) {
    if (it === run || RUN.test(it.text.trim())) continue;
    const below = run.y - it.y;
    if (below > 2 && below < run.height * 2.4 && Math.abs(it.x - run.x) < 40) return it.text.trim();
  }
  return "";
}

/** Runs are often split into several text items; merge anything that overlaps. */
function dedupe(fields: DetectedField[]): DetectedField[] {
  const out: DetectedField[] = [];
  for (const f of fields.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.page === f.page &&
      Math.abs(prev.y - f.y) < 4 &&
      f.x <= prev.x + prev.width + 6 &&
      prev.type === f.type
    ) {
      prev.width = Math.max(prev.width, f.x + f.width - prev.x);
      continue;
    }
    out.push({ ...f });
  }
  return out;
}
