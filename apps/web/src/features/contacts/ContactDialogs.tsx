import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FileUp, Loader2 } from "lucide-react";
import { Button, Dialog, Field, Input, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { contactsKey, importContacts, useCreateContact, useEditContact } from "./api";
import { readContactsCsv, type CsvError } from "./csv";
import type { Contact, ContactInput, ImportProblem, ImportRow, ImportSummary } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const empty: ContactInput = { name: "", email: "", phone: "", company: "", jobTitle: "" };

/* ------------------------------------------------------------------ */
/* Add / edit                                                          */
/* ------------------------------------------------------------------ */

export function ContactFormDialog({
  open,
  onClose,
  contact,
  tenantId,
  onSaved
}: {
  open: boolean;
  onClose: () => void;
  /** Present for edit, absent for add. */
  contact?: Contact;
  tenantId?: string;
  onSaved?: (contactId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const editing = !!contact;
  const [form, setForm] = useState<ContactInput>(empty);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactInput, string>>>({});
  const create = useCreateContact(tenantId);
  const edit = useEditContact(tenantId);
  const busy = create.isPending || edit.isPending;

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      contact
        ? {
            name: contact.name,
            email: contact.email,
            phone: contact.phone ?? "",
            company: contact.company ?? "",
            jobTitle: contact.jobTitle ?? ""
          }
        : empty
    );
  }, [open, contact]);

  const set = (k: keyof ContactInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Partial<Record<keyof ContactInput, string>> = {};
    if (!form.name.trim()) next.name = t("contacts.form.errors.name");
    if (!form.email.trim()) next.email = t("contacts.form.errors.emailRequired");
    else if (!EMAIL.test(form.email.trim())) next.email = t("contacts.form.errors.emailInvalid");
    setErrors(next);
    if (Object.keys(next).length) return;

    const input: ContactInput = {
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone?.trim() || undefined,
      company: form.company?.trim() || undefined,
      jobTitle: form.jobTitle?.trim() || undefined
    };
    try {
      if (editing && contact) {
        const res = await edit.mutateAsync({ contactId: contact.objectId, input });
        toast.success(t("contacts.toast.updated"), input.name);
        onSaved?.(res?.objectId);
      } else {
        const res = await create.mutateAsync(input);
        toast.success(t("contacts.toast.added"), input.name);
        onSaved?.(res?.objectId);
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|duplicate/i.test(msg)) {
        setErrors({ email: t("contacts.form.errors.duplicate") });
      } else {
        toast.error(t(editing ? "contacts.toast.updateFailed" : "contacts.toast.addFailed"), msg);
      }
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      title={t(editing ? "contacts.form.editTitle" : "contacts.form.addTitle")}
      description={t(editing ? "contacts.form.editDescription" : "contacts.form.addDescription")}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.actions.cancel")}
          </Button>
          <Button type="submit" form="contact-form" variant="primary" loading={busy}>
            {t(editing ? "common.actions.saveChanges" : "contacts.actions.addPerson")}
          </Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("contacts.fields.name")} error={errors.name}>
          <Input
            value={form.name}
            onChange={set("name")}
            placeholder={t("contacts.form.placeholders.name")}
            autoFocus
            invalid={!!errors.name}
          />
        </Field>
        <Field label={t("contacts.fields.email")} error={errors.email}>
          <Input
            value={form.email}
            onChange={set("email")}
            type="email"
            placeholder={t("contacts.form.placeholders.email")}
            invalid={!!errors.email}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label={t("contacts.fields.phone")} hint={t("contacts.form.optional")}>
            <Input
              value={form.phone}
              onChange={set("phone")}
              placeholder={t("contacts.form.placeholders.phone")}
            />
          </Field>
          <Field label={t("contacts.fields.company")} hint={t("contacts.form.optional")}>
            <Input
              value={form.company}
              onChange={set("company")}
              placeholder={t("contacts.form.placeholders.company")}
            />
          </Field>
        </div>
        <Field label={t("contacts.fields.jobTitle")} hint={t("contacts.form.optional")}>
          <Input
            value={form.jobTitle}
            onChange={set("jobTitle")}
            placeholder={t("contacts.form.placeholders.jobTitle")}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Import CSV                                                          */
/* ------------------------------------------------------------------ */

type ImportPhase = "pick" | "preview" | "running" | "done";

const CSV_ERROR_KEYS: Record<CsvError, string> = {
  empty: "contacts.import.errors.empty",
  missingColumns: "contacts.import.errors.missingColumns"
};

const PROBLEM_KEYS: Record<ImportProblem, string> = {
  noEmail: "contacts.import.problem.noEmail",
  invalidEmail: "contacts.import.problem.invalidEmail",
  noName: "contacts.import.problem.noName",
  duplicate: "contacts.import.problem.duplicate"
};

/** One sentence covering however many of created / skipped / failed apply. */
function summaryText(t: TFunction, summary: ImportSummary) {
  const suffix = summary.skipped
    ? summary.failed
      ? "SkippedFailed"
      : "Skipped"
    : summary.failed
      ? "Failed"
      : "";
  return t(`contacts.import.summary.added${suffix}`, {
    count: summary.created,
    skipped: summary.skipped,
    failed: summary.failed
  });
}

export function ImportDialog({
  open,
  onClose,
  tenantId
}: {
  open: boolean;
  onClose: () => void;
  tenantId?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<ImportPhase>("pick");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  useEffect(() => {
    if (open) return;
    setPhase("pick");
    setFileName("");
    setRows([]);
    setError(null);
    setDone(0);
    setSummary(null);
  }, [open]);

  const valid = rows.filter((r) => !r.problem);

  async function take(file: File | undefined) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setError(t("contacts.import.errors.notCsv"));
      return;
    }
    const text = await file.text();
    const res = readContactsCsv(text);
    if (res.error) {
      setError(t(CSV_ERROR_KEYS[res.error]));
      return;
    }
    setError(null);
    setFileName(file.name);
    setRows(res.rows);
    setPhase("preview");
  }

  async function run() {
    setPhase("running");
    setDone(0);
    try {
      const result = await importContacts(
        valid.map((r) => ({
          name: r.name,
          email: r.email,
          phone: r.phone,
          company: r.company,
          jobTitle: r.jobTitle
        })),
        tenantId,
        setDone
      );
      const skippedInFile = rows.length - valid.length;
      setSummary({ ...result, skipped: result.skipped + skippedInFile });
      setPhase("done");
      qc.invalidateQueries({ queryKey: contactsKey });
      if (result.created) {
        toast.success(t("contacts.import.toast.imported", { count: result.created }));
      }
    } catch (err) {
      setPhase("preview");
      toast.error(t("contacts.import.toast.failed"), err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title={t("contacts.import.title")}
      description={t("contacts.import.description")}
      footer={
        phase === "done" ? (
          <Button variant="primary" onClick={onClose}>
            {t("common.actions.done")}
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={phase === "running"}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={run}
              loading={phase === "running"}
              disabled={phase !== "preview" || !valid.length}
            >
              {valid.length
                ? t("contacts.import.actions.importCount", { count: valid.length })
                : t("common.actions.import")}
            </Button>
          </>
        )
      }
    >
      {phase === "pick" ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void take(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 h-40 rounded-lg border border-dashed text-[13px] transition-colors",
              dragging ? "border-accent bg-accent-tint text-accent" : "border-line-strong bg-surface-2 text-muted"
            )}
          >
            <FileUp className="size-5" strokeWidth={1.6} />
            <span>{t("contacts.import.dropzone")}</span>
            {/* The CSV column names the parser accepts, so they stay in English. */}
            <span className="text-[11px] text-muted-2">Name, Email, Phone, Company, Job title</span>
          </button>
          {error ? <p className="text-[12px] text-danger">{error}</p> : null}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void take(e.target.files?.[0])}
          />
        </div>
      ) : null}

      {phase === "preview" || phase === "running" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium truncate">{fileName}</span>
            <span className="text-[12px] text-muted">
              {rows.length - valid.length > 0
                ? t("contacts.import.readyWithSkipped", {
                    count: valid.length,
                    skipped: rows.length - valid.length
                  })
                : t("contacts.import.ready", { count: valid.length })}
            </span>
          </div>

          <div className="border border-line rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_1.2fr_1fr_100px] h-[30px] items-center px-3 gap-3 bg-surface-2 border-b border-line text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium">
              <span>{t("contacts.fields.name")}</span>
              <span>{t("contacts.fields.email")}</span>
              <span>{t("contacts.fields.company")}</span>
              <span />
            </div>
            {rows.slice(0, 6).map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1.2fr_1fr_100px] h-9 items-center px-3 gap-3 border-b border-line-soft last:border-b-0 text-[12px]"
              >
                <span className="truncate">{r.name}</span>
                <span className="truncate text-muted">{r.email}</span>
                <span className="truncate text-muted">{r.company}</span>
                <span className={cn("text-[11px] text-right", r.problem ? "text-danger" : "text-muted-2")}>
                  {r.problem ? t(PROBLEM_KEYS[r.problem]) : t("contacts.import.problem.ready")}
                </span>
              </div>
            ))}
          </div>
          {rows.length > 6 ? (
            <p className="text-[12px] text-muted-2">
              {t("contacts.import.showingFirst", { shown: 6, count: rows.length })}
            </p>
          ) : null}

          {phase === "running" ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <Loader2 className="size-3.5 animate-spin" />
                {t("contacts.import.progress", { done, total: valid.length })}
              </div>
              <div className="h-1.5 rounded-full bg-paper overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${valid.length ? (done / valid.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === "done" && summary ? (
        <div className="flex flex-col gap-2 text-[13px]">
          <p>{summaryText(t, summary)}</p>
          {summary.errors.length ? (
            <ul className="text-[12px] text-danger flex flex-col gap-1">
              {summary.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
