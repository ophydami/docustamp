import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FilePen, FileText, FolderClosed, Loader2, Lock, Sparkles, UploadCloud } from "lucide-react";
import { Button, Cap, Field, Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";
import { ACCEPTED_EXTENSIONS, MAX_FILE_MB, formatBytes, type UploadStage } from "../upload";
import type { TemplateSummary } from "../types";

/** Matches the `Note` column the draft is saved into. */
const NOTE_MAX_CHARS = 200;

export interface StepDocumentsProps {
  hasDocument: boolean;
  fileName: string;
  bytes?: number;
  pageCount?: number;
  name: string;
  onName: (v: string) => void;
  note: string;
  onNote: (v: string) => void;
  stage: UploadStage;
  error: string | null;
  onPickFile: (file: File) => void;
  onReplace: () => void;
  templates: TemplateSummary[];
  templatesLoading: boolean;
  templatesError: boolean;
  onUseTemplate: (templateId: string) => void;
  pendingTemplateId: string | null;
  selfSign: boolean;
  /** Set when the flow was opened from inside a Drive folder (`?folder=<id>`). */
  folderName?: string;
  /** Switch step 1 to the in-app editor ("Write it here"). */
  onWrite: () => void;
}

function stageLabel(stage: UploadStage, t: TFunction): string | null {
  switch (stage.kind) {
    case "reading":
      return t("send.documents.stage.reading");
    case "converting":
      return t("send.documents.stage.converting");
    case "decrypting":
      return t("send.documents.stage.decrypting");
    case "uploading":
      return t("send.documents.stage.uploading", { percent: num(stage.percent) });
    default:
      return null;
  }
}

export function StepDocuments(props: StepDocumentsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const busy = props.stage.kind !== "idle" && props.stage.kind !== "done";
  const label = stageLabel(props.stage, t);
  const percent = props.stage.kind === "uploading" ? props.stage.percent : null;

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) props.onPickFile(dropped);
  }

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[22px] leading-tight tracking-[-.015em]">
          {props.selfSign ? t("send.documents.titleSelf") : t("send.documents.title")}
        </h1>
        <p className="text-[13px] text-muted">{t("send.documents.subtitle")}</p>
        {props.folderName ? (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-2">
            <FolderClosed className="size-3.5" strokeWidth={1.6} />
            {t("send.documents.savingInto", { folder: props.folderName })}
          </p>
        ) : null}
      </div>

      {props.hasDocument ? (
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3 border border-line rounded-xl bg-surface px-4 py-3.5">
            <span className="mt-0.5 flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent shrink-0">
              <FileText className="size-4" strokeWidth={1.6} />
            </span>
            <span className="flex flex-col gap-0.5 min-w-0 flex-1">
              <span className="text-[13px] font-semibold truncate">{props.fileName}</span>
              <span className="text-[11px] text-muted-2">
                {[
                  props.pageCount ? t("common.count.page", { count: props.pageCount }) : null,
                  props.bytes ? formatBytes(props.bytes) : null
                ]
                  .filter(Boolean)
                  .join(" · ") || t("send.documents.ready")}
              </span>
            </span>
            <Button size="sm" onClick={props.onReplace} disabled={busy}>
              {t("send.actions.replace")}
            </Button>
          </div>

          <Field label={t("send.documents.nameLabel")} hint={t("send.documents.nameHint")}>
            <Input
              value={props.name}
              maxLength={250}
              onChange={(e) => props.onName(e.target.value)}
              placeholder={t("send.documents.namePlaceholder")}
            />
          </Field>

          <Field
            label={t("send.documents.noteLabel")}
            hint={t("send.documents.noteHint", { max: num(NOTE_MAX_CHARS) })}
          >
            <Textarea
              value={props.note}
              maxLength={NOTE_MAX_CHARS}
              rows={3}
              onChange={(e) => props.onNote(e.target.value)}
              placeholder={t("send.documents.notePlaceholder")}
            />
          </Field>
        </div>
      ) : (
        <>
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
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="w-full flex flex-col items-center gap-3 px-6 py-14 text-center disabled:cursor-wait"
            >
              {busy ? (
                <Loader2 className="size-6 text-accent animate-spin" strokeWidth={1.6} />
              ) : (
                <UploadCloud className="size-6 text-muted-2" strokeWidth={1.6} />
              )}
              <span className="flex flex-col gap-1">
                <span className="text-[14px] font-semibold">
                  {busy ? label : t("send.documents.dropFile")}
                </span>
                <span className="text-[12px] text-muted-2">
                  {busy
                    ? t("send.documents.keepTabOpen")
                    : t("send.documents.fileLimit", { size: num(MAX_FILE_MB) })}
                </span>
              </span>
              {percent !== null ? (
                <span className="w-56 h-1 rounded-full bg-line overflow-hidden">
                  <span className="block h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
                </span>
              ) : null}
            </button>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) props.onPickFile(picked);
              }}
            />
          </div>

          {props.error ? (
            <p className="text-[12px] text-danger flex items-center gap-1.5">
              <Lock className="size-3.5" strokeWidth={1.6} />
              {props.error}
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy}
            onClick={props.onWrite}
            className={cn(
              "flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors",
              "hover:border-line-strong hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            <span className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent shrink-0">
              <FilePen className="size-4" strokeWidth={1.6} />
            </span>
            <span className="flex flex-col gap-0.5 min-w-0 flex-1">
              <span className="text-[13px] font-semibold">{t("send.documents.write.title")}</span>
              <span className="text-[12px] text-muted">{t("send.documents.write.body")}</span>
            </span>
            <span className="self-center text-[12px] font-medium text-ink-2 whitespace-nowrap">
              {t("send.documents.write.cta")}
            </span>
          </button>

          {!props.hasDocument && !props.selfSign ? (
            <div className="flex items-start gap-3 rounded-lg border border-accent-line bg-accent-tint px-4 py-3">
              <Sparkles className="size-4 text-accent mt-0.5 shrink-0" strokeWidth={1.6} />
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <span className="text-[13px] font-semibold">{t("send.documents.ai.title")}</span>
                <span className="text-[12px] text-muted">{t("send.documents.ai.body")}</span>
              </div>
              <Button size="sm" onClick={() => navigate("/ai")}>
                {t("send.documents.ai.cta")}
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <Cap>{t("send.documents.templates.heading")}</Cap>
            {props.templatesLoading ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-2">
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />{" "}
                {t("send.documents.templates.loading")}
              </div>
            ) : props.templatesError ? (
              <p className="text-[12px] text-muted-2">{t("send.documents.templates.error")}</p>
            ) : props.templates.length === 0 ? (
              <p className="text-[12px] text-muted-2">{t("send.documents.templates.empty")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line-soft border border-line rounded-xl bg-surface">
                {props.templates.slice(0, 5).map((tpl) => (
                  <li key={tpl.objectId} className="flex items-center gap-3 px-4 h-[52px]">
                    <FileText className="size-4 text-muted-2 shrink-0" strokeWidth={1.6} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-medium truncate">{tpl.name}</span>
                      <span className="block text-[11px] text-muted-2">
                        {tpl.signerCount
                          ? t("common.count.role", { count: tpl.signerCount })
                          : t("send.documents.templates.noRoles")}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      loading={props.pendingTemplateId === tpl.objectId}
                      disabled={!!props.pendingTemplateId}
                      onClick={() => props.onUseTemplate(tpl.objectId)}
                    >
                      {t("send.actions.use")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
