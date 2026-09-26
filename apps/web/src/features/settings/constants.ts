import type { TFunction } from "i18next";
import type { SectionId } from "./types";

/**
 * Date format values accepted by the server's `selectFormat`
 * (apps/server/Utils.js). Anything else silently falls back to
 * MM/dd/yyyy, so only these are offered.
 */
export const DATE_FORMATS = [
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "DD/MM/YYYY",
  "MM-DD-YYYY",
  "MM.DD.YYYY",
  "DD.MM.YYYY",
  "YYYY-MM-DD",
  "MMM DD, YYYY",
  "DD MMM, YYYY",
  "DD-MMM-YYYY",
  "MMMM DD, YYYY",
  "DD MMMM, YYYY"
] as const;

/** `DownloadFilenameFormat` on contracts_Users. The example filenames are samples, not copy. */
export const FILENAME_FORMATS: Array<{ value: string; example: string }> = [
  { value: "DOCNAME", example: "Master agreement.pdf" },
  { value: "DOCNAME_SIGNED", example: "Master agreement_signed.pdf" },
  { value: "DOCNAME_EMAIL", example: "Master agreement_ana@acme.com.pdf" },
  { value: "DOCNAME_EMAIL_DATE", example: "Master agreement_ana@acme.com_2026-08-20.pdf" }
];

/** Label for one `FILENAME_FORMATS` value, resolved on the active language. */
export function filenameFormatLabel(t: TFunction, value: string): string {
  return t(`settings.signing.filenameFormats.${value}`);
}

const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland"
];

/** Every IANA zone the browser knows, falling back to a short curated list. */
export function timezoneList(): string[] {
  try {
    const all = Intl.supportedValuesOf("timeZone");
    if (all.length) return all;
  } catch {
    // Intl.supportedValuesOf is missing on older engines.
  }
  return FALLBACK_ZONES;
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Current UTC offset of a zone, e.g. "UTC+01:00". Empty when the zone is invalid. */
export function zoneOffsetLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(
      new Date()
    );
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    return name === "GMT" ? "UTC+00:00" : name.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/** Mail-merge variables understood by the server's `replaceMailVaribles` (§10.2). */
export const MAIL_VARIABLES = [
  "document_title",
  "note",
  "sender_name",
  "sender_mail",
  "sender_phone",
  "receiver_name",
  "receiver_email",
  "receiver_phone",
  "expiry_date",
  "company_name",
  "signing_url"
];

export interface SectionMeta {
  id: SectionId;
  adminOnly?: boolean;
}

export const YOU_SECTIONS: SectionMeta[] = [
  { id: "profile" },
  { id: "signature" },
  { id: "notifications" },
  { id: "security" }
];

export const WORKSPACE_SECTIONS: SectionMeta[] = [
  { id: "general" },
  { id: "team" },
  { id: "branding" },
  { id: "signing" },
  { id: "email" },
  { id: "integrations" },
  { id: "api" },
  { id: "audit" },
  { id: "billing" }
];

export const ALL_SECTIONS = [...YOU_SECTIONS, ...WORKSPACE_SECTIONS];

/**
 * The nav label, header title and header description of a section. Resolved at
 * render so a language switch re-renders the nav.
 */
export function sectionLabel(t: TFunction, id: SectionId): string {
  return t(`settings.sections.${id}.label`);
}

export function sectionTitle(t: TFunction, id: SectionId): string {
  return t(`settings.sections.${id}.title`);
}

export function sectionDescription(t: TFunction, id: SectionId): string {
  return t(`settings.sections.${id}.description`);
}

export function sectionMeta(id: string): SectionMeta | undefined {
  return ALL_SECTIONS.find((s) => s.id === id);
}
