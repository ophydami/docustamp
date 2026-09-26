/**
 * The upload pipeline for step 1.
 *
 * Word files go through the custom /docxtopdf route, encrypted PDFs through
 * /decryptpdf (both are plain Express routes next to the Parse mount, §5), the
 * result is uploaded with Parse.File and then token-signed with `fileupload`
 * so the url survives the local file adapter's JWT gate (§8.2, §8.3).
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import i18next from "i18next";
import { Parse, cloud } from "@/lib/parse";
import { docxToPdfBytes, decryptPdfBytes } from "@/lib/customRoutes";
import { num } from "@/lib/format";
import type { UploadedFile } from "./types";

/** Client cap, matching the old app. The server's own limit is 100 MB. */
export const MAX_FILE_MB = 80;

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".doc"];

export class PasswordRequiredError extends Error {
  constructor() {
    super(i18next.t("send.upload.passwordProtected"));
    this.name = "PasswordRequiredError";
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super(i18next.t("send.upload.wrongPassword"));
    this.name = "WrongPasswordError";
  }
}

export type UploadStage =
  | { kind: "idle" }
  | { kind: "reading"; fileName: string }
  | { kind: "converting"; fileName: string }
  | { kind: "decrypting"; fileName: string }
  | { kind: "uploading"; fileName: string; percent: number }
  | { kind: "done" };

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function titleFromFilename(name: string): string {
  return (
    name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 250) ||
    i18next.t("send.upload.untitledDocument")
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return i18next.t("send.units.bytes", { value: num(n) });
  if (n < 1024 * 1024) return i18next.t("send.units.kilobytes", { value: num(Math.round(n / 1024)) });
  return i18next.t("send.units.megabytes", {
    value: num(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  });
}

/** Random, collision-safe upload name. The original name goes on the document. */
function uploadName(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s}.pdf`;
}

/**
 * Count pages, and detect encryption. pdf.js transfers the buffer it is given,
 * so always hand it a copy.
 */
export async function probePdf(bytes: Uint8Array, password?: string): Promise<number> {
  const task = pdfjs.getDocument({ data: bytes.slice(), password });
  try {
    const doc = await task.promise;
    return doc.numPages;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") throw new PasswordRequiredError();
    throw err;
  } finally {
    task.destroy().catch(() => undefined);
  }
}

/** POST /docxtopdf (see @/lib/customRoutes), then fetch the produced PDF. */
export async function convertDocx(file: File): Promise<Uint8Array> {
  return docxToPdfBytes(file, {
    convertFailed: i18next.t("send.upload.conversionFailed"),
    downloadFailed: i18next.t("send.upload.convertedDownloadFailed")
  });
}

/** POST /decryptpdf (see @/lib/customRoutes) with the password the user typed. */
export async function decryptPdf(file: Blob, fileName: string, password: string): Promise<Uint8Array> {
  return decryptPdfBytes(file, fileName, password, {
    wrongPassword: () => new WrongPasswordError(),
    failed: (message) => new Error(message || i18next.t("send.upload.unlockFailed"))
  });
}

/**
 * Upload the bytes and return a url that will still resolve when fetched.
 * Local storage rejects /files/ GETs without a `?token=` JWT, so sign it.
 */
export function toPdfBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

export async function uploadPdf(bytes: Uint8Array, onProgress?: (percent: number) => void): Promise<string> {
  const file = new Parse.File(uploadName(), toPdfBlob(bytes), "application/pdf");
  const saved = await file.save({
    progress: (value: number | null, loaded: number, total: number) => {
      if (value === null || !total) return;
      onProgress?.(Math.min(99, Math.round((loaded / total) * 100)));
    }
  });
  const url = (saved ?? file).url();
  if (!url) throw new Error(i18next.t("send.upload.uploadFailed"));
  if (!url.includes("/files/")) return url;
  const signed = await cloud<{ url?: string }>("fileupload", { url });
  return signed?.url || url;
}

/**
 * Full pipeline for one picked file. `askPassword` is called (possibly twice,
 * after a wrong first answer) when the PDF turns out to be encrypted.
 */
export async function prepareFile(
  input: File,
  opts: {
    onStage: (s: UploadStage) => void;
    askPassword: (fileName: string, retry: boolean) => Promise<string | null>;
  }
): Promise<UploadedFile | null> {
  const ext = extensionOf(input.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new Error(i18next.t("send.upload.unsupportedType"));
  }
  if (input.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(i18next.t("send.upload.tooLarge", { size: num(MAX_FILE_MB) }));
  }

  let converted = false;
  let decrypted = false;
  let bytes: Uint8Array;

  if (ext === ".pdf") {
    opts.onStage({ kind: "reading", fileName: input.name });
    bytes = new Uint8Array(await input.arrayBuffer());
  } else {
    opts.onStage({ kind: "converting", fileName: input.name });
    bytes = await convertDocx(input);
    converted = true;
  }

  let pageCount = 0;
  try {
    pageCount = await probePdf(bytes);
  } catch (err) {
    if (!(err instanceof PasswordRequiredError)) throw err;
    let retry = false;
    for (;;) {
      const password = await opts.askPassword(input.name, retry);
      if (password === null) return null;
      opts.onStage({ kind: "decrypting", fileName: input.name });
      try {
        bytes = await decryptPdf(toPdfBlob(bytes), input.name, password);
        pageCount = await probePdf(bytes);
        decrypted = true;
        break;
      } catch (e) {
        if (e instanceof WrongPasswordError || e instanceof PasswordRequiredError) {
          retry = true;
          continue;
        }
        throw e;
      }
    }
  }

  opts.onStage({ kind: "uploading", fileName: input.name, percent: 0 });
  const url = await uploadPdf(bytes, (percent) => opts.onStage({ kind: "uploading", fileName: input.name, percent }));
  opts.onStage({ kind: "done" });

  return {
    url,
    fileName: input.name,
    title: titleFromFilename(input.name),
    bytes: bytes.byteLength,
    pageCount,
    data: bytes,
    decrypted,
    converted
  };
}
