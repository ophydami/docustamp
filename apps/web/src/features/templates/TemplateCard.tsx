import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, MoreHorizontal, Pencil } from "lucide-react";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { Button, Input, Menu, Pill } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num, whenShort } from "@/lib/format";
import { useTemplateThumbUrl } from "./api";
import type { Template } from "./types";

const THUMB_WIDTH = 120;

/** Mount the PDF only once the card scrolls near the viewport. */
function useInView<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

function Thumb({ template }: { template: Template }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [pageCount, setPageCount] = useState(0);
  const [failed, setFailed] = useState(false);
  // The row url is already presigned by TemplateAfterFind, so the gallery
  // renders straight from it and only asks for a fresh signature when that
  // one turns out to be unsigned (past the trigger's 200-object cap) or stale.
  const [needsFreshUrl, setNeedsFreshUrl] = useState(false);
  const { data: fresh, isError } = useTemplateThumbUrl(template.id, template.url, inView && needsFreshUrl);
  // Still gated on `inView`: the card must not fetch a PDF it is not showing.
  const url = needsFreshUrl ? fresh : inView ? template.url : undefined;

  const pages = pageCount || template.fieldPages;
  const pills: string[] = [];
  if (pages) pills.push(t("common.count.page", { count: pages }));
  pills.push(t("common.count.field", { count: template.fieldCount }));

  return (
    <div ref={ref} className="relative h-[150px] bg-sand border-b border-line overflow-hidden">
      <div className="absolute inset-0 flex items-start justify-center pt-3">
        {url && !failed && !isError ? (
          // The viewer renders every page; the box clips everything past the first.
          <PdfViewer
            src={url}
            pageWidth={THUMB_WIDTH}
            gap={12}
            onLoad={(p) => setPageCount(p.length)}
            onError={() => (needsFreshUrl ? setFailed(true) : setNeedsFreshUrl(true))}
            pageClassName="rounded-[2px]"
          />
        ) : (
          <div className="w-[120px] h-[156px] rounded-[2px] paper-white border border-line flex items-center justify-center">
            <FileText className="size-5 text-faint" strokeWidth={1.6} />
          </div>
        )}
      </div>
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2 pointer-events-none">
        <Pill tone="neutral">{pills.join(" · ")}</Pill>
        {template.bulkReady ? (
          <Pill tone="accent">{t("templates.badge.bulkReady")}</Pill>
        ) : template.isPublic ? (
          <Pill tone="violet">{t("templates.badge.publicForm")}</Pill>
        ) : null}
      </div>
    </div>
  );
}

export interface TemplateCardProps {
  template: Template;
  selected: boolean;
  uses?: number;
  renaming: boolean;
  onSelect: () => void;
  onUse: () => void;
  onBulkSend: () => void;
  onEdit: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDuplicate: () => void;
  onShare?: () => void;
  onDelete: () => void;
}

export function TemplateCard({
  template,
  selected,
  uses,
  renaming,
  onSelect,
  onUse,
  onBulkSend,
  onEdit,
  onStartRename,
  onRename,
  onCancelRename,
  onDuplicate,
  onShare,
  onDelete
}: TemplateCardProps) {
  const { t } = useTranslation();
  const meta = [
    template.folder || t("templates.card.noFolder"),
    t("templates.card.updated", { when: whenShort(template.updatedAt) })
  ];
  if (template.ownerName) meta.push(t("templates.card.by", { name: template.ownerName }));

  return (
    <div
      onMouseDown={onSelect}
      className={cn(
        "bg-surface border border-line rounded-xl overflow-hidden flex flex-col shadow-[var(--shadow-card)]",
        selected ? "ring-2 ring-accent border-accent" : "hover:border-line-strong"
      )}
    >
      <button
        type="button"
        onClick={onUse}
        aria-label={t("templates.a11y.use", { name: template.name })}
        className="text-left cursor-pointer focus-visible:outline-none"
      >
        <Thumb template={template} />
      </button>

      <div className="flex flex-col gap-2 p-3">
        {renaming ? (
          <Input
            autoFocus
            defaultValue={template.name}
            aria-label={t("templates.fields.name")}
            className="h-8"
            onBlur={(e) => onRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRename(e.currentTarget.value);
              if (e.key === "Escape") onCancelRename();
            }}
          />
        ) : (
          <span className="text-[14px] font-semibold leading-tight truncate" title={template.name}>
            {template.name}
          </span>
        )}

        <span className="text-[11px] text-muted-2 truncate" title={meta.join(" · ")}>
          {meta.join(" · ")}
        </span>

        <div className="flex items-center gap-1.5 min-h-[18px]">
          {template.signerRoles.length ? (
            <>
              <span className="flex items-center gap-1 min-w-0">
                {template.signerRoles.slice(0, 3).map((r) => (
                  <span key={r.id} className="flex items-center gap-1 min-w-0">
                    <span className="swatch size-2 rounded-full shrink-0" style={{ ["--swatch" as string]: r.color, background: "var(--swatch-on)" }} />
                    <span className="text-[11px] text-ink-2 truncate max-w-[76px]">{r.name}</span>
                  </span>
                ))}
              </span>
              {template.signerRoles.length > 3 ? (
                <span className="text-[11px] text-muted-2">
                  {t("templates.card.moreRoles", { value: num(template.signerRoles.length - 3) })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-[11px] text-muted-2">{t("templates.card.noRoles")}</span>
          )}
          {uses !== undefined ? (
            <span className="num ml-auto text-[11px] text-muted-2 shrink-0">
              {t("templates.card.uses", { value: num(uses) })}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 pt-1">
          <Button size="sm" variant="primary" onClick={onUse} className="flex-1">
            {t("templates.actions.use")}
          </Button>
          <Button size="sm" icon={<Pencil className="size-3.5" strokeWidth={1.6} />} onClick={onEdit}>
            {t("common.actions.edit")}
          </Button>
          <Menu
            items={[
              ...(template.bulkReady
                ? [{ label: t("templates.actions.bulkSend"), onSelect: onBulkSend }, "separator" as const]
                : []),
              { label: t("common.actions.duplicate"), onSelect: onDuplicate },
              { label: t("common.actions.rename"), onSelect: onStartRename },
              ...(onShare
                ? ["separator" as const, { label: t("templates.actions.shareWithTeam"), onSelect: onShare }]
                : []),
              "separator" as const,
              { label: t("common.actions.delete"), onSelect: onDelete, danger: true }
            ]}
            trigger={(p) => (
              <Button size="sm" aria-label={t("templates.a11y.moreActions")} {...p}>
                <MoreHorizontal className="size-3.5" strokeWidth={1.6} />
              </Button>
            )}
          />
        </div>
      </div>
    </div>
  );
}
