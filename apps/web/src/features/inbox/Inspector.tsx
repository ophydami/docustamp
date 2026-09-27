import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Avatar, Button, Cap, Pill } from "@/components/ui";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { whenShort } from "@/lib/format";
import { agoShort, shortDuration, typicalSignTime } from "./metrics";
import { firstName } from "./DocumentRow";
import type { DocumentRecord } from "./types";

function PagePlaceholders() {
  return (
    <div className="flex gap-2 items-center">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[66px] h-[86px] rounded-[3px] bg-surface border border-line" />
      ))}
    </div>
  );
}

/**
 * First pages of the document. PdfViewer lays its pages out in a column, so the
 * strip flips it to a row and clips whatever does not fit the 156px box.
 */
function Thumbnails({ url, loading }: { url?: string; loading: boolean }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="h-[156px] rounded-lg bg-ground border border-line flex items-center px-3 overflow-hidden [&>div]:flex-row!">
      {loading ? (
        <Loader2 className="size-4 animate-spin text-muted-2 mx-auto" />
      ) : url && !failed ? (
        <PdfViewer
          src={url}
          pageWidth={66}
          gap={8}
          onError={() => setFailed(true)}
          className="items-center"
          pageClassName="shrink-0 rounded-[3px]"
        />
      ) : (
        <PagePlaceholders />
      )}
    </div>
  );
}

export interface InspectorProps {
  doc: DocumentRecord;
  detail?: DocumentRecord;
  detailLoading: boolean;
  detailError: boolean;
  /** Every document on screen, used for the "usually signs within" estimate. */
  docs: DocumentRecord[];
  onSign: () => void;
  onRemind: () => void;
  onOpenDocument: () => void;
  onDownload: () => void;
  reminding: boolean;
}

export function Inspector({
  doc,
  detail,
  detailLoading,
  detailError,
  docs,
  onSign,
  onRemind,
  onOpenDocument,
  onDownload,
  reminding
}: InspectorProps) {
  const { t } = useTranslation();
  const full = detail ?? doc;
  // A completed or declined document is waiting on nobody, so no "their turn".
  const settled = full.isCompleted || full.isDeclined;
  const pending = settled ? [] : full.recipients.filter((r) => !r.signedAt);
  const next = settled ? undefined : (full.nextSigner ?? pending[0]);
  const typical = next ? typicalSignTime(docs, next.email) : undefined;
  const lastPending = full.needsMe && pending.length === 1;
  const showHint = lastPending || (!!next && !next.isMe && typical !== undefined);

  return (
    <aside className="hidden xl:flex w-[344px] shrink-0 border-l border-line bg-surface flex-col overflow-y-auto scroll-thin">
      <div className="px-5 py-[18px] flex flex-col gap-3.5">
        <div className="flex items-center justify-between">
          <Cap>{t("inbox.inspector.selected")}</Cap>
          <Link
            to={`/documents/${full.id}`}
            className="text-[12px] text-accent inline-flex items-center gap-0.5"
          >
            {t("inbox.inspector.openFullView")}
            <ArrowUpRight className="size-3" strokeWidth={1.6} />
          </Link>
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-[16px] leading-snug tracking-[-.015em]">{full.name}</h2>
          <p className="text-[11px] text-muted-2 flex gap-1.5">
            <span className="font-mono">{full.id.slice(0, 8)}</span>
            {full.pageCount ? <span>· {t("common.count.page", { count: full.pageCount })}</span> : null}
            <span>· {t("common.count.recipient", { count: full.recipients.length })}</span>
          </p>
        </div>

        <Thumbnails
          key={detail?.signedUrl ?? detail?.url ?? full.id}
          url={detail?.signedUrl ?? detail?.url}
          loading={detailLoading && !detailError}
        />

        <div className="flex gap-2">
          {full.needsMe ? (
            <Button variant="primary" size="md" className="flex-1" onClick={onSign}>
              {t("inbox.actions.reviewAndSign")}
            </Button>
          ) : full.isCompleted ? (
            <Button size="md" className="flex-1" onClick={onDownload}>
              {t("inbox.actions.downloadSignedPdf")}
            </Button>
          ) : (
            <Button size="md" className="flex-1" onClick={onOpenDocument}>
              {t("inbox.actions.openDocument")}
            </Button>
          )}
          {full.isMine && next && !full.isCompleted && !full.isDeclined ? (
            <Button size="md" className="flex-1" loading={reminding} onClick={onRemind}>
              {t("inbox.actions.remindOthers")}
            </Button>
          ) : null}
        </div>

        {full.lastReminderAt ? (
          <p className="text-[11px] text-muted-2">
            {t("inbox.inspector.reminded", { ago: agoShort(full.lastReminderAt) })}
          </p>
        ) : null}
      </div>

      <div className="px-5 pb-5 flex flex-col gap-2.5 border-t border-line pt-4">
        <Cap>{t("inbox.inspector.signingOrder")}</Cap>
        {full.recipients.length ? (
          <ol className="flex flex-col gap-2.5">
            {full.recipients.map((r) => (
              <li key={`${r.order}-${r.email}`} className="flex items-center gap-2.5">
                <span className="num text-[11px] text-muted-2 w-3">{r.order}</span>
                <Avatar
                  name={r.name}
                  email={r.email}
                  size={22}
                  tone={r.isMe ? "ink" : r.signedAt ? "success" : "neutral"}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] truncate">
                    {r.isMe ? t("inbox.you") : r.name}
                  </span>
                  <span className="block text-[11px] text-muted-2 truncate">
                    {r.signedAt
                      ? t("inbox.inspector.signedAt", { when: whenShort(r.signedAt) })
                      : (r.openCount ?? 0) > 1
                        ? t("inbox.inspector.openedTimes", {
                            count: r.openCount,
                            when: whenShort(r.lastOpenedAt ?? r.viewedAt)
                          })
                        : r.viewedAt
                          ? t("inbox.inspector.openedAt", { when: whenShort(r.viewedAt) })
                          : t("inbox.inspector.notOpened")}
                  </span>
                </span>
                {!r.signedAt && r.order === next?.order ? (
                  <Pill tone={r.isMe ? "accent" : "warn"}>
                    {r.isMe ? t("inbox.inspector.yourTurn") : t("inbox.inspector.theirTurn")}
                  </Pill>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[12px] text-muted-2">{t("inbox.empty.noRecipientsSentence")}</p>
        )}
      </div>

      <div className="px-5 pb-5 flex flex-col gap-2 border-t border-line pt-4">
        <Cap>{t("inbox.inspector.activity")}</Cap>
        {detailLoading && !detail ? (
          <Loader2 className="size-4 animate-spin text-muted-2" />
        ) : full.activity.length ? (
          <ul className="flex flex-col gap-1.5">
            {full.activity.slice(0, 8).map((a, i) => (
              <li key={i} className="flex gap-2 text-[12px]">
                <span className="font-mono text-[11px] text-muted-2 shrink-0">
                  {a.at ? whenShort(a.at) : "--"}
                </span>
                <span className="text-ink-2 truncate">
                  {t("inbox.activity.line", { what: a.what, who: a.who })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted-2">{t("inbox.inspector.noActivity")}</p>
        )}
        {detailError ? (
          <p className="text-[12px] text-danger">{t("inbox.errors.detailFailed")}</p>
        ) : null}
      </div>

      {showHint ? (
        <div className="mx-5 mb-5 rounded-lg bg-accent-tint border border-accent-line px-3.5 py-3">
          {lastPending ? (
            <p className="text-[12px] font-semibold text-accent">
              {t("inbox.inspector.signNowHint")}
            </p>
          ) : null}
          {next && !next.isMe && typical !== undefined ? (
            <p className="text-[12px] text-ink-2 mt-1">
              {t("inbox.inspector.typicalHint", {
                name: firstName(next.name),
                duration: shortDuration(typical)
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
