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

/** Where the user stands on a document someone else sent them. */
export type MyStatus = "needs_you" | "waiting" | "signed" | "declined" | string;

/** One of the user's own fields on a document someone else sent them. */
export interface MyField {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
  page?: number;
  options?: string[];
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
    urls?: { original?: string; signed?: string; certificate?: string; app?: string; file?: string };
    /**
     * 'signer' when someone else sent it to the user (the participant view).
     * That view names the document `id` and `title`; normalizeView() copies
     * them to `objectId` and `name` so the views read one shape.
     */
    role?: "owner" | "signer" | string;
    id?: string;
    title?: string;
    myStatus?: MyStatus;
    sender?: { name?: string; company?: string; email?: string };
    myFields?: MyField[];
    pageCount?: number;
  };
  review?: {
    readyToSend: boolean;
    errors: ReviewIssue[];
    warnings: ReviewIssue[];
    pages?: number;
  };
  /** Set by sign_document when the user's agent has just signed their part. */
  banner?: { kind: "signed_for_you" | string; agent?: { name?: string; host?: string } };
}

/* ------------------------------------------------------------------ approvals */

/** The AI's read of a document's terms (review_document). Not legal advice. */
export interface ContractReview {
  summary: string;
  overall: "standard" | "review" | "concerning" | string;
  parties?: Array<{ name: string; role?: string }>;
  keyTerms?: Array<{ label: string; value: string; quote?: string; page?: number }>;
  flags: Array<{ severity: "info" | "caution" | "warning" | string; title: string; why?: string; quote?: string; page?: number }>;
  instructionsAimedAtAI?: boolean;
  model?: string;
  reviewedAt?: string;
  disclaimer?: string;
}

export interface ApprovalValue {
  key: string;
  type: string;
  label?: string;
  value: unknown;
  page?: number;
}

export type ApprovalStatus = "pending" | "signed" | "declined" | "failed" | "expired" | string;

/** A request from the user's agent to sign a document someone else sent them. */
export interface Approval {
  id: string;
  status: ApprovalStatus;
  createdAt?: string;
  decidedAt?: string | null;
  decidedVia?: "web" | "chat" | null;
  error?: string | null;
  document: {
    id: string;
    title: string;
    senderName?: string;
    senderCompany?: string;
    senderEmail?: string;
    pageCount?: number;
  };
  agent: { name?: string; host?: string; kind?: string };
  values: ApprovalValue[];
  review: ContractReview | null;
}

/**
 * sign_document waiting for the user. The single-use approval code is never
 * in here: it comes in the tool result's `_meta` (see App.tsx), which the host
 * keeps from the model.
 */
export interface ApprovalData {
  view: "approval";
  approval: Approval;
  /** True when this host may approve from the card; otherwise the user approves in DocuStamp. */
  chatApproval: boolean;
  appUrl?: string;
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

export type ViewData = HomeData | DocumentData | ListData | ApprovalData;
