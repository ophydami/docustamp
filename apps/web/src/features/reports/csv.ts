/**
 * Client-side CSV: the backend has no export endpoint.
 *
 * Header rows and the derived status column stay in English on purpose: the
 * file is a data format, not screen copy. Display values that come from the
 * screen (template and member names, durations) follow the active language.
 */
import { format } from "date-fns";
import i18next from "i18next";
import type { DocRow, MemberStat, RecipientStat, StalledRow, TemplateStat } from "./types";
import { formatDuration, isExpired, NO_TEMPLATE_KEY } from "./compute";

export type Cell = string | number | undefined;

function escape(v: Cell): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  // Prefix a BOM so Excel reads the file as UTF-8.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const iso = (d: Date | undefined) => (d ? format(d, "yyyy-MM-dd HH:mm") : "");

/**
 * Status stays in English, like the header row: these are the file's enum-ish
 * values, meant to be filtered on by whatever opens the CSV.
 */
function status(d: DocRow): string {
  if (d.isCompleted) return "Completed";
  if (d.isDeclined) return "Declined";
  if (isExpired(d)) return "Expired";
  return d.sentAt ? "Waiting" : "Draft";
}

export function documentsCsv(docs: DocRow[]): string {
  return toCsv(
    [
      "Document",
      "Status",
      "Owner",
      "Template",
      "Recipients",
      "Sent",
      "Completed",
      "Time to sign",
      "Expiry",
      "Document id"
    ],
    docs.map((d) => [
      d.name,
      status(d),
      d.ownerName,
      d.templateName ?? i18next.t(NO_TEMPLATE_KEY),
      d.signers.map((s) => s.email || s.name).join("; "),
      iso(d.sentAt),
      iso(d.completedAt),
      d.timeToSignMs ? formatDuration(d.timeToSignMs) : "",
      iso(d.expiryDate),
      d.objectId
    ])
  );
}

export function templatesCsv(rows: TemplateStat[]): string {
  return toCsv(
    ["Template", "Sent", "Completed", "Completion %", "Median time to sign", "Declines"],
    rows.map((r) => [r.name, r.sent, r.completed, r.completionRate, formatDuration(r.medianMs), r.declined])
  );
}

export function membersCsv(rows: MemberStat[]): string {
  return toCsv(
    ["Team member", "Sent", "Completed", "Completion %", "Median time to sign"],
    rows.map((r) => [r.name, r.sent, r.completed, r.completionRate, formatDuration(r.medianMs)])
  );
}

export function stalledCsv(rows: StalledRow[]): string {
  return toCsv(
    ["Document", "Recipient", "Email", "Opens", "First opened", "Last opened", "Sent", "Expiry", "Owner", "Document id"],
    rows.map((r) => [
      r.docName,
      r.name,
      r.email,
      r.opens,
      iso(r.firstOpenedAt),
      iso(r.lastOpenedAt),
      iso(r.sentAt),
      iso(r.expiryDate),
      r.ownerName,
      r.docId
    ])
  );
}

export function recipientsCsv(rows: RecipientStat[]): string {
  return toCsv(
    ["Recipient", "Email", "Documents", "Signed", "Median time to sign", "Last activity", "Declines"],
    rows.map((r) => [
      r.name,
      r.email,
      r.docs,
      r.signed,
      formatDuration(r.medianMs),
      iso(r.lastActivity),
      r.declines
    ])
  );
}
