/**
 * Plain, typed shapes for the documents feature.
 *
 * Everything here is produced by `api.ts` from raw Parse JSON. Components never
 * see a `Parse.Object` or a `{__type:"Date"}` wrapper.
 * Field names follow docs/BACKEND_API.md §3.5, §6.2, §6.3, §7.2.
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

/** Bucket a document falls into. Drives the filter chips and the status pill. */
export type DocStatus = "draft" | "in_progress" | "completed" | "declined" | "expired";

/** Filter chips on the documents list. "needs_you" is a cross-cut of in_progress. */
export type DocFilter = "all" | "needs_you" | "in_progress" | "completed" | "declined" | "expired" | "draft";

export type OwnerFilter = "anyone" | "me";

/** Sidebar saved views, arriving as `?view=`. */
export type SavedView = "waiting-on-me" | "expiring" | "sent-by-me";

/** Rolling window applied to `updatedAt`. */
export type DateFilter = "any" | "7" | "30" | "90";

export interface Signer {
  objectId: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  /** `_User` objectId behind the contact, when the pointer came back. */
  userId?: string;
}

export type SignerState = "signed" | "viewed" | "waiting" | "declined" | "turn";

/** A recipient of a document, merged with their placeholder role and audit state. */
export interface Recipient extends Signer {
  /** Placeholder index (also the signing order position), 0-based. */
  order: number;
  role: string;
  color: string;
  state: SignerState;
  signedAt?: string;
  viewedAt?: string;
  /** How many times they opened their signing link (every open counts, also after signing). */
  openCount: number;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
  /** Only set when this recipient is the one who declined. */
  declineReason?: string;
  fieldCount: number;
}

/** One open of the signing link, from the server's open log. */
export interface DocumentOpen {
  id: string;
  at?: string;
  contactId: string;
  name: string;
  email: string;
  ip?: string;
  userAgent?: string;
}

export interface DocumentOpens {
  total: number;
  /** Newest first. */
  opens: DocumentOpen[];
}

/** One placed widget, flattened out of `Placeholders[].placeHolder[].pos[]`. */
export interface DocField {
  key: number;
  type: string;
  page: number;
  required: boolean;
  /** Machine name from `options.name`. */
  name?: string;
  signerObjId?: string;
  signerName: string;
  signerEmail?: string;
  color: string;
  /** Text-ish answer, if the signer filled one in. */
  value?: string;
  /** Image answer (signature / stamp / initials / drawing), as a URL or data URL. */
  image?: string;
  /** PDF-space geometry at scale 1, measured from the page's top-left (§7.4). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AuditEvent {
  id: string;
  activity: string;
  at?: string;
  ip?: string;
  actorName: string;
  actorEmail?: string;
  /** base64 png without the `data:` prefix, when the server stored one. */
  signature?: string;
}

export interface Folder {
  objectId: string;
  name: string;
  parentId?: string;
}

export interface DocumentSettings {
  timeToCompleteDays?: number;
  expiryDate?: string;
  automaticReminders: boolean;
  remindOnceInEvery?: number;
  isEnableOTP: boolean;
  notifyOnSignatures: boolean;
  allowModifications: boolean;
  isTourEnabled: boolean;
  sendInOrder: boolean;
  sendInOrderStrict: boolean;
  redirectUrl?: string;
}

export interface Document {
  objectId: string;
  name: string;
  note?: string;
  description?: string;
  /** Original, unsigned PDF. */
  url?: string;
  /** Working PDF. Presence is the draft/sent flag (§11.6). */
  signedUrl?: string;
  certificateUrl?: string;
  documentHash?: string;
  status: DocStatus;
  isCompleted: boolean;
  isDeclined: boolean;
  declineReason?: string;
  isSignYourself: boolean;
  sentToOthers: boolean;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  expiryDate?: string;
  ownerName?: string;
  ownerEmail?: string;
  /** `contracts_Users` objectId of the owner, needed for the mail counter. */
  extUserId?: string;
  /** `_User` objectId of `CreatedBy`. */
  createdById?: string;
  folderId?: string;
  folderName?: string;
  templateId?: string;
  templateName?: string;
  pageCount?: number;
  recipients: Recipient[];
  fields: DocField[];
  audit: AuditEvent[];
  settings: DocumentSettings;
  /** "Send B when A completes" config stored on this document (Chain column). */
  chain?: { templateId: string; templateName?: string; name?: string };
  /** What happened when the chain fired, recorded by the server on completion. */
  chainResult?: { status: "sent" | "failed"; documentId?: string; error?: string; at?: string };
  /** Set on a follow-up: the completed document that triggered it. */
  chainedFromId?: string;
  /** True when the signed-in user still has to sign this one. */
  needsYou: boolean;
  /** The contact id to sign as, when `needsYou`. */
  myContactId?: string;
  /** Blocked behind an earlier signer under strict order. */
  blockedByOrder: boolean;
}

export interface DocumentPage {
  documents: Document[];
  total: number;
}

export interface BucketCounts {
  all: number;
  needs_you: number;
  in_progress: number;
  completed: number;
  declined: number;
  expired: number;
  draft: number;
}

export interface TemplateOption {
  objectId: string;
  name: string;
}

/** Everything the list query needs; also the URL state of the page. */
export interface DocumentQuery {
  filter: DocFilter;
  owner: OwnerFilter;
  date: DateFilter;
  templateId?: string;
  folderId?: string;
  search?: string;
  view?: SavedView;
  page: number;
  perPage: number;
}
