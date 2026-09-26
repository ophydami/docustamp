import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useTranslation } from "react-i18next";
import { PdfThumbnail } from "../EditorPdf";
import { PREFILL_COLOR, THUMB_WIDTH } from "../constants";
import { cn } from "@/lib/cn";
import type { EditorField, PageSize, SignerRow } from "../types";

export interface ThumbnailsProps {
  doc: PDFDocumentProxy;
  pages: PageSize[];
  fields: EditorField[];
  signers: SignerRow[];
  current: number;
  onGoTo: (page: number) => void;
}

export function Thumbnails({ doc, pages, fields, signers, current, onGoTo }: ThumbnailsProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("editor.thumbnails.title")} className="w-[92px] shrink-0 bg-surface border-r border-line overflow-auto scroll-thin py-3">
      <ul className="flex flex-col items-center gap-3">
        {pages.map((page) => {
          const marks = fields.filter((f) => f.page === page.number);
          const active = page.number === current;
          const scale = THUMB_WIDTH / page.width;
          return (
            <li key={page.number}>
              <button
                type="button"
                onClick={() => onGoTo(page.number)}
                aria-current={active ? "true" : undefined}
                aria-label={t("editor.thumbnails.pageLabel", { page: page.number, count: marks.length })}
                className="flex flex-col items-center gap-1 group"
              >
                <span
                  className={cn(
                    "relative block paper-white",
                    active ? "outline outline-2 outline-ink" : "outline outline-1 outline-line group-hover:outline-line-strong"
                  )}
                >
                  <PdfThumbnail doc={doc} info={page} width={THUMB_WIDTH} />
                  <span className="absolute inset-0">
                    {marks.map((f) => {
                      const signer = signers.find((s) => s.id === f.signerId);
                      const color = signer && signer.color !== PREFILL_COLOR ? signer.color : "#b5412e";
                      return (
                        <span
                          key={f.id}
                          className="absolute rounded-[1px]"
                          style={{
                            left: f.widget.xPosition * scale,
                            top: f.widget.yPosition * scale,
                            width: Math.max(f.widget.Width * scale, 3),
                            height: Math.max(f.widget.Height * scale, 2),
                            background: color,
                            opacity: 0.75
                          }}
                        />
                      );
                    })}
                  </span>
                </span>
                <span className={cn("num text-[10px]", active ? "text-ink font-semibold" : "text-muted-2")}>
                  {page.number}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
