/**
 * Widget vocabulary, validation and value helpers (docs/BACKEND_API.md §7).
 *
 * The server never inspects widget answers: `signPdf` receives an already
 * stamped PDF (§11.40). Everything in here is therefore the only validation
 * that exists, and it has to match what the sender configured.
 */

import i18next from "i18next";
import type { RawValidation, SignerField, WidgetType } from "./types";
import { formatDate } from "@/lib/format";

export const WIDGET_TYPES: WidgetType[] = [
  "signature",
  "stamp",
  "initials",
  "text input",
  "name",
  "job title",
  "company",
  "email",
  "date",
  "text",
  "cells",
  "checkbox",
  "dropdown",
  "radio button",
  "image",
  "draw"
];

const KNOWN = new Set<string>(WIDGET_TYPES);

/** The server still accepts the legacy alias `textbox` (§7.1). */
export function normalizeWidgetType(type: unknown): string {
  const t = typeof type === "string" ? type.trim() : "";
  return t === "textbox" ? "text input" : t;
}

export function isKnownWidget(type: string): type is WidgetType {
  return KNOWN.has(type);
}

/** Default W x H in PDF points at scale 1, from the palette table in §7.1. */
export function defaultSize(type: string): { w: number; h: number } {
  switch (type) {
    case "initials":
      return { w: 50, h: 50 };
    case "text input":
    case "name":
    case "job title":
    case "company":
    case "email":
    case "text":
      return { w: 150, h: 19 };
    case "date":
      return { w: 100, h: 20 };
    case "cells":
      return { w: 112, h: 22 };
    case "checkbox":
      return { w: 15, h: 19 };
    case "dropdown":
      return { w: 120, h: 22 };
    case "radio button":
      return { w: 5, h: 10 };
    case "image":
      return { w: 70, h: 70 };
    default:
      return { w: 150, h: 60 };
  }
}

/** Types whose answer is a base64 image. */
export const IMAGE_TYPES = new Set<WidgetType>(["signature", "stamp", "initials", "image", "draw"]);

/** Types auto-filled from the signer's contact record. */
export const IDENTITY_TYPES = new Set<WidgetType>(["name", "email", "company", "job title"]);

/** Types whose answer propagates to same-named siblings (§7.3 duplicate auto-fill). */
export const AUTOFILL_TYPES = new Set<WidgetType>(["name", "company", "job title", "email", "text input"]);

export function isImageField(f: SignerField): boolean {
  return IMAGE_TYPES.has(f.type);
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

export const DEFAULT_DATE_FORMAT = "MM/dd/yyyy";

/**
 * `selectFormat` in the old client: a small enum of labels mapped onto date-fns
 * patterns, silently falling back to `MM/dd/yyyy` (§7.3, §11.18).
 */
const DATE_FORMATS: Record<string, string> = {
  "MM/DD/YYYY": "MM/dd/yyyy",
  "DD-MM-YYYY": "dd-MM-yyyy",
  "DD/MM/YYYY": "dd/MM/yyyy",
  LL: "MMMM dd, yyyy",
  "DD MMM, YYYY": "dd MMM, yyyy",
  "YYYY-MM-DD": "yyyy-MM-dd",
  "MM-DD-YYYY": "MM-dd-yyyy",
  "MM.DD.YYYY": "MM.dd.yyyy",
  "MMM DD, YYYY": "MMM dd, yyyy",
  "MMMM DD, YYYY": "MMMM dd, yyyy",
  "DD MMMM, YYYY": "dd MMMM, yyyy",
  "DD.MM.YYYY": "dd.MM.yyyy",
  "DD-MMM-YYYY": "dd-MMM-yyyy"
};

export function dateFnsPattern(label: string | undefined): string {
  if (!label) return DEFAULT_DATE_FORMAT;
  return DATE_FORMATS[label] ?? (Object.values(DATE_FORMATS).includes(label) ? label : DEFAULT_DATE_FORMAT);
}

/** The pattern a date widget should use: its own `validation.format` wins. */
export function fieldDatePattern(f: SignerField, docFormat: string): string {
  if (f.validation?.type === "date-format" && f.validation.format) return dateFnsPattern(f.validation.format);
  return dateFnsPattern(docFormat);
}

export function formatToday(pattern: string): string {
  try {
    return formatDate(new Date(), pattern);
  } catch {
    return formatDate(new Date(), DEFAULT_DATE_FORMAT);
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** `getRegexForType` in `utils/widgetUtils.js` (§7.3). */
export function regexForValidation(v: RawValidation | undefined): RegExp | null {
  if (!v?.type) return null;
  switch (v.type) {
    case "email":
      return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    case "number":
      return /^\d+(?:\.\d+)?$/;
    case "text":
      return /^[a-zA-Z ]+$/;
    case "ssn":
      return /^(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/;
    case "date-format":
      return null;
    case "regex":
      return v.pattern ? safeRegex(v.pattern) : null;
    default:
      return safeRegex(v.type);
  }
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

export function isFilled(f: SignerField): boolean {
  const r = f.response;
  if (Array.isArray(r)) return r.length > 0;
  return typeof r === "string" ? r.trim().length > 0 : false;
}

/** Returns an error message, or null when the field is acceptable. */
export function validateField(f: SignerField): string | null {
  const filled = isFilled(f);

  if (f.type === "checkbox") {
    const chosen = Array.isArray(f.response) ? f.response.length : 0;
    const min = f.validation?.minRequiredCount;
    const max = f.validation?.maxRequiredCount;
    if (typeof min === "number" && chosen < min) {
      return i18next.t("signer.validation.selectAtLeast", { count: min });
    }
    if (typeof max === "number" && max > 0 && chosen > max) {
      return i18next.t("signer.validation.selectAtMost", { count: max });
    }
    if (f.required && typeof min !== "number" && chosen === 0) return i18next.t("signer.validation.required");
    return null;
  }

  if (f.required && !filled) return i18next.t("signer.validation.required");
  if (!filled) return null;

  if (typeof f.response === "string") {
    const re = regexForValidation(f.validation);
    if (re && !re.test(f.response)) {
      if (f.validation?.type === "email") return i18next.t("signer.validation.email");
      if (f.validation?.type === "number") return i18next.t("signer.validation.number");
      if (f.validation?.type === "ssn") return i18next.t("signer.validation.ssn");
      return f.hint
        ? i18next.t("signer.validation.format", { hint: f.hint })
        : i18next.t("signer.validation.notExpectedFormat");
    }
    if (f.type === "cells" && f.response.length > f.cellCount) {
      return i18next.t("signer.validation.cellsTooLong", { count: f.cellCount });
    }
  }
  return null;
}

/** Every field of mine that still blocks finishing, in reading order. */
export function outstandingFields(fields: SignerField[]): SignerField[] {
  return fields.filter((f) => f.mine && !f.readOnly && validateField(f) !== null);
}

export function requiredCount(fields: SignerField[]): number {
  return fields.filter((f) => f.mine && !f.readOnly && f.required).length;
}

export function doneCount(fields: SignerField[]): number {
  return fields.filter((f) => f.mine && !f.readOnly && f.required && validateField(f) === null).length;
}

/** Reading order: page, then top to bottom, then left to right. */
export function inReadingOrder(fields: SignerField[]): SignerField[] {
  return [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/**
 * Translation leaf per widget type. The `type` strings themselves are wire
 * values (§7.1) and never translated; only the label the signer reads is.
 */
const LABEL_KEYS: Record<WidgetType, string> = {
  signature: "signature",
  stamp: "stamp",
  initials: "initials",
  "text input": "textInput",
  name: "name",
  "job title": "jobTitle",
  company: "company",
  email: "email",
  date: "date",
  text: "text",
  cells: "cells",
  checkbox: "checkbox",
  dropdown: "dropdown",
  "radio button": "radioButton",
  image: "image",
  draw: "draw"
};

/** Resolved on every call, so a language switch re-labels on the next render. */
export function widgetLabel(type: WidgetType): string {
  const key = LABEL_KEYS[type];
  return key ? i18next.t(`signer.widget.${key}`) : type;
}

export function fieldLabel(f: SignerField): string {
  return widgetLabel(f.type);
}

const FONT_COLORS: Record<string, string> = {
  red: "#b5412e",
  black: "#1c1b18",
  blue: "#2f4f9f",
  yellow: "#b07a12"
};

export function cssFontColor(name: string | undefined): string {
  return FONT_COLORS[name ?? "black"] ?? "#1c1b18";
}

/** rgb triple in 0..1 for pdf-lib. */
export function pdfFontColor(name: string | undefined): [number, number, number] {
  const hex = cssFontColor(name).replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255
  ];
}
