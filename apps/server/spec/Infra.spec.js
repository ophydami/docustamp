/**
 * Coverage for the server plumbing hardened in this pass:
 *
 *  - `flattenPdf` must bake pre-filled AcroForm values into the page content.
 *    It used to delete the widgets without rendering anything, so a document
 *    uploaded with filled fields came out blank where the values had been.
 *  - `publicOriginFor` decides the origin of every signing link and reminder
 *    mail. It must come from configuration, not from the client's Host header.
 *  - `trust proxy` decides which X-Forwarded-For entry becomes the client IP
 *    recorded in the audit trail and used for rate limiting.
 *  - `parseUploadFile` puts a file name straight into a master-key request path.
 *  - the specs' database URI has to follow MONGODB_TEST_URI.
 */
import zlib from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import { flattenPdf, sanitizeFileName } from '../Utils.js';
import { parseUploadFile } from '../utils/fileUtils.js';
import { publicOriginFor, configuredPublicOrigin } from '../cloud/lib/publicUrl.js';
import { testDatabaseUri } from './utils/test-runner.js';
import { app } from '../index.js';

/** Every stream in the document, decompressed where it is deflated. */
function decodedStreams(pdfDoc) {
  const out = [];
  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    const contents = obj?.contents;
    if (!contents?.length) continue;
    let bytes = Buffer.from(contents);
    try {
      bytes = zlib.inflateSync(bytes);
    } catch {
      // not deflated, or not something we can read: use the raw bytes
    }
    out.push(bytes.toString('latin1'));
  }
  return out;
}

/**
 * True when one of the streams shows `value` as text. pdf-lib writes the
 * operand of `Tj` as a hex string, other producers use a literal string, so
 * both spellings count.
 */
function drawsText(streams, value) {
  const hex = Buffer.from(value, 'latin1').toString('hex').toUpperCase();
  return streams.some(
    stream =>
      stream.includes('Tj') &&
      (stream.includes(`(${value})`) ||
        stream.toUpperCase().includes(`<${hex}>`) ||
        stream.includes(value))
  );
}

function widgetCount(pdfDoc) {
  let count = 0;
  for (const page of pdfDoc.getPages()) {
    const annots = pdfDoc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!annots?.asArray) continue;
    for (const ref of annots.asArray()) {
      const annot = pdfDoc.context.lookup(ref);
      if (annot?.get(PDFName.of('Subtype'))?.toString() === '/Widget') count += 1;
    }
  }
  return count;
}

/** A one page pdf with a filled text field and a ticked checkbox. */
async function filledFormPdf(value) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  const text = form.createTextField('applicant.name');
  text.setText(value);
  text.addToPage(page, { x: 30, y: 200, width: 240, height: 24 });
  const box = form.createCheckBox('applicant.agrees');
  box.check();
  box.addToPage(page, { x: 30, y: 150, width: 14, height: 14 });
  return doc.save();
}

describe('flattenPdf', () => {
  const value = 'Jonas Quinlan-42';

  it('renders pre-filled field values into the page content', async () => {
    const flat = await flattenPdf(await filledFormPdf(value));
    const out = await PDFDocument.load(flat);
    const streams = decodedStreams(out);
    // The value is drawn by a text-showing operator, not left as a /V string.
    expect(drawsText(streams, value)).toBeTrue();
  });

  it('leaves no interactive form behind', async () => {
    const flat = await flattenPdf(await filledFormPdf(value));
    const out = await PDFDocument.load(flat);
    expect(widgetCount(out)).toBe(0);
    // getForm() creates an empty AcroForm on demand, so assert on the fields.
    expect(out.getForm().getFields().length).toBe(0);
  });

  it('keeps annotations that are not form widgets', async () => {
    const doc = await PDFDocument.load(await filledFormPdf(value));
    const page = doc.getPages()[0];
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10, 60, 30],
      Border: [0, 0, 0],
    });
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    page.node.set(PDFName.of('Annots'), doc.context.obj([...annots.asArray(), link]));

    const out = await PDFDocument.load(await flattenPdf(await doc.save()));
    const kept = out.context.lookup(out.getPages()[0].node.get(PDFName.of('Annots')));
    const subtypes = (kept?.asArray() || []).map(ref =>
      out.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString()
    );
    expect(subtypes).toEqual(['/Link']);
  });

  it('returns a usable pdf even when there is no form at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText('plain');
    const flat = await flattenPdf(await doc.save());
    const out = await PDFDocument.load(flat);
    expect(out.getPageCount()).toBe(1);
  });
});

describe('publicOriginFor', () => {
  const saved = { PUBLIC_URL: process.env.PUBLIC_URL, SERVER_URL: process.env.SERVER_URL };
  const req = (host, protocol = 'http') => ({
    protocol,
    headers: { host },
    get: name => (name.toLowerCase() === 'host' ? host : undefined),
  });

  afterEach(() => {
    process.env.PUBLIC_URL = saved.PUBLIC_URL;
    process.env.SERVER_URL = saved.SERVER_URL;
  });

  it('prefers PUBLIC_URL over anything the client sends', () => {
    process.env.PUBLIC_URL = 'https://sign.example.com/';
    expect(publicOriginFor(req('evil.attacker.test'))).toBe('https://sign.example.com');
  });

  it('falls back to the origin of an absolute SERVER_URL', () => {
    delete process.env.PUBLIC_URL;
    process.env.SERVER_URL = 'https://sign.example.com/api/app';
    expect(publicOriginFor(req('evil.attacker.test'))).toBe('https://sign.example.com');
  });

  it('ignores a loopback SERVER_URL so development still works', () => {
    delete process.env.PUBLIC_URL;
    process.env.SERVER_URL = 'http://localhost:30001/test';
    expect(configuredPublicOrigin()).toBe('');
    // Only then does the request itself decide, using its own protocol.
    expect(publicOriginFor(req('localhost:3000'))).toBe('http://localhost:3000');
  });

  it('ignores a PUBLIC_URL that is not an absolute http(s) url', () => {
    process.env.PUBLIC_URL = '/relative/path';
    delete process.env.SERVER_URL;
    expect(configuredPublicOrigin()).toBe('');
  });
});

describe('trust proxy', () => {
  it('defaults to a single reverse proxy hop', () => {
    // Caddy in deploy/ is one hop; anything beyond it must not be believed.
    expect(app.get('trust proxy')).toBe(1);
  });
});

describe('parseUploadFile', () => {
  it('refuses a name that sanitises away to nothing', async () => {
    await expectAsync(
      parseUploadFile('/////', Buffer.from('%PDF-1.4'), 'application/pdf')
    ).toBeRejectedWith(jasmine.objectContaining({ code: 400 }));
  });

  it('strips path separators out of a traversal name before it reaches the url', () => {
    const safe = sanitizeFileName('../../etc/passwd');
    expect(safe.includes('/')).toBeFalse();
    expect(safe.includes('\\')).toBeFalse();
    expect(safe.includes('..')).toBeFalse();
  });
});

describe('testDatabaseUri', () => {
  const saved = process.env.MONGODB_TEST_URI;
  afterEach(() => {
    if (saved === undefined) delete process.env.MONGODB_TEST_URI;
    else process.env.MONGODB_TEST_URI = saved;
  });

  it('defaults to a local mongod', () => {
    delete process.env.MONGODB_TEST_URI;
    expect(testDatabaseUri()).toBe('mongodb://localhost:27017/parse-test');
  });

  it('adds a database name to the bare uri mongodb-runner prints', () => {
    process.env.MONGODB_TEST_URI = 'mongodb://127.0.0.1:45671/';
    expect(testDatabaseUri()).toBe('mongodb://127.0.0.1:45671/parse-test');
  });

  it('keeps a database name and query string that are already there', () => {
    process.env.MONGODB_TEST_URI = 'mongodb://127.0.0.1:45671/other?directConnection=true';
    expect(testDatabaseUri()).toBe('mongodb://127.0.0.1:45671/other?directConnection=true');
  });
});
