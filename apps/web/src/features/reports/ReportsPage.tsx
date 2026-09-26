import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Download, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Button, Card, Chip, EmptyState, Menu, toast } from "@/components/ui";
import { useHotkeys } from "@/lib/hotkeys";
import { num } from "@/lib/format";
import type { RangeId, ReportFilters, SectionId } from "./types";
import { NO_TEMPLATE, RANGE_KEYS, clampRange, rangeFor, rangeLabel } from "./compute";
import { MAX_DOCS, useReportDocs } from "./api";
import { buildView } from "./view";
import { documentsCsv, downloadCsv } from "./csv";
import { Overview } from "./sections/Overview";
import { ByTemplate } from "./sections/ByTemplate";
import { ByMember } from "./sections/ByMember";
import { Recipients } from "./sections/Recipients";
import { Stalled } from "./sections/Stalled";
import { Exports } from "./sections/Exports";

/** `id` is the route segment, so only the label is translated. */
const SECTIONS: Array<{ id: SectionId; labelKey: string }> = [
  { id: "overview", labelKey: "reports.sections.overview" },
  { id: "by-template", labelKey: "reports.sections.byTemplate" },
  { id: "by-member", labelKey: "reports.sections.byMember" },
  { id: "recipients", labelKey: "reports.sections.recipients" },
  { id: "stalled", labelKey: "reports.sections.stalled" },
  { id: "exports", labelKey: "reports.sections.exports" }
];

const RANGES: RangeId[] = ["7d", "30d", "90d", "12m"];

function isSection(v: string | undefined): v is SectionId {
  return !!v && SECTIONS.some((s) => s.id === v);
}

/** Two date inputs in a popover, used by the "Custom" range chip. */
function CustomRange({
  value,
  onApply,
  active
}: {
  value: { from: string; to: string };
  onApply: (v: { from: string; to: string }) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const inputClass =
    "h-8 px-2 rounded-md border border-line bg-surface text-[12px] text-ink focus:outline-none focus:border-accent";

  return (
    <div ref={ref} className="relative">
      <Chip active={active} onClick={() => setOpen((v) => !v)}>
        {t("reports.ranges.custom")}
        <ChevronDown className="size-3" strokeWidth={1.6} />
      </Chip>
      {open ? (
        <div className="absolute z-40 mt-1.5 left-0 w-[260px] bg-surface border border-line rounded-xl shadow-[var(--shadow-pop)] p-3 flex flex-col gap-2.5">
          <label className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
            {t("reports.customRange.from")}
            <input
              type="date"
              className={inputClass}
              value={draft.from}
              max={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
            {t("reports.customRange.to")}
            <input
              type="date"
              className={inputClass}
              value={draft.to}
              min={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </label>
          <Button
            size="sm"
            variant="dark"
            block
            disabled={!draft.from || !draft.to}
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            {t("reports.customRange.apply")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterMenu({
  label,
  items,
  onSelect
}: {
  label: string;
  items: Array<{ id: string; name: string }>;
  onSelect: (id: string) => void;
}) {
  return (
    <Menu
      trigger={(p) => (
        <Button size="sm" iconRight={<ChevronDown className="size-3.5" strokeWidth={1.6} />} {...p}>
          {label}
        </Button>
      )}
      items={items.map((i) => ({ label: i.name, onSelect: () => onSelect(i.id) }))}
    />
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} className="h-[86px] animate-pulse bg-surface-2" />
        ))}
      </div>
      <Card className="h-[228px] animate-pulse bg-surface-2" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="h-[210px] animate-pulse bg-surface-2" />
        <Card className="h-[210px] animate-pulse bg-surface-2" />
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { t, i18n } = useTranslation();
  const { reportId } = useParams();
  const navigate = useNavigate();

  const [rangeId, setRangeId] = useState<RangeId>("30d");
  const [custom, setCustom] = useState(() => ({
    from: format(rangeFor("30d").from, "yyyy-MM-dd"),
    to: format(new Date(), "yyyy-MM-dd")
  }));
  const [filters, setFilters] = useState<ReportFilters>({ owner: "all", template: "all" });

  const range = useMemo(() => clampRange(rangeFor(rangeId, custom)), [rangeId, custom]);
  const { data, isLoading, isError, error, refetch, isFetching } = useReportDocs(range);

  const view = useMemo(
    () => buildView(data?.rows ?? [], range, rangeId, filters, data?.truncated ?? false),
    // The filter option names are translated, so a language switch rebuilds them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, range, rangeId, filters, i18n.language]
  );

  const exportCsv = () => {
    if (!view.cohort.length) {
      toast.show(t("reports.toast.nothingToExport"), t("reports.toast.nothingToExportBody"));
      return;
    }
    downloadCsv(
      `reports_${format(range.from, "yyyy-MM-dd")}_${format(range.to, "yyyy-MM-dd")}.csv`,
      documentsCsv(view.cohort)
    );
  };

  useHotkeys({ e: () => exportCsv() }, [view.cohort]);

  if (reportId !== undefined && !isSection(reportId)) return <Navigate to="/reports" replace />;
  const section: SectionId = isSection(reportId) ? reportId : "overview";

  const everyone = t("reports.filters.everyone");
  const allTemplates = t("reports.filters.allTemplates");
  const ownerName = filters.owner === "all" ? everyone : (view.owners.find((o) => o.id === filters.owner)?.name ?? everyone);
  const templateName =
    filters.template === "all"
      ? allTemplates
      : (view.templates.find((x) => x.id === filters.template)?.name ?? allTemplates);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2.5 lg:flex-nowrap lg:h-[52px] lg:py-0 lg:px-6 bg-surface border-b border-line">
        <h1 className="font-serif text-[18px] font-medium mr-2">{t("reports.title")}</h1>
        {RANGES.map((r) => (
          <Chip key={r} active={rangeId === r} onClick={() => setRangeId(r)}>
            {t(RANGE_KEYS[r])}
          </Chip>
        ))}
        <CustomRange
          active={rangeId === "custom"}
          value={custom}
          onApply={(v) => {
            setCustom(v);
            setRangeId("custom");
          }}
        />
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {isFetching && !isLoading ? <Loader2 className="size-3.5 animate-spin text-muted-2" /> : null}
          {view.owners.length > 1 ? (
            <FilterMenu
              label={ownerName}
              items={[{ id: "all", name: everyone }, ...view.owners]}
              onSelect={(owner) => setFilters((f) => ({ ...f, owner }))}
            />
          ) : null}
          {view.templates.length > 1 ? (
            <FilterMenu
              label={templateName}
              items={[{ id: "all", name: allTemplates }, ...view.templates]}
              onSelect={(template) => setFilters((f) => ({ ...f, template }))}
            />
          ) : null}
          <Button size="sm" kbd="E" icon={<Download className="size-3.5" strokeWidth={1.6} />} onClick={exportCsv}>
            {t("reports.actions.exportCsv")}
          </Button>
        </div>
      </header>

      <nav
        className="shrink-0 flex items-center gap-1.5 flex-wrap px-4 lg:px-6 py-3"
        aria-label={t("reports.nav.sections")}
      >
        {SECTIONS.map((s) => (
          <Chip
            key={s.id}
            active={s.id === section}
            onClick={() => navigate(s.id === "overview" ? "/reports" : `/reports/${s.id}`)}
          >
            {t(s.labelKey)}
          </Chip>
        ))}
        <span className="ml-auto text-[11px] text-muted-2">
          {filters.template === NO_TEMPLATE
            ? t("reports.ranges.withoutTemplate", { range: rangeLabel(range) })
            : rangeLabel(range)}
        </span>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 lg:px-6 pb-10">
        {isLoading ? (
          <Skeleton />
        ) : isError ? (
          <Card className="p-6 flex flex-col items-start gap-3">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-danger">
              <AlertTriangle className="size-4" strokeWidth={1.6} />
              {t("reports.errors.loadFailed")}
            </span>
            <span className="text-[12px] text-muted">
              {error instanceof Error ? error.message : t("reports.errors.unknown")}
            </span>
            <Button size="sm" onClick={() => void refetch()}>
              {t("common.actions.tryAgain")}
            </Button>
          </Card>
        ) : !data?.rows.length ? (
          <EmptyState
            title={t("reports.empty.noReports.title")}
            body={t("reports.empty.noReports.body")}
            action={
              <Button variant="dark" size="md" onClick={() => navigate("/send")}>
                {t("reports.actions.newRequest")}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {view.truncated ? (
              <p className="text-[12px] text-warn-ink bg-warn-soft border border-line rounded-md px-3 py-2">
                {t("reports.truncated", { limit: num(MAX_DOCS) })}
              </p>
            ) : null}
            {section === "overview" ? <Overview view={view} /> : null}
            {section === "by-template" ? <ByTemplate view={view} /> : null}
            {section === "by-member" ? <ByMember view={view} /> : null}
            {section === "recipients" ? <Recipients view={view} /> : null}
            {section === "stalled" ? <Stalled view={view} /> : null}
            {section === "exports" ? <Exports view={view} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}
