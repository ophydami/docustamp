/**
 * Pure report maths. No React, no Parse, no I/O: every function here takes
 * `DocRow[]` (plus a range) and returns plain data, so it can be unit tested
 * directly. Copy goes through the i18next singleton rather than a `t` prop, and
 * always inside a function body, so labels follow the active language every
 * time a section re-renders.
 */
import {
  addDays,
  addMonths,
  endOfDay,
  format,
  startOfDay,
  startOfWeek,
  subDays,
  subMonths
} from "date-fns";
import i18next from "i18next";
import { dateMedium, monthDay, num, percent } from "@/lib/format";
import type {
  DateRange,
  DocRow,
  FunnelStage,
  HistBucket,
  MemberStat,
  RangeId,
  RecipientStat,
  StalledRow,
  Summary,
  TemplateStat,
  WeekPoint
} from "./types";

/* ------------------------------------------------------------------ ranges */

/**
 * The range ids are state and route values, so only their labels are
 * translated: these are i18n keys, resolved wherever the chip is rendered.
 */
export const RANGE_KEYS: Record<RangeId, string> = {
  "7d": "reports.ranges.days7",
  "30d": "reports.ranges.days30",
  "90d": "reports.ranges.days90",
  "12m": "reports.ranges.months12",
  custom: "reports.ranges.custom"
};

/** "the previous 30 days", used by the median comparison note. */
export const PREV_RANGE_KEYS: Record<RangeId, string> = {
  "7d": "reports.ranges.previous.days7",
  "30d": "reports.ranges.previous.days30",
  "90d": "reports.ranges.previous.days90",
  "12m": "reports.ranges.previous.months12",
  custom: "reports.ranges.previous.custom"
};

/** The selected window, always whole days in the viewer's timezone. */
export function rangeFor(id: RangeId, custom?: { from?: string; to?: string }, now: Date = new Date()): DateRange {
  const to = endOfDay(now);
  switch (id) {
    case "7d":
      return { from: startOfDay(subDays(now, 6)), to };
    case "30d":
      return { from: startOfDay(subDays(now, 29)), to };
    case "90d":
      return { from: startOfDay(subDays(now, 89)), to };
    case "12m":
      return { from: startOfDay(subMonths(now, 12)), to };
    case "custom": {
      const f = custom?.from ? startOfDay(new Date(`${custom.from}T00:00:00`)) : startOfDay(subDays(now, 29));
      const t = custom?.to ? endOfDay(new Date(`${custom.to}T00:00:00`)) : to;
      return t < f ? { from: t, to: endOfDay(f) } : { from: f, to: t };
    }
  }
}

/** The same-length window immediately before `r`, used for the "was ..." notes. */
export function previousRange(r: DateRange): DateRange {
  const span = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - span - 1), to: new Date(r.from.getTime() - 1) };
}

export function inRange(d: Date | undefined, r: DateRange): boolean {
  if (!d) return false;
  const t = d.getTime();
  return t >= r.from.getTime() && t <= r.to.getTime();
}

export function rangeLabel(r: DateRange): string {
  const sameYear = r.from.getFullYear() === r.to.getFullYear();
  return i18next.t("reports.ranges.span", {
    from: sameYear ? monthDay(r.from) : dateMedium(r.from),
    to: dateMedium(r.to)
  });
}

/* ------------------------------------------------------------------- maths */

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/** "48m", "5h 20m", "3d 4h". Compact enough for a Stat tile. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-";
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return i18next.t("reports.duration.minutes", { value: num(mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem
      ? i18next.t("reports.duration.hoursMinutes", { hours: num(hours), minutes: num(rem) })
      : i18next.t("reports.duration.hours", { value: num(hours) });
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH
    ? i18next.t("reports.duration.daysHours", { days: num(days), hours: num(remH) })
    : i18next.t("reports.duration.days", { value: num(days) });
}

/* --------------------------------------------------------------- selection */

/** Documents whose send date falls inside the window. The base for every rate. */
export function sentCohort(docs: DocRow[], r: DateRange): DocRow[] {
  return docs.filter((d) => inRange(d.sentAt, r));
}

/** Documents that reached "all parties signed" inside the window. */
export function completedIn(docs: DocRow[], r: DateRange): DocRow[] {
  return docs.filter((d) => d.isCompleted && inRange(d.completedAt, r));
}

export function isExpired(d: DocRow, now: Date = new Date()): boolean {
  return !d.isCompleted && !d.isDeclined && !!d.expiryDate && d.expiryDate.getTime() < now.getTime();
}

/* ----------------------------------------------------------------- summary */

export function summarise(cohort: DocRow[], prevCohort: DocRow[], now: Date = new Date()): Summary {
  const completed = cohort.filter((d) => d.isCompleted);
  const declined = cohort.filter((d) => d.isDeclined).length;
  const expired = cohort.filter((d) => isExpired(d, now)).length;
  const waiting = cohort.filter((d) => !d.isCompleted && !d.isDeclined && !isExpired(d, now)).length;
  const overdue = cohort.filter(
    (d) =>
      !d.isCompleted &&
      !d.isDeclined &&
      !isExpired(d, now) &&
      !!d.expiryDate &&
      d.expiryDate.getTime() - now.getTime() < 3 * 86400000
  ).length;
  return {
    sent: cohort.length,
    completed: completed.length,
    completionRate: pct(completed.length, cohort.length),
    medianMs: median(completed.map((d) => d.timeToSignMs ?? 0).filter((n) => n > 0)),
    prevMedianMs: median(
      prevCohort
        .filter((d) => d.isCompleted)
        .map((d) => d.timeToSignMs ?? 0)
        .filter((n) => n > 0)
    ),
    declined,
    expired,
    waiting,
    overdue
  };
}

/* ------------------------------------------------------------ weekly chart */

/** One point per ISO week in the range, counting documents completed that week. */
export function weeklySeries(docs: DocRow[], r: DateRange): WeekPoint[] {
  const points: WeekPoint[] = [];
  const index = new Map<string, number>();
  let cursor = startOfWeek(r.from, { weekStartsOn: 1 });
  const last = startOfWeek(r.to, { weekStartsOn: 1 });
  while (cursor.getTime() <= last.getTime()) {
    const key = format(cursor, "yyyy-MM-dd");
    index.set(key, points.length);
    points.push({ key, label: monthDay(cursor), value: 0 });
    cursor = addDays(cursor, 7);
  }
  for (const d of docs) {
    if (!d.isCompleted || !inRange(d.completedAt, r) || !d.completedAt) continue;
    const key = format(startOfWeek(d.completedAt, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const i = index.get(key);
    if (i !== undefined) points[i].value += 1;
  }
  return points;
}

/* --------------------------------------------------------------- histogram */

const HOUR = 3600000;
/**
 * `key` is data (it identifies a bucket in code and as a React key); the axis
 * label and the insight phrase are i18n keys resolved when the chart renders.
 */
export const TIME_BUCKETS: Array<{ key: string; labelKey: string; maxMs: number; phraseKey: string }> = [
  { key: "lt1h", labelKey: "reports.buckets.lt1h.label", maxMs: HOUR, phraseKey: "reports.buckets.lt1h.phrase" },
  { key: "1-6h", labelKey: "reports.buckets.h1to6.label", maxMs: 6 * HOUR, phraseKey: "reports.buckets.h1to6.phrase" },
  {
    key: "6-24h",
    labelKey: "reports.buckets.h6to24.label",
    maxMs: 24 * HOUR,
    phraseKey: "reports.buckets.h6to24.phrase"
  },
  { key: "1-3d", labelKey: "reports.buckets.d1to3.label", maxMs: 72 * HOUR, phraseKey: "reports.buckets.d1to3.phrase" },
  { key: "3-7d", labelKey: "reports.buckets.d3to7.label", maxMs: 168 * HOUR, phraseKey: "reports.buckets.d3to7.phrase" },
  {
    key: "7d+",
    labelKey: "reports.buckets.d7plus.label",
    maxMs: Number.POSITIVE_INFINITY,
    phraseKey: "reports.buckets.d7plus.phrase"
  }
];

export function bucketFor(ms: number): string {
  return (TIME_BUCKETS.find((b) => ms < b.maxMs) ?? TIME_BUCKETS[TIME_BUCKETS.length - 1]).key;
}

export function histogram(docs: DocRow[]): { buckets: HistBucket[]; insight: string } {
  const buckets: HistBucket[] = TIME_BUCKETS.map((b) => ({
    key: b.key,
    label: i18next.t(b.labelKey),
    value: 0,
    maxMs: b.maxMs
  }));
  const byKey = new Map(buckets.map((b, i) => [b.key, i]));
  const tail: DocRow[] = [];
  let total = 0;
  for (const d of docs) {
    if (!d.isCompleted || !d.timeToSignMs || d.timeToSignMs <= 0) continue;
    const key = bucketFor(d.timeToSignMs);
    buckets[byKey.get(key) as number].value += 1;
    if (key === "7d+") tail.push(d);
    total += 1;
  }
  return { buckets, insight: histogramInsight(buckets, tail, total) };
}

function histogramInsight(buckets: HistBucket[], tail: DocRow[], total: number): string {
  if (!total) return i18next.t("reports.insight.noCompletions");
  // "Most documents are signed within X": the smallest bucket boundary that
  // covers more than half of all completions.
  let running = 0;
  let phraseKey = TIME_BUCKETS[TIME_BUCKETS.length - 1].phraseKey;
  for (let i = 0; i < buckets.length; i += 1) {
    running += buckets[i].value;
    if (running * 2 >= total) {
      phraseKey = TIME_BUCKETS[i].phraseKey;
      break;
    }
  }
  const phrase = i18next.t(phraseKey);
  if (!tail.length) return i18next.t("reports.insight.mostSigned", { phrase });

  const counts = new Map<string, number>();
  for (const d of tail) {
    const name = d.templateName ?? i18next.t("reports.insight.noTemplateDocuments");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] * 2 >= tail.length) {
    return i18next.t("reports.insight.mostSignedWithTail", { phrase, name: top[0] });
  }
  return i18next.t("reports.insight.mostSignedWithSlow", {
    phrase,
    slow: num(tail.length),
    total: num(total)
  });
}

/* ------------------------------------------------------------------ funnel */

export function hasSigned(d: DocRow): boolean {
  return d.audit.some((a) => a.activity === "Signed");
}

export function hasOpened(d: DocRow): boolean {
  return d.audit.some((a) => a.activity === "Viewed") || hasSigned(d);
}

export function funnel(docs: DocRow[]): { stages: FunnelStage[]; insight: string } {
  const sent = docs.length;
  const opened = docs.filter(hasOpened).length;
  const started = docs.filter(hasSigned).length;
  const done = docs.filter((d) => d.isCompleted).length;
  const stages: FunnelStage[] = [
    { key: "sent", label: i18next.t("reports.funnelStages.sent"), value: sent, pct: 100 },
    { key: "opened", label: i18next.t("reports.funnelStages.opened"), value: opened, pct: pct(opened, sent) },
    { key: "started", label: i18next.t("reports.funnelStages.started"), value: started, pct: pct(started, sent) },
    { key: "signed", label: i18next.t("reports.funnelStages.signed"), value: done, pct: pct(done, sent) }
  ];
  return { stages, insight: funnelInsight(stages) };
}

function funnelInsight(stages: FunnelStage[]): string {
  if (!stages[0].value) return i18next.t("reports.insight.nothingSent");
  let worst = 1;
  let drop = -1;
  for (let i = 1; i < stages.length; i += 1) {
    const d = stages[i - 1].value - stages[i].value;
    if (d > drop) {
      drop = d;
      worst = i;
    }
  }
  if (drop <= 0) return i18next.t("reports.insight.allSigned");
  const from = stages[worst - 1];
  const to = stages[worst];
  // Mid-sentence stage names have their own keys: lower-casing a translated
  // label is wrong in languages that capitalise nouns.
  return i18next.t("reports.insight.biggestDrop", {
    from: i18next.t(`reports.funnelStages.lower.${from.key}`),
    to: i18next.t(`reports.funnelStages.lower.${to.key}`),
    drop: num(drop),
    total: num(from.value),
    pct: percent(pct(drop, from.value))
  });
}

/* ------------------------------------------------------------ breakdowns */

export const NO_TEMPLATE = "none";
/** i18n key for the "no template" grouping label. */
export const NO_TEMPLATE_KEY = "reports.filters.noTemplate";

export function byTemplate(docs: DocRow[]): TemplateStat[] {
  const groups = new Map<string, DocRow[]>();
  for (const d of docs) {
    const key = d.templateId ?? NO_TEMPLATE;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }
  const rows: TemplateStat[] = [];
  for (const [key, list] of groups) {
    const completed = list.filter((d) => d.isCompleted);
    rows.push({
      key,
      name: list.find((d) => d.templateName)?.templateName ?? i18next.t(NO_TEMPLATE_KEY),
      sent: list.length,
      completed: completed.length,
      completionRate: pct(completed.length, list.length),
      medianMs: median(completed.map((d) => d.timeToSignMs ?? 0).filter((n) => n > 0)),
      declined: list.filter((d) => d.isDeclined).length
    });
  }
  return rows.sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
}

export function byMember(docs: DocRow[]): MemberStat[] {
  const groups = new Map<string, DocRow[]>();
  for (const d of docs) {
    const list = groups.get(d.ownerId);
    if (list) list.push(d);
    else groups.set(d.ownerId, [d]);
  }
  const rows: MemberStat[] = [];
  for (const [key, list] of groups) {
    const completed = list.filter((d) => d.isCompleted);
    rows.push({
      key,
      name: list[0].ownerName || i18next.t("common.state.unknown"),
      email: "",
      sent: list.length,
      completed: completed.length,
      completionRate: pct(completed.length, list.length),
      medianMs: median(completed.map((d) => d.timeToSignMs ?? 0).filter((n) => n > 0))
    });
  }
  return rows.sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
}

/**
 * Per-recipient behaviour, keyed by email (a contact's objectId changes when it
 * is edited, see BACKEND_API.md §11.35, so email is the stable identity).
 */
export function byRecipient(docs: DocRow[]): RecipientStat[] {
  interface Acc {
    name: string;
    email: string;
    docs: number;
    times: number[];
    signed: number;
    last?: Date;
    declines: number;
  }
  const acc = new Map<string, Acc>();
  for (const d of docs) {
    for (const s of d.signers) {
      const key = (s.email || s.objectId).toLowerCase();
      let a = acc.get(key);
      if (!a) {
        a = { name: s.name, email: s.email, docs: 0, times: [], signed: 0, last: undefined, declines: 0 };
        acc.set(key, a);
      }
      if (!a.name && s.name) a.name = s.name;
      a.docs += 1;
      if (d.isDeclined && d.declinedById && s.userId && d.declinedById === s.userId) a.declines += 1;
      for (const e of d.audit) {
        if (e.actorId !== s.objectId || !e.at) continue;
        if (!a.last || e.at > a.last) a.last = e.at;
        if (e.activity === "Signed" && d.sentAt) {
          a.signed += 1;
          const ms = e.at.getTime() - d.sentAt.getTime();
          if (ms > 0) a.times.push(ms);
        }
      }
    }
  }
  return [...acc.entries()]
    .map(([key, a]) => ({
      key,
      name: a.name || a.email,
      email: a.email,
      docs: a.docs,
      signed: a.signed,
      medianMs: median(a.times),
      lastActivity: a.last,
      declines: a.declines
    }))
    .sort((a, b) => b.docs - a.docs || a.name.localeCompare(b.name));
}

/* ----------------------------------------------------------------- stalled */

/**
 * Recipients who opened a document that is still waiting on them: the people
 * to chase. One row per (document, recipient); documents that are completed,
 * declined or expired are out. A recipient counts as "opened" from the server's
 * open tally, or from a Viewed audit entry for documents sent before opens were
 * counted (shown as one open).
 */
export function stalledRecipients(docs: DocRow[], now: Date = new Date()): StalledRow[] {
  const rows: StalledRow[] = [];
  for (const d of docs) {
    if (d.isCompleted || d.isDeclined || !d.sentAt || isExpired(d, now)) continue;
    for (const s of d.signers) {
      const signed = d.audit.some((a) => a.activity === "Signed" && a.actorId === s.objectId);
      if (signed) continue;
      const stat = d.opens[s.objectId];
      const viewed = d.audit.find((a) => a.activity === "Viewed" && a.actorId === s.objectId);
      if (!stat && !viewed) continue;
      rows.push({
        key: `${d.objectId}:${s.objectId}`,
        docId: d.objectId,
        docName: d.name,
        ownerName: d.ownerName,
        contactId: s.objectId,
        name: s.name || s.email,
        email: s.email,
        opens: stat?.count ?? 1,
        firstOpenedAt: stat?.firstAt ?? viewed?.at,
        lastOpenedAt: stat?.lastAt ?? viewed?.at,
        sentAt: d.sentAt,
        expiryDate: d.expiryDate
      });
    }
  }
  return rows.sort(
    (a, b) => b.opens - a.opens || (b.lastOpenedAt?.getTime() ?? 0) - (a.lastOpenedAt?.getTime() ?? 0)
  );
}

/** Cheap sanity guard so a 12-month custom range cannot ask for years of data. */
export function clampRange(r: DateRange, maxMonths = 24): DateRange {
  const floor = addMonths(r.to, -maxMonths);
  return r.from < floor ? { from: floor, to: r.to } : r;
}
