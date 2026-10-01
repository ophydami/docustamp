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
