import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { cn } from "@/lib/cn";
import { pageBoxOfPdfJs } from "@/lib/pageBox";
import type { PageSize } from "./types";

/**
 * A local variant of `@/components/pdf/PdfViewer`.
 *
 * The shared viewer renders every page eagerly and owns its own PDFDocumentProxy.
 * The editor needs (a) lazy page rendering for long PDFs, (b) the same proxy shared
 * with the thumbnail rail and the auto-detect text scan, and (c) a per-page overlay
 * that survives re-renders while dragging. Rather than change the shared component
 * under other features, this file re-implements the parts the editor needs. The
 * coordinate contract is identical: overlay px = pdfPoint * scale.
 */

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

export interface PdfDocState {
  doc: PDFDocumentProxy | null;
  pages: PageSize[];
  error: Error | null;
  loading: boolean;
}

/** Parse a PDF once and expose every page's intrinsic size in points. */
export function usePdfDocument(bytes: Uint8Array | undefined): PdfDocState {
  const [state, setState] = useState<PdfDocState>({ doc: null, pages: [], error: null, loading: false });

  useEffect(() => {
    if (!bytes) {
      setState({ doc: null, pages: [], error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ doc: null, pages: [], error: null, loading: true });
    // pdf.js takes ownership of the buffer, so hand it a copy: the bytes are cached
    // by react-query and must stay usable if this effect runs again.
    const task = pdfjs.getDocument({ data: bytes.slice() });
    task.promise
      .then(async (doc) => {
        const pages: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const box = pageBoxOfPdfJs(page);
          pages.push({ number: i, width: box.width, height: box.height, renderHeight: box.renderHeight });
        }
        // The task's own destroy() in the cleanup below tears the document down.
        if (cancelled) return;
        setState({ doc, pages, error: null, loading: false });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ doc: null, pages: [], error: e, loading: false });
      });
    return () => {
      cancelled = true;
      task.destroy().catch(() => undefined);
    };
  }, [bytes]);

  return state;
}

interface PageProps {
  doc: PDFDocumentProxy;
  info: PageSize;
  /** Rendered width in CSS px. */
  width: number;
  overlay?: (page: PageSize, scale: number) => ReactNode;
  onPointerDown?: (e: React.PointerEvent, page: PageSize, scale: number) => void;
  pageRef?: (n: number, el: HTMLDivElement | null) => void;
  scrollRoot?: HTMLElement | null;
  className?: string;
}

/** One page. The canvas only renders once the page is near the viewport. */
export function PdfPageView({ doc, info, width, overlay, onPointerDown, pageRef, scrollRoot, className }: PageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / info.width;
  // The page box can be taller than what pdf.js paints (a CropBox with a y
  // origin); the canvas keeps the painted height, the page element the box.
  const height = Math.round(info.height * scale);
  const canvasHeight = Math.round(info.renderHeight * scale);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true);
      },
      { root: scrollRoot ?? null, rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    doc.getPage(info.number).then((page) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${canvasHeight}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const render = page.render({ canvasContext: ctx, viewport: vp, canvas });
      task = render;
      render.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, info.number, scale, width, canvasHeight, visible]);

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        pageRef?.(info.number, el);
      }}
      data-page={info.number}
      className={cn("relative paper-white border border-line shadow-[var(--shadow-page)]", className)}
      style={{ width, height }}
      onPointerDown={onPointerDown ? (e) => onPointerDown(e, info, scale) : undefined}
    >
      <canvas ref={canvasRef} className="block" />
      {overlay ? <div className="absolute inset-0">{overlay(info, scale)}</div> : null}
    </div>
  );
}

/** A small page thumbnail for the rail. Renders once it scrolls into the rail. */
export function PdfThumbnail({ doc, info, width }: { doc: PDFDocumentProxy; info: PageSize; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / info.width;
  const canvasHeight = Math.round(info.renderHeight * scale);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true);
      },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    doc.getPage(info.number).then((page) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${canvasHeight}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const render = page.render({ canvasContext: ctx, viewport: vp, canvas });
      task = render;
      render.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, info.number, scale, width, canvasHeight, visible]);

  return <canvas ref={canvasRef} className="block paper-white" style={{ width, height: canvasHeight }} />;
}

/** Track which page fills most of the scroll container. */
export function useCurrentPage(root: HTMLElement | null, count: number) {
  const [current, setCurrent] = useState(1);
  useEffect(() => {
    if (!root || !count) return;
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
      { root, threshold: [0, 0.2, 0.5, 0.8, 1] }
    );
    const observe = () => {
      root.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => io.observe(el));
    };
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root, count]);
  return current;
}

/** Measure an element's width, for fit-to-width zoom. */
export function useElementWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [el]);
  return useMemo(() => width, [width]);
}
