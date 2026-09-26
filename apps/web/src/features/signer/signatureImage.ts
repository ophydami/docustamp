/**
 * Canvas helpers for producing signature images.
 *
 * Everything returns a `data:image/png;base64,...` URL, because that is what
 * `options.response` / `SignUrl` hold for image-bearing widgets (§7.3) and what
 * the embed step feeds to pdf-lib.
 */

import i18next from "i18next";

/** The cursive face used for typed signatures. Loaded once, lazily. */
export const CURSIVE_FONT = "Caveat";
const CURSIVE_STACK = `"${CURSIVE_FONT}", "Segoe Script", "Bradley Hand", cursive`;
const FONT_HREF = "https://fonts.googleapis.com/css2?family=Caveat:wght@400;600&display=swap";

let fontRequested = false;

/** Injects the Google Fonts link for the typed-signature face exactly once. */
export function ensureCursiveFont(): void {
  if (fontRequested || typeof document === "undefined") return;
  fontRequested = true;
  if (document.querySelector(`link[data-signer-font="${CURSIVE_FONT}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  link.dataset.signerFont = CURSIVE_FONT;
  document.head.appendChild(link);
}

/** Resolves once the cursive face is actually usable, or after a short timeout. */
export async function cursiveFontReady(): Promise<void> {
  ensureCursiveFont();
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  await Promise.race([
    fonts.load(`48px ${CURSIVE_STACK}`).then(() => undefined),
    new Promise<void>((r) => setTimeout(r, 1200))
  ]);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Renders `text` in the cursive face onto a transparent canvas sized to the
 * glyphs, at 2x for retina. Returns a PNG data URL.
 */
export async function typedSignatureToPng(text: string, color = "#1c1b18", height = 120): Promise<string> {
  await cursiveFontReady();
  const dpr = 2;
  const fontSize = Math.round(height * 0.62);
  const measure = makeCanvas(10, 10).getContext("2d");
  if (!measure) return "";
  measure.font = `${fontSize}px ${CURSIVE_STACK}`;
  const width = Math.max(40, Math.ceil(measure.measureText(text || " ").width) + 24);

  const canvas = makeCanvas(width * dpr, height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(dpr, dpr);
  ctx.font = `${fontSize}px ${CURSIVE_STACK}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2 + fontSize * 0.04);
  return trimTransparent(canvas.toDataURL("image/png"), 8);
}

/**
 * Crops fully transparent (or near-white) margins off a PNG, the way the old
 * app trims uploaded signature images so they sit tight inside the widget box.
 */
export async function trimTransparent(dataUrl: string, pad = 4): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = makeCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return dataUrl; // tainted canvas, e.g. a cross-origin URL
  }
  const { width, height } = canvas;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data.data[i + 3];
      if (a < 24) continue;
      // Treat near-white as background so scanned/photographed uploads trim too.
      const bright = data.data[i] > 242 && data.data[i + 1] > 242 && data.data[i + 2] > 242;
      if (bright) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0 || bottom < 0) return dataUrl; // nothing drawn

  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);

  const out = makeCanvas(right - left + 1, bottom - top + 1);
  const octx = out.getContext("2d");
  if (!octx) return dataUrl;
  octx.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Makes a white (or otherwise light) background transparent on an uploaded image. */
export async function whiteToTransparent(dataUrl: string, threshold = 236): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = makeCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return dataUrl;
  }
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] >= threshold && px[i + 1] >= threshold && px[i + 2] >= threshold) px[i + 3] = 0;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(i18next.t("signer.errors.couldNotReadImage")));
    img.src = src;
  });
}

export interface FittedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fits an image of `natural` size inside `box` preserving aspect ratio and
 * centring it, which is how signature PNGs are placed inside their widget.
 * Coordinates are relative to the box's top-left.
 */
export function fitContain(natural: { width: number; height: number }, box: { w: number; h: number }): FittedBox {
  if (!natural.width || !natural.height) return { x: 0, y: 0, width: box.w, height: box.h };
  const ratio = Math.min(box.w / natural.width, box.h / natural.height);
  const width = natural.width * ratio;
  const height = natural.height * ratio;
  return { x: (box.w - width) / 2, y: (box.h - height) / 2, width, height };
}

/** Reads a File as a data URL. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(i18next.t("signer.errors.couldNotReadFile")));
    fr.readAsDataURL(file);
  });
}

/** Fetch any URL (including a presigned one) as a data URL, mirroring `getBase64FromUrl`. */
export async function urlToDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(i18next.t("signer.errors.couldNotFetch", { url }));
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(i18next.t("signer.errors.couldNotReadFile")));
    fr.readAsDataURL(blob);
  });
}

/** Strips the `data:image/png;base64,` prefix the way the server expects. */
export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Derives sensible initials from a full name. */
export function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
