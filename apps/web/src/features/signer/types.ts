/**
 * Typed shapes for the signer experience.
 *
 * These mirror the raw Parse JSON that `getDocument` returns (docs/BACKEND_API.md
 * §3.5, §6.2, §6.3, §7.2) but every value is plain: no `Parse.Object`, no
 * `{__type:"Date"}` wrappers. `api.ts` is the only place that touches raw JSON.
 *
 * Casing note (§7.2): the widget shape on the wire is deliberately inconsistent
 * (`xPosition` but `Width`, `options` but `SignUrl`). The raw types below keep
 * the server spelling; the normalised types use ours.
 */

export interface ParsePointer {
  __type: "Pointer";
  className: string;
  objectId: string;
}

export interface ParseDate {
  __type: "Date";
  iso: string;
}

/* ------------------------------------------------------------------ *
 * Raw wire shapes
 * ------------------------------------------------------------------ */

export interface RawValidation {
  type?: string;
  pattern?: string;
  format?: string;
  minRequiredCount?: number;
  maxRequiredCount?: number;
}

export interface RawWidgetOptions {
  name?: string;
  status?: "required" | "optional";
  defaultValue?: string | number | number[];
  response?: string | number | number[];
  validation?: RawValidation;
  values?: string[];
  layout?: "vertical" | "horizontal";
  cellCount?: number;
  isReadOnly?: boolean;
  isHideLabel?: boolean;
  hint?: string;
  fontSize?: number;
  fontColor?: string;
  rotation?: number;
  penColors?: string[];
  [k: string]: unknown;
}

/** One placed field, exactly as stored in `Placeholders[].placeHolder[].pos[]`. */
export interface RawWidget {
  key: number;
  type: string;
  xPosition: number;
  yPosition: number;
  Width?: number;
  Height?: number;
  scale?: number;
  zIndex?: number;
  isStamp?: boolean;
  isMobile?: boolean;
  IsResize?: boolean;
  options?: RawWidgetOptions;
  SignUrl?: string;
  ImageType?: string;
  signatureType?: string;
  typeSignature?: string;
  typeFont?: string;
  fontColor?: string;
  [k: string]: unknown;
}

export interface RawPage {
  pageNumber: number;
  pos: RawWidget[];
}

export interface RawPlaceholder {
  Id?: number;
  Role?: string;
  blockColor?: string;
  signerObjId?: string;
  signerPtr?: ParsePointer | Record<string, never>;
  email?: string;
  Name?: string;
  placeHolder?: RawPage[];
  /** Self-sign documents store pages at the top level instead (§7.2). */
  pageNumber?: number;
  pos?: RawWidget[];
  [k: string]: unknown;
}

export interface RawContact {
  objectId: string;
  Name?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  JobTitle?: string;
  UserId?: { objectId: string; [k: string]: unknown } | ParsePointer;
  [k: string]: unknown;
}

export interface RawAuditEntry {
  UserPtr?: ParsePointer & { Name?: string; Email?: string };
  Activity?: string;
  SignedUrl?: string;
  ipAddress?: string;
  SignedOn?: ParseDate | string;
  ViewedOn?: ParseDate | string;
  Signature?: string;
  [k: string]: unknown;
}

export interface RawDocument {
  objectId: string;
  Name?: string;
  Note?: string;
  Description?: string;
  URL?: string;
  SignedUrl?: string;
  CertificateUrl?: string;
  DocumentHash?: string;
  Placeholders?: RawPlaceholder[];
  Signers?: RawContact[];
  AuditTrail?: RawAuditEntry[];
  /**
   * Projected for guests: `getDocument` hands a signer only
   * `{objectId, name, email}` for the pointered users, so `username` and every
   * other _User field are owner-only. Read defensively.
   */
  CreatedBy?: { objectId: string; name?: string; email?: string; username?: string };
  /**
   * Guests get a projection of the sender's contracts_Users row: objectId, Name,
   * Email, Phone, Company, JobTitle, DateFormat, plus a TenantId cut down to its
   * branding fields. Anything else (Timezone, Is12HourTime, ...) only arrives
   * when the caller owns the document.
   */
  ExtUserPtr?: {
    objectId: string;
    Name?: string;
    Email?: string;
    Phone?: string;
    Company?: string;
    JobTitle?: string;
    DateFormat?: string;
    /** Owner-only. */
    Timezone?: string;
    /** Owner-only. */
    Is12HourTime?: boolean;
    TenantId?: { objectId: string; TenantName?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  DeclineReason?: string;
  /** Projected for guests to `{objectId, name, email}`. */
  DeclineBy?: { objectId: string; name?: string; email?: string };
  IsArchive?: boolean;
  IsSignyourself?: boolean;
  SentToOthers?: boolean;
  SendinOrder?: boolean;
  SendInOrderStrict?: boolean;
  IsEnableOTP?: boolean;
  IsTourEnabled?: boolean;
  AllowModifications?: boolean;
  NotifyOnSignatures?: boolean;
  TimeToCompleteDays?: number;
  ExpiryDate?: ParseDate | string;
  DocSentAt?: ParseDate | string;
  SignatureType?: Array<{ name: string; enabled: boolean }>;
  PenColors?: string[];
  RedirectUrl?: string;
  /** Per-document date format (settings.dateFormat on the API); the account default otherwise. */
  DateFormat?: string;
  SenderName?: string;
  SenderMail?: string;
  IsSendMail?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Normalised shapes the UI works with
 * ------------------------------------------------------------------ */

/** Every widget type string this build knows about (§7.1). */
export type WidgetType =
  | "signature"
  | "stamp"
  | "initials"
  | "text input"
  | "name"
  | "job title"
  | "company"
  | "email"
  | "date"
  | "text"
  | "cells"
  | "checkbox"
  | "dropdown"
  | "radio button"
  | "image"
  | "draw";

/** A field on the page, normalised. Geometry is PDF points from the page top-left. */
export interface SignerField {
  key: number;
  type: WidgetType;
  page: number;
  /** Index of the owning placeholder, which is also the signing-order position. */
  placeholderIndex: number;
  /** Index inside `placeHolder[].pos[]`, so we can write the answer back. */
  pageIndex: number;
  posIndex: number;
  /** True when this field belongs to the person currently signing. */
  mine: boolean;
  /** True when the signer placed this field themselves in this session. */
  added?: boolean;
  /** `options` verbatim as it will be persisted, kept for added fields. */
  rawOptions?: RawWidgetOptions;
  /** Stacking order, incremented per placement like the old `zIndex` counter. */
  zIndex?: number;
  /** `IsResize`: the signer has resized this field by hand. */
  resized?: boolean;
  signerName: string;
  signerEmail?: string;
  color: string;
  required: boolean;
  readOnly: boolean;
  /** `options.isHideLabel`: draw the boxes without their option labels. */
  hideLabel: boolean;
  name?: string;
  hint?: string;
  values: string[];
  layout: "vertical" | "horizontal";
  cellCount: number;
  fontSize: number;
  fontColor: string;
  rotation: number;
  validation?: RawValidation;
  /** The stored answer, if any. Images are base64 data URLs or signed URLs. */
  response?: string | number[];
  defaultValue?: string | number[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** `scale` recorded when the widget was placed (§7.4). */
  placedScale: number;
}

export type SignerState = "signed" | "declined" | "waiting" | "turn";

export interface SignerParty {
  order: number;
  contactId?: string;
  role: string;
  name: string;
  email?: string;
  color: string;
  state: SignerState;
  signedAt?: string;
  fieldCount: number;
  isPrefill: boolean;
}

/** Why the signer cannot sign right now, if they cannot. */
export type BlockReason =
  | "not_found"
  | "declined"
  | "expired"
  | "completed"
  | "already_signed"
  | "waiting_turn"
  | "no_fields";

export interface SignerDocument {
  objectId: string;
  name: string;
  note?: string;
  description?: string;
  /** The PDF to render and to stamp: `SignedUrl` when sent, else `URL`. */
  fileUrl?: string;
  originalUrl?: string;
  certificateUrl?: string;
  documentHash?: string;
  isCompleted: boolean;
  isDeclined: boolean;
  declineReason?: string;
  declinedByName?: string;
  isSignYourself: boolean;
  sendInOrder: boolean;
  sendInOrderStrict: boolean;
  isEnableOTP: boolean;
  allowModifications: boolean;
  expiryDate?: string;
  sentAt?: string;
  createdAt?: string;
  ownerName: string;
  ownerEmail: string;
  ownerExtUserId?: string;
  dateFormat: string;
  /** Allowed signature input methods, from the doc's `SignatureType`. */
  signatureTypes: string[];
  penColors: string[];
  redirectUrl?: string;
  signers: SignerParty[];
  /** Everything placed on the document, mine and other people's. */
  fields: SignerField[];
  /** Kept verbatim so we can write answers back into the exact wire shape. */
  raw: RawDocument;
}

/** Who the browser is signing as. */
export interface SignerIdentity {
  contactId?: string;
  /** `_User` objectId, needed for `declinedoc` and `getdefaultsignature`. */
  userId?: string;
  name: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  /** Index into `Placeholders`; -1 when we could not match. */
  placeholderIndex: number;
  /** True in self-sign mode: the owner is signing their own document. */
  isOwner: boolean;
}

/** The adopted signature, reused for every signature field in the session. */
export interface AdoptedSignature {
  /** base64 PNG data URL of the full signature. */
  signature: string;
  /** base64 PNG data URL of the initials. */
  initials?: string;
  fullName: string;
  initialsText: string;
  method: "draw" | "type" | "upload" | "default";
  typedFont?: string;
}

/** What the page is doing right now. */
export type SignerPhase = "loading" | "otp" | "blocked" | "signing" | "submitting" | "error";

export interface SavedSignature {
  objectId?: string;
  imageUrl?: string;
  initials?: string;
  stamp?: string;
}
