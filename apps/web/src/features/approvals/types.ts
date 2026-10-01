/**
 * Sign approvals: a connected app (ChatGPT, Claude, ...) wants to sign a
 * document someone else sent this person, and asks first. Shapes follow the
 * server's `listsignapprovals` / `getsignapproval` / `decidesignapproval`.
 */

export type ApprovalStatus = "pending" | "signed" | "declined" | "failed" | "expired";

export type ReviewOverall = "standard" | "review" | "concerning";
export type FlagSeverity = "info" | "caution" | "warning";

/** The AI's read of the terms (server: cloud/ai/review.js). Not legal advice. */
export interface Review {
  summary: string;
  overall: ReviewOverall;
  parties: Array<{ name: string; role: string }>;
  keyTerms: Array<{ label: string; value: string; quote?: string; page?: number }>;
  flags: Array<{ severity: FlagSeverity; title: string; why: string; quote?: string; page?: number }>;
  /** The document contains text that tries to instruct an AI. */
  instructionsAimedAtAI: boolean;
  model?: string;
  reviewedAt?: string;
  disclaimer?: string;
}

/** One value the agent will put on the page when it signs. */
export interface ApprovalValue {
  key: string;
  type: string;
  label: string;
  value: string | number | boolean | string[] | null;
  page?: number;
}

export interface Approval {
  id: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedVia: "web" | "chat" | null;
  error: string | null;
  document: {
    id: string;
    title: string;
    senderName: string;
    senderCompany?: string;
    senderEmail?: string;
    pageCount: number;
  };
  agent: { name: string; host?: string; kind?: string };
  values: ApprovalValue[];
  review: Review | null;
}

export type ApprovalFilter = "pending" | "all";

export type ApprovalDecision = "approve" | "decline";

/** `getsignapprovalpage`: one page of the document as a PNG data URL. */
export interface ApprovalPage {
  image: string;
  page: number;
  pageCount: number;
}
