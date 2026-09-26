import i18next from "i18next";
import { num } from "@/lib/format";
import type { DocumentRecord } from "./types";

const DAY = 86_400_000;

/** "9 min", "4 h", "3 d". Input is a duration in milliseconds. */
export function shortDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 90)
    return i18next.t("inbox.duration.minutes", { count: Math.max(1, Math.round(minutes)) });
  const hours = ms / 3_600_000;
  if (hours < 48) return i18next.t("inbox.duration.hours", { count: Math.round(hours) });
  return i18next.t("inbox.duration.days", { count: Math.round(hours / 24) });
}

/** "just now", "8m ago", "2h ago", "3d ago": compact age of a timestamp. */
export function agoShort(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return i18next.t("inbox.ago.justNow");
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return i18next.t("inbox.ago.justNow");
  if (minutes < 60) return i18next.t("inbox.ago.minutes", { count: minutes });
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return i18next.t("inbox.ago.hours", { count: hours });
  return i18next.t("inbox.ago.days", { count: Math.round(hours / 24) });
}

/** "2 days", "5 hours": how long something has been waiting. */
export function waitingFor(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  const days = Math.floor(ms / DAY);
  if (days >= 1) return i18next.t("common.count.day", { count: days });
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return i18next.t("common.count.hour", { count: hours });
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface Kpis {
  awaiting: number;
  /** Age of the longest-waiting document that needs this user. */
  awaitingOldest?: string;
  waiting: number;
  waitingExpiring: number;
  completed30: number;
  /** Change against the previous 30 days, when the fetched window covers it. */
  completedDelta?: number;
  medianSignMs?: number;
  fastestSignMs?: number;
}

export function computeKpis(docs: DocumentRecord[], completedTruncated: boolean): Kpis {
  const now = Date.now();
  const needsYou = docs.filter((d) => d.needsMe);
  const waiting = docs.filter((d) => d.status === "waiting" && d.isMine);

  const oldest = needsYou
    .map((d) => d.sentAt ?? d.createdAt)
    .sort()
    .at(0);

  const completed = docs.filter((d) => d.isCompleted && d.completedAt);
  const last30 = completed.filter((d) => now - new Date(d.completedAt as string).getTime() <= 30 * DAY);
  const prev30 = completed.filter((d) => {
    const age = now - new Date(d.completedAt as string).getTime();
    return age > 30 * DAY && age <= 60 * DAY;
  });

  // The completed bucket is capped, so the previous window is only trustworthy
  // when the fetch reached back past 60 days.
  const oldestCompleted = completed.map((d) => d.completedAt as string).sort().at(0);
  const coversPrevious =
    !completedTruncated || (!!oldestCompleted && now - new Date(oldestCompleted).getTime() > 60 * DAY);

  const durations = last30
    .map((d) => new Date(d.completedAt as string).getTime() - new Date(d.createdAt).getTime())
    .filter((ms) => ms > 0);

  return {
    awaiting: needsYou.length,
    awaitingOldest: oldest ? waitingFor(oldest) : undefined,
    waiting: waiting.length,
    waitingExpiring: waiting.filter(
      (d) => d.expiryDate && new Date(d.expiryDate).getTime() - now <= 7 * DAY
    ).length,
    completed30: last30.length,
    completedDelta: coversPrevious ? last30.length - prev30.length : undefined,
    medianSignMs: median(durations),
    fastestSignMs: durations.length ? Math.min(...durations) : undefined
  };
}

/** The not-completed document closest to expiry, when that is within 48 hours. */
export function findNudge(docs: DocumentRecord[]): DocumentRecord | undefined {
  const now = Date.now();
  return docs
    .filter((d) => !d.isCompleted && !d.isDeclined && !d.isDraft && d.expiryDate)
    .filter((d) => {
      const left = new Date(d.expiryDate as string).getTime() - now;
      return left > 0 && left <= 2 * DAY;
    })
    .sort((a, b) => (a.expiryDate as string).localeCompare(b.expiryDate as string))
    .at(0);
}

/** Documents not yet finished that expire within the next seven days. */
export function expiringThisWeek(docs: DocumentRecord[]): number {
  const now = Date.now();
  return docs.filter((d) => {
    if (d.isCompleted || d.isDeclined || d.isDraft || !d.expiryDate) return false;
    const left = new Date(d.expiryDate).getTime() - now;
    return left > 0 && left <= 7 * DAY;
  }).length;
}

/** "in 19 hours", "tomorrow", "in 3 days". */
export function expiresPhrase(expiry: string): string {
  const left = new Date(expiry).getTime() - Date.now();
  if (left <= 0) return i18next.t("inbox.expires.expired");
  const hours = Math.round(left / 3_600_000);
  if (hours < 24) return i18next.t("inbox.expires.inHours", { count: hours });
  if (hours < 48) return i18next.t("inbox.expires.tomorrow");
  return i18next.t("inbox.expires.inDays", { count: Math.round(hours / 24) });
}

/** Number words for 0 to 9, digits above that. Translated, so "three"/"drei". */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 9 ? i18next.t(`inbox.numberWord.${n}`) : num(n);
}

export type TimeOfDay = "morning" | "afternoon" | "evening";

/** Which greeting the clock calls for. The value is a key suffix, not copy. */
export function timeOfDay(d = new Date()): TimeOfDay {
  const h = d.getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/**
 * How long this signer has historically taken, measured from send to signature
 * across the documents already in the inbox. Needs at least two samples.
 */
export function typicalSignTime(docs: DocumentRecord[], email: string): number | undefined {
  const samples: number[] = [];
  for (const d of docs) {
    const r = d.recipients.find((x) => x.email === email && x.signedAt);
    if (!r?.signedAt) continue;
    const from = new Date(d.sentAt ?? d.createdAt).getTime();
    const ms = new Date(r.signedAt).getTime() - from;
    if (ms > 0) samples.push(ms);
  }
  return samples.length >= 2 ? median(samples) : undefined;
}
