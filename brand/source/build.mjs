// Builds the DocuStamp logo files: the mark (a solid page with a rubber stamp
// cut out of it and a blue line of ink), the lockup with the wordmark in
// IBM Plex Sans SemiBold turned into outlines, and the favicon.
//
// Run from this folder:
//   npm install --no-save opentype.js @fontsource/ibm-plex-sans
//   node build.mjs ..
// The PNG files in ../png were exported from these SVGs in a browser.
import fs from "node:fs";
import path from "node:path";
import opentype from "opentype.js";

const OUT = process.argv[2] || "out";
fs.mkdirSync(OUT, { recursive: true });

const INK = "#09090B";
const PAPER = "#FAFAFA";
const BLUE = "#1447E6";

// ---- mark geometry on a 64 x 64 grid --------------------------------------
// Page body, clockwise, with the top-right corner notched out for the fold.
const PAGE = "M16 4H38V18H52V56A4 4 0 0 1 48 60H16A4 4 0 0 1 12 56V8A4 4 0 0 1 16 4Z";
// The folded flap, 2.5 units clear of the page on both sides.
const FLAP = "M40.5 4L52 15.5H42.5A2 2 0 0 1 40.5 13.5Z";
// Stamp silhouette, counter-clockwise so it cuts a hole: knob, tapered neck, base.
const STAMP =
  // Knob and neck.
  "M29.4 29.84L28.4 36.5H21A2 2 0 0 0 19 38.5V41A2 2 0 0 0 21 43H43A2 2 0 0 0 45 41V38.5" +
  "A2 2 0 0 0 43 36.5H35.6L34.6 29.84A4.8 4.8 0 1 0 29.4 29.84Z" +
  // The rubber under the block, as its own strip.
  "M22.3 44.3A0.8 0.8 0 0 0 21.5 45.1V46A0.8 0.8 0 0 0 22.3 46.8H41.7A0.8 0.8 0 0 0 42.5 46V45.1A0.8 0.8 0 0 0 41.7 44.3Z";
// Line of ink under the stamp. As a shape for the colour mark, as a hole for mono.
const LINE_RECT = { x: 19, y: 50.5, w: 26, h: 3.5 };
const LINE_HOLE = "M20.75 50.5A1.75 1.75 0 0 0 20.75 54H43.25A1.75 1.75 0 0 0 43.25 50.5Z";

const lineRect = (fill) =>
  `<rect x="${LINE_RECT.x}" y="${LINE_RECT.y}" width="${LINE_RECT.w}" height="${LINE_RECT.h}" rx="${LINE_RECT.h / 2}" fill="${fill}"/>`;

function markBody(page, blue) {
  return (
    `<path fill="${page}" fill-rule="evenodd" d="${PAGE}${STAMP}"/>` +
    `<path fill="${page}" d="${FLAP}"/>` +
    lineRect(blue)
  );
}
function monoBody(fill) {
  return `<path fill="${fill}" fill-rule="evenodd" d="${PAGE}${STAMP}${LINE_HOLE}"/><path fill="${fill}" d="${FLAP}"/>`;
}

// Tight box around the page: x 12..52, y 4..60.
const MARK_BOX = { x: 12, y: 4, w: 40, h: 56 };

// ---- wordmark --------------------------------------------------------------
const fontFile = "node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff";
const buf = fs.readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const CAP = font.tables.os2.sCapHeight || 698;
const UPM = font.unitsPerEm;
// Cap height matches a bit over half the page height, which is how the app
// lockup (34px mark, 22px type) reads.
const SIZE = (29 / CAP) * UPM; // font size in grid units
const BASELINE = 32 + 29 / 2; // caps centred on the page
const TRACK = -0.02 * SIZE; // -0.02em

function wordPath(text, x0) {
  const glyphs = font.stringToGlyphs(text);
  const scale = SIZE / UPM;
  let x = x0;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(x, BASELINE, SIZE).toPathData(2));
    let adv = g.advanceWidth * scale + TRACK;
    if (i < glyphs.length - 1) adv += font.getKerningValue(g, glyphs[i + 1]) * scale;
    x += adv;
  });
  const width = x - TRACK - x0;
  return { d: parts.join(""), width };
}

const GAP = 20; // page edge to the D, in grid units
const TEXT_X = MARK_BOX.x + MARK_BOX.w + GAP;
const word = wordPath("DocuStamp", TEXT_X);
const LOGO_W = TEXT_X + word.width - MARK_BOX.x;

// ---- files -----------------------------------------------------------------
const svg = (viewBox, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>${body}</svg>\n`;
const markVB = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}`;
const logoVB = `${MARK_BOX.x} ${MARK_BOX.y} ${+LOGO_W.toFixed(2)} ${MARK_BOX.h}`;
const title = (t) => `<title>${t}</title>`;

const files = {
  "docustamp-mark.svg": svg(markVB, title("DocuStamp") + markBody(INK, BLUE)),
  "docustamp-mark-on-dark.svg": svg(markVB, title("DocuStamp") + markBody(PAPER, BLUE)),
  "docustamp-mark-mono.svg": svg(markVB, title("DocuStamp") + monoBody("currentColor")),
  "docustamp-logo.svg": svg(logoVB, title("DocuStamp") + markBody(INK, BLUE) + `<path fill="${INK}" d="${word.d}"/>`),
  "docustamp-logo-on-dark.svg": svg(
    logoVB,
    title("DocuStamp") + markBody(PAPER, BLUE) + `<path fill="${PAPER}" d="${word.d}"/>`
  ),
  "docustamp-logo-mono.svg": svg(logoVB, title("DocuStamp") + monoBody("currentColor") + `<path fill="currentColor" d="${word.d}"/>`),
  // Square favicon: the page fills the height. Follows the browser's theme.
  "favicon.svg": svg(
    "4 4 56 56",
    `<style>.p{fill:${INK}}@media (prefers-color-scheme:dark){.p{fill:${PAPER}}}</style>` +
      `<path class="p" fill-rule="evenodd" d="${PAGE}${STAMP}"/><path class="p" d="${FLAP}"/>` +
      lineRect(BLUE)
  )
};
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), body);

// Geometry for the React component and the PNG renderer.
fs.writeFileSync(
  path.join(OUT, "geometry.json"),
  JSON.stringify({ PAGE, FLAP, STAMP, LINE_RECT, LINE_HOLE, MARK_BOX, word: word.d, LOGO_W }, null, 2)
);
console.log("wrote", Object.keys(files).length, "svgs; logo width", LOGO_W.toFixed(2), "units");
