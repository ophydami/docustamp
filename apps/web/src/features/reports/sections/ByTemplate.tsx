import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";
import { num, percent } from "@/lib/format";
import { byTemplate, formatDuration, pct } from "../compute";
import type { ReportView } from "../view";
import type { TemplateStat } from "../types";
import { ChartCard, ChartLegend, MiniBar } from "../components/Charts";
import { DataTable, type Column } from "../components/DataTable";

export function ByTemplate({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const rows = byTemplate(view.cohort);
  if (!rows.length) {
    return <EmptyState title={t("reports.empty.noTemplates.title")} body={t("reports.empty.noTemplates.body")} />;
  }

  const totalSent = rows.reduce((n, r) => n + r.sent, 0);
  const totalCompleted = rows.reduce((n, r) => n + r.completed, 0);
  const best = [...rows].filter((r) => r.sent >= 3).sort((a, b) => b.completionRate - a.completionRate)[0];

  const columns: Column<TemplateStat>[] = [
    {
      key: "name",
      header: t("reports.table.template"),
      width: "minmax(0,2fr)",
      render: (r) => <span className="truncate block text-ink">{r.name}</span>,
      sortValue: (r) => r.name
    },
    {
      key: "sent",
      header: t("reports.table.sent"),
      width: "80px",
      align: "right",
      render: (r) => <span className="num">{num(r.sent)}</span>,
      sortValue: (r) => r.sent
    },
    {
      key: "completed",
      header: t("reports.table.completed"),
      width: "100px",
      align: "right",
      render: (r) => <span className="num text-ink-2">{num(r.completed)}</span>,
      sortValue: (r) => r.completed
    },
    {
      key: "rate",
      header: t("reports.table.completion"),
      width: "190px",
      render: (r) => (
        <MiniBar
          value={r.completionRate}
          title={t("reports.table.completionTitle", { completed: num(r.completed), sent: num(r.sent) })}
        />
      ),
      sortValue: (r) => r.completionRate
    },
    {
      key: "median",
      header: t("reports.table.median"),
      width: "110px",
      align: "right",
      render: (r) => <span className="num text-ink-2">{formatDuration(r.medianMs)}</span>,
      sortValue: (r) => r.medianMs ?? Number.MAX_SAFE_INTEGER
    },
    {
      key: "declined",
      header: t("reports.table.declines"),
      width: "100px",
      align: "right",
      render: (r) => <span className={r.declined ? "num text-danger" : "num text-muted-2"}>{num(r.declined)}</span>,
      sortValue: (r) => r.declined
    }
  ];

  return (
    <div className="flex flex-col gap-4">
      <ChartCard title={t("reports.charts.templatesInRange.title")}>
        <ChartLegend
          items={[
            { label: t("reports.legend.templatesUsed"), value: num(rows.length) },
            { label: t("reports.legend.sent"), value: num(totalSent) },
            { label: t("reports.legend.completion"), value: percent(pct(totalCompleted, totalSent)) },
            {
              label: t("reports.legend.bestPerformer"),
              value: best
                ? t("reports.legend.bestValue", { name: best.name, rate: percent(best.completionRate) })
                : t("reports.legend.notEnoughData")
            }
          ]}
        />
      </ChartCard>
      <DataTable columns={columns} rows={rows} getKey={(r) => r.key} defaultSort={{ key: "sent", dir: "desc" }} />
    </div>
  );
}
