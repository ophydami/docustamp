import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";
import { ago, num } from "@/lib/format";
import { byRecipient, formatDuration } from "../compute";
import type { ReportView } from "../view";
import type { RecipientStat } from "../types";
import { DataTable, type Column } from "../components/DataTable";

export function Recipients({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const rows = byRecipient(view.cohort);
  if (!rows.length) {
    return <EmptyState title={t("reports.empty.noRecipients.title")} body={t("reports.empty.noRecipients.body")} />;
  }

  const columns: Column<RecipientStat>[] = [
    {
      key: "name",
      header: t("reports.table.recipient"),
      width: "minmax(0,2fr)",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{r.name}</div>
          {r.email && r.email !== r.name ? <div className="truncate text-[12px] text-muted-2">{r.email}</div> : null}
        </div>
      ),
      sortValue: (r) => r.email || r.name
    },
    {
      key: "docs",
      header: t("reports.table.documents"),
      width: "110px",
      align: "right",
      render: (r) => <span className="num">{num(r.docs)}</span>,
      sortValue: (r) => r.docs
    },
    {
      key: "signed",
      header: t("reports.table.signed"),
      width: "90px",
      align: "right",
      render: (r) => <span className="num text-ink-2">{num(r.signed)}</span>,
      sortValue: (r) => r.signed
    },
    {
      key: "median",
      header: t("reports.table.medianTimeToSign"),
      width: "170px",
      align: "right",
      render: (r) => <span className="num text-ink-2">{formatDuration(r.medianMs)}</span>,
      sortValue: (r) => r.medianMs ?? Number.MAX_SAFE_INTEGER
    },
    {
      key: "last",
      header: t("reports.table.lastActivity"),
      width: "150px",
      align: "right",
      render: (r) => (
        <span className="text-muted">{r.lastActivity ? ago(r.lastActivity) : t("reports.table.noActivity")}</span>
      ),
      sortValue: (r) => r.lastActivity?.getTime() ?? 0
    },
    {
      key: "declines",
      header: t("reports.table.declines"),
      width: "100px",
      align: "right",
      render: (r) => <span className={r.declines ? "num text-danger" : "num text-muted-2"}>{num(r.declines)}</span>,
      sortValue: (r) => r.declines
    }
  ];

  return (
    <div className="flex flex-col gap-3">
      <DataTable columns={columns} rows={rows} getKey={(r) => r.key} defaultSort={{ key: "docs", dir: "desc" }} />
      <p className="text-[11px] text-muted-2">{t("reports.notes.recipients")}</p>
    </div>
  );
}
