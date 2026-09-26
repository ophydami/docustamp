/** Canvas helpers for the signature dialog. */

import i18next from "i18next";

export function dataUrlToFile(dataUrl: string, filename: string): File {
  const [head, body] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(head)?.[1] ?? "image/png";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.split("/").pop() ?? "png";
  return new File([bytes], `${filename}.${ext}`, { type: mime });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

/**
 * Crop transparent and near-white margins, leaving a small padding.
 * Returns the original data URL when the image is effectively blank.
 */
export async function trimDataUrl(dataUrl: string, pad = 8): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 24) continue;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma > 244) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0 || bottom < 0) return dataUrl;

  const x0 = Math.max(0, left - pad);
  const y0 = Math.max(0, top - pad);
  const w = Math.min(width, right + pad) - x0 + 1;
  const h = Math.min(height, bottom + pad) - y0 + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return dataUrl;
  octx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

let fontLinked = false;

/** Add the Caveat webfont once and wait for it to be usable on a canvas. */
export async function ensureScriptFont(): Promise<void> {
  if (!fontLinked) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap";
    document.head.appendChild(link);
    fontLinked = true;
  }
  try {
    await document.fonts.load("600 72px Caveat");
    await document.fonts.ready;
  } catch {
    // Fall back to the generic cursive stack below.
  }
}

/** Render typed text as a transparent PNG at 2x device pixels. */
export async function typedSignatureDataUrl(text: string, color: string, maxWidth = 520): Promise<string> {
  await ensureScriptFont();
  const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  const fontSize = 72;
  const font = `600 ${fontSize}px "Caveat", "Segoe Script", cursive`;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error(i18next.t("settings.errors.canvasUnavailable"));
  measure.font = font;
  const m = measure.measureText(text);
  const width = Math.min(maxWidth, Math.ceil(m.width) + 24);
  const height = Math.ceil(fontSize * 1.6);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(i18next.t("settings.errors.canvasUnavailable"));
  ctx.scale(ratio, ratio);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const scale = Math.min(1, (width - 24) / Math.max(1, m.width));
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.fillText(text, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Read a File as a data URL. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(i18next.t("settings.errors.couldNotReadFile")));
    reader.readAsDataURL(file);
  });
}
