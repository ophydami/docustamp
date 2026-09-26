/**
 * One page-box rule for the whole app.
 *
 * Field coordinates are stored in PDF points with the origin at the TOP-LEFT of
 * the page, so everything that places, validates, renders or stamps a field has
 * to agree on how big a page is. This is the client mirror of the server's
 * `apps/server/cloud/lib/pageBox.js` (`pageBox` / `pageBoxFromViewport`,
 * used by `cloud/lib/drafts.js` pageSizes and `cloud/ai/pdfLayout.js`
 * extractLayout); keep the two in step:
 *
 *   angle    = rotation normalised into 0/90/180/270
 *   upright  = angle is 0 or 180
 *   width    = upright ? CropBox.width  : CropBox.height
 *   height   = (upright ? CropBox.height : CropBox.width) + (upright ? CropBox.y : 0)
 *
 * Three things it settles:
 *  - the CropBox, not the MediaBox, is the page (they are the same box when a
 *    PDF has no CropBox, which is the common case);
 *  - a 90/270 rotation swaps width and height, because the widgets are placed
 *    against the page as it is displayed;
 *  - the CropBox y origin is folded into the height, and ONLY on an upright
 *    page. On a rotated page that offset runs along the displayed x axis, so
 *    adding it to the height would move every field. This is the part the four
 *    old copies disagreed about.
 *
 * The offset is a stamping correction, not extra paper: pdf-lib draws in user
 * space, where the visible area starts at CropBox.y, so a `yFromTop` of 0 has to
 * map to `height - boxHeight` with the offset already in `height`. What is
 * actually painted is `renderWidth` x `renderHeight`, and a field is inside the
 * page when `yFromTop + fieldHeight <= renderHeight`.
 */

export interface PageBox {
  /** 0, 90, 180 or 270. */
  rotation: number;
  /** CropBox origin in PDF points. Usually 0, 0. */
  cropX: number;
  cropY: number;
  /** The page as the widget coordinate system sees it (rotation applied). */
  width: number;
  height: number;
  /** The area pdf.js actually paints, without the CropBox offset. */
  renderWidth: number;
  renderHeight: number;
  /** pdf-lib user space, which is never rotated, with the same correction. */
  stampWidth: number;
  stampHeight: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rotation as one of 0/90/180/270, whatever the PDF says (server: `normaliseRotation`). */
export function normaliseRotation(rotation: number | undefined): number {
  const angle = Number(rotation) || 0;
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

/** The server rounds the page box to 2dp; match it so the two never disagree. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The rule above, from a CropBox and a rotation. */
export function pageBoxOf(box: Box, rotation: number | undefined): PageBox {
  const angle = normaliseRotation(rotation);
  const upright = angle === 0 || angle === 180;
  const offset = upright ? box.y : 0;
  const renderWidth = upright ? box.width : box.height;
  const renderHeight = upright ? box.height : box.width;
  return {
    rotation: angle,
    cropX: box.x,
    cropY: box.y,
    // Rounded like the server's, because these two are what both sides compare.
    width: round2(renderWidth),
    height: round2(renderHeight + offset),
    // Left exact: these only ever measure this page, on this side.
    renderWidth,
    renderHeight,
    stampWidth: box.width,
    stampHeight: box.height + offset
  };
}

/**
 * The same rule for a pdf.js page. `page.view` is the CropBox as
 * `[x0, y0, x1, y1]` before rotation, which is exactly what `pageBoxOf` wants.
 */
export function pageBoxOfPdfJs(page: { view?: number[]; rotate?: number }): PageBox {
  const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : [0, 0, 612, 792];
  const [x0, y0, x1, y1] = view;
  return pageBoxOf({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, page.rotate);
}

/** The same rule for a pdf-lib page. Falls back to the MediaBox when there is no CropBox. */
export function pageBoxOfPdfLib(page: {
  getCropBox?: () => Box;
  getMediaBox?: () => Box;
  getWidth: () => number;
  getHeight: () => number;
  getRotation: () => { angle: number };
}): PageBox {
  let box: Box | undefined;
  try {
    box = page.getCropBox?.() ?? page.getMediaBox?.();
  } catch {
    box = undefined;
  }
  if (!box || !box.width || !box.height) {
    box = { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
  }
  return pageBoxOf(box, page.getRotation()?.angle);
}
