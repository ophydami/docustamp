/**
 * Server-side stamping (cloud/lib/stamp.js), the port of the signer page's
 * `embedWidgetsToDoc` (apps/web/src/features/signer/pdfEmbed.ts).
 *
 * The expected numbers below are worked out from the browser's formulas, not
 * from the module under test: `browserTopLeftToPdf` is pdfEmbed.ts
 * `topLeftToPdf` copied verbatim, and every offset (+6 - 4 for text, +2 for a
 * checkbox, (+2, +3) for a radio, 18pt line height, the cell centring) is
 * spelled out again here. Draw calls are captured on pdf-lib's page prototype,
 * and text is also read back out of the saved file with pdf.js.
 */
import { PDFDocument, PDFPage, StandardFonts, degrees } from 'pdf-lib';
import { formatInTimeZone } from 'date-fns-tz';
import {
  certificateSignature,
  dateFnsPattern,
  embedWidgetsToDoc,
  fieldFromWidget,
  initialsFrom,
  pageSizeOf,
  renderToWidgetBox,
  topLeftToPdf,
  typedSignaturePng,
} from '../cloud/lib/stamp.js';

/** pdfEmbed.ts `topLeftToPdf`, verbatim (types removed). */
function browserTopLeftToPdf(pageRotation, x, yFromTop, boxHeight, size) {
  const angle = ((pageRotation % 360) + 360) % 360;
  const rads = (angle * Math.PI) / 180;
  const bx = x;
  const by =
    angle === 90 || angle === 270
      ? size.width - (yFromTop + boxHeight)
      : size.height - (yFromTop + boxHeight);
  const cos = Math.cos(rads);
  const sin = Math.sin(rads);
  if (angle === 90) return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos };
  if (angle === 180)
    return { x: bx * cos - by * sin + size.width, y: bx * sin + by * cos + size.height };
  if (angle === 270) return { x: bx * cos - by * sin, y: bx * sin + by * cos + size.height };
  return { x: bx, y: by };
}

let pdfjsLib;
async function textItems(bytes, pageNumber = 1) {
  pdfjsLib = pdfjsLib || (await import('pdfjs-dist/legacy/build/pdf.mjs'));
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
    .promise;
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], size: it.transform[0] }));
}

/** A blank pdf: Letter by default, optionally with a crop box or a rotation. */
async function blankPdf({ width = 612, height = 792, crop, rotate } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([width, height]);
  if (crop) page.setCropBox(crop.x, crop.y, crop.width, crop.height);
  if (rotate) page.setRotation(degrees(rotate));
  return await pdf.save();
}

let seq = 0;
function field(type, x, y, options = {}, extra = {}) {
  seq += 1;
  const f = fieldFromWidget(
    { key: 10000000 + seq, type, xPosition: x, yPosition: y, options, ...extra },
    1
  );
  return f;
}

const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(0.01, `${a} vs ${b}`);

describe('server stamping (lib/stamp.js)', () => {
  let font;
  let calls;

  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    font = await pdf.embedFont(StandardFonts.Helvetica);
  });

  beforeEach(() => {
    calls = { text: [], rect: [], line: [], circle: [], image: [] };
    spyOn(PDFPage.prototype, 'drawText').and.callFake(function (text, opts) {
      calls.text.push({ text, ...opts });
    });
    spyOn(PDFPage.prototype, 'drawRectangle').and.callFake(opts => calls.rect.push(opts));
    spyOn(PDFPage.prototype, 'drawLine').and.callFake(opts => calls.line.push(opts));
    spyOn(PDFPage.prototype, 'drawCircle').and.callFake(opts => calls.circle.push(opts));
    spyOn(PDFPage.prototype, 'drawImage').and.callFake((img, opts) => calls.image.push(opts));
  });

  /** Undo the spies for a test that needs the real drawing (read-back). */
  function realDrawing() {
    for (const m of ['drawText', 'drawRectangle', 'drawLine', 'drawCircle', 'drawImage']) {
      PDFPage.prototype[m].and.callThrough();
    }
  }

  describe('geometry', () => {
    it('converts top-left points exactly like the browser at every rotation', () => {
      const size = { width: 612, height: 799.92 };
      for (const angle of [0, 90, 180, 270, -90, 450]) {
        for (const [x, y, h] of [
          [0, 0, 12],
          [72, 100, 12],
          [300.5, 640.25, 60],
        ]) {
          const ours = topLeftToPdf(angle, x, y, h, size);
          const theirs = browserTopLeftToPdf(angle, x, y, h, size);
          close(ours.x, theirs.x);
          close(ours.y, theirs.y);
        }
      }
      expect(topLeftToPdf(0, 72, 100, 12, { width: 612, height: 792 })).toEqual({ x: 72, y: 680 });
    });

    it('folds the crop box origin into the height on an upright page only', async () => {
      const upright = await PDFDocument.load(
        await blankPdf({
          width: 612,
          height: 800,
          crop: { x: 0, y: 7.92, width: 612, height: 792 },
        })
      );
      const up = pageSizeOf(upright.getPage(0));
      close(up.width, 612);
      close(up.height, 799.92);

      const turned = await PDFDocument.load(
        await blankPdf({
          width: 612,
          height: 800,
          crop: { x: 0, y: 7.92, width: 612, height: 792 },
          rotate: 90,
        })
      );
      const quarter = pageSizeOf(turned.getPage(0));
      close(quarter.width, 612);
      close(quarter.height, 792);
    });

    it('maps the stored widget shape the way the signer page does', () => {
      const f = fieldFromWidget(
        {
          key: 42,
          type: 'textbox',
          xPosition: '10',
          yPosition: 20,
          options: { status: 'optional', fontSize: 9, fontColor: 'blue', hint: 'Rent' },
        },
        2
      );
      expect(f.type).toBe('text input');
      expect(f.required).toBe(false);
      expect(f.w).toBe(150);
      expect(f.h).toBe(19);
      expect(f.fontSize).toBe(9);
      expect(f.fontColor).toBe('blue');
      expect(f.page).toBe(2);
      expect(f.x).toBe(10);
      // A signature is mandatory whatever `status` says.
      expect(
        fieldFromWidget({ key: 1, type: 'signature', options: { status: 'optional' } }, 1).required
      ).toBe(true);
      expect(fieldFromWidget({ key: 1, type: 'hologram' }, 1)).toBeNull();
      expect(dateFnsPattern('DD-MM-YYYY')).toBe('dd-MM-yyyy');
      expect(dateFnsPattern('dd.MM.yyyy')).toBe('dd.MM.yyyy');
      expect(dateFnsPattern('nonsense')).toBe('MM/dd/yyyy');
    });
  });

  describe('field types', () => {
    const size = { width: 612, height: 792 };

    it('draws text fields nudged +2 and wraps at a flat 18pt', async () => {
      const name = { ...field('name', 72, 100, { fontSize: 12 }), response: 'Jane Doe' };
      const long = {
        ...field('text input', 72, 200, { fontSize: 10 }, { Width: 60 }),
        response: 'alpha beta gamma delta',
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [name, long] });

      const first = calls.text.find(c => c.text === 'Jane Doe');
      const p = browserTopLeftToPdf(0, 72, 100 + 6 - 4, 12, size);
      close(first.x, p.x);
      close(first.y, p.y);
      expect(first.size).toBe(12);

      const lines = calls.text.filter(c => c.size === 10);
      expect(lines.length).toBeGreaterThan(1);
      lines.forEach((line, i) => {
        const q = browserTopLeftToPdf(0, 72, 200 + 6 - 4 + 18 * i, 10, size);
        close(line.x, q.x);
        close(line.y, q.y);
        expect(font.widthOfTextAtSize(line.text, 10)).not.toBeGreaterThan(60);
      });
      expect(lines.map(l => l.text).join(' ')).toBe('alpha beta gamma delta');
    });

    it('draws a dropdown without the text nudge', async () => {
      const f = { ...field('dropdown', 50, 300, { values: ['A', 'B'] }), response: 'B' };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      const p = browserTopLeftToPdf(0, 50, 300 - 4, 12, size);
      expect(calls.text.length).toBe(1);
      close(calls.text[0].x, p.x);
      close(calls.text[0].y, p.y);
    });

    it('formats "today" in the document format and time zone, a field format first', async () => {
      const zone = 'America/Los_Angeles';
      const plain = { ...field('date', 72, 400), response: 'today' };
      const own = {
        ...field('date', 72, 430, { validation: { type: 'date-format', format: 'YYYY-MM-DD' } }),
        response: 'today',
      };
      await embedWidgetsToDoc({
        pdfBytes: await blankPdf(),
        fields: [plain, own],
        dateFormat: 'DD-MM-YYYY',
        timeZone: zone,
      });
      const now = new Date();
      expect(calls.text.map(c => c.text)).toEqual([
        formatInTimeZone(now, zone, 'dd-MM-yyyy'),
        formatInTimeZone(now, zone, 'yyyy-MM-dd'),
      ]);
    });

    it('draws checkbox boxes at +2, ticks only the chosen ones, labels 3pt up', async () => {
      const f = {
        ...field('checkbox', 80, 500, { values: ['Yes', 'No', 'Maybe'], fontSize: 12 }),
        response: [1],
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      const boxSize = 11;
      expect(calls.rect.length).toBe(3);
      calls.rect.forEach((r, i) => {
        const y = 500 + 2 + i * (12 + 5.5);
        const p = browserTopLeftToPdf(0, 80, y, boxSize, size);
        close(r.x, p.x);
        close(r.y, p.y);
        expect(r.width).toBe(boxSize);
      });
      // One tick = two strokes, inside the second box.
      expect(calls.line.length).toBe(2);
      const second = browserTopLeftToPdf(0, 80, 500 + 2 + 17.5, boxSize, size);
      close(calls.line[0].start.x, second.x + boxSize * 0.2);
      close(calls.line[0].start.y, second.y + boxSize * 0.5);
      close(calls.line[1].end.x, second.x + boxSize * 0.82);
      close(calls.line[1].end.y, second.y + boxSize * 0.78);
      const label = calls.text.find(c => c.text === 'No');
      const lp = browserTopLeftToPdf(0, 80 + 12 + 3.4, 500 + 2 + 17.5 - 3, 12, size);
      close(label.x, lp.x);
      close(label.y, lp.y);
    });

    it('lays a horizontal checkbox group out by label width', async () => {
      const f = {
        ...field('checkbox', 80, 500, { values: ['Yes', 'No'], layout: 'horizontal' }),
        response: [],
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      const gap = 11 + (12 + 3.4 + font.widthOfTextAtSize('Yes', 12));
      close(calls.rect[1].x, 80 + gap);
      close(calls.rect[1].y, calls.rect[0].y);
      expect(calls.line.length).toBe(0);
    });

    it('draws radio circles at (+2, +3) and fills the chosen one', async () => {
      const f = { ...field('radio button', 60, 600, { values: ['A', 'B'] }), response: 'B' };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      const outer = calls.circle.filter(c => c.borderWidth);
      const filled = calls.circle.filter(c => !c.borderWidth);
      expect(outer.length).toBe(2);
      expect(filled.length).toBe(1);
      const b = browserTopLeftToPdf(0, 62, 603 + 17, 12, size);
      close(filled[0].x, b.x + 6);
      close(filled[0].y, b.y + 6);
      expect(filled[0].size).toBe(3);
      const label = calls.text.find(c => c.text === 'A');
      const lp = browserTopLeftToPdf(0, 62 + 15, 603 - 2, 12, size);
      close(label.x, lp.x);
      close(label.y, lp.y);
    });

    it('centres one character per cell', async () => {
      const f = { ...field('cells', 100, 650, { cellCount: 4 }, { Width: 80 }), response: 'AB7' };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      expect(calls.text.map(c => c.text)).toEqual(['A', 'B', '7']);
      calls.text.forEach((c, i) => {
        const charX = 100 + 20 * i + (20 - font.widthOfTextAtSize(c.text, 12)) / 2;
        const p = browserTopLeftToPdf(0, charX, 650 + 2, 12, size);
        close(c.x, p.x);
        close(c.y, p.y);
      });
    });

    it('sets the image above a note printed along the bottom of the box', async () => {
      const png = await typedSignaturePng('Jane Doe');
      const f = {
        ...field('signature', 72, 600, {}, { Width: 150, Height: 60 }),
        response: png,
        note: 'Signed via ChatGPT for Jane Doe',
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      expect(calls.image.length).toBe(1);
      const img = calls.image[0];
      // 8pt of the 60pt box is kept for the note, so a printed label under the
      // box is never overwritten.
      const p = browserTopLeftToPdf(0, 72, 600, 52, size);
      close(img.x, p.x);
      close(img.y, p.y);
      expect(img.width).toBe(150);
      expect(img.height).toBe(52);
      const note = calls.text[0];
      expect(note.text).toBe('Signed via ChatGPT for Jane Doe');
      expect(note.size).toBe(6);
      const n = browserTopLeftToPdf(0, 74, 600 + 52 + 1, 6, size);
      close(note.x, n.x);
      close(note.y, n.y);
    });

    it('keeps the note inside a signature box that sits at the bottom of the page', async () => {
      const png = await typedSignaturePng('Jane Doe');
      const f = {
        ...field('signature', 72, 732, {}, { Width: 150, Height: 60 }),
        response: png,
        note: 'Signed via ChatGPT for Jane Doe',
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      const n = browserTopLeftToPdf(0, 74, 732 + 52 + 1, 6, size);
      close(calls.text[0].y, n.y);
      expect(calls.text[0].y).toBeGreaterThanOrEqual(0);
    });

    it('shrinks the note to fit a short box', async () => {
      const png = await typedSignaturePng('Jane Doe');
      const f = {
        ...field('signature', 72, 600, {}, { Width: 150, Height: 20 }),
        response: png,
        note: 'Signed via ChatGPT for Jane Doe',
      };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [f] });
      // 30% of 20pt = 6pt band, so the note is at most 5pt and inside the box.
      expect(calls.text[0].size).toBeLessThanOrEqual(5);
      expect(calls.image[0].height).toBe(14);
    });

    it('applies the page rotation to text the way the browser does', async () => {
      const f = { ...field('name', 72, 100), response: 'Turned' };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf({ rotate: 90 }), fields: [f] });
      const p = browserTopLeftToPdf(90, 72, 102, 12, size);
      close(calls.text[0].x, p.x);
      close(calls.text[0].y, p.y);
      expect(calls.text[0].rotate.angle).toBe(90);
    });

    it('skips a field on a page that does not exist and characters Helvetica cannot draw', async () => {
      const off = { ...field('name', 72, 100), response: 'Nowhere', page: 3 };
      const mixed = { ...field('name', 72, 140), response: 'Zoë 李' };
      await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields: [off, mixed] });
      expect(calls.text.map(c => c.text)).toEqual(['Zoë ']);
    });
  });

  describe('the saved file', () => {
    it('carries the text where the browser would have put it', async () => {
      realDrawing();
      const fields = [
        { ...field('name', 72, 100), response: 'Jane Doe' },
        { ...field('company', 72, 140), response: 'Acme Inc' },
        {
          ...field('signature', 72, 600, {}, { Width: 150, Height: 60 }),
          response: await typedSignaturePng('Jane Doe'),
          note: 'Signed via ChatGPT for Jane Doe',
        },
      ];
      const out = await embedWidgetsToDoc({ pdfBytes: await blankPdf(), fields });
      const items = await textItems(out);
      const at = str => items.find(i => i.str === str);
      close(at('Jane Doe').x, 72);
      close(at('Jane Doe').y, 792 - (102 + 12));
      close(at('Acme Inc').y, 792 - (142 + 12));
      close(at('Signed via ChatGPT for Jane Doe').y, 792 - (653 + 6));
      expect(at('Signed via ChatGPT for Jane Doe').size).toBe(6);
      const loaded = await PDFDocument.load(out);
      expect(loaded.getPageCount()).toBe(1);
    });
  });

  describe('signature images', () => {
    it('sets a name in the handwriting face, trimmed to the ink', async () => {
      const { loadImage } = await import('@napi-rs/canvas');
      const png = await typedSignaturePng('Jane Doe');
      const img = await loadImage(png);
      // 120pt tall at 2x, trimmed: shorter than the canvas, wider than tall.
      expect(img.height).toBeLessThan(240);
      expect(img.width).toBeGreaterThan(img.height);
      expect(initialsFrom('Jane Q Doe')).toBe('JD');
      expect(initialsFrom('Cher')).toBe('CH');
    });

    it('letterboxes onto exactly the widget box and stretches to 300x120 for the certificate', async () => {
      const { loadImage } = await import('@napi-rs/canvas');
      const png = await typedSignaturePng('Jane Doe');
      const boxed = await loadImage(await renderToWidgetBox(png, 150, 60));
      expect(boxed.width).toBe(600);
      expect(boxed.height).toBe(240);
      const cert = await loadImage(await certificateSignature(png));
      expect(cert.width).toBe(300);
      expect(cert.height).toBe(120);
      // A data url works as well as bytes.
      const fromDataUrl = await renderToWidgetBox(
        `data:image/png;base64,${png.toString('base64')}`,
        50,
        50
      );
      expect((await loadImage(fromDataUrl)).width).toBe(200);
    });
  });
});
