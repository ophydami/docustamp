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
  /**
   * Signature and initials on a pending request: a short-lived link to the
   * image the person saved, which approving stamps. Absent when they have none
   * and their name will be typed instead.
   */
  imageUrl?: string;
}

/** One name the document prints for the person's party. */
export interface PrintedName {
  name: string;
  page?: number;
  quote?: string;
  source?: "role" | "nearby";
  /** The person themselves, or their own company. */
  matches: boolean;
}

/**
 * Whether the document prints the person's own name for the party the agent
 * signs (server: cloud/lib/signerName.js). The agent always signs as the
 * account holder, so a mismatch means the page and the signature disagree.
 */
export interface NameCheck {
  status: "match" | "mismatch" | "unknown";
  /** The account name the signature shows. */
  expected: string;
  /** The party's role label on the document, "" when it has none. */
  role: string;
  printed: PrintedName[];
}

/** One reason the account's rules did not let the agent sign on its own. The text is the server's, a plain sentence. */
export interface RuleReason {
  code: string;
  text: string;
}

/**
 * Whether the account's rules for its AI let the agent sign this document
 * without asking (server: checkSignRules in cloud/lib/agentRules.js). When the
 * rules are off (`enabled: false`) every document someone else sends comes to
 * the person, and nothing is shown.
 */
export interface RuleCheck {
  enabled: boolean;
  allowed: boolean;
  reasons: RuleReason[];
  summary?: string;
  rulesUpdatedAt?: string | null;
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
  /** Null on a request made before the check existed. */
  nameCheck?: NameCheck | null;
  /** Why the rules sent this to the person. Missing or null on a request made before rules existed. */
  ruleCheck?: RuleCheck | null;
  /** Signing saved the typed signature as the person's own (they had none). */
  signatureSaved?: boolean;
}

export type ApprovalFilter = "pending" | "all";

export type ApprovalDecision = "approve" | "decline";

/** `getsignapprovalpage`: one page of the document as a PNG data URL. */
export interface ApprovalPage {
  image: string;
  page: number;
  pageCount: number;
}
