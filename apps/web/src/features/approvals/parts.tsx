import type { TFunction } from "i18next";
import type { PillTone } from "@/components/ui";
import { activeLocale, dateMedium, timeShort } from "@/lib/format";
import type { Approval, ApprovalStatus, ApprovalValue, FlagSeverity, NameCheck, ReviewOverall } from "./types";

/** Status pill for an approval. Pending is the one that needs you, so it is the blue one. */
export function approvalPill(status: ApprovalStatus, t: TFunction): { text: string; tone: PillTone } {
  switch (status) {
    case "pending":
      return { text: t("common.status.needsYou"), tone: "accent" };
    case "signed":
      return { text: t("common.status.signed"), tone: "success" };
    case "declined":
      return { text: t("common.status.declined"), tone: "neutral" };
    case "failed":
      return { text: t("approvals.status.failed"), tone: "danger" };
    case "expired":
      return { text: t("common.status.expired"), tone: "neutral" };
  }
}

export const OVERALL: Record<ReviewOverall, { key: string; tone: PillTone }> = {
  standard: { key: "approvals.review.overall.standard", tone: "success" },
  review: { key: "approvals.review.overall.review", tone: "warn" },
  concerning: { key: "approvals.review.overall.concerning", tone: "danger" }
};

export const SEVERITY: Record<FlagSeverity, { key: string; tone: PillTone }> = {
  info: { key: "approvals.review.severity.info", tone: "neutral" },
  caution: { key: "approvals.review.severity.caution", tone: "warn" },
  warning: { key: "approvals.review.severity.warning", tone: "danger" }
};

/** "ChatGPT (chatgpt.com)": the app's name and the host it sends people back to. */
export function agentLabel(agent: Approval["agent"]): string {
  return agent.host ? `${agent.name} (${agent.host})` : agent.name;
}

/** "Jane Cole, Acme": who sent the document. */
export function senderLabel(doc: Approval["document"]): string {
  return [doc.senderName, doc.senderCompany].filter(Boolean).join(", ");
}

/** Date and time of a decision or request: "Oct 1, 2026, 3:05 PM". */
export function stampOf(d: string | null | undefined): string {
  if (!d) return "";
  const date = dateMedium(d);
  return date ? `${date}, ${timeShort(d)}` : "";
}

/** Field types that have a name in documents.fieldType; anything else shows as text. */
const FIELD_TYPES = new Set([
  "cells",
  "checkbox",
  "company",
  "date",
  "draw",
  "dropdown",
  "email",
  "image",
  "initials",
  "jobTitle",
  "name",
  "signature",
  "stamp",
  "text"
]);
const TYPE_ALIASES: Record<string, string> = {
  "job title": "jobTitle",
  radio: "choice",
  "radio button": "choice",
  number: "text",
  "text input": "text"
};

export function fieldTypeLabel(type: string, t: TFunction): string {
  const key = TYPE_ALIASES[type?.toLowerCase?.() ?? ""] ?? type;
  if (key === "choice") return t("documents.fieldType.choice");
  return FIELD_TYPES.has(key) ? t(`documents.fieldType.${key}`) : type;
}

/** A value as it will read on the page. Ticked boxes, lists and blanks get words. */
export function formatValue(value: ApprovalValue["value"], t: TFunction): string {
  if (value === true) return t("approvals.values.checked");
  if (value === false) return t("approvals.values.notChecked");
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("approvals.values.empty");
  if (value === null || value === undefined || String(value).trim() === "") return t("approvals.values.empty");
  return String(value);
}

/** Values that read best in Geist Mono: dates and numbers. */
export function isNumericValue(v: ApprovalValue): boolean {
  if (v.type === "date" || v.type === "number") return true;
  return typeof v.value === "number";
}

/** The names printed for the person's party that are not theirs, as one phrase in the reader's language. */
export function mismatchedNames(check: NameCheck): string {
  const names = check.printed.filter((p) => !p.matches).map((p) => p.name);
  try {
    return new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}
