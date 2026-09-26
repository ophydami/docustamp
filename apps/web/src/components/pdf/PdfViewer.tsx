import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { pageBoxOfPdfJs } from "@/lib/pageBox";

// Worker served by Vite from node_modules. The legacy build ships polyfills for
// Uint8Array.prototype.toHex/toBase64, which pdf.js 6 relies on but older
// browsers (and many in-app webviews) lack: "n.toHex is not a function".
pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

export interface PdfPageInfo {
  /** 1-based page number */
  number: number;
  /**
   * Intrinsic page size in PDF points, in the top-left system the fields are
   * stored in: the shared rule in @/lib/pageBox, which the editor, the signing
   * page's stamping pass and the server all measure with.
   */
  width: number;
  height: number;
  /** The painted area, i.e. `height` without the CropBox offset. */
  renderHeight: number;
  /** CropBox origin offsets in points (page.view[0], page.view[1]); usually 0. */
  cropX: number;
  cropY: number;
  /** Page rotation in degrees (0/90/180/270). */
  rotation: number;
}

export interface PdfViewerProps {
  /** URL or raw bytes of the PDF. */
  src: string | ArrayBuffer | Uint8Array;
  /** Rendered page width in CSS px. Height follows the page aspect. */
  pageWidth: number;
  /** Overlay rendered on top of each page (fields, signatures). Receives the page and the scale (css px per PDF point). */
  renderOverlay?: (page: PdfPageInfo, scale: number) => ReactNode;
  /** Called once the document is parsed, with every page's intrinsic size. */
  onLoad?: (pages: PdfPageInfo[]) => void;
  onError?: (err: Error) => void;
  /** Ref callback per page element, for scroll-to-page. */
  pageRef?: (number: number, el: HTMLDivElement | null) => void;
  className?: string;
  pageClassName?: string;
  gap?: number;
  /** Render only the first N pages (thumbnails, previews). */
  maxPages?: number;
  /** Render only these 1-based pages. Takes precedence over maxPages. */
  pages?: number[];
}

/**
 * Renders every page of a PDF to a canvas at `pageWidth`, with an optional
 * absolutely-positioned overlay per page. Coordinates in the overlay are
 * `pdfPoint * scale`, where `scale = pageWidth / page.width`.
 */
export function PdfViewer({
  src,
  pageWidth,
  renderOverlay,
  onLoad,
  onError,
  pageRef,
  className,
  pageClassName,
  gap = 16,
  maxPages,
  pages: onlyPages
}: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PdfPageInfo[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPages([]);
    setError(null);
    const task = pdfjs.getDocument(
      typeof src === "string" ? { url: src, withCredentials: false } : { data: src instanceof Uint8Array ? src : new Uint8Array(src) }
    );
    task.promise
      .then(async (d) => {
        if (cancelled) return;
        const infos: PdfPageInfo[] = [];
        const last = maxPages ? Math.min(d.numPages, maxPages) : d.numPages;
        for (let i = 1; i <= last; i++) {
          if (onlyPages && !onlyPages.includes(i)) continue;
          const p = await d.getPage(i);
          const box = pageBoxOfPdfJs(p);
          infos.push({
            number: i,
            width: box.width,
            height: box.height,
            renderHeight: box.renderHeight,
            cropX: box.cropX,
            cropY: box.cropY,
            rotation: box.rotation
          });
        }
        if (cancelled) return;
        setDoc(d);
        setPages(infos);
        onLoad?.(infos);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e);
        onError?.(e);
      });
    return () => {
      cancelled = true;
      task.destroy().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (error) {
    return (
      <div className={cn("flex items-center justify-center text-danger text-[13px] p-8", className)}>
        Could not load this PDF. {error.message}
      </div>
    );
  }
  if (!doc) {
    return (
      <div className={cn("flex items-center justify-center text-muted-2 p-12", className)}>
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col items-center", className)} style={{ gap }}>
      {pages.map((p) => (
        <PdfPage
          key={p.number}
          doc={doc}
          info={p}
          width={pageWidth}
          className={pageClassName}
          overlay={renderOverlay}
          pageRef={pageRef}
        />
      ))}
    </div>
  );
}

function PdfPage({
  doc,
  info,
  width,
  overlay,
  className,
  pageRef
}: {
  doc: PDFDocumentProxy;
  info: PdfPageInfo;
  width: number;
  overlay?: (page: PdfPageInfo, scale: number) => ReactNode;
  className?: string;
  pageRef?: (number: number, el: HTMLDivElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scale = width / info.width;
  // The page box can be taller than what pdf.js paints (a CropBox with a y
  // origin), so the canvas keeps the painted height and the page element keeps
  // the box: overlay coordinates and the paper then line up with the fields.
  const height = Math.round(info.height * scale);
  const canvasHeight = Math.round(info.renderHeight * scale);

  useEffect(() => {
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    doc.getPage(info.number).then((p) => {
      if (cancelled) return;
      page = p;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${canvasHeight}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderTask = p.render({ canvasContext: ctx, viewport: vp, canvas });
      renderTask.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [doc, info.number, scale, width, canvasHeight]);

  const style = useMemo(() => ({ width, height }), [width, height]);

  return (
    <div
      ref={(el) => pageRef?.(info.number, el)}
      data-page={info.number}
      className={cn("relative paper-white border border-line shadow-[var(--shadow-page)]", className)}
      style={style}
    >
      <canvas ref={canvasRef} className="block" />
      {overlay ? <div className="absolute inset-0">{overlay(info, scale)}</div> : null}
    </div>
  );
}

/** Hook: keep track of which page is most visible inside a scroll container. */
export function useVisiblePage(containerRef: React.RefObject<HTMLElement | null>, pageCount: number) {
  const [current, setCurrent] = useState(1);
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !pageCount) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[data-page]"));
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = 1;
        let bestRatio = -1;
        ratios.forEach((r, n) => {
          if (r > bestRatio) {
            bestRatio = r;
            best = n;
          }
        });
        setCurrent(best);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [containerRef, pageCount]);
  return current;
}
