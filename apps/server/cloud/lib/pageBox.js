/**
 * The one page-box formula.
 *
 * Every field in this product is stored as `xPosition` / `yPosition` in PDF
 * points measured from the **top-left of the page box**, and four different
 * places used to work out what that box is: `drafts.pageSizes` (pdf-lib),
 * `ai/pdfLayout.extractLayout` (pdf.js), the signer's `pdfEmbed` and the web
 * viewer. They disagreed about the CropBox origin, which is the number that
 * decides whether a field near the bottom of a cropped page is inside the page
 * or off it, so `review_draft` could report `field_off_document` for a field the
 * editor had just drawn on screen.
 *
 * The rule, in one place:
 *
 *   width   = the crop box width  on an upright page (0 / 180 degrees),
 *             the crop box height on a quarter-turned page (90 / 270).
 *   height  = the crop box height on an upright page, **plus** the crop box y
 *             origin; the crop box width on a quarter-turned page, with no
 *             offset.
 *
 * Why the `+ y` only when upright: a non-zero CropBox origin means the visible
 * page starts that far up from the MediaBox origin, and every renderer in this
 * product lays fields out against a box that starts at the MediaBox top. Folding
 * the offset into the height keeps a field's stored `yPosition` meaning the same
 * distance from the top of what the signer sees. On a 90/270 rotation the
 * CropBox y offset runs along the *rendered x* axis, so adding it to the height
 * would move fields in the wrong direction; it is left out rather than applied
 * to the wrong dimension.
 *
 * This module deliberately takes plain numbers rather than a page object: the
 * server reads PDFs with two different libraries (pdf-lib for stamping and page
 * sizes, pdf.js for text layout) and the browser with a third. Each caller pulls
 * the four numbers out of its own page object and the arithmetic happens here.
 * `apps/web` mirrors this file client side; keep the two in step.
 */

/** Normalise any rotation to 0, 90, 180 or 270. */
export function normaliseRotation(angle) {
  const n = Number(angle) || 0;
  return (((Math.round(n / 90) * 90) % 360) + 360) % 360;
}

/** True when the page is upright, i.e. its crop box axes are the rendered axes. */
export function isUpright(angle) {
  const a = normaliseRotation(angle);
  return a === 0 || a === 180;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * The page box every stored coordinate is measured against.
 *
 * @param {Object} crop the page's crop box and rotation.
 * @param {number} crop.y crop box y origin in PDF points (0 for most files).
 * @param {number} crop.width crop box width.
 * @param {number} crop.height crop box height.
 * @param {number} [crop.rotation] page rotation in degrees.
 * @returns {{width: number, height: number, rotation: number}} rounded to 2dp.
 */
export function pageBox({ y = 0, width = 0, height = 0, rotation = 0 } = {}) {
  const angle = normaliseRotation(rotation);
  const upright = isUpright(angle);
  const offset = upright ? Number(y) || 0 : 0;
  return {
    width: round2(upright ? width : height),
    height: round2((upright ? height : width) + offset),
    rotation: angle,
  };
}

/**
 * The same box for a pdf.js page, whose viewport has already applied the
 * rotation (so its width/height are the rendered ones and only the CropBox
 * offset is left to fold in).
 *
 * @param {{width: number, height: number}} viewport `page.getViewport({scale: 1})`.
 * @param {number} cropY `page.view[1]`, the crop box y origin.
 * @param {number} rotation `page.rotate`.
 */
export function pageBoxFromViewport(viewport, cropY, rotation) {
  const angle = normaliseRotation(rotation);
  const offset = isUpright(angle) ? Number(cropY) || 0 : 0;
  return {
    width: round2(viewport?.width || 0),
    height: round2((viewport?.height || 0) + offset),
    rotation: angle,
  };
}
