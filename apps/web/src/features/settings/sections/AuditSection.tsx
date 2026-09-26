import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Download } from "lucide-react";
import { Button, toast } from "@/components/ui";
import { SERVER_URL } from "@/lib/parse";
import { useExtUser } from "@/lib/extUser";
import { fetchAllOwnedDocuments, useStorageUsage, useTenant } from "../api";
import type { DocumentExportRow } from "../types";
import { FormColumn, ReadOnlyRow, SectionCard } from "../parts";

function isoOf(value: DocumentExportRow["ExpiryDate"]): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.iso ?? "";
}

function statusOf(t: TFunction, d: DocumentExportRow): string {
  if (d.IsCompleted) return t("common.status.completed");
  if (d.IsDeclined) return t("common.status.declined");
  const expiry = isoOf(d.ExpiryDate);
  if (expiry && new Date(expiry) < new Date()) return t("common.status.expired");
  return d.SignedUrl ? t("common.status.inProgress") : t("common.status.draft");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(t: TFunction, rows: DocumentExportRow[]): string {
  const header = [
    t("settings.audit.csv.documentId"),
    t("settings.audit.csv.name"),
    t("settings.audit.csv.status"),
    t("settings.audit.csv.owner"),
    t("settings.audit.csv.ownerEmail"),
    t("settings.audit.csv.signers"),
    t("settings.audit.csv.created"),
    t("settings.audit.csv.lastUpdated"),
    t("settings.audit.csv.sent"),
    t("settings.audit.csv.expires"),
    t("settings.audit.csv.declineReason")
  ];
  const lines = rows.map((d) =>
    [
      d.objectId,
      d.Name ?? "",
      statusOf(t, d),
      d.ExtUserPtr?.Name ?? "",
      d.ExtUserPtr?.Email ?? "",
      (d.Signers ?? []).map((s) => s.Email ?? s.Name ?? "").filter(Boolean).join("; "),
      d.createdAt ?? "",
      d.updatedAt ?? "",
      isoOf(d.DocSentAt),
      isoOf(d.ExpiryDate),
      d.DeclineReason ?? ""
    ]
      .map((c) => csvCell(String(c)))
      .join(",")
  );
  return [header.join(","), ...lines].join("\r\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export default function AuditSection() {
  const { t } = useTranslation();
  const { data: extUser } = useExtUser();
  const { data: tenant } = useTenant();
  const tenantId = typeof extUser?.TenantId?.objectId === "string" ? extUser.TenantId.objectId : undefined;
  const storage = useStorageUsage(tenantId);
  const [busy, setBusy] = useState(false);

  const exportCsv = async () => {
    setBusy(true);
    try {
      const rows = await fetchAllOwnedDocuments();
      if (!rows.length) {
        toast.show(t("settings.audit.toast.nothing"), t("settings.audit.toast.nothingBody"));
        return;
      }
      const blob = new Blob(["﻿" + toCsv(t, rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `documents-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("settings.audit.toast.ready"), t("settings.audit.toast.readyBody", { count: rows.length }));
    } catch (err) {
      toast.error(t("settings.audit.toast.failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const documentCount = typeof extUser?.DocumentCount === "number" ? extUser.DocumentCount : undefined;
  const templateCount = typeof extUser?.TemplateCount === "number" ? extUser.TemplateCount : undefined;

  return (
    <FormColumn>
      <SectionCard title={t("settings.audit.export.title")} note={t("settings.audit.export.note")}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12px] text-muted leading-relaxed max-w-[320px]">{t("settings.audit.export.body")}</p>
          <Button
            size="sm"
            loading={busy}
            icon={<Download className="size-3.5" strokeWidth={1.6} />}
            onClick={() => void exportCsv()}
          >
            {t("settings.audit.export.button")}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title={t("settings.audit.data.title")} note={t("settings.audit.data.note")}>
        <ReadOnlyRow label={t("settings.audit.data.endpoint")} value={SERVER_URL} mono />
        <ReadOnlyRow label={t("settings.audit.data.workspace")} value={tenant?.TenantName ?? "-"} />
        <ReadOnlyRow
          label={t("settings.audit.data.storage")}
          value={
            storage.isPending
              ? t("settings.audit.data.checking")
              : typeof storage.data === "number"
                ? formatBytes(storage.data)
                : t("settings.audit.data.notTracked")
          }
        />
        {documentCount !== undefined ? (
          <ReadOnlyRow label={t("settings.audit.data.documents")} value={documentCount} />
        ) : null}
        {templateCount !== undefined ? (
          <ReadOnlyRow label={t("settings.audit.data.templates")} value={templateCount} />
        ) : null}
      </SectionCard>

      <SectionCard title={t("settings.audit.trails.title")}>
        <p className="text-[12px] text-muted leading-relaxed">{t("settings.audit.trails.body")}</p>
      </SectionCard>
    </FormColumn>
  );
}
