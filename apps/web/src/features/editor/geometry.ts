import { PAGE_MARGIN, SNAP_TOLERANCE } from "./constants";
import type { EditorField, PageSize, SnapGuide } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fieldRect(f: EditorField): Rect {
  return { x: f.widget.xPosition, y: f.widget.yPosition, w: f.widget.Width, h: f.widget.Height };
}

/** Alignment lines a page offers on one axis, in PDF points. */
function pageLines(page: PageSize, axis: "x" | "y"): number[] {
  const size = axis === "x" ? page.width : page.height;
  return [PAGE_MARGIN, size / 2, size - PAGE_MARGIN];
}

function widgetLines(fields: EditorField[], axis: "x" | "y"): number[] {
  const out: number[] = [];
  for (const f of fields) {
    const r = fieldRect(f);
    if (axis === "x") out.push(r.x, r.x + r.w / 2, r.x + r.w);
    else out.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return out;
}

interface Hit {
  delta: number;
  at: number;
}

/** Smallest move that lands any of `edges` on one of `targets`, within tolerance. */
function bestHit(edges: number[], targets: number[]): Hit | null {
  let best: Hit | null = null;
  for (const edge of edges) {
    for (const t of targets) {
      const delta = t - edge;
      if (Math.abs(delta) > SNAP_TOLERANCE) continue;
      if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: t };
    }
  }
  return best;
}

export interface SnapResult {
  rect: Rect;
  guides: SnapGuide[];
}

/**
 * Snap a moving rect to the other widgets on the page and to the page margins.
 * Tolerance is in PDF points, so snapping feels the same at any zoom.
 */
export function snapMove(rect: Rect, page: PageSize, others: EditorField[], enabled: boolean): SnapResult {
  const base = clampToPage(rect, page);
  if (!enabled) return { rect: base, guides: [] };

  const guides: SnapGuide[] = [];
  const hx = bestHit([base.x, base.x + base.w / 2, base.x + base.w], [...widgetLines(others, "x"), ...pageLines(page, "x")]);
  const hy = bestHit([base.y, base.y + base.h / 2, base.y + base.h], [...widgetLines(others, "y"), ...pageLines(page, "y")]);

  let { x, y } = base;
  if (hx) {
    x += hx.delta;
    guides.push({ page: page.number, axis: "x", at: hx.at });
  }
  if (hy) {
    y += hy.delta;
    guides.push({ page: page.number, axis: "y", at: hy.at });
  }
  return { rect: clampToPage({ ...base, x, y }, page), guides };
}

/** Snap the bottom-right edges a resize handle moves. */
export function snapResize(rect: Rect, page: PageSize, others: EditorField[], enabled: boolean): SnapResult {
  if (!enabled) return { rect: clampToPage(rect, page), guides: [] };
  const guides: SnapGuide[] = [];
  const next = { ...rect };

  const hx = bestHit([rect.x + rect.w], [...widgetLines(others, "x"), ...pageLines(page, "x")]);
  if (hx) {
    next.w = hx.at - rect.x;
    guides.push({ page: page.number, axis: "x", at: hx.at });
  }
  const hy = bestHit([rect.y + rect.h], [...widgetLines(others, "y"), ...pageLines(page, "y")]);
  if (hy) {
    next.h = hy.at - rect.y;
    guides.push({ page: page.number, axis: "y", at: hy.at });
  }
  return { rect: clampToPage(next, page), guides };
}

/** Keep a widget inside the page. */
export function clampToPage(rect: Rect, page: PageSize): Rect {
  const w = Math.min(rect.w, page.width);
  const h = Math.min(rect.h, page.height);
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, 0), Math.max(0, page.width - w)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, page.height - h))
  };
}
