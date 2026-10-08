/**
 * Written documents (docs/TEXT_DOCUMENTS.md): the content model's
 * normalisation, the plain-text view, the PDF renderer, the `Content` column
 * and the `rendertextpdf` cloud function.
 */
import axios from 'axios';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { serverAppId } from '../Utils.js';
import { documentFields } from '../cloud/lib/documents.js';
import {
  CONTENT_MAX_BLOCKS,
  CONTENT_MAX_CHARS,
  LIST_MAX_ITEMS,
  PAGE_SIZES,
  contentText,
  normaliseContent,
  renderTextDocument,
  renderTextPdf,
} from '../cloud/lib/textDocument.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        ...headers,
      },
    });
    return { ok: true, status: res.status, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, status: err.response.status, code: data.code, error: data.error };
  }
}

async function loginToken(email, password) {
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: { 'X-Parse-Application-Id': APP_ID, 'X-Parse-Javascript-Key': JS_KEY } }
  );
  return res.data.sessionToken;
}

async function makeUser(email, password = 'Str0ng!pass') {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', password);
  user.set('name', email.split('@')[0]);
  await user.signUp();
  user.__specSessionToken = await loginToken(email, password);
  return user;
}

async function makeExtUser(user, extra = {}) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', 'contracts_User');
  for (const [key, value] of Object.entries(extra)) ext.set(key, value);
  return await ext.save(null, { useMasterKey: true });
}

function session(token) {
  return { 'X-Parse-Session-Token': token };
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

/* ------------------------------------------------------------ fixtures */

const para = (text, extra = {}) => ({ type: 'paragraph', runs: [{ text }], ...extra });
const content = (blocks, extra = {}) => ({ version: 1, blocks, ...extra });

const LONG =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud. ';

/** Enough paragraphs to spill over `pages` Letter pages. */
function paragraphs(count) {
  return Array.from({ length: count }, (_, i) => para(`Paragraph ${i + 1}. ${LONG}`));
}

/* ----------------------------------------------------------- pdf reading */

async function openPdf(bytes) {
  return await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
}

async function pageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const text = await page.getTextContent();
  return text.items
    .map(item => item.str)
    .filter(Boolean)
    .join(' ');
}

async function allText(bytes) {
  const doc = await openPdf(bytes);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    // eslint-disable-next-line no-await-in-loop -- pages are read in order
    pages.push(await pageText(doc, i));
  }
  return { pageCount: doc.numPages, pages, text: pages.join('\n') };
}

async function pageSize(bytes, pageNumber = 1) {
  const doc = await openPdf(bytes);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

describe('normaliseContent', () => {
  it('fills in the defaults and keeps a well-formed document as it is', () => {
    const out = normaliseContent(
      content([
        { type: 'heading', level: 2, runs: [{ text: 'Terms', bold: true }], align: 'center' },
        para('Hello'),
        {
          type: 'list',
          ordered: true,
          items: [[{ text: 'one' }], [{ text: 'two', italic: true }]],
        },
        { type: 'rule' },
        { type: 'pageBreak' },
      ])
    );
    expect(out.version).toBe(1);
    expect(out.pageSize).toBe('letter');
    expect(out.blocks).toEqual([
      { type: 'heading', level: 2, runs: [{ text: 'Terms', bold: true }], align: 'center' },
      { type: 'paragraph', runs: [{ text: 'Hello' }], align: 'left' },
      { type: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two', italic: true }]] },
      { type: 'rule' },
      { type: 'pageBreak' },
    ]);
    expect(normaliseContent(content([], { pageSize: 'a4' })).pageSize).toBe('a4');
  });

  it('refuses the wrong shape or version', () => {
    const code = Parse.Error.VALIDATION_ERROR;
    for (const bad of [null, undefined, 'text', [], 42, {}, { version: 2, blocks: [] }]) {
      expect(() => normaliseContent(bad)).toThrowMatching(err => err.code === code);
    }
    expect(() => normaliseContent({ version: 1 })).toThrowMatching(err => err.code === code);
    expect(() => normaliseContent({ version: 1, blocks: 'no' })).toThrowMatching(
      err => err.code === code
    );
  });

  it('enforces the block, character and list-item limits', () => {
    const code = Parse.Error.VALIDATION_ERROR;
    const rules = n => Array.from({ length: n }, () => ({ type: 'rule' }));
    expect(normaliseContent(content(rules(CONTENT_MAX_BLOCKS))).blocks.length).toBe(
      CONTENT_MAX_BLOCKS
    );
    expect(() => normaliseContent(content(rules(CONTENT_MAX_BLOCKS + 1)))).toThrowMatching(
      err => err.code === code
    );

    const chunk = 'x'.repeat(10_000);
    const exact = Array.from({ length: CONTENT_MAX_CHARS / 10_000 }, () => para(chunk));
    expect(normaliseContent(content(exact)).blocks.length).toBe(exact.length);
    expect(() => normaliseContent(content([...exact, para('y')]))).toThrowMatching(
      err => err.code === code
    );

    const items = n => Array.from({ length: n }, (_, i) => [{ text: `item ${i}` }]);
    expect(
      normaliseContent(content([{ type: 'list', ordered: false, items: items(LIST_MAX_ITEMS) }]))
        .blocks[0].items.length
    ).toBe(LIST_MAX_ITEMS);
    expect(() =>
      normaliseContent(
        content([{ type: 'list', ordered: false, items: items(LIST_MAX_ITEMS + 1) }])
      )
    ).toThrowMatching(err => err.code === code);
  });

  it('drops unknown blocks and keys, strips control characters and expands tabs', () => {
    const out = normaliseContent(
      content([
        { type: 'table', rows: [] },
        'junk',
        null,
        {
          type: 'paragraph',
          runs: [{ text: 'a\tb\u0007c\r\nd', color: 'red' }],
          align: 'left',
          id: 'p1',
        },
        { type: 'list', ordered: false, items: 'nope' },
        { type: 'list', ordered: false, items: [] },
      ])
    );
    expect(out.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'a    bc\nd' }], align: 'left' },
    ]);
    expect(Object.keys(out)).toEqual(['version', 'pageSize', 'blocks']);
  });

  it('clamps heading levels, alignment and the page size', () => {
    const out = normaliseContent(
      content(
        [
          { type: 'heading', level: 9, runs: [{ text: 'big' }], align: 'justify' },
          { type: 'heading', level: 0, runs: [{ text: 'small' }] },
          { type: 'heading', level: 'two', runs: [{ text: 'odd' }] },
          para('p', { align: 'middle' }),
        ],
        { pageSize: 'legal' }
      )
    );
    expect(out.pageSize).toBe('letter');
    expect(out.blocks.map(b => b.level)).toEqual([3, 1, 1, undefined]);
    expect(out.blocks.map(b => b.align)).toEqual(['left', 'left', 'left', 'left']);
  });

  it('drops empty runs, merges same-style neighbours and keeps only true flags', () => {
    const out = normaliseContent(
      content([
        {
          type: 'paragraph',
          runs: [
            { text: 'ab', bold: true },
            { text: '' },
            { text: 'cd', bold: true, italic: false },
            { text: 'ef', bold: 'yes' },
            { text: 'gh', underline: true },
            { text: 'ij', underline: true },
            { text: 42 },
          ],
        },
      ])
    );
    expect(out.blocks[0].runs).toEqual([
      { text: 'abcd', bold: true },
      { text: 'ef' },
      { text: 'ghij', underline: true },
    ]);
  });
});

describe('contentText', () => {
  it('writes one block per line with list markers', () => {
    const out = contentText(
      normaliseContent(
        content([
          { type: 'heading', level: 1, runs: [{ text: 'Title ' }, { text: 'here', bold: true }] },
          para('First\nsecond'),
          { type: 'paragraph', runs: [] },
          { type: 'list', ordered: false, items: [[{ text: 'a' }], [{ text: 'b' }]] },
          { type: 'list', ordered: true, items: [[{ text: 'x' }], [{ text: 'y' }]] },
          { type: 'rule' },
          para('End'),
        ])
      )
    );
    expect(out).toBe('Title here\nFirst\nsecond\n\n- a\n- b\n1. x\n2. y\n\nEnd');
    expect(contentText({ version: 1, blocks: [] })).toBe('');
    expect(contentText(null)).toBe('');
  });
});

describe('renderTextPdf', () => {
  it('draws the title and the body text where pdfjs can read them back', async () => {
    const bytes = await renderTextPdf({
      title: 'Service agreement',
      content: content([
        { type: 'heading', level: 1, runs: [{ text: 'Scope of work' }] },
        {
          type: 'paragraph',
          runs: [{ text: 'The ' }, { text: 'contractor', bold: true }, { text: ' agrees.' }],
        },
        { type: 'list', ordered: true, items: [[{ text: 'Deliver' }], [{ text: 'Invoice' }]] },
        { type: 'list', ordered: false, items: [[{ text: 'Bullet point' }]] },
        { type: 'rule' },
        para('Signature: ____________________'),
      ]),
    });
    expect(bytes).toEqual(jasmine.any(Uint8Array));
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
    const read = await allText(bytes);
    expect(read.pageCount).toBe(1);
    expect(read.text).toContain('Service agreement');
    expect(read.text).toContain('Scope of work');
    expect(read.text).toContain('contractor');
    expect(read.text).toContain('agrees.');
    expect(read.text).toContain('1.');
    expect(read.text).toContain('Deliver');
    expect(read.text).toContain('Invoice');
    expect(read.text).toContain('Bullet point');
    expect(read.text).toContain('Signature:');
    // One page: no footer.
    expect(read.text).not.toContain('Page 1 of');
  });

  it('writes the document metadata', async () => {
    const bytes = await renderTextPdf({ title: 'Lease', content: content([para('x')]) });
    const doc = await openPdf(bytes);
    const { info } = await doc.getMetadata();
    expect(info.Title).toBe('Lease');
    expect(info.Producer).toBe('DocuStamp');
    expect(info.Creator).toBe('DocuStamp');
  });

  it('adds pages as the content grows and numbers them', async () => {
    const short = await renderTextDocument({ title: 'Short', content: content(paragraphs(3)) });
    expect(short.pageCount).toBe(1);
    const long = await renderTextDocument({ title: 'Long', content: content(paragraphs(40)) });
    expect(long.pageCount).toBeGreaterThan(2);
    const longer = await renderTextDocument({ title: 'Longer', content: content(paragraphs(80)) });
    expect(longer.pageCount).toBeGreaterThan(long.pageCount);

    const read = await allText(long.bytes);
    expect(read.pageCount).toBe(long.pageCount);
    expect(read.pages[0]).toContain('Paragraph 1.');
    expect(read.pages[0]).toContain(`Page 1 of ${long.pageCount}`);
    expect(read.pages[read.pages.length - 1]).toContain(
      `Page ${long.pageCount} of ${long.pageCount}`
    );
    expect(read.text).toContain('Paragraph 40.');
  });

  it('starts a new page at a page break, except on an empty page', async () => {
    const broken = await renderTextDocument({
      title: 'Break',
      content: content([para('Before'), { type: 'pageBreak' }, para('After')]),
    });
    expect(broken.pageCount).toBe(2);
    const read = await allText(broken.bytes);
    expect(read.pages[0]).toContain('Before');
    expect(read.pages[0]).not.toContain('After');
    expect(read.pages[1]).toContain('After');

    // A break before anything is drawn, two in a row, or one at the very end
    // add no empty pages.
    const redundant = await renderTextDocument({
      content: content([
        { type: 'pageBreak' },
        para('One'),
        { type: 'pageBreak' },
        { type: 'pageBreak' },
        para('Two'),
        { type: 'pageBreak' },
      ]),
    });
    expect(redundant.pageCount).toBe(2);
  });

  it('keeps a heading with the lines under it', async () => {
    // Fill the first page so the heading would land just above the bottom
    // margin: it has to move to page two together with its paragraph.
    let filler = 30;
    let result;
    for (; filler < 60; filler++) {
      // eslint-disable-next-line no-await-in-loop -- searching for the page boundary
      result = await renderTextDocument({
        content: content([
          ...paragraphs(filler),
          { type: 'heading', level: 2, runs: [{ text: 'Orphan test' }] },
          para('Body under the heading.'),
        ]),
      });
      if (result.pageCount === 2) break;
    }
    const read = await allText(result.bytes);
    const headingPage = read.pages.findIndex(text => text.includes('Orphan test'));
    const bodyPage = read.pages.findIndex(text => text.includes('Body under the heading.'));
    expect(headingPage).toBeGreaterThanOrEqual(0);
    expect(bodyPage).toBe(headingPage);
  });

  it('renders A4 and Letter at their sizes', async () => {
    const letter = await renderTextPdf({ content: content([para('x')]) });
    expect(await pageSize(letter)).toEqual({ width: 612, height: 792 });
    const a4 = await renderTextPdf({ content: content([para('x')], { pageSize: 'a4' }) });
    const size = await pageSize(a4);
    expect(size.width).toBeCloseTo(PAGE_SIZES.a4[0], 1);
    expect(size.height).toBeCloseTo(PAGE_SIZES.a4[1], 1);
  });

  it('renders empty content as one page', async () => {
    const blank = await renderTextDocument({ title: '', content: content([]) });
    expect(blank.pageCount).toBe(1);
    expect((await allText(blank.bytes)).text.trim()).toBe('');
    const titled = await renderTextDocument({ title: 'Only a title', content: content([]) });
    expect(titled.pageCount).toBe(1);
    expect((await allText(titled.bytes)).text).toContain('Only a title');
    const none = await renderTextDocument({ title: 'No content at all' });
    expect(none.pageCount).toBe(1);
  });

  it('never throws on odd text: long words, missing glyphs, lone surrogates', async () => {
    const bytes = await renderTextPdf({
      title: 'Odd \u{1F600} \uD83D title',
      content: content([
        para('Supercalifragilisticexpialidocious'.repeat(8)),
        para(
          'Emoji \u{1F600}, CJK \u4E2D\u6587, Arabic \u0645\u0631\u062D\u0628\u0627, lone \uD83D surrogate, zwj a\u200Db.'
        ),
        {
          type: 'heading',
          level: 1,
          runs: [{ text: 'Heading-with-a-very-long-unbreakable-word-' + 'x'.repeat(200) }],
        },
        { type: 'list', ordered: true, items: [[{ text: 'y'.repeat(300), underline: true }]] },
        {
          type: 'paragraph',
          runs: [{ text: '   leading spaces and trailing   ' }],
          align: 'right',
        },
        { type: 'paragraph', runs: [{ text: 'centred\nover two lines' }], align: 'center' },
      ]),
    });
    const read = await allText(bytes);
    expect(read.text).toContain('Odd');
    expect(read.text).toContain('Supercalifragilisticexpialidocious');
    expect(read.text).toContain('over two lines');
  });
});

describe('Content column', () => {
  it('documentFields writes the content it is given and nothing otherwise', () => {
    const caller = { userId: 'u1', extUserId: 'e1' };
    const normalised = normaliseContent(content([para('hi')]));
    const withContent = documentFields(caller, { name: 'Written', url: 'u', content: normalised });
    expect(withContent.Content).toEqual(normalised);
    const without = documentFields(caller, { name: 'Uploaded', url: 'u' });
    expect('Content' in without).toBe(false);
  });
});

describe('rendertextpdf cloud function', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let ownerSession;
  let ownerExt;
  let noProfile;
  let suspended;

  beforeAll(async () => {
    owner = await makeUser(uniqueEmail('owner.textdoc'));
    ownerSession = owner.__specSessionToken;
    ownerExt = await makeExtUser(owner);
    noProfile = await makeUser(uniqueEmail('noprofile.textdoc'));
    suspended = await makeUser(uniqueEmail('suspended.textdoc'));
    await makeExtUser(suspended, { IsDisabled: true });
  }, 120000);

  beforeEach(() => resetRateLimits());

  const body = { title: 'Consulting agreement', content: content([para('Hello there.')]) };

  it('refuses a caller without a session', async () => {
    const res = await callFn('rendertextpdf', body);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
  });

  it('refuses an account without a profile row, and a suspended one', async () => {
    const missing = await callFn('rendertextpdf', body, session(noProfile.__specSessionToken));
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    expect(missing.status).toBe(404);

    const disabled = await callFn('rendertextpdf', body, session(suspended.__specSessionToken));
    expect(disabled.ok).toBe(false);
    expect(disabled.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
  });

  it('refuses content the model does not accept', async () => {
    const res = await callFn(
      'rendertextpdf',
      { title: 'x', content: { version: 3, blocks: [] } },
      session(ownerSession)
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe(Parse.Error.VALIDATION_ERROR);
    const none = await callFn('rendertextpdf', { title: 'x' }, session(ownerSession));
    expect(none.ok).toBe(false);
    expect(none.code).toBe(Parse.Error.VALIDATION_ERROR);
  });

  it('returns the PDF as base64 with its page count and size', async () => {
    const res = await callFn('rendertextpdf', body, session(ownerSession));
    expect(res.ok).toBe(true);
    expect(Object.keys(res.result).sort()).toEqual(['bytes', 'pageCount', 'pdfBase64']);
    expect(res.result.pageCount).toBe(1);
    const bytes = Buffer.from(res.result.pdfBase64, 'base64');
    expect(bytes.length).toBe(res.result.bytes);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const read = await allText(bytes);
    expect(read.text).toContain('Consulting agreement');
    expect(read.text).toContain('Hello there.');
  }, 60000);

  it('trims the title to 250 characters and treats a missing title as none', async () => {
    const longTitle = `  ${'T'.repeat(300)}  `;
    const res = await callFn(
      'rendertextpdf',
      { title: longTitle, content: body.content },
      session(ownerSession)
    );
    expect(res.ok).toBe(true);
    const doc = await openPdf(Buffer.from(res.result.pdfBase64, 'base64'));
    const { info } = await doc.getMetadata();
    expect(info.Title).toBe('T'.repeat(250));

    const untitled = await callFn(
      'rendertextpdf',
      { content: body.content },
      session(ownerSession)
    );
    expect(untitled.ok).toBe(true);
    expect(untitled.result.pageCount).toBe(1);
  }, 60000);

  it('createdocumentfromapp stores the normalised content on the draft', async () => {
    const res = await callFn(
      'createdocumentfromapp',
      {
        document: {
          Name: `Written ${Date.now()}`,
          URL: localFileUrl('written.pdf'),
          Content: content([
            { type: 'heading', level: 7, runs: [{ text: 'Head\tline' }] },
            { type: 'unknown' },
            para('Body'),
          ]),
        },
      },
      session(ownerSession)
    );
    expect(res.ok).toBe(true);
    const stored = await new Parse.Query('contracts_Document').get(res.result.objectId, {
      useMasterKey: true,
    });
    expect(stored.get('ExtUserPtr').id).toBe(ownerExt.id);
    expect(stored.get('Content')).toEqual({
      version: 1,
      pageSize: 'letter',
      blocks: [
        { type: 'heading', level: 3, runs: [{ text: 'Head    line' }], align: 'left' },
        { type: 'paragraph', runs: [{ text: 'Body' }], align: 'left' },
      ],
    });

    const bad = await callFn(
      'createdocumentfromapp',
      {
        document: {
          Name: `Written bad ${Date.now()}`,
          URL: localFileUrl('written.pdf'),
          Content: { version: 1, blocks: 'nope' },
        },
      },
      session(ownerSession)
    );
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe(Parse.Error.VALIDATION_ERROR);
  }, 60000);
});
