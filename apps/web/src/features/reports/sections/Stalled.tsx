import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, toast } from "@/components/ui";
import { ago, num, whenShort } from "@/lib/format";
import { remindMany, remindSummary } from "@/lib/reminder";
import { stalledRecipients } from "../compute";
import type { ReportView } from "../view";
import type { StalledRow } from "../types";
import { DataTable, type Column } from "../components/DataTable";

/**
 * "Opened, not signed": every recipient who has looked at a document that is
 * still waiting on them. Built from the whole fetched window rather than the
 * sent cohort, because what matters is who is stalling now, not when the
 * document went out.
 */
export function Stalled({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rows = useMemo(() => stalledRecipients(view.all), [view.all]);
  const [reminding, setReminding] = useState<string | null>(null);

  if (!rows.length) {
    return <EmptyState title={t("reports.empty.noStalled.title")} body={t("reports.empty.noStalled.body")} />;
  }

  const remind = async (row: StalledRow) => {
    setReminding(row.docId);
    try {
      const totals = await remindMany([{ id: row.docId, name: row.docName }]);
      const summary = remindSummary(totals);
      toast.show(summary.title, summary.detail);
    } finally {
      setReminding(null);
    }
  };

  const columns: Column<StalledRow>[] = [
    {
      key: "document",
      header: t("reports.table.document"),
      width: "minmax(0,2fr)",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{r.docName}</div>
          <div className="truncate text-[12px] text-muted-2">{r.ownerName}</div>
        </div>
      ),
      sortValue: (r) => r.docName
    },
    {
      key: "recipient",
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
      key: "opens",
      header: t("reports.table.opens"),
      width: "90px",
      align: "right",
      render: (r) => <span className="num">{num(r.opens)}</span>,
      sortValue: (r) => r.opens
    },
    {
      key: "first",
      header: t("reports.table.firstOpened"),
      width: "140px",
      align: "right",
      render: (r) => <span className="text-muted">{r.firstOpenedAt ? whenShort(r.firstOpenedAt) : "-"}</span>,
      sortValue: (r) => r.firstOpenedAt?.getTime() ?? 0
    },
    {
      key: "last",
      header: t("reports.table.lastOpened"),
      width: "140px",
      align: "right",
      render: (r) => <span className="text-ink-2">{r.lastOpenedAt ? ago(r.lastOpenedAt) : "-"}</span>,
      sortValue: (r) => r.lastOpenedAt?.getTime() ?? 0
    },
    {
      key: "expires",
      header: t("reports.table.expires"),
      width: "120px",
      align: "right",
      render: (r) => <span className="text-muted">{r.expiryDate ? whenShort(r.expiryDate) : "-"}</span>,
      sortValue: (r) => r.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER
    },
    {
      key: "actions",
      header: "",
      width: "96px",
      align: "right",
      render: (r) => (
        <Button
          size="xs"
          loading={reminding === r.docId}
          onClick={(e) => {
            e.stopPropagation();
            void remind(r);
          }}
        >
          {t("reports.actions.remind")}
        </Button>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        columns={columns}
        rows={rows}
        getKey={(r) => r.key}
        defaultSort={{ key: "opens", dir: "desc" }}
        onRowClick={(r) => navigate(`/documents/${r.docId}`)}
      />
      <p className="text-[11px] text-muted-2">{t("reports.notes.stalled")}</p>
    </div>
  );
}
