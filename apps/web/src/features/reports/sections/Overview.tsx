import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { Button, Cap, Stat } from "@/components/ui";
import { num, percent } from "@/lib/format";
import { formatDuration, funnel, histogram, byTemplate, weeklySeries, PREV_RANGE_KEYS } from "../compute";
import type { ReportView } from "../view";
import { BarChart, ChartCard, FunnelChart, MiniBar } from "../components/Charts";
import { DataTable, type Column } from "../components/DataTable";
import type { TemplateStat } from "../types";

function TableView({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-[190px] overflow-y-auto scroll-thin border border-line rounded-md">
      <div className="grid grid-cols-[1fr_auto] text-[12px]">
        <div className="px-3 h-8 flex items-center bg-surface-2 border-b border-line">
          <Cap>{t("reports.table.weekOf")}</Cap>
        </div>
        <div className="px-3 h-8 flex items-center justify-end bg-surface-2 border-b border-line">
          <Cap>{t("reports.table.completed")}</Cap>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <div className="px-3 h-8 flex items-center border-b border-line-soft text-ink-2">{r.label}</div>
            <div className="px-3 h-8 flex items-center justify-end border-b border-line-soft num text-ink">
              {num(r.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Overview({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const [weeklyTable, setWeeklyTable] = useState(false);
  const { cohort, all, range, summary, rangeId } = view;

  const weeks = weeklySeries(all, range).map((w) => ({
    key: w.key,
    label: w.label,
    value: w.value,
    tooltip: t("reports.charts.weekly.tooltip", { week: w.label, value: num(w.value) })
  }));
  const hist = histogram(cohort);
  const histData = hist.buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: b.value,
    tooltip: t("reports.charts.timeToSign.tooltip", { value: num(b.value), bucket: b.label })
  }));
  const fun = funnel(cohort);
  const funData = fun.stages.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.value,
    tooltip: t("reports.charts.funnel.tooltip", {
      stage: s.label,
      value: num(s.value),
      total: num(fun.stages[0].value),
      pct: percent(s.pct)
    })
  }));
  const templates = byTemplate(cohort).slice(0, 6);

  const prevLabel = t(PREV_RANGE_KEYS[rangeId]);
  const medianNote = summary.medianMs
    ? summary.prevMedianMs
      ? t("reports.stats.median.wasPrevious", { duration: formatDuration(summary.prevMedianMs), range: prevLabel })
      : t("reports.stats.median.noComparison", { range: prevLabel })
    : t("reports.stats.median.noCompletions");

  const columns: Column<TemplateStat>[] = [
    {
      key: "name",
      header: t("reports.table.template"),
      width: "minmax(0,2fr)",
      render: (r) => <span className="truncate block">{r.name}</span>
    },
    {
      key: "sent",
      header: t("reports.table.sent"),
      width: "70px",
      align: "right",
      render: (r) => <span className="num">{num(r.sent)}</span>
    },
    {
      key: "rate",
      header: t("reports.table.completion"),
      width: "150px",
      render: (r) => (
        <MiniBar
          value={r.completionRate}
          title={t("reports.table.completionTitle", { completed: num(r.completed), sent: num(r.sent) })}
        />
      )
    },
    {
      key: "median",
      header: t("reports.table.median"),
      width: "100px",
      align: "right",
      render: (r) => <span className="num text-ink-2">{formatDuration(r.medianMs)}</span>
    },
    {
      key: "declined",
      header: t("reports.table.declines"),
      width: "90px",
      align: "right",
      render: (r) => <span className={r.declined ? "num text-danger" : "num text-muted-2"}>{num(r.declined)}</span>
    }
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label={t("reports.stats.sent.label")} value={num(summary.sent)} note={t("reports.stats.sent.note")} />
        <Stat
          label={t("reports.stats.completed.label")}
          value={num(summary.completed)}
          note={t("reports.stats.completed.note", { rate: percent(summary.completionRate) })}
          tone="accent"
        />
        <Stat label={t("reports.stats.median.label")} value={formatDuration(summary.medianMs)} note={medianNote} />
        <Stat
          label={t("reports.stats.declinedExpired.label")}
          value={num(summary.declined + summary.expired)}
          note={t("reports.stats.declinedExpired.note", {
            declined: num(summary.declined),
            expired: num(summary.expired)
          })}
        />
        <Stat
          label={t("reports.stats.waiting.label")}
          value={num(summary.waiting)}
          note={
            summary.overdue
              ? t("reports.stats.waiting.due", { count: summary.overdue })
              : t("reports.stats.waiting.noneDue")
          }
        />
      </div>

      <ChartCard
        title={t("reports.charts.weekly.title")}
        right={
          <Button size="xs" variant={weeklyTable ? "dark" : "default"} onClick={() => setWeeklyTable((v) => !v)}>
            {weeklyTable ? t("reports.actions.chartView") : t("reports.actions.tableView")}
          </Button>
        }
      >
        {weeklyTable ? (
          <TableView rows={weeks.map((w) => ({ label: w.label, value: w.value }))} />
        ) : (
          <BarChart
            data={weeks}
            caption={t("reports.charts.weekly.title")}
            unit={t("reports.charts.weekly.unit")}
          />
        )}
      </ChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title={t("reports.charts.timeToSign.title")} insight={hist.insight}>
          <BarChart
            data={histData}
            caption={t("reports.charts.timeToSign.caption")}
            unit={t("reports.charts.timeToSign.unit")}
            labelEvery={1}
            height={130}
          />
        </ChartCard>
        <ChartCard title={t("reports.charts.funnel.title")} insight={fun.insight}>
          <FunnelChart stages={funData} caption={t("reports.charts.funnel.caption")} />
        </ChartCard>
      </div>

      <ChartCard
        title={t("reports.charts.byTemplate.title")}
        right={
          <Link
            to="/reports/by-template"
            className="text-[12px] font-medium inline-flex items-center gap-1 text-accent hover:text-accent-deep"
          >
            {t("reports.actions.fullReport")}
            <ArrowRight className="size-3.5" strokeWidth={1.6} />
          </Link>
        }
      >
        {templates.length ? (
          <DataTable columns={columns} rows={templates} getKey={(r) => r.key} />
        ) : (
          <p className="text-[12px] text-muted">{t("reports.insight.nothingSent")}</p>
        )}
      </ChartCard>

      <p className="text-[11px] text-muted-2">{t("reports.notes.overview")}</p>
    </div>
  );
}
