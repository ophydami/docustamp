/**
 * Stamping the signer's answers into the PDF.
 *
 * `signPdf` does NOT render widgets: the client flattens and stamps the bytes
 * itself and posts the finished PDF (docs/BACKEND_API.md §6.4, §11.40). This
 * module is the whole of that step, and it reproduces the old client's
 * coordinate math exactly, fudge factors included:
 *
 *  - page size is `cropBox.height + cropBox.y` on an upright page, never
 *    `page.getHeight()` (a Letter page is 799.92, not 792) - get this wrong and
 *    every field drifts. The one rule lives in @/lib/pageBox;
 *  - stored `xPosition`/`yPosition` are PDF points from the page TOP-left, so
 *    `pdfY = pageHeight - (yTop + boxHeight)`;
 *  - text-ish widgets are nudged `yPosition + 6` then drawn at `- 4`, i.e. +2 net;
 *  - checkbox boxes sit at `+2`, radio circles at `(+2, +3)`;
 *  - multi-line text advances a flat 18 points per line whatever the font size;
 *  - image answers are letterboxed onto a canvas of exactly the widget box, so
 *    the drawn rect is always the full box and the aspect ratio is preserved by
 *    transparent padding.
 *
 * pdf-lib is loaded lazily (its own chunk) the first time a signer finishes.
 */

import i18next from "i18next";
import { pageBoxOfPdfLib } from "@/lib/pageBox";
import type { SignerField } from "./types";
import { fieldDatePattern, formatToday, IMAGE_TYPES, pdfFontColor } from "./widgets";
import { loadImage } from "./signatureImage";

/* ------------------------------------------------------------------ *
 * Minimal structural view of the parts of pdf-lib we use
 * ------------------------------------------------------------------ */

interface PdfColor {
  readonly __brand?: "color";
}
/**
 * A real pdf-lib `Rotation` (`degrees(n)` / `radians(n)`). A bare `{ angle }`
 * object is NOT one: pdf-lib throws `Invalid rotation` on it, and in
 * `drawImage` that throw lands after the XObject is registered, so the image
 * ends up in the page resources but never on the page.
 */
interface PdfRotation {
  readonly type: "degrees" | "radians";
  angle: number;
}
interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number;
}
interface PdfImage {
  readonly __brand?: "image";
}
interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PdfPage {
  getCropBox(): PdfBox;
  getRotation(): PdfRotation;
  getWidth(): number;
  getHeight(): number;
  drawImage(image: PdfImage, opts: { x: number; y: number; width: number; height: number; rotate?: PdfRotation }): void;
  drawText(
    text: string,
    opts: { x: number; y: number; size: number; font: PdfFont; color: PdfColor; rotate?: PdfRotation }
  ): void;
  drawRectangle(opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    borderColor?: PdfColor;
    borderWidth?: number;
    color?: PdfColor;
    rotate?: PdfRotation;
  }): void;
  drawCircle(opts: {
    x: number;
    y: number;
    size: number;
    borderColor?: PdfColor;
    borderWidth?: number;
    color?: PdfColor;
  }): void;
  drawLine(opts: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    thickness?: number;
    color?: PdfColor;
  }): void;
}
interface PdfDocument {
  getPages(): PdfPage[];
  embedFont(name: string): Promise<PdfFont>;
  embedPng(bytes: ArrayBuffer | Uint8Array | string): Promise<PdfImage>;
  saveAsBase64(opts: { useObjectStreams: boolean }): Promise<string>;
}
interface PdfLib {
  PDFDocument: {
    load(bytes: ArrayBuffer | Uint8Array, opts?: { ignoreEncryption?: boolean; updateMetadata?: boolean }): Promise<PdfDocument>;
  };
  StandardFonts: Record<string, string>;
  rgb(r: number, g: number, b: number): PdfColor;
  degrees(angle: number): PdfRotation;
}

/** Thrown when pdf-lib is not on the page. Surfaced to the signer verbatim. */
export class PdfLibMissingError extends Error {
  constructor() {
    super(i18next.t("signer.errors.pdfLibMissing"));
    this.name = "PdfLibMissingError";
  }
}

let pdfLib: PdfLib | null = null;

/**
 * pdf-lib is a hard requirement for signing but is not yet in package.json.
 * The specifier is held in a variable so the bundler leaves the import alone
 * and the rest of the app keeps building; the signer surfaces a clear error
 * instead of a blank screen if it really is missing.
 */
export async function loadPdfLib(): Promise<PdfLib> {
  if (pdfLib) return pdfLib;
  try {
    const mod = (await import("pdf-lib")) as unknown as PdfLib;
    if (!mod?.PDFDocument) throw new PdfLibMissingError();
    pdfLib = mod;
    return mod;
  } catch {
    throw new PdfLibMissingError();
  }
}

export function isPdfLibMissing(err: unknown): boolean {
  return err instanceof PdfLibMissingError;
}

/* ------------------------------------------------------------------ *
 * Coordinate conversion (§7.4)
 * ------------------------------------------------------------------ */

export interface PageSize {
  width: number;
  height: number;
}

/**
 * The exact inverse of `compensateRotation`: a top-left anchored point in PDF
 * points becomes a bottom-left anchored point, then the page rotation matrix is
 * applied. `boxHeight` is the height of the thing being placed (for text, the
 * font size; for a box, the box height).
 */
export function topLeftToPdf(
  pageRotation: number,
  x: number,
  yFromTop: number,
  boxHeight: number,
  size: PageSize
): { x: number; y: number } {
  const angle = ((pageRotation % 360) + 360) % 360;
  const rads = (angle * Math.PI) / 180;
  const bx = x;
  // Rotated pages measure the flip against the page WIDTH, not the height.
  const by = angle === 90 || angle === 270 ? size.width - (yFromTop + boxHeight) : size.height - (yFromTop + boxHeight);
  const cos = Math.cos(rads);
  const sin = Math.sin(rads);
  if (angle === 90) return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos };
  if (angle === 180) return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos + size.height };
  if (angle === 270) return { x: bx * cos - by * sin, y: bx * sin + by * cos + size.height };
  return { x: bx, y: by };
}

/**
 * The page box to stamp against, in pdf-lib user space (never rotated).
 *
 * The rule lives in @/lib/pageBox and is shared with the viewer, the editor and
 * the server (cloud/lib/pageBox.js): CropBox over MediaBox, and the CropBox y
 * origin folded into the height, but only on an upright page. This used to add
 * the offset unconditionally, which moved every field on a rotated page with a
 * cropped box, because `topLeftToPdf` measures the flip of such a page against
 * the width.
 */
export function pageSizeOf(page: PdfPage): PageSize {
  const box = pageBoxOfPdfLib(page);
  return { width: box.stampWidth, height: box.stampHeight };
}

/* ------------------------------------------------------------------ *
 * Image preparation
 * ------------------------------------------------------------------ */

/**
 * Letterboxes an image onto a transparent canvas of exactly `w` x `h` PDF
 * points (rendered at 2x device pixels), which is how signature PNGs are fitted
 * to their widget. Always returns PNG.
 */
export async function renderToWidgetBox(dataUrl: string, w: number, h: number): Promise<string> {
  const img = await loadImage(dataUrl);
  const ratio = Math.min(w / img.naturalWidth, h / img.naturalHeight, 1);
  const drawW = img.naturalWidth * ratio;
  const drawH = img.naturalHeight * ratio;
  const px = Math.min((window.devicePixelRatio || 1) * 2, 4);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * px));
  canvas.height = Math.max(1, Math.ceil(h * px));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.scale(px, px);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
  return canvas.toDataURL("image/png");
}

/** Stretches a signature to the fixed 300x120 the completion certificate wants. */
export async function certificateSignature(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = 300;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, 300, 120);
  return canvas.toDataURL("image/png", 1.0);
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------------ *
 * Text layout
 * ------------------------------------------------------------------ */

/** Greedy word wrap, with character-level splitting for words wider than the box. */
export function wrapText(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    if (font.widthOfTextAtSize(paragraph, size) <= maxWidth) {
      out.push(paragraph);
      continue;
    }
    let line = "";
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
      let chunk = "";
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
  return out.length ? out : [""];
}

/** The standard 14 fonts are WinAnsi only; drop anything they cannot encode. */
function winAnsiSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\u0000-\u00ff]/g, "");
}

/* ------------------------------------------------------------------ *
 * The embed pass
 * ------------------------------------------------------------------ */

export interface EmbedOptions {
  /** Raw bytes of the PDF to stamp (the current `SignedUrl`). */
  pdfBytes: ArrayBuffer;
  /** Only the fields to stamp, i.e. this signer's answered widgets. */
  fields: SignerField[];
  /** The document's date format label, for `response === "today"`. */
  dateFormat: string;
}

/** Returns base64 of the stamped PDF with no `data:` prefix, ready for `signPdf`. */
export async function embedWidgetsToDoc(opts: EmbedOptions): Promise<string> {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(opts.pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const pages = doc.getPages();

  // Prepare every image answer up front so the draw loop stays synchronous-ish.
  const imageByKey = new Map<number, PdfImage>();
  for (const f of opts.fields) {
    if (!IMAGE_TYPES.has(f.type)) continue;
    if (typeof f.response !== "string" || !f.response) continue;
    try {
      const boxed = await renderToWidgetBox(f.response, f.w, f.h);
      imageByKey.set(f.key, await doc.embedPng(await dataUrlToBytes(boxed)));
    } catch (err) {
      // A single unreadable image must not sink the whole signature.
      console.warn("[pdfEmbed] could not embed image for widget", f.key, err);
    }
  }

  for (const f of opts.fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const size = pageSizeOf(page);
    const rotation = page.getRotation();
    const angle = rotation.angle ?? 0;
    const [r, g, b] = pdfFontColor(f.fontColor);
    const color = lib.rgb(r, g, b);
    const fontSize = f.fontSize || 12;

    try {
      if (IMAGE_TYPES.has(f.type)) {
        const img = imageByKey.get(f.key);
        if (!img) continue;
        drawRotatedImage(lib, page, img, f, size, angle);
        continue;
      }

      if (f.type === "checkbox") {
        drawCheckboxGroup(lib, page, f, size, angle, font, fontSize, color);
        continue;
      }

      if (f.type === "radio button") {
        drawRadioGroup(lib, page, f, size, angle, font, fontSize, color);
        continue;
      }

      const text = textContentOf(f, opts.dateFormat);
      if (!text) continue;

      if (f.type === "cells") {
        drawCells(lib, page, f, text, size, angle, font, fontSize, color);
        continue;
      }

      // dropdown and every text-ish widget draw as plain text.
      const isTextType = TEXT_TYPES.has(f.type);
      const yTop = (isTextType ? f.y + 6 : f.y) - 4;
      const lines = wrapText(winAnsiSafe(text), font, fontSize, f.w);
      let y = yTop;
      for (const line of lines) {
        const p = topLeftToPdf(angle, f.x, y, fontSize, size);
        page.drawText(line, { x: p.x, y: p.y, size: fontSize, font, color, rotate: rotation });
        y += 18; // flat line height, matching the old embed
      }
    } catch (err) {
      // Skip an individual widget rather than fail the whole document, but never
      // silently: a swallowed pdf-lib error here once shipped unsigned PDFs.
      console.warn("[pdfEmbed] could not draw widget", f.type, f.key, err);
    }
  }

  return doc.saveAsBase64({ useObjectStreams: false });
}

const TEXT_TYPES = new Set<string>(["text", "text input", "cells", "name", "company", "job title", "date", "email"]);

function textContentOf(f: SignerField, docFormat: string): string {
  const raw = f.response ?? f.defaultValue;
  if (raw === undefined || raw === null) return "";
  if (Array.isArray(raw)) return "";
  const s = String(raw);
  if (f.type === "date" && s === "today") return formatToday(fieldDatePattern(f, docFormat));
  return s;
}

function drawRotatedImage(
  lib: PdfLib,
  page: PdfPage,
  img: PdfImage,
  f: SignerField,
  size: PageSize,
  angle: number
) {
  const widgetRotation = f.rotation || 0;
  const swapped = widgetRotation === 90 || widgetRotation === 270;
  const width = swapped ? f.h : f.w;
  const height = swapped ? f.w : f.h;
  const p = topLeftToPdf(angle, f.x, f.y, height, size);
  const opt: { x: number; y: number; width: number; height: number; rotate?: PdfRotation } = {
    x: p.x,
    y: p.y,
    width,
    height,
    rotate: lib.degrees(angle)
  };
  if (widgetRotation) {
    opt.rotate = lib.degrees(angle - widgetRotation);
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

function selectedIndices(f: SignerField): number[] {
  if (Array.isArray(f.response)) return f.response;
  if (Array.isArray(f.defaultValue)) return f.defaultValue;
  return [];
}

function drawCheckboxGroup(
  lib: PdfLib,
  page: PdfPage,
  f: SignerField,
  size: PageSize,
  angle: number,
  font: PdfFont,
  fontSize: number,
  color: PdfColor
) {
  const horizontal = f.layout === "horizontal";
  const boxSize = fontSize - 1;
  const gapFromLeft = fontSize + 3.4;
  const verticalGap = fontSize + 5.5;
  const chosen = new Set(selectedIndices(f));
  const values = f.values.length ? f.values : [""];
  let x = f.x;
  let y = f.y + 2;
  let horizontalGap = 0;

  values.forEach((label, i) => {
    if (i > 0) {
      if (horizontal) x += horizontalGap;
      else y += verticalGap;
    }
    {
      const box = topLeftToPdf(angle, x, y, boxSize, size);
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: boxSize,
        height: boxSize,
        borderColor: lib.rgb(0.25, 0.24, 0.22),
        borderWidth: 0.8,
        rotate: lib.degrees(angle)
      });
      if (chosen.has(i)) {
        // A tick, drawn as two strokes inside the box.
        page.drawLine({
          start: { x: box.x + boxSize * 0.2, y: box.y + boxSize * 0.5 },
          end: { x: box.x + boxSize * 0.42, y: box.y + boxSize * 0.24 },
          thickness: 1.1,
          color
        });
        page.drawLine({
          start: { x: box.x + boxSize * 0.42, y: box.y + boxSize * 0.24 },
          end: { x: box.x + boxSize * 0.82, y: box.y + boxSize * 0.78 },
          thickness: 1.1,
          color
        });
      }
    }
    if (!f.hideLabel && label) {
      // label position mirrors the old embed: gap to the right, 3pt up
      const lp = topLeftToPdf(angle, x + gapFromLeft, y - 3, fontSize, size);
      page.drawText(winAnsiSafe(label), { x: lp.x, y: lp.y, size: fontSize, font, color, rotate: lib.degrees(angle) });
    }
    const textWidth = label && !f.hideLabel ? font.widthOfTextAtSize(winAnsiSafe(label), fontSize) : 0;
    horizontalGap = boxSize + (textWidth ? gapFromLeft + textWidth : gapFromLeft - 5);
  });
}

function drawRadioGroup(
  lib: PdfLib,
  page: PdfPage,
  f: SignerField,
  size: PageSize,
  angle: number,
  font: PdfFont,
  fontSize: number,
  color: PdfColor
) {
  const horizontal = f.layout === "horizontal";
  const gapFromLeft = fontSize + 3;
  const radioSize = fontSize;
  const verticalGap = fontSize + 5;
  const chosen = typeof f.response === "string" ? f.response : typeof f.defaultValue === "string" ? f.defaultValue : "";
  const values = f.values.length ? f.values : [""];
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
      borderColor: lib.rgb(0.25, 0.24, 0.22),
      borderWidth: 0.8
    });
    if (label && label.trim() === chosen.trim()) {
      page.drawCircle({ x: cx, y: cy, size: radioSize / 4, color });
    }
    if (label && !f.hideLabel) {
      const lp = topLeftToPdf(angle, x + gapFromLeft, y - 2, fontSize, size);
      page.drawText(winAnsiSafe(label), { x: lp.x, y: lp.y, size: fontSize, font, color, rotate: lib.degrees(angle) });
    }
    const textWidth = label && !f.hideLabel ? font.widthOfTextAtSize(winAnsiSafe(label), fontSize) : 0;
    horizontalGap = radioSize + (textWidth ? gapFromLeft + textWidth : gapFromLeft - 6);
  });
}

function drawCells(
  lib: PdfLib,
  page: PdfPage,
  f: SignerField,
  text: string,
  size: PageSize,
  angle: number,
  font: PdfFont,
  fontSize: number,
  color: PdfColor
) {
  const safe = winAnsiSafe(text);
  const cellCount = f.cellCount || safe.length || 1;
  const charWidth = f.w / cellCount;
  const y = f.y + 6 - 4;
  for (let i = 0; i < cellCount; i++) {
    const ch = safe[i];
    if (!ch) continue;
    const charX = f.x + charWidth * i + (charWidth - font.widthOfTextAtSize(ch, fontSize)) / 2;
    const p = topLeftToPdf(angle, charX, y, fontSize, size);
    page.drawText(ch, { x: p.x, y: p.y, size: fontSize, font, color, rotate: lib.degrees(angle) });
  }
}

/** Fetches the working PDF as bytes. `convertPdfArrayBuffer` in the old client. */
export async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(i18next.t("signer.errors.expiredLink"));
  return res.arrayBuffer();
}
