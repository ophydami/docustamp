/**
 * Contact-book types.
 *
 * Backed by `contracts_Contactbook` (docs/BACKEND_API.md §3.7). That class has
 * no tags, no notes, no timezone and no SMS-verification flag, so the design's
 * tag column, notes box and timezone row are not rendered anywhere here.
 */

export interface Contact {
  objectId: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  /** objectId of the shadow `_User` the server creates for every contact. */
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type DocStatus = "draft" | "waiting" | "completed" | "declined" | "expired";

/** A document this contact is a signer on. */
export interface ContactDoc {
  objectId: string;
  name: string;
  status: DocStatus;
  /** Most recent moment we know about for this doc, used for ordering. */
  at?: string;
  /** True when the doc is out for signature and this contact has not signed. */
  pending: boolean;
}

export type ActivityKind = "signed" | "viewed" | "declined" | "sent";

export interface ContactActivity {
  kind: ActivityKind;
  at: string;
  /** Viewed more than 24h ago and still not signed. */
  stale: boolean;
}

export interface ContactStats {
  docs: ContactDoc[];
  total: number;
  pending: number;
  activity: ContactActivity | null;
  /** Median milliseconds between "sent" and this contact's signature. */
  medianSignMs: number | null;
  signedCount: number;
}

export interface CompanyGroup {
  key: string;
  name: string;
  /** True when the name came from the email domain, not a Company value. */
  inferred: boolean;
  people: Contact[];
  documents: number;
}

export type SortKey = "recent" | "name" | "documents";
export type ViewKey = "people" | "companies";

/** Why a CSV row cannot be imported. Translated where it is shown. */
export type ImportProblem = "noEmail" | "invalidEmail" | "noName" | "duplicate";

/** One parsed CSV row, already mapped onto contact fields. */
export interface ImportRow {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  /** Why this row cannot be imported, if anything. */
  problem?: ImportProblem;
}

export interface ImportSummary {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface ContactInput {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
}
