import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, AvatarStack, Checkbox, Pill } from "@/components/ui";
import type { AvatarTone, PillTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num, whenShort } from "@/lib/format";
import { agoShort } from "./metrics";
import type { DocumentRecord } from "./types";

/**
 * Column track shared by the header and every row. The table only exists from
 * 768px up; below that each document is a stacked card instead.
 *
 * Columns come and go with the width of the table itself (container queries on
 * the Card), not the viewport: the Inspector takes 344px at xl, so a viewport
 * breakpoint would add the recipients column at exactly the moment the table
 * loses the room for it, and the 1fr name column would collapse to nothing.
 * Tiers (table width): < 640 name, progress, action; >= 640 adds updated;
 * >= 860 adds recipients and widens progress.
 */
export const GRID =
  "hidden md:grid grid-cols-[24px_minmax(0,1fr)_170px_96px] @min-[640px]:grid-cols-[24px_minmax(0,1fr)_170px_100px_96px] @min-[860px]:grid-cols-[24px_minmax(0,1fr)_160px_210px_100px_96px] gap-3 items-center px-3.5";
/** Display classes for the cells that only exist in the wider tiers. Keep in step with GRID. */
export const RECIPIENTS_CELL = "hidden @min-[860px]:flex";
export const RECIPIENTS_HEAD = "hidden @min-[860px]:block";
export const UPDATED_CELL = "hidden @min-[640px]:block";

export type RowActionKind = "sign" | "remind" | "download" | "recreate" | "open";

export interface RowAction {
  kind: RowActionKind;
  label: string;
  primary: boolean;
}

/** The one action that matters for a row, given where the document stands. */
export function rowAction(doc: DocumentRecord, t: TFunction): RowAction {
  if (doc.needsMe) return { kind: "sign", label: t("common.actions.sign"), primary: true };
  if (doc.status === "waiting" && doc.isMine && doc.nextSigner)
    return { kind: "remind", label: t("common.actions.remind"), primary: false };
  if (doc.isCompleted)
    return { kind: "download", label: t("common.actions.download"), primary: false };
  if (doc.isDeclined && doc.isMine)
    return { kind: "recreate", label: t("inbox.actions.recreate"), primary: false };
  return { kind: "open", label: t("common.actions.open"), primary: false };
}

export function statusPill(doc: DocumentRecord, t: TFunction): { text: string; tone: PillTone } {
  switch (doc.status) {
    case "needsYou":
      return { text: t("inbox.status.needsYourSignature"), tone: "accent" };
    case "completed":
      return { text: t("common.status.completed"), tone: "ink" };
    case "declined":
      return {
        text: doc.declineReason
          ? t("inbox.status.declinedWithReason", { reason: doc.declineReason })
          : t("common.status.declined"),
        tone: "danger"
      };
    case "draft":
      return { text: t("common.status.draft"), tone: "neutral" };
    case "expired":
      return { text: t("common.status.expired"), tone: "danger" };
    default:
      return doc.nextSigner
        ? {
            text: t("inbox.status.waitingOn", { name: firstName(doc.nextSigner.name) }),
            tone: "warn"
          }
        : {
            text: t("inbox.status.signedOf", {
              signed: num(doc.signedCount),
              total: num(doc.recipients.length)
            }),
            tone: "warn"
          };
  }
}

export function firstName(name: string) {
  return name.split(/[\s@]/)[0] || name;
}

const barTone: Record<DocumentRecord["status"], string> = {
  needsYou: "bg-accent",
  waiting: "bg-warn",
  completed: "bg-ink",
  declined: "bg-danger",
  expired: "bg-danger",
  draft: "bg-line-strong"
};

function avatarTone(signed: boolean, isMe: boolean): AvatarTone {
  if (isMe) return "ink";
  return signed ? "accent" : "neutral";
}

/** "aB3dEf91 · 4 pages · sequential, you are next · reminded 2h ago" */
function metaLine(doc: DocumentRecord, t: TFunction) {
  const bits: string[] = [];
  if (doc.pageCount) bits.push(t("common.count.page", { count: doc.pageCount }));
  if (doc.sendInOrder)
    bits.push(t(doc.needsMe ? "inbox.meta.sequentialYouAreNext" : "inbox.meta.sequential"));
  if (doc.isSelfSign) bits.push(t("inbox.meta.onlyYouSign"));
  if (doc.lastReminderAt && !doc.isCompleted)
    bits.push(t("inbox.meta.reminded", { ago: agoShort(doc.lastReminderAt) }));
  return bits;
}

export interface DocumentRowProps {
  doc: DocumentRecord;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onCheck: () => void;
  onAction: (kind: RowActionKind) => void;
  busy?: boolean;
}

export function DocumentRow({
  doc,
  selected,
  checked,
  onSelect,
  onOpen,
  onCheck,
  onAction,
  busy
}: DocumentRowProps) {
  const { t } = useTranslation();
  const pill = statusPill(doc, t);
  const action = rowAction(doc, t);
  const total = doc.recipients.length;
  const progress = doc.isCompleted
    ? 1
    : total
      ? doc.signedCount / total
      : doc.isDraft
        ? 0
        : 0.5;

  const actionButton = (
    <Button
      size="sm"
      variant={action.primary ? "primary" : "default"}
      loading={busy}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
        onAction(action.kind);
      }}
    >
      {action.label}
    </Button>
  );

  const progressBar = (
    <div className="h-1 rounded-full bg-line-soft overflow-hidden">
      <div
        className={cn("h-full rounded-full", barTone[doc.status])}
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  );

  const avatars = total ? (
    <AvatarStack
      size={22}
      max={4}
      people={doc.recipients.map((r) => ({
        name: r.name,
        email: r.email,
        tone: avatarTone(!!r.signedAt, r.isMe)
      }))}
    />
  ) : (
    <span className="text-[12px] text-muted-2">{t("inbox.empty.noRecipients")}</span>
  );

  return (
    <>
    <div
      role="row"
      onClick={onOpen}
      className={cn(
        "md:hidden border-b border-line-soft px-4 py-3 flex flex-col gap-2.5 text-[13px]",
        selected ? "bg-accent-tint" : ""
      )}
    >
      <div className="min-w-0">
        <button type="button" onClick={onOpen} className="block w-full text-left min-w-0">
          <span className="block font-semibold text-ink truncate">{doc.name}</span>
          <span className="block text-[11px] text-muted-2 truncate">
            <span className="font-mono">{doc.id.slice(0, 8)}</span>
            {metaLine(doc, t).map((b) => (
              <span key={b}> · {b}</span>
            ))}
          </span>
        </button>
      </div>

      {progressBar}

      <div className="flex items-center gap-2 min-w-0">
        <Pill tone={pill.tone} className="min-w-0">
          <span className="truncate">{pill.text}</span>
        </Pill>
        <span className="num text-[12px] text-muted ml-auto shrink-0">{whenShort(doc.updatedAt)}</span>
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="min-w-0 truncate">{avatars}</span>
        <span className="ml-auto shrink-0">{actionButton}</span>
      </div>
    </div>

    <div
      role="row"
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "h-[54px] border-b border-line-soft cursor-default text-[13px]",
        GRID,
        selected ? "bg-accent-tint shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-surface-2"
      )}
    >
      <Checkbox
        checked={checked}
        onChange={onCheck}
        label={t("inbox.a11y.selectDocument", { name: doc.name })}
      />

      <div className="min-w-0">
        <div className="font-semibold text-ink truncate">{doc.name}</div>
        <div className="text-[11px] text-muted-2 truncate flex gap-1.5">
          <span className="font-mono">{doc.id.slice(0, 8)}</span>
          {metaLine(doc, t).map((b) => (
            <span key={b}>· {b}</span>
          ))}
        </div>
      </div>

      <div className={cn(RECIPIENTS_CELL, "items-center")}>{avatars}</div>

      <div className="flex flex-col gap-1.5 min-w-0">
        {progressBar}
        <Pill tone={pill.tone} className="max-w-full truncate">
          <span className="truncate">{pill.text}</span>
        </Pill>
      </div>

      <span className={cn(UPDATED_CELL, "num text-[12px] text-muted")}>{whenShort(doc.updatedAt)}</span>

      <div className="flex justify-end">{actionButton}</div>
    </div>
    </>
  );
}
