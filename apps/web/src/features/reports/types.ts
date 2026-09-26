/**
 * Reports feature types.
 *
 * Everything on this screen is computed in the browser from `contracts_Document`
 * rows, because the backend has no analytics endpoint: `getReport` only returns
 * canned status lists (docs/BACKEND_API.md §9) and there is no aggregate cloud
 * function. `DocRow` is the plain, typed shape we convert Parse objects into at
 * the api boundary; `compute.ts` only ever sees `DocRow[]`.
 */

export type RangeId = "7d" | "30d" | "90d" | "12m" | "custom";

export type SectionId = "overview" | "by-template" | "by-member" | "recipients" | "stalled" | "exports";

export interface DateRange {
  from: Date;
  /** Exclusive-ish upper bound: always end of the selected day. */
  to: Date;
}

/** One audit-trail entry, normalised. `at` is undefined when the row carried no usable date. */
export interface AuditEvent {
  activity: "Created" | "Viewed" | "Signed" | string;
  /** objectId of the `contracts_Contactbook` (or `contracts_Users`) the entry belongs to. */
  actorId?: string;
  at?: Date;
}

export interface SignerRef {
  objectId: string;
  name: string;
  email: string;
  /** The shadow `_User` behind the contact, used to attribute declines. */
  userId?: string;
}

/** How often one recipient opened their signing link (server `OpenStats`). */
export interface OpenStat {
  count: number;
  firstAt?: Date;
  lastAt?: Date;
}

export interface DocRow {
  objectId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  /** `DocSentAt`, falling back to `createdAt` once `SignedUrl` exists. Undefined for drafts. */
  sentAt?: Date;
  expiryDate?: Date;
  isCompleted: boolean;
  isDeclined: boolean;
  declinedById?: string;
  signers: SignerRef[];
  audit: AuditEvent[];
  /** Keyed by the signer's contact objectId. Empty for documents sent before open tracking. */
  opens: Record<string, OpenStat>;
  ownerId: string;
  ownerName: string;
  templateId?: string;
  templateName?: string;
  /** Last `Signed` audit event, or `updatedAt` when the doc is complete but the trail is empty. */
  completedAt?: Date;
  /** First `Viewed` audit event. */
  firstViewedAt?: Date;
  /** completedAt - sentAt, in ms. Only set for completed documents. */
  timeToSignMs?: number;
}

export interface Summary {
  sent: number;
  completed: number;
  completionRate: number;
  medianMs?: number;
  prevMedianMs?: number;
  declined: number;
  expired: number;
  waiting: number;
  overdue: number;
}

export interface WeekPoint {
  /** ISO date of the Monday that starts the week. */
  key: string;
  label: string;
  value: number;
}

export interface HistBucket {
  key: string;
  label: string;
  value: number;
  /** Upper bound in ms; `Infinity` for the tail bucket. */
  maxMs: number;
}

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  /** Share of the "Sent" stage, 0-100. */
  pct: number;
}

export interface TemplateStat {
  key: string;
  name: string;
  sent: number;
  completed: number;
  completionRate: number;
  medianMs?: number;
  declined: number;
}

export interface MemberStat {
  key: string;
  name: string;
  email: string;
  sent: number;
  completed: number;
  completionRate: number;
  medianMs?: number;
}

/** One recipient who opened a document that is still waiting on them. */
export interface StalledRow {
  key: string;
  docId: string;
  docName: string;
  ownerName: string;
  contactId: string;
  name: string;
  email: string;
  opens: number;
  firstOpenedAt?: Date;
  lastOpenedAt?: Date;
  sentAt?: Date;
  expiryDate?: Date;
}

export interface RecipientStat {
  key: string;
  name: string;
  email: string;
  docs: number;
  signed: number;
  medianMs?: number;
  lastActivity?: Date;
  declines: number;
}

export interface ReportFilters {
  /** `ownerId` to scope to a single creator, or "all". */
  owner: string;
  /** `templateId` (or "none" for documents with no template), or "all". */
  template: string;
}

export interface OwnerOption {
  id: string;
  name: string;
}
