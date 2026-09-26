import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";
import { num } from "@/lib/format";
import { byMember, formatDuration } from "../compute";
import type { ReportView } from "../view";
import type { MemberStat } from "../types";
import { MiniBar } from "../components/Charts";
import { DataTable, type Column } from "../components/DataTable";

export function ByMember({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const rows = byMember(view.cohort);

  if (rows.length < 2) {
    return <EmptyState title={t("reports.empty.oneMember.title")} body={t("reports.empty.oneMember.body")} />;
  }

  const columns: Column<MemberStat>[] = [
    {
      key: "name",
      header: t("reports.table.teamMember"),
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
    }
  ];

  return <DataTable columns={columns} rows={rows} getKey={(r) => r.key} defaultSort={{ key: "sent", dir: "desc" }} />;
}
