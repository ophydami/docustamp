import { useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Plus, Trash2, Upload, Users } from "lucide-react";
import { Button, Cap, Card, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";
import { isEmail, type BulkRow } from "../types";
import { emptyBulkRow, rowsFromCsv } from "../bulk";

export interface StepBulkProps {
  templateName: string;
  roleCount: number;
  rows: BulkRow[];
  onRows: (rows: BulkRow[]) => void;
  onOpenContacts: () => void;
}

export function StepBulk(props: StepBulkProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const blocked = props.roleCount > 1;

  async function readFile(file: File) {
    setParseError(null);
    try {
      const text = await file.text();
      const parsed = rowsFromCsv(text);
      if (!parsed.length) {
        setParseError(t("send.bulk.noRows"));
        return;
      }
      const seen = new Set(props.rows.map((r) => r.email.toLowerCase()));
      const merged = [...props.rows];
      for (const r of parsed) {
        const key = r.email.toLowerCase();
        if (key && seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      props.onRows(merged);
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  const valid = props.rows.filter((r) => isEmail(r.email)).length;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[22px] leading-tight tracking-[-.015em]">{t("send.bulk.title")}</h1>
        <p className="text-[13px] text-muted">
          {t("send.bulk.subtitle", { template: props.templateName || t("send.bulk.theTemplate") })}
        </p>
      </div>

      {blocked ? (
        <Card className="border-warn-soft bg-warn-soft px-4 py-3.5 flex gap-2.5 text-warn-ink">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" strokeWidth={1.6} />
          <p className="text-[13px] leading-relaxed">{t("send.bulk.multiRole", { count: props.roleCount })}</p>
        </Card>
      ) : null}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-lg border border-dashed transition-colors",
          dragging ? "border-accent bg-accent-tint" : "border-line-strong bg-surface"
        )}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full flex flex-col items-center gap-2 px-6 py-10 text-center"
        >
          <Upload className="size-5 text-muted-2" strokeWidth={1.6} />
          <span className="text-[14px] font-semibold">{t("send.bulk.dropCsv")}</span>
          <span className="text-[12px] text-muted-2">{t("send.bulk.columns")}</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void readFile(file);
          }}
        />
      </div>

      {parseError ? <p className="text-[12px] text-danger">{parseError}</p> : null}

      <div className="flex items-center gap-2">
        <Button size="sm" icon={<Users className="size-3.5" strokeWidth={1.6} />} onClick={props.onOpenContacts}>
          {t("send.actions.fromContacts")}
        </Button>
        <Button
          size="sm"
          icon={<Plus className="size-3.5" strokeWidth={1.6} />}
          onClick={() => props.onRows([...props.rows, emptyBulkRow()])}
        >
          {t("send.actions.addRow")}
        </Button>
        {props.rows.length ? (
          <span className="text-[12px] text-muted-2">
            {t("send.bulk.ready", { valid: num(valid), total: num(props.rows.length) })}
          </span>
        ) : null}
      </div>

      {props.rows.length ? (
        <div className="border border-line rounded-xl overflow-hidden bg-surface">
          <div className="grid grid-cols-[32px_1fr_1fr_160px_36px] items-center h-[34px] px-3 bg-surface-2 border-b border-line">
            <Cap>#</Cap>
            <Cap>{t("send.fields.name")}</Cap>
            <Cap>{t("send.fields.email")}</Cap>
            <Cap>{t("send.fields.phone")}</Cap>
            <span />
          </div>
          <ul className="divide-y divide-line-soft max-h-[420px] overflow-y-auto scroll-thin">
            {props.rows.map((r, i) => {
              const bad = r.email.length > 0 && !isEmail(r.email);
              return (
                <li key={r.key} className="grid grid-cols-[32px_1fr_1fr_160px_36px] items-center gap-2 px-3 py-2">
                  <span className="num text-[12px] text-muted-2">{i + 1}</span>
                  <Input
                    value={r.name}
                    aria-label={t("send.fields.name")}
                    onChange={(e) =>
                      props.onRows(props.rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))
                    }
                    placeholder={t("send.placeholders.fullName")}
                  />
                  <Input
                    value={r.email}
                    aria-label={t("send.fields.email")}
                    invalid={bad}
                    onChange={(e) =>
                      props.onRows(
                        props.rows.map((x) => (x.key === r.key ? { ...x, email: e.target.value, contactId: undefined } : x))
                      )
                    }
                    placeholder={t("send.placeholders.email")}
                  />
                  <Input
                    value={r.phone ?? ""}
                    aria-label={t("send.fields.phone")}
                    onChange={(e) =>
                      props.onRows(props.rows.map((x) => (x.key === r.key ? { ...x, phone: e.target.value } : x)))
                    }
                    placeholder={t("send.placeholders.optional")}
                  />
                  <button
                    type="button"
                    aria-label={t("send.a11y.removeRow")}
                    onClick={() => props.onRows(props.rows.filter((x) => x.key !== r.key))}
                    className="size-8 inline-flex items-center justify-center rounded-md text-muted-2 hover:bg-line-soft hover:text-danger"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.6} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
