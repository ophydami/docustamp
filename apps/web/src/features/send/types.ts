/**
 * Types for the "New request" send flow.
 *
 * Naming follows the Parse classes in docs/BACKEND_API.md §3.5 / §3.7 at the wire
 * boundary (PascalCase, pointers) and camelCase for the plain records the UI uses.
 */
import type { Content } from "@/features/compose/model";

export interface ParsePointer<C extends string = string> {
  __type: "Pointer";
  className: C;
  objectId: string;
}

export interface ParseDate {
  __type: "Date";
  iso: string;
}

export function pointer<C extends string>(className: C, objectId: string): ParsePointer<C> {
  return { __type: "Pointer", className, objectId };
}

export function parseDate(d: Date): ParseDate {
  return { __type: "Date", iso: d.toISOString() };
}

/** Steps of the flow. 3 (fields) lives in the editor feature. */
export type Step = 1 | 2 | 3 | 4;

export type SendMode = "request" | "self" | "bulk";

/**
 * Recipient roles this backend actually supports.
 * There is no Viewer, Approver or Witness class on the server (§3.5, §11.7):
 * a "signer" is an entry in `Placeholders` + `Signers`, a "cc" is an entry in the
 * document's `Cc` array and never signs.
 */
export type RecipientRole = "signer" | "cc";

/** Signer verification. SMS/phone OTP does not exist in this build (§3.5). */
export type AuthMethod = "link" | "otp";

export interface Recipient {
  /** Local, stable across re-renders. Not a backend id. */
  key: string;
  /** contracts_Contactbook objectId, once the contact exists. */
  contactId?: string;
  /** Placeholders[].Id this recipient owns, so editor field data survives edits. */
  placeholderId?: number;
  name: string;
  email: string;
  phone?: string;
  role: RecipientRole;
  /** blockColor written onto the placeholder for this signer. */
  color: string;
}

/**
 * One `Bcc` entry. The old app stored contact pointers, this build stores the
 * plain `{ Name, Email }` shape §3.5 documents (`signPdf` only ever reads
 * `.Email`, and `Cc` is already written that way here). `objectId` is carried
 * through when the address came from a contact so a document written by the old
 * app round-trips without losing anything.
 */
export interface BccEntry {
  objectId?: string;
  name?: string;
  email: string;
}

/**
 * "Send B when A completes": stored as the `Chain` column. The server fires it
 * from the completion path (cloud/lib/chain.js) and carries the completed
 * document's signers over to the follow-up; `templateName` is denormalised for
 * display.
 */
export interface ChainConfig {
  templateId: string;
  templateName?: string;
  /** Title of the follow-up document (default: the template's name). */
  name?: string;
}

export interface SendSettings {
  /** TimeToCompleteDays; drives ExpiryDate. */
  expiryDays: number;
  /** RemindOnceInEvery; 0 means AutomaticReminders off. */
  remindEveryDays: number;
  sendInOrder: boolean;
  /** SendInOrderStrict: refuse out-of-order signing server-side (§6.5). */
  strictOrder: boolean;
  /** IsEnableOTP: the signer must authenticate by email OTP. Document-wide. */
  auth: AuthMethod;
  /** NotifyOnSignatures: mail the owner after each signature. */
  notifyOnSignatures: boolean;
  /** AllowModifications: the signer may place their own fields (§7.1). */
  allowModifications: boolean;
  /** RedirectUrl: where the signer lands once they are done. Empty means stay put. */
  redirectUrl: string;
  /** Bcc: blind copies of the completion mail. Never signs, never sees the request. */
  bcc: BccEntry[];
  /** Chain: automatically send a document from this template once this one completes. */
  chain: ChainConfig | null;
}

export interface SendMessage {
  subject: string;
  body: string;
}

/** One entry per signer role in `Placeholders` (§6.2). */
export interface PlaceholderEntry {
  /** randomId(8): a NUMBER on this backend, not a string (§11.2). */
  Id: number;
  Role: string;
  blockColor: string;
  signerObjId: string;
  signerPtr: ParsePointer<"contracts_Contactbook"> | Record<string, never>;
  email: string;
  Name?: string;
  placeHolder: Array<{ pageNumber: number; pos: unknown[] }>;
}

export interface ContactRecord {
  objectId: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
}

export interface TemplateSummary {
  objectId: string;
  name: string;
  note?: string;
  url?: string;
  signerCount: number;
  updatedAt?: string;
}

/** The draft document as the send flow needs it. */
export interface DraftDocument {
  objectId: string;
  /** Set when the document was written in the app: the text its PDF is rendered from. */
  content?: Content;
  name: string;
  note: string;
  description: string;
  /** Original (unsigned) PDF url. */
  url: string;
  /** Presence of SignedUrl means the document has been sent (§11.6). */
  sent: boolean;
  isSignyourself: boolean;
  placeholders: PlaceholderEntry[];
  signers: ContactRecord[];
  cc: Array<{ Name?: string; Email: string }>;
  /** Folder pointer on the document, when it lives inside a Drive folder. */
  folderId?: string;
  folderName?: string;
  settings: SendSettings;
  message: SendMessage;
  templateId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A file that has been converted, decrypted and uploaded, ready to become a document. */
export interface UploadedFile {
  /** Final (token-signed) url stored as `URL` on the document. */
  url: string;
  /** Original filename as chosen by the user. */
  fileName: string;
  /** Filename without extension: the default document name. */
  title: string;
  bytes: number;
  pageCount: number;
  /** Raw pdf bytes, kept for the preview so we do not refetch a short-lived url. */
  data: Uint8Array;
  /** True when we had to run the file through /decryptpdf. */
  decrypted: boolean;
  /** True when the source was a Word file run through /docxtopdf. */
  converted: boolean;
}

/** One row of a bulk send. */
export interface BulkRow {
  key: string;
  name: string;
  email: string;
  phone?: string;
  /** Filled in as the row is created. */
  contactId?: string;
  error?: string;
}

export const SIGNER_COLORS = ["#1447e6", "#e17100", "#6b5bd6", "#009966", "#c8000a", "#0e7490"] as const;

export function signerColor(index: number): string {
  return SIGNER_COLORS[index % SIGNER_COLORS.length];
}

export const EXPIRY_OPTIONS = [7, 14, 30, 60, 90] as const;
export const REMINDER_OPTIONS = [0, 1, 3, 7] as const;

export const DEFAULT_SETTINGS: SendSettings = {
  expiryDays: 15,
  remindEveryDays: 0,
  sendInOrder: false,
  strictOrder: false,
  auth: "link",
  notifyOnSignatures: true,
  allowModifications: false,
  redirectUrl: "",
  bcc: [],
  chain: null
};

/** Placeholders[].Id is an 8-digit NUMBER on this backend, not a string (§11.2). */
export function randomPlaceholderId(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const min = 10_000_000;
  const max = 99_999_999;
  return min + (buf[0] % (max - min + 1));
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** Same rule the old form used: an absolute http(s) URL. */
export function isUrl(v: string): boolean {
  try {
    const url = new URL(v.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function emailDomain(v: string): string {
  const at = v.indexOf("@");
  return at === -1 ? "" : v.slice(at + 1).toLowerCase().trim();
}
