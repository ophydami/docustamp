import { useTranslation } from "react-i18next";
import { AlertTriangle, FolderClosed, Loader2, UploadCloud } from "lucide-react";
import { Button, Field, Textarea } from "@/components/ui";
import { num } from "@/lib/format";
import { Composer } from "@/features/compose/Composer";
import type { Content } from "@/features/compose/model";

/** Matches the `Note` column the draft is saved into. */
const NOTE_MAX_CHARS = 200;

export interface StepWriteProps {
  title: string;
  onTitle: (v: string) => void;
  content: Content;
  onContent: (v: Content) => void;
  note: string;
  onNote: (v: string) => void;
  /** No draft yet: the text becomes a document on Continue. */
  isNew: boolean;
  /** Only for a new document: go back to the upload box. */
  onBackToUpload: () => void;
  /** The live PDF is being rendered or uploaded. */
  rendering: boolean;
  renderError: string | null;
  /** Fields were already placed on this document, so big edits can move them off their lines. */
  hasFields: boolean;
  selfSign: boolean;
  /** Set when the flow was opened from inside a Drive folder (`?folder=<id>`). */
  folderName?: string;
  disabled?: boolean;
}

/**
 * Step 1 in "write it here" mode: the document is typed in the app and the PDF
 * on the right is rendered from it. For a new request, Continue creates the
 * draft; for an existing written draft every edit autosaves (SendPage owns
 * both, this is the layout).
 */
export function StepWrite(props: StepWriteProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[22px] leading-tight tracking-[-.015em]">
          {props.selfSign ? t("send.documents.titleSelf") : t("send.documents.write.heading")}
        </h1>
        <p className="text-[13px] text-muted">{t("send.documents.write.subtitle")}</p>
        {props.folderName ? (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-2">
            <FolderClosed className="size-3.5" strokeWidth={1.6} />
            {t("send.documents.savingInto", { folder: props.folderName })}
          </p>
        ) : null}
      </div>

      <Composer
        title={props.title}
        onTitle={props.onTitle}
        value={props.content}
        onChange={props.onContent}
        autoFocus={props.isNew ? "title" : undefined}
        disabled={props.disabled}
        toolbarRight={
          <span className="flex items-center gap-1.5 text-[11px] text-muted-2 whitespace-nowrap">
            {props.renderError ? (
              <>
                <AlertTriangle className="size-3.5 text-danger" strokeWidth={1.6} />
                <span className="text-danger">{t("send.documents.write.renderFailed")}</span>
              </>
            ) : props.rendering ? (
              <>
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />
                {t("send.documents.write.rendering")}
              </>
            ) : null}
          </span>
        }
      />

      {props.hasFields ? (
        <p className="text-[12px] text-muted-2">{t("send.documents.write.fieldsKept")}</p>
      ) : null}

      {props.isNew ? (
        <div>
          <Button
            size="sm"
            icon={<UploadCloud className="size-3.5" strokeWidth={1.6} />}
            onClick={props.onBackToUpload}
            disabled={props.disabled}
          >
            {t("send.documents.write.backToUpload")}
          </Button>
        </div>
      ) : (
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
      )}
    </div>
  );
}
