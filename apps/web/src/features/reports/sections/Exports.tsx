import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { format } from "date-fns";
import { Button, Card } from "@/components/ui";
import { byMember, byRecipient, byTemplate, rangeLabel, stalledRecipients } from "../compute";
import { documentsCsv, downloadCsv, membersCsv, recipientsCsv, stalledCsv, templatesCsv } from "../csv";
import type { ReportView } from "../view";

export function Exports({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const stamp = `${format(view.range.from, "yyyy-MM-dd")}_${format(view.range.to, "yyyy-MM-dd")}`;
  const items = [
    {
      key: "documents",
      title: t("reports.exports.documents.title"),
      body: t("reports.exports.documents.body"),
      count: view.cohort.length,
      countKey: "common.count.document",
      run: () => downloadCsv(`documents_${stamp}.csv`, documentsCsv(view.cohort))
    },
    {
      key: "templates",
      title: t("reports.exports.templates.title"),
      body: t("reports.exports.templates.body"),
      count: byTemplate(view.cohort).length,
      countKey: "common.count.template",
      run: () => downloadCsv(`by-template_${stamp}.csv`, templatesCsv(byTemplate(view.cohort)))
    },
    {
      key: "members",
      title: t("reports.exports.members.title"),
      body: t("reports.exports.members.body"),
      count: byMember(view.cohort).length,
      countKey: "reports.count.sender",
      run: () => downloadCsv(`by-member_${stamp}.csv`, membersCsv(byMember(view.cohort)))
    },
    {
      key: "recipients",
      title: t("reports.exports.recipients.title"),
      body: t("reports.exports.recipients.body"),
      count: byRecipient(view.cohort).length,
      countKey: "common.count.recipient",
      run: () => downloadCsv(`recipients_${stamp}.csv`, recipientsCsv(byRecipient(view.cohort)))
    },
    {
      key: "stalled",
      title: t("reports.exports.stalled.title"),
      body: t("reports.exports.stalled.body"),
      count: stalledRecipients(view.all).length,
      countKey: "common.count.recipient",
      run: () => downloadCsv(`opened-not-signed_${stamp}.csv`, stalledCsv(stalledRecipients(view.all)))
    }
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted">{t("reports.exports.intro", { range: rangeLabel(view.range) })}</p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {items.map((i) => (
          <Card key={i.key} className="px-4 py-3.5 flex items-start gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-ink">{i.title}</span>
              <span className="text-[12px] text-muted leading-relaxed">{i.body}</span>
              <span className="num text-[11px] text-muted-2">{t(i.countKey, { count: i.count })}</span>
            </div>
            <Button
              size="sm"
              icon={<Download className="size-3.5" strokeWidth={1.6} />}
              disabled={!i.count}
              onClick={i.run}
            >
              {t("reports.actions.csv")}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
