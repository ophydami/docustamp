/**
 * The view model every report section renders from. Built once per range,
 * filter or language change (the filter option names are translated).
 */
import i18next from "i18next";
import type { DateRange, DocRow, OwnerOption, RangeId, ReportFilters, Summary } from "./types";
import { NO_TEMPLATE, NO_TEMPLATE_KEY, previousRange, sentCohort, summarise } from "./compute";

export interface ReportView {
  rangeId: RangeId;
  range: DateRange;
  /** Every document in the fetched window, after the owner/template filters. */
  all: DocRow[];
  /** Documents sent inside the range: the base for every rate on the screen. */
  cohort: DocRow[];
  prevCohort: DocRow[];
  summary: Summary;
  owners: OwnerOption[];
  templates: OwnerOption[];
  truncated: boolean;
}

export function buildView(
  rows: DocRow[],
  range: DateRange,
  rangeId: RangeId,
  filters: ReportFilters,
  truncated: boolean,
  now: Date = new Date()
): ReportView {
  // Filter options come from the unfiltered set so a selection never hides itself.
  const ownerMap = new Map<string, string>();
  const templateMap = new Map<string, string>();
  for (const d of rows) {
    if (d.ownerId && !ownerMap.has(d.ownerId))
      ownerMap.set(d.ownerId, d.ownerName || i18next.t("common.state.unknown"));
    const tid = d.templateId ?? NO_TEMPLATE;
    if (!templateMap.has(tid)) templateMap.set(tid, d.templateName ?? i18next.t(NO_TEMPLATE_KEY));
  }

  const all = rows.filter((d) => {
    if (filters.owner !== "all" && d.ownerId !== filters.owner) return false;
    if (filters.template !== "all" && (d.templateId ?? NO_TEMPLATE) !== filters.template) return false;
    return true;
  });

  const cohort = sentCohort(all, range);
  const prevCohort = sentCohort(all, previousRange(range));

  return {
    rangeId,
    range,
    all,
    cohort,
    prevCohort,
    summary: summarise(cohort, prevCohort, now),
    owners: [...ownerMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    templates: [...templateMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.id === NO_TEMPLATE ? 1 : b.id === NO_TEMPLATE ? -1 : a.name.localeCompare(b.name))),
    truncated
  };
}
