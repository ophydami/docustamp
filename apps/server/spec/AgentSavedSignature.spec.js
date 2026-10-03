/**
 * An agent signing with the signature its user saved in DocuStamp
 * (cloud/lib/savedSignature.js, used by cloud/lib/agentSign.js): the saved
 * signature and initials are stamped like an adopted image; a user with none
 * gets the typed one, and that is saved as theirs the first time. Approvals
 * show the saved image before the user decides.
 *
 * Like spec/AgentSign.spec.js this needs the internal proxy on 8080 and a
 * pkcs#12 from openssl; without either the signing cases are pending.
 */
import axios from 'axios';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from 'pdf-lib';
import { setAiClientForTests } from '../cloud/ai/client.js';
import {
  SIGNATURE_SAVED_LINE,
  agentSignDocument,
  prepareAgentSignature,
  setAgentSignMailTransport,
} from '../cloud/lib/agentSign.js';
import {
  createSignApproval,
  decideApproval,
  getApproval,
  getApprovalImages,
  setApprovalMailTransport,
  withoutImageUrls,
} from '../cloud/lib/approvals.js';
import { loadCaller } from '../cloud/lib/context.js';
import { fetchPdfBytes } from '../cloud/lib/files.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { saveTypedImages } from '../cloud/lib/savedSignature.js';
import {
  certificateSignature,
  initialsFrom,
  renderToWidgetBox,
  typedSignaturePng,
} from '../cloud/lib/stamp.js';
import { fetchStoredImage } from '../cloud/lib/upload.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const MASTER_KEY = 'test';
const INTERNAL_PORT = 8080;
const INTERNAL_PREFIX = '/app';
const PUBLIC_URL = 'https://sign.example.test';

/** The signature box (150 x 60) less its 8pt note band, and the 50 x 50 initials box, at 4 px a point. */
const SIG_BOX = { w: 150, h: 52 };
const INITIALS_BOX = { w: 50, h: 50 };

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Reverse proxy for `cloudServerUrl` (see spec/SignPdf.spec.js). */
function startInternalProxy() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const suffix = req.url.startsWith(INTERNAL_PREFIX)
          ? req.url.slice(INTERNAL_PREFIX.length)
          : req.url;
        try {
          const upstream = await fetch(`${TEST_SERVER}${suffix}`, {
            method: req.method,
            headers: {
              'content-type': req.headers['content-type'] || 'application/json',
              'X-Parse-Application-Id': APP_ID,
              'X-Parse-Master-Key': MASTER_KEY,
            },
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') || 'application/json',
          });
          res.end(body);
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
      });
    });
    server.on('error', () => resolve(null));
    server.listen(INTERNAL_PORT, () => resolve(server));
  });
}

/** A self-signed pkcs#12, base64, or null without openssl. */
function makePfxBase64() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docustamp-saved-sig-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const p12 = path.join(dir, 'k.p12');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2'].concat([
        '-nodes',
        '-subj',
        '/CN=DocuStamp Saved Signature Spec',
      ]),
      { stdio: 'ignore' }
    );
    execFileSync(
      'openssl',
      ['pkcs12', '-export', '-out', p12, '-inkey', key, '-in', cert, '-passout', 'pass:specpass']
        .concat(['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']),
      { stdio: 'ignore' }
    );
    return fs.readFileSync(p12).toString('base64');
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function storeFile(name, bytes) {
  const file = new Parse.File(name, { base64: Buffer.from(bytes).toString('base64') });
  await file.save({ useMasterKey: true });
  return file.url().split('?')[0];
}

async function storePdf(text) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 72, y: 740, size: 14, font });
  return await storeFile('base.pdf', await pdf.save());
}

let canvasLib;
async function canvas() {
  canvasLib = canvasLib || (await import('@napi-rs/canvas'));
  return canvasLib;
}

/**
 * A "hand drawn" mark that looks nothing like a typed name: crisp blocks of
 * ink on a transparent ground, laid out by `seed`.
 */
async function drawnMark(seed, width = 320, height = 110) {
  const { createCanvas } = await canvas();
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1c1b18';
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(10 + i * 50, 10 + ((i * seed) % 5) * 15, 30, 20 + seed * 3);
  }
  return c.toBuffer('image/png');
}

/** The alpha channel of a PNG: the shape of the ink. */
async function alphaOf(png) {
  const { createCanvas, loadImage } = await canvas();
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const alpha = Buffer.alloc(img.width * img.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { width: img.width, height: img.height, alpha };
}

/** What the stamp would embed for `png` in a box of `box` points. */
async function boxedAlpha(png, box) {
  return await alphaOf(await renderToWidgetBox(png, box.w, box.h));
}

/** Every image with an alpha mask in a PDF, as the stamp embedded it. */
async function embeddedImages(pdfBytes) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const out = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const smaskRef = obj.dict.get(PDFName.of('SMask'));
    if (!smaskRef) continue;
    const smask = pdf.context.lookup(smaskRef);
    out.push({
      width: obj.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
      height: obj.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
      alpha: zlib.inflateSync(Buffer.from(smask.contents)),
    });
  }
  return out;
}

/** True when the signed PDF carries an image with exactly `expected`'s ink. */
function carries(images, expected) {
  return images.some(
    img =>
      img.width === expected.width &&
      img.height === expected.height &&
      Buffer.compare(img.alpha, expected.alpha) === 0
  );
}

let pdfjsLib;
async function pdfText(bytes) {
  pdfjsLib = pdfjsLib || (await import('pdfjs-dist/legacy/build/pdf.mjs'));
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
    .promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n); // eslint-disable-line no-await-in-loop
    const content = await page.getTextContent(); // eslint-disable-line no-await-in-loop
    out.push(...content.items.map(i => i.str));
  }
  return out.join('\n');
}

async function makeAccount(prefix, name) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  user.set('name', name);
  await user.signUp();
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', `${name} Co`);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const ext = new Parse.Object('contracts_Users');
  ext.set('Name', name);
  ext.set('Email', email);
  ext.set('Timezone', 'America/New_York');
  ext.set('UserId', user.toPointer());
  ext.set('TenantId', tenant.toPointer());
  ext.set('UserRole', 'contracts_Admin');
  await ext.save(null, { useMasterKey: true });
  user.set('emailVerified', true);
  await user.save(null, { useMasterKey: true });
  // A session of their own, for the cloud functions the web app calls.
  const signedIn = await Parse.User.logIn(email, 'pa55word!');
  return { user, ext, email, name, session: { sessionToken: signedIn.getSessionToken() } };
}

/** The caller an OAuth app with "Can sign for me" gets for `account`. */
async function callerFor(account) {
  const user = await new Parse.Query(Parse.User).get(account.user.id, { useMasterKey: true });
  const caller = await loadCaller(user, { publicUrl: PUBLIC_URL });
  caller.oauth = {
    clientId: 'client-chatgpt',
    clientName: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    signingEnabledAt: new Date('2026-10-01T12:00:00Z'),
  };
  caller.scopes = [...new Set([...(caller.scopes || []), 'documents:sign'])];
  caller.ip = '10.1.2.3';
  return caller;
}

/** Save a signature (and initials) the way the settings page does: upload, then `savesignature`. */
async function saveInSettings(account, { signature, initials }) {
  const params = { userId: account.user.id, title: account.name };
  if (signature) params.signature = await storeFile('mine_signature.png', signature);
  if (initials) params.initials = await storeFile('mine_initials.png', initials);
  await Parse.Cloud.run('savesignature', params, account.session);
  return params;
}

async function signatureRows(account) {
  const query = new Parse.Query('contracts_Signature');
  query.equalTo('UserId', pointer('_User', account.user.id));
  return await query.find({ useMasterKey: true });
}

const bare = url => String(url || '').split('?')[0];

async function contactOf(owner, person) {
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', person.name);
  contact.set('Email', person.email);
  contact.set('CreatedBy', owner.user.toPointer());
  contact.set('UserId', person.user.toPointer());
  contact.set('IsDeleted', false);
  return await contact.save(null, { useMasterKey: true });
}

let keySeq = 5000;
function widget(type, x, y, w, h) {
  keySeq += 1;
  return {
    key: keySeq,
    type,
    xPosition: x,
    yPosition: y,
    Width: w,
    Height: h,
    scale: 1,
    options: { name: `${type}-${keySeq}`, status: 'required' },
  };
}

/**
 * A sent document by `owner`: `signer` first (a signature and, unless
 * `initials: false`, initials), then `other`, so one signature never completes it.
 */
async function makeDoc(owner, signer, other, { initials = true } = {}) {
  const url = await storePdf('Saved signature agreement');
  const first = await contactOf(owner, signer);
  const second = await contactOf(owner, other);
  const mine = [widget('signature', 72, 600, 150, 60)];
  if (initials) mine.push(widget('initials', 300, 600, 50, 50));
  const seats = [
    { contact: first, widgets: mine },
    { contact: second, widgets: [widget('signature', 72, 680, 150, 60)] },
  ];
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', `Agreement ${keySeq}`);
  doc.set('URL', url);
  doc.set('CreatedBy', owner.user.toPointer());
  doc.set('ExtUserPtr', owner.ext.toPointer());
  doc.set('IsSendMail', false);
  doc.set(
    'Signers',
    seats.map(s => pointer('contracts_Contactbook', s.contact.id))
  );
  doc.set(
    'Placeholders',
    seats.map((s, i) => ({
      Id: i + 1,
      Role: `Role ${i + 1}`,
      signerObjId: s.contact.id,
      signerPtr: pointer('contracts_Contactbook', s.contact.id),
      email: s.contact.get('Email'),
      placeHolder: [{ pageNumber: 1, pos: s.widgets }],
    }))
  );
  await doc.save(null, { useMasterKey: true });
  const update = new Parse.Object('contracts_Document');
  update.id = doc.id;
  update.set('SignedUrl', url);
  update.set('DocSentAt', new Date());
  await update.save(null, { useMasterKey: true });
  return doc;
}

async function reload(docId) {
  return JSON.parse(
    JSON.stringify(await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true }))
  );
}

async function signedPdf(docId) {
  return await fetchPdfBytes((await reload(docId)).SignedUrl);
}

describe('agent signing with the saved signature (lib/savedSignature.js)', () => {
  Parse.User.enableUnsafeCurrentUser();

  let proxy;
  let pfxBase64;
  let ownerMails;
  let other;

  function requirements() {
    if (!proxy) return 'port 8080 is not free, so the internal server url cannot be stubbed';
    if (!pfxBase64) return 'openssl is not available to build a test pkcs#12';
    return '';
  }

  beforeAll(async () => {
    proxy = await startInternalProxy();
    pfxBase64 = makePfxBase64();
    process.env.PFX_BASE64 = pfxBase64 || '';
    process.env.PASS_PHRASE = pfxBase64 ? 'specpass' : '';
    other = await makeAccount('saved.other', 'Oscar Other');
    setRequestMailTransport(async () => ({ status: 'success' }));
    setApprovalMailTransport(async () => ({ status: 'success' }));
    setAgentSignMailTransport(async params => {
      ownerMails.push(params);
      return { status: 'success' };
    });
    // The approval's AI review is beside the point here: no review.
    setAiClientForTests({
      messages: {
        create: async () => {
          throw new Error('no AI in this spec');
        },
      },
    });
  }, 120000);

  afterAll(async () => {
    setRequestMailTransport(null);
    setApprovalMailTransport(null);
    setAgentSignMailTransport(null);
    setAiClientForTests(null);
    if (proxy) await new Promise(resolve => proxy.close(resolve));
  });

  beforeEach(() => {
    resetRateLimits();
    ownerMails = [];
  });

  it('stamps the saved signature and initials, and saves nothing new', async () => {
    const why = requirements();
    if (why) return pending(why);
    const sally = await makeAccount('saved.sally', 'Sally Saved');
    const signature = await drawnMark(1);
    const initials = await drawnMark(2, 120, 90);
    const stored = await saveInSettings(sally, { signature, initials });
    const doc = await makeDoc(sally, sally, other);

    const res = await agentSignDocument(await callerFor(sally), doc.id);
    expect(res.status).toBe('signed');
    expect(res.signatureSaved).toBe(false);

    // The saved images, letterboxed into each box like an adopted image.
    const bytes = await signedPdf(doc.id);
    const images = await embeddedImages(bytes);
    expect(carries(images, await boxedAlpha(signature, SIG_BOX))).toBeTrue();
    expect(carries(images, await boxedAlpha(initials, INITIALS_BOX))).toBeTrue();
    // Not the typed name.
    const typed = await typedSignaturePng('Sally Saved');
    expect(carries(images, await boxedAlpha(typed, SIG_BOX))).toBeFalse();
    // The agent note stays in the box.
    expect(await pdfText(bytes)).toContain('Signed via ChatGPT for Sally Saved');

    // The certificate's image is made from the same saved signature.
    const entry = (await reload(doc.id)).AuditTrail[0];
    const certImage = await fetchStoredImage(entry.Signature);
    expect((await alphaOf(certImage)).alpha).toEqual(
      (await alphaOf(await certificateSignature(signature))).alpha
    );

    // Nothing saved, nothing replaced, and no "we saved" line.
    const rows = await signatureRows(sally);
    expect(rows.length).toBe(1);
    expect(bare(rows[0].get('ImageURL'))).toBe(stored.signature);
    expect(bare(rows[0].get('Initials'))).toBe(stored.initials);
    expect(ownerMails.length).toBe(1);
    expect(ownerMails[0].html).not.toContain('We saved this as your signature');
  }, 120000);

  it('saves the typed signature and initials the first time, then uses them', async () => {
    const why = requirements();
    if (why) return pending(why);
    const fred = await makeAccount('saved.fred', 'Fred Fresh');
    expect((await signatureRows(fred)).length).toBe(0);

    const first = await makeDoc(fred, fred, other);
    const res1 = await agentSignDocument(await callerFor(fred), first.id);
    expect(res1.signatureSaved).toBe(true);
    // The owner notice says so, once.
    expect(ownerMails.length).toBe(1);
    expect(ownerMails[0].html).toContain('We saved this as your signature.');
    expect(ownerMails[0].html).toContain('Settings &gt; My signature and initials.');
    expect(SIGNATURE_SAVED_LINE).toBe(
      'We saved this as your signature. You can change it any time in DocuStamp Settings > My signature and initials.'
    );

    // Stamped with the typed name, as before.
    const typed = await typedSignaturePng('Fred Fresh');
    const typedInitials = await typedSignaturePng(initialsFrom('Fred Fresh'));
    const firstImages = await embeddedImages(await signedPdf(first.id));
    expect(carries(firstImages, await boxedAlpha(typed, SIG_BOX))).toBeTrue();
    expect(carries(firstImages, await boxedAlpha(typedInitials, INITIALS_BOX))).toBeTrue();

    // Saved like the settings page saves one: one row, the owner's alone.
    const rows = await signatureRows(fred);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.get('SignatureName')).toBe('Fred Fresh');
    expect(row.getACL().getPublicReadAccess()).toBe(false);
    expect(row.getACL().getPublicWriteAccess()).toBe(false);
    expect(row.getACL().getReadAccess(fred.user.id)).toBe(true);
    expect(row.getACL().getWriteAccess(fred.user.id)).toBe(true);
    expect((await alphaOf(await fetchStoredImage(row.get('ImageURL')))).alpha).toEqual(
      (await alphaOf(typed)).alpha
    );
    expect((await alphaOf(await fetchStoredImage(row.get('Initials')))).alpha).toEqual(
      (await alphaOf(typedInitials)).alpha
    );

    // The web signer page and Settings now offer it as theirs.
    const offered = await Parse.Cloud.run(
      'getdefaultsignature',
      { userId: fred.user.id },
      fred.session
    );
    expect(offered.id).toBe(row.id);
    expect(bare(offered.get('ImageURL'))).toBe(bare(row.get('ImageURL')));
    expect(bare(offered.get('Initials'))).toBe(bare(row.get('Initials')));

    // The next signature reuses it, saves nothing and says nothing.
    const second = await makeDoc(fred, fred, other);
    const res2 = await agentSignDocument(await callerFor(fred), second.id);
    expect(res2.signatureSaved).toBe(false);
    expect(ownerMails.length).toBe(2);
    expect(ownerMails[1].html).not.toContain('We saved this as your signature');
    const after = await signatureRows(fred);
    expect(after.length).toBe(1);
    expect(bare(after[0].get('ImageURL'))).toBe(bare(row.get('ImageURL')));
    expect(bare(after[0].get('Initials'))).toBe(bare(row.get('Initials')));
    const secondImages = await embeddedImages(await signedPdf(second.id));
    expect(carries(secondImages, await boxedAlpha(typed, SIG_BOX))).toBeTrue();
  }, 120000);

  it('saves typed initials next to a saved signature, leaving the signature alone', async () => {
    const why = requirements();
    if (why) return pending(why);
    const hana = await makeAccount('saved.hana', 'Hana Half');
    const signature = await drawnMark(3);
    const stored = await saveInSettings(hana, { signature });

    const doc = await makeDoc(hana, hana, other);
    const res = await agentSignDocument(await callerFor(hana), doc.id);
    expect(res.signatureSaved).toBe(true);
    const typedInitials = await typedSignaturePng(initialsFrom('Hana Half'));
    const images = await embeddedImages(await signedPdf(doc.id));
    expect(carries(images, await boxedAlpha(signature, SIG_BOX))).toBeTrue();
    expect(carries(images, await boxedAlpha(typedInitials, INITIALS_BOX))).toBeTrue();

    const rows = await signatureRows(hana);
    expect(rows.length).toBe(1);
    expect(bare(rows[0].get('ImageURL'))).toBe(stored.signature);
    expect((await alphaOf(await fetchStoredImage(rows[0].get('Initials')))).alpha).toEqual(
      (await alphaOf(typedInitials)).alpha
    );

    const again = await makeDoc(hana, hana, other);
    expect((await agentSignDocument(await callerFor(hana), again.id)).signatureSaved).toBe(false);
  }, 120000);

  it('saves only what the document used, and never replaces a saved image', async () => {
    const why = requirements();
    if (why) return pending(why);
    const nina = await makeAccount('saved.nina', 'Nina Noinitials');
    const doc = await makeDoc(nina, nina, other, { initials: false });
    const res = await agentSignDocument(await callerFor(nina), doc.id);
    expect(res.signatureSaved).toBe(true);
    const rows = await signatureRows(nina);
    expect(rows.length).toBe(1);
    expect(rows[0].get('ImageURL')).toContain('/files/');
    expect(rows[0].get('Initials')).toBeUndefined();

    // A signature saved by now is kept: only the empty column is written.
    const kept = await saveTypedImages(
      nina.user.id,
      { signature: await drawnMark(4), initials: await drawnMark(5) },
      { name: nina.name }
    );
    expect(kept).toEqual({ signature: false, initials: true });
    const after = await signatureRows(nina);
    expect(after.length).toBe(1);
    expect(bare(after[0].get('ImageURL'))).toBe(bare(rows[0].get('ImageURL')));
    expect(after[0].get('Initials')).toContain('/files/');
  }, 120000);

  it('refuses, signing nothing, when the saved signature cannot be read', async () => {
    const why = requirements();
    if (why) return pending(why);
    const bea = await makeAccount('saved.bea', 'Bea Broken');
    // A stored file that is not an image.
    await Parse.Cloud.run(
      'savesignature',
      { userId: bea.user.id, signature: await storePdf('not an image') },
      bea.session
    );
    const doc = await makeDoc(bea, bea, other);
    let err;
    try {
      await agentSignDocument(await callerFor(bea), doc.id);
    } catch (e) {
      err = e;
    }
    expect(err?.message).toContain('Your saved signature could not be loaded, so nothing was signed.');
    expect((await reload(doc.id)).AuditTrail).toBeUndefined();
  }, 60000);

  describe('before the user approves', () => {
    it('shows the saved image that will be stamped, read fresh', async () => {
      const why = requirements();
      if (why) return pending(why);
      const amy = await makeAccount('saved.amy', 'Amy Approver');
      const caller = await callerFor(amy);
      // Someone else's document, sent to Amy.
      const doc = await makeDoc(other, amy, other);

      // Nothing saved yet: the name will be typed, so no image.
      const plain = await prepareAgentSignature(caller, doc.id);
      expect(plain.values.find(v => v.type === 'signature').imageUrl).toBeUndefined();

      const signature = await drawnMark(6);
      const initials = await drawnMark(7, 120, 90);
      await saveInSettings(amy, { signature, initials });

      const prepared = await prepareAgentSignature(caller, doc.id);
      const sigValue = prepared.values.find(v => v.type === 'signature');
      expect(sigValue.value).toBe('Amy Approver');
      expect(sigValue.imageUrl).toContain('/files/');
      expect(sigValue.imageUrl).toContain('token=');

      const asked = await createSignApproval(caller, doc.id);
      const values = asked.approval.values;
      const shown = values.find(v => v.type === 'signature').imageUrl;
      const shownInitials = values.find(v => v.type === 'initials').imageUrl;
      expect(shown).toContain('token=');
      expect(shownInitials).toContain('token=');
      // A short-lived link to the saved image itself.
      const fetched = await axios.get(shown, { responseType: 'arraybuffer' });
      expect(Buffer.from(fetched.data).equals(signature)).toBeTrue();
      // Not stored on the request: it is read again on every read.
      const row = await new Parse.Query('contracts_SignApproval').get(asked.approval.id, {
        useMasterKey: true,
      });
      expect(JSON.stringify(row.get('Values'))).not.toContain('imageUrl');
      const read = await getApproval(caller, asked.approval.id);
      expect(read.values.find(v => v.type === 'signature').imageUrl).toContain('token=');
      expect(read.signatureSaved).toBe(false);
      // What an AI app is handed: a flag that an image is saved, never the link.
      const forModel = withoutImageUrls(read);
      expect(JSON.stringify(forModel)).not.toContain('token=');
      expect(forModel.values.find(v => v.type === 'signature').savedImage).toBeTrue();
      expect(forModel.values.find(v => v.type === 'initials').savedImage).toBeTrue();

      // The chat card gets the images as data urls.
      const cardImages = await getApprovalImages(caller, asked.approval.id);
      expect(Object.keys(cardImages).sort()).toEqual(['initials', 'signature']);
      const decoded = Buffer.from(cardImages.signature.split(',')[1], 'base64');
      expect(cardImages.signature).toMatch(/^data:image\/png;base64,/);
      expect(decoded.equals(signature)).toBeTrue();

      const decided = await decideApproval({
        approvalId: asked.approval.id,
        decision: 'approve',
        via: 'web',
        caller,
      });
      expect(decided.status).toBe('signed');
      expect(decided.signatureSaved).toBe(false);
      // Decided: no image link any more.
      expect(decided.values.some(v => v.imageUrl)).toBeFalse();
      expect(await getApprovalImages(caller, asked.approval.id)).toEqual({});
      const images = await embeddedImages(await signedPdf(doc.id));
      expect(carries(images, await boxedAlpha(signature, SIG_BOX))).toBeTrue();
      expect(ownerMails.length).toBe(0);
    }, 120000);

    it('says once that approving saved the typed signature as theirs', async () => {
      const why = requirements();
      if (why) return pending(why);
      const tom = await makeAccount('saved.tom', 'Tom Typed');
      const caller = await callerFor(tom);
      const doc = await makeDoc(other, tom, other);

      const asked = await createSignApproval(caller, doc.id);
      expect(asked.approval.values.some(v => v.imageUrl)).toBeFalse();
      expect(asked.approval.signatureSaved).toBe(false);

      const decided = await decideApproval({
        approvalId: asked.approval.id,
        decision: 'approve',
        via: 'web',
        caller,
      });
      expect(decided.status).toBe('signed');
      expect(decided.signatureSaved).toBe(true);
      // Kept with the request, so the page still says it after a reload.
      expect((await getApproval(caller, asked.approval.id)).signatureSaved).toBe(true);
      expect((await signatureRows(tom)).length).toBe(1);

      // The next request shows the signature that is now saved, and saves nothing.
      const next = await makeDoc(other, tom, other);
      const again = await createSignApproval(caller, next.id);
      expect(again.approval.values.find(v => v.type === 'signature').imageUrl).toContain(
        'token='
      );
      const second = await decideApproval({
        approvalId: again.approval.id,
        decision: 'approve',
        via: 'web',
        caller,
      });
      expect(second.status).toBe('signed');
      expect(second.signatureSaved).toBe(false);
    }, 120000);
  });
});
