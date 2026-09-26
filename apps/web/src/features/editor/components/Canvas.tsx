import { useCallback, useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfPageView } from "../EditorPdf";
import { WIDGET_BY_TYPE } from "../constants";
import { clampToPage, fieldRect, snapMove, snapResize, type Rect } from "../geometry";
import { FieldBox, type DragMode } from "./FieldBox";
import type { EditorField, PageSize, SignerRow, WidgetType } from "../types";

export interface FieldGeometry {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasProps {
  doc: PDFDocumentProxy;
  pages: PageSize[];
  /** css px per PDF point, per page. */
  scaleFor: (page: PageSize) => number;
  fields: EditorField[];
  signers: SignerRow[];
  selectedIds: string[];
  snap: boolean;
  preview: boolean;
  armedType: WidgetType | null;
  scrollRoot: HTMLElement | null;
  setScrollRoot: (el: HTMLElement | null) => void;
  pageRef: (n: number, el: HTMLDivElement | null) => void;
  onSelect: (ids: string[]) => void;
  onCommitGeometry: (updates: FieldGeometry[]) => void;
  onPlace: (type: WidgetType, page: number, x: number, y: number) => void;
  /** Records where the pointer is, so a keyboard shortcut can place a field there. */
  hoverRef: React.MutableRefObject<{ page: number; x: number; y: number } | null>;
}

interface DragItem {
  id: string;
  el: HTMLElement;
  start: Rect;
}

interface DragState {
  mode: DragMode;
  page: PageSize;
  scale: number;
  clientX: number;
  clientY: number;
  minWidth: number;
  minHeight: number;
  primary: DragItem;
  items: DragItem[];
  others: EditorField[];
  snap: boolean;
  moved: boolean;
  last: Map<string, Rect>;
}

const GUIDE = "#2f9e6e";

export function Canvas({
  doc,
  pages,
  scaleFor,
  fields,
  signers,
  selectedIds,
  snap,
  preview,
  armedType,
  scrollRoot,
  setScrollRoot,
  pageRef,
  onSelect,
  onCommitGeometry,
  onPlace,
  hoverRef
}: CanvasProps) {
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const guides = useRef(new Map<number, { x: HTMLElement | null; y: HTMLElement | null }>());
  // Kept in a ref so the window listeners below never need re-binding mid-drag.
  const commitRef = useRef(onCommitGeometry);
  useEffect(() => {
    commitRef.current = onCommitGeometry;
  }, [onCommitGeometry]);

  const setGuide = useCallback((page: number, axis: "x" | "y", at: number | null, scale: number) => {
    const el = guides.current.get(page)?.[axis];
    if (!el) return;
    if (at === null) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    if (axis === "x") el.style.left = `${at * scale}px`;
    else el.style.top = `${at * scale}px`;
  }, []);

  // One pair of window listeners for the component's lifetime. They no-op unless a
  // drag is in flight, and the drag itself writes styles directly so nothing
  // re-renders between pointerdown and pointerup.
  useEffect(() => {
    const applyFrame = (clientX: number, clientY: number) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(clientX - d.clientX) < 2 && Math.abs(clientY - d.clientY) < 2) return;
      d.moved = true;
      const dx = (clientX - d.clientX) / d.scale;
      const dy = (clientY - d.clientY) / d.scale;

      if (d.mode === "move") {
        const wanted: Rect = { ...d.primary.start, x: d.primary.start.x + dx, y: d.primary.start.y + dy };
        const res = snapMove(wanted, d.page, d.others, d.snap);
        const shiftX = res.rect.x - d.primary.start.x;
        const shiftY = res.rect.y - d.primary.start.y;
        for (const item of d.items) {
          const next = clampToPage({ ...item.start, x: item.start.x + shiftX, y: item.start.y + shiftY }, d.page);
          d.last.set(item.id, next);
          item.el.style.transform = `translate(${(next.x - item.start.x) * d.scale}px, ${(next.y - item.start.y) * d.scale}px)`;
        }
        setGuide(d.page.number, "x", res.guides.find((g) => g.axis === "x")?.at ?? null, d.scale);
        setGuide(d.page.number, "y", res.guides.find((g) => g.axis === "y")?.at ?? null, d.scale);
        return;
      }

      const s = d.primary.start;
      let rect: Rect = { ...s };
      if (d.mode === "se") rect = { x: s.x, y: s.y, w: s.w + dx, h: s.h + dy };
      else if (d.mode === "sw") rect = { x: s.x + dx, y: s.y, w: s.w - dx, h: s.h + dy };
      else if (d.mode === "ne") rect = { x: s.x, y: s.y + dy, w: s.w + dx, h: s.h - dy };
      else rect = { x: s.x + dx, y: s.y + dy, w: s.w - dx, h: s.h - dy };
      if (rect.w < d.minWidth) {
        if (d.mode === "sw" || d.mode === "nw") rect.x = s.x + s.w - d.minWidth;
        rect.w = d.minWidth;
      }
      if (rect.h < d.minHeight) {
        if (d.mode === "ne" || d.mode === "nw") rect.y = s.y + s.h - d.minHeight;
        rect.h = d.minHeight;
      }
      const res =
        d.mode === "se" ? snapResize(rect, d.page, d.others, d.snap) : { rect: clampToPage(rect, d.page), guides: [] };
      d.last.set(d.primary.id, res.rect);
      const el = d.primary.el;
      el.style.left = `${res.rect.x * d.scale}px`;
      el.style.top = `${res.rect.y * d.scale}px`;
      el.style.width = `${Math.max(res.rect.w * d.scale, 6)}px`;
      el.style.height = `${Math.max(res.rect.h * d.scale, 6)}px`;
      setGuide(d.page.number, "x", res.guides.find((g) => g.axis === "x")?.at ?? null, d.scale);
      setGuide(d.page.number, "y", res.guides.find((g) => g.axis === "y")?.at ?? null, d.scale);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const { clientX, clientY } = e;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => applyFrame(clientX, clientY));
    };

    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      if (!d) return;
      setGuide(d.page.number, "x", null, d.scale);
      setGuide(d.page.number, "y", null, d.scale);
      if (!d.moved) return;
      const updates: FieldGeometry[] = [];
      for (const item of d.items) {
        const r = d.last.get(item.id) ?? item.start;
        // Freeze the final geometry on the node so React's next paint matches.
        item.el.style.transform = "";
        item.el.style.left = `${r.x * d.scale}px`;
        item.el.style.top = `${r.y * d.scale}px`;
        item.el.style.width = `${Math.max(r.w * d.scale, 6)}px`;
        item.el.style.height = `${Math.max(r.h * d.scale, 6)}px`;
        updates.push({ id: item.id, x: r.x, y: r.y, w: r.w, h: r.h });
      }
      commitRef.current(updates);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [setGuide]);

  const startDrag = useCallback(
    (e: React.PointerEvent, field: EditorField, mode: DragMode) => {
      if (preview) return;
      e.preventDefault();
      e.stopPropagation();
      const page = pages.find((p) => p.number === field.page);
      if (!page) return;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let ids = selectedIds;
      if (!selectedIds.includes(field.id)) {
        ids = additive ? [...selectedIds, field.id] : [field.id];
        onSelect(ids);
      }

      const host = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-overlay]");
      if (!host) return;
      const scale = scaleFor(page);
      const spec = WIDGET_BY_TYPE[field.widget.type];
      const collect = (id: string): DragItem | null => {
        const el = host.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(id)}"]`);
        const f = fields.find((x) => x.id === id);
        if (!el || !f || f.page !== page.number) return null;
        return { id, el, start: fieldRect(f) };
      };
      const items = (mode === "move" ? ids : [field.id]).map(collect).filter((x): x is DragItem => x !== null);
      const primary = items.find((i) => i.id === field.id);
      if (!primary) return;

      dragRef.current = {
        mode,
        page,
        scale,
        clientX: e.clientX,
        clientY: e.clientY,
        minWidth: spec.minWidth,
        minHeight: spec.minHeight,
        primary,
        items,
        others: fields.filter((f) => f.page === page.number && !items.some((i) => i.id === f.id)),
        snap,
        moved: false,
        last: new Map()
      };
    },
    [fields, pages, preview, scaleFor, selectedIds, snap, onSelect]
  );

  const pagePointerDown = useCallback(
    (e: React.PointerEvent, page: PageSize, scale: number) => {
      if (preview) return;
      if ((e.target as HTMLElement).closest("[data-field-id]")) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      if (armedType) {
        const spec = WIDGET_BY_TYPE[armedType];
        onPlace(armedType, page.number, x - spec.width / 2, y - spec.height / 2);
        return;
      }
      onSelect([]);
    },
    [armedType, onPlace, onSelect, preview]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/x-docustamp-widget") as WidgetType;
      if (!type || !WIDGET_BY_TYPE[type]) return;
      const pageEl = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
      if (!pageEl) return;
      const number = Number(pageEl.dataset.page);
      const page = pages.find((p) => p.number === number);
      if (!page) return;
      const scale = scaleFor(page);
      const rect = pageEl.getBoundingClientRect();
      const spec = WIDGET_BY_TYPE[type];
      onPlace(
        type,
        number,
        (e.clientX - rect.left) / scale - spec.width / 2,
        (e.clientY - rect.top) / scale - spec.height / 2
      );
    },
    [onPlace, pages, scaleFor]
  );

  const trackHover = useCallback(
    (e: React.PointerEvent) => {
      const pageEl = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
      if (!pageEl) {
        hoverRef.current = null;
        return;
      }
      const number = Number(pageEl.dataset.page);
      const page = pages.find((p) => p.number === number);
      if (!page) return;
      const scale = scaleFor(page);
      const rect = pageEl.getBoundingClientRect();
      hoverRef.current = { page: number, x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
    },
    [hoverRef, pages, scaleFor]
  );

  return (
    <div
      ref={setScrollRoot}
      className="flex-1 min-h-0 overflow-auto scroll-thin bg-paper"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onPointerMove={trackHover}
    >
      <div className="flex flex-col items-center gap-5 py-6 px-6">
        {pages.map((page) => {
          const scale = scaleFor(page);
          const pageFields = fields.filter((f) => f.page === page.number);
          return (
            <PdfPageView
              key={page.number}
              doc={doc}
              info={page}
              width={Math.round(page.width * scale)}
              scrollRoot={scrollRoot}
              pageRef={pageRef}
              onPointerDown={pagePointerDown}
              overlay={() => (
                <div data-overlay={page.number} className="absolute inset-0">
                  {pageFields.map((f) => (
                    <FieldBox
                      key={f.id}
                      field={f}
                      signer={signers.find((s) => s.id === f.signerId)}
                      scale={scale}
                      selected={selectedIds.includes(f.id)}
                      preview={preview}
                      onPointerDown={startDrag}
                    />
                  ))}
                  <div
                    ref={(el) => registerGuide(guides.current, page.number, "x", el)}
                    className="absolute top-0 bottom-0 w-px pointer-events-none z-40"
                    style={{ background: GUIDE, display: "none" }}
                  />
                  <div
                    ref={(el) => registerGuide(guides.current, page.number, "y", el)}
                    className="absolute left-0 right-0 h-px pointer-events-none z-40"
                    style={{ background: GUIDE, display: "none" }}
                  />
                </div>
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

function registerGuide(
  map: Map<number, { x: HTMLElement | null; y: HTMLElement | null }>,
  page: number,
  axis: "x" | "y",
  el: HTMLElement | null
) {
  const entry = map.get(page) ?? { x: null, y: null };
  entry[axis] = el;
  map.set(page, entry);
}
