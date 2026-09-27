import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Plus, Sparkles } from "lucide-react";
import { Button, Cap } from "@/components/ui";
import { cn } from "@/lib/cn";
import { PdfViewer, type PdfPageInfo } from "@/components/pdf/PdfViewer";
import { formatBytes } from "../upload";
import type { HistorySuggestion } from "../suggest";
import { num } from "@/lib/format";

const PREVIEW_WIDTH = 250;

export interface PreviewAsideProps {
  /** Bytes for a just-uploaded file, or a signed url for a resumed draft. */
  src: string | Uint8Array | null;
  fileName: string;
  bytes?: number;
  pageCount?: number;
  decrypted?: boolean;
  converted?: boolean;
  suggestion?: HistorySuggestion | null;
  onPages?: (count: number) => void;
  onAddSuggested?: (r: { name: string; email: string }) => void;
  onUseExpiry?: (days: number) => void;
  /**
   * Below 1024 the aside is not part of the layout: it is hidden until the header's
   * "Preview" button opens it, and then it sits over the page.
   */
  open?: boolean;
}

export function PreviewAside({
  src,
  fileName,
  bytes,
  pageCount,
  decrypted,
  converted,
  suggestion,
  onPages,
  onAddSuggested,
  onUseExpiry,
  open = false
}: PreviewAsideProps) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<PdfPageInfo[]>([]);
  const count = pageCount || pages.length;

  const firstPageHeight = useMemo(() => {
    const first = pages[0];
    if (!first) return 320;
    return Math.round((PREVIEW_WIDTH / first.width) * first.height);
  }, [pages]);

  const facts = [
    count ? t("common.count.page", { count }) : null,
    bytes ? formatBytes(bytes) : null,
    decrypted ? t("send.preview.passwordRemoved") : null,
    converted ? t("send.preview.convertedFromWord") : null
  ].filter(Boolean) as string[];

  return (
    <aside
      className={cn(
        "border-l border-line bg-surface overflow-y-auto scroll-thin",
        "lg:static lg:block lg:w-[420px] lg:shrink-0 lg:shadow-none",
        open
          ? "fixed z-30 top-14 bottom-0 right-0 w-[min(420px,88vw)] shadow-[var(--shadow-pop)]"
          : "hidden"
      )}
    >
      <div className="px-5 py-5 lg:px-7 lg:py-6 flex flex-col gap-4">
        <Cap>{t("send.preview.heading")}</Cap>

        {src ? (
          <>
            <div className="flex items-start gap-3 border border-line rounded-xl px-3.5 py-3">
              <span className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent shrink-0">
                <FileText className="size-4" strokeWidth={1.6} />
              </span>
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[13px] font-semibold truncate" title={fileName}>
                  {fileName}
                </span>
                <span className="text-[11px] text-muted-2">
                  {facts.length ? facts.join(" · ") : t("send.preview.reading")}
                </span>
              </span>
            </div>

            <div className="bg-sand rounded-lg p-5 flex flex-col items-center gap-3">
              <div
                className="overflow-hidden rounded-[2px]"
                style={{ width: PREVIEW_WIDTH, height: firstPageHeight }}
              >
                <PdfViewer
                  src={src}
                  pageWidth={PREVIEW_WIDTH}
                  onLoad={(loaded) => {
                    setPages(loaded);
                    onPages?.(loaded.length);
                  }}
                  gap={16}
                />
              </div>
              <span className="num text-[11px] text-muted-2">
                {t("send.preview.pageOf", { total: count ? num(count) : "?" })}
              </span>
            </div>
          </>
        ) : (
          <div className="bg-sand rounded-lg px-5 py-12 flex flex-col items-center gap-2 text-center">
            <FileText className="size-5 text-faint" strokeWidth={1.6} />
            <span className="text-[12px] text-muted-2 max-w-[240px]">
              {t("send.preview.emptyHint")}
            </span>
          </div>
        )}

        {suggestion ? (
          <div className="bg-ground border border-line rounded-xl px-4 py-3.5 flex flex-col gap-3">
            <span className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-muted-2" strokeWidth={1.6} />
              <Cap>{t("send.preview.suggestedHeading")}</Cap>
            </span>
            <p className="text-[12px] text-muted">
              {t("send.preview.from", { count: suggestion.sampleSize, domain: suggestion.domain })}
            </p>
            {suggestion.recipients.length ? (
              <ul className="flex flex-col gap-1.5">
                {suggestion.recipients.map((r) => (
                  <li key={r.email} className="flex items-center gap-2">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] font-medium truncate">{r.name || r.email}</span>
                      <span className="block text-[11px] text-muted-2 truncate">
                        {r.email} · {t("send.preview.addedTimes", { count: r.count })}
                      </span>
                    </span>
                    <Button
                      size="xs"
                      icon={<Plus className="size-3" strokeWidth={1.6} />}
                      onClick={() => onAddSuggested?.(r)}
                    >
                      {t("common.actions.add")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {suggestion.expiryDays && onUseExpiry ? (
              <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
                <span className="text-[12px] text-muted">
                  {t("send.preview.usualExpiry", { count: suggestion.expiryDays })}
                </span>
                <Button size="xs" onClick={() => onUseExpiry(suggestion.expiryDays as number)}>
                  {t("send.actions.use")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
