import type { PillTone } from "@/components/ui/Pill";
import type { DocStatus, SignerRow } from "./types";

/* Formatting for the MCP app: words, tones and dates shared by its views. */

/** Same tones and words as the web app's document pages. */
const STATUS: Record<string, { tone: PillTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  in_progress: { tone: "warn", label: "In progress" },
  completed: { tone: "success", label: "Completed" },
  declined: { tone: "danger", label: "Declined" },
  expired: { tone: "danger", label: "Expired" },
  voided: { tone: "neutral", label: "Voided" }
};

export function statusOf(status: DocStatus) {
  return STATUS[status] ?? { tone: "neutral" as PillTone, label: status };
}

/** "Sep 30", or "Sep 30, 2025" outside the current year. */
export function shortDate(iso: string | undefined, locale?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" })
  }).format(date);
}

/** "Sep 29, 4:12 PM", for a signature. */
export function stamp(iso: string | undefined, locale?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    date
  );
}

export function signedCount(signers: SignerRow[]) {
  return { signed: signers.filter((s) => s.status === "signed").length, total: signers.length };
}

/* ------------------------------------------------------------------ received documents and approvals */

/** Where the user stands on a document someone else sent them. Blue only for what needs them. */
const MY_STATUS: Record<string, { tone: PillTone; label: string }> = {
  needs_you: { tone: "accent", label: "Needs your signature" },
  waiting: { tone: "neutral", label: "Not your turn yet" },
  signed: { tone: "success", label: "You signed" },
  declined: { tone: "danger", label: "You declined" }
};

export function myStatusOf(status: string | undefined) {
  return MY_STATUS[status || ""] ?? { tone: "neutral" as PillTone, label: status || "Sent to you" };
}

const APPROVAL_STATUS: Record<string, { tone: PillTone; label: string }> = {
  pending: { tone: "accent", label: "Needs you" },
  signed: { tone: "success", label: "Signed" },
  declined: { tone: "neutral", label: "Declined" },
  failed: { tone: "danger", label: "Failed" },
  expired: { tone: "neutral", label: "Expired" }
};

export function approvalStatusOf(status: string) {
  return APPROVAL_STATUS[status] ?? { tone: "neutral" as PillTone, label: status };
}

/** The review's overall read of the terms. */
const OVERALL: Record<string, { tone: PillTone; label: string }> = {
  standard: { tone: "success", label: "Standard terms" },
  review: { tone: "warn", label: "Worth a careful read" },
  concerning: { tone: "danger", label: "Concerning" }
};

export function overallOf(overall: string) {
  return OVERALL[overall] ?? { tone: "neutral" as PillTone, label: overall };
}

const SEVERITY: Record<string, { tone: PillTone; label: string }> = {
  info: { tone: "neutral", label: "Note" },
  caution: { tone: "warn", label: "Caution" },
  warning: { tone: "danger", label: "Warning" }
};

export function severityOf(severity: string) {
  return SEVERITY[severity] ?? { tone: "neutral" as PillTone, label: severity };
}

/** "ChatGPT (chatgpt.com)", or whichever half is known. */
export function agentName(agent: { name?: string; host?: string } | undefined): string {
  const name = agent?.name?.trim() || "";
  const host = agent?.host?.trim() || "";
  if (name && host && name.toLowerCase() !== host.toLowerCase()) return `${name} (${host})`;
  return name || host || "Your assistant";
}

/** A field value as the user reads it: checkboxes as words, lists joined, blanks said out loud. */
export function valueText(value: unknown): string {
  if (value === true) return "Checked";
  if (value === false) return "Not checked";
  if (Array.isArray(value)) return value.map(String).join(", ") || "None";
  if (value === null || value === undefined || value === "") return "Left blank";
  return String(value);
}

/** Dates, numbers and amounts are set in Geist Mono. */
export function isNumeric(type: string, text: string): boolean {
  return ["date", "number", "cells"].includes(type) || /^[\d\s$%.,:/+()-]+$/.test(text);
}
