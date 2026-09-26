import {
  differenceInCalendarDays,
  differenceInHours,
  format,
  formatDistanceToNowStrict,
  isToday,
  isYesterday
} from "date-fns";
import type { Locale } from "date-fns";
// The i18next singleton, not `@/lib/i18n`: that module imports this one to keep
// the date locale in step, and importing it back would be circular.
import i18next from "i18next";

/**
 * date-fns ships one module per locale; each is its own chunk so only the
 * active language is downloaded. `en-US` is the built-in default.
 */
const DATE_LOCALES: Record<string, () => Promise<{ default?: Locale } & Record<string, unknown>>> = {
  en: () => import("date-fns/locale/en-US"),
  de: () => import("date-fns/locale/de"),
  es: () => import("date-fns/locale/es"),
  fr: () => import("date-fns/locale/fr"),
  hi: () => import("date-fns/locale/hi"),
  it: () => import("date-fns/locale/it"),
  ko: () => import("date-fns/locale/ko")
};

let dateLocale: Locale | undefined;

/** Loads the date-fns locale for `lang`. Called by `initI18n` on every switch. */
export async function setDateLocale(lang: string): Promise<void> {
  const code = (lang || "en").toLowerCase().split("-")[0];
  const load = DATE_LOCALES[code] ?? DATE_LOCALES.en;
  const mod = await load();
  // The subpath modules export the locale both as default and by name.
  dateLocale = (mod.default ?? Object.values(mod).find((v) => typeof v === "object" && v !== null)) as Locale;
}

function opts() {
  return dateLocale ? { locale: dateLocale } : undefined;
}

/**
 * date-fns `format` with the active locale applied, so month and weekday names
 * follow the UI language. Use this instead of importing `format` directly.
 */
export function formatDate(d: Date | string | undefined | null, pattern: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return format(date, pattern, opts());
}

/** The BCP 47 tag for `Intl`, taken from the active i18next language. */
export function activeLocale(): string {
  return i18next.resolvedLanguage || i18next.language || "en";
}

/** Locale-aware number, e.g. "1,204" in English and "1.204" in German. */
export function num(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale(), options).format(value);
}

/** Locale-aware percentage from a 0-100 value, e.g. "62%". */
export function percent(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(value / 100);
}

/** "14:02" today, "Yesterday", "Aug 17", "Aug 17, 2025" across years. */
export function whenShort(d: Date | string | undefined | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  if (isToday(date)) return format(date, "HH:mm", opts());
  if (isYesterday(date)) return i18next.t("common.date.yesterday");
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? "MMM d" : "MMM d, yyyy", opts());
}

/** "19h", "3d", "20d"; returns "" when no date. */
export function untilShort(d: Date | string | undefined | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  if (date <= now) return i18next.t("common.date.expired");
  const hours = differenceInHours(date, now);
  if (hours < 48) return i18next.t("common.date.hoursShort", { count: Math.max(1, hours) });
  return i18next.t("common.date.daysShort", { count: differenceInCalendarDays(date, now) });
}

export function ago(d: Date | string | undefined | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return formatDistanceToNowStrict(date, { addSuffix: true, ...opts() });
}

export function initials(name: string | undefined | null, email?: string) {
  const src = (name && name.trim()) || email || "?";
  const parts = src.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
}
