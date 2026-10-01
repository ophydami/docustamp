/**
 * The shapes the server's app tools return in `structuredContent`
 * (apps/server/cloud/mcp/app.js). Kept loose on purpose: a field the server
 * adds later must not break an older page that a host still has cached.
 */

export type DocStatus = "draft" | "in_progress" | "completed" | "declined" | "voided" | "expired" | string;

export interface SignerRow {
  name?: string;
  email?: string;
  role?: string;
  status: "pending" | "signed" | "declined" | "voided" | string;
  signedAt?: string;
}

export interface DocRow {
  objectId: string;
  name: string;
  status: DocStatus;
  updatedAt?: string;
  sentAt?: string;
  expiresAt?: string;
  completedAt?: string;
  fieldCount?: number;
  signers: SignerRow[];
}

export interface HomeData {
  view: "home" | "panel";
  account?: { name?: string; email?: string; company?: string };
  appUrl?: string;
  canWrite: boolean;
  waiting: DocRow[];
  drafts: DocRow[];
  completed: DocRow[];
  limit: number;
}

export interface ReviewIssue {
  code: string;
  message: string;
}

export interface DocumentData {
  view: "document";
  canWrite: boolean;
  appUrl?: string;
  /** The first page with a field on it, where previews open. */
  previewPage?: number;
  document: DocRow & {
    declineReason?: string;
    voided?: boolean;
    hasCertificate?: boolean;
    urls?: { original?: string; signed?: string; certificate?: string; app?: string };
  };
  review?: {
    readyToSend: boolean;
    errors: ReviewIssue[];
    warnings: ReviewIssue[];
    pages?: number;
  };
}

export interface ListData {
  view: "list";
  filter: "waiting" | "draft" | "completed" | "all";
  items: DocRow[];
  more: boolean;
  canWrite: boolean;
}

export interface PageImage {
  page: number;
  pageCount: number;
  width: number;
  height: number;
  source?: "original" | "signed";
  image: string;
}

export type ViewData = HomeData | DocumentData | ListData;
