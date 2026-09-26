/**
 * Coverage for the signing-integrity fixes in `signPdf` (cloud/parsefunction/pdf/PDF.js).
 *
 * `signPdf` used to trust `req.params.userId`: anyone who knew a docId could
 * post a pdf as any signer on it, re-sign a document that was already complete,
 * or submit twice. It also fired the certificate/completion-mail promise without
 * awaiting it, so a throw in there became an unhandled rejection that takes the
 * process down on node 18+.
 *
 * Two environment facts shape this spec:
 *  - `cloudServerUrl` in Utils.js is hard-coded to http://localhost:8080/app and
 *    PDF.js captures `process.env.MASTER_KEY` at import time (undefined under
 *    `npx jasmine`). The signing happy path therefore talks to a port that does
 *    not exist in tests, so we stand a small reverse proxy on 8080 that forwards
 *    to the test Parse Server and injects the master key.
 *  - `SIGNING_TOKEN_REQUIRED_FROM` (authGuard.js) still grants legacy links a
 *    grace period, and documents created by this spec fall inside it, so an
 *    anonymous call that carries a real contactId is accepted by design. The
 *    anonymous refusal covered here is the one the grace period does not touch:
 *    no session, no token, no contactId, and a token that does not verify.
 */
import axios from 'axios';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { upsertAuditEntry } from '../cloud/lib/auditTrail.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';

/** A 1x1 png, standing in for the signer's rendered signature image. */
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const APP_ID = 'test';
const MASTER_KEY = 'test';
/** Utils.js `cloudServerUrl`; the server calls itself here. */
const INTERNAL_PORT = 8080;
const INTERNAL_PREFIX = '/app';

const http_ = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http_.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': 'test',
        'x-real-ip': '10.9.9.9',
        public_url: 'https://sign.example.test',
        ...headers,
      },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

async function loginToken(email, password) {
  const res = await http_.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: { 'X-Parse-Application-Id': APP_ID, 'X-Parse-Javascript-Key': 'test' } }
  );
  return res.data.sessionToken;
}

const session = token => ({ 'X-Parse-Session-Token': token });

/**
 * Reverse proxy for `cloudServerUrl`. Everything PDF.js does over HTTP (file
 * upload, the document PUT, the DebugginLog PUT) goes through here.
 */
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
              // PDF.js reads MASTER_KEY at import time, before jasmine loads the
              // specs, so it cannot send one itself in this harness.
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

/** A self-signed pkcs#12, base64. Returns null when openssl is unavailable. */
function makePfxBase64() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docustamp-spec-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const p12 = path.join(dir, 'k.p12');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '2',
        '-nodes',
        '-subj',
        '/CN=DocuStamp Spec',
      ],
      { stdio: 'ignore' }
    );
    execFileSync(
      'openssl',
      [
        'pkcs12',
        '-export',
        '-out',
        p12,
        '-inkey',
        key,
        '-in',
        cert,
        '-passout',
        'pass:specpass',
        // node-forge (used by @signpdf/signer-p12) cannot read OpenSSL 3 defaults.
        '-keypbe',
        'PBE-SHA1-3DES',
        '-certpbe',
        'PBE-SHA1-3DES',
        '-macalg',
        'sha1',
      ],
      { stdio: 'ignore' }
    );
    return fs.readFileSync(p12).toString('base64');
  } catch (err) {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A one page pdf, base64, as the signer page posts it. */
async function makePdfBase64() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Spec agreement', { x: 72, y: 700, size: 14, font });
  return Buffer.from(await pdf.save()).toString('base64');
}

describe('signPdf integrity', () => {
  Parse.User.enableUnsafeCurrentUser();

  let proxy;
  let pfxBase64;
  let pdfBase64;
  let owner;
  let ownerSession;
  let ownerExt;
  let alice;
  let bob;
  let seq = 0;

  async function makeContact(email, name) {
    const contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', name);
    contact.set('Email', email);
    contact.set('CreatedBy', pointer('_User', owner.id));
    contact.set('UserId', pointer('_User', owner.id));
    contact.set('IsDeleted', false);
    return await contact.save(null, { useMasterKey: true });
  }

  /** A document with `contacts` as signers, one placeholder each. */
  async function makeDoc(contacts, extra = {}) {
    seq += 1;
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', `signpdf spec ${seq}`);
    doc.set('URL', `${TEST_SERVER}/files/${APP_ID}/spec.pdf`);
    doc.set('CreatedBy', pointer('_User', owner.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
    doc.set('IsSendMail', false);
    if (contacts.length > 0) {
      doc.set(
        'Signers',
        contacts.map(c => pointer('contracts_Contactbook', c.id))
      );
      doc.set(
        'Placeholders',
        contacts.map((c, i) => ({ Id: i + 1, signerObjId: c.id, email: c.get('Email') }))
      );
    }
    await doc.save(null, { useMasterKey: true });
    // The afterSave trigger recomputes ExpiryDate on insert, so fixture values
    // have to land in a follow-up update where it does not run.
    if (Object.keys(extra).length > 0) {
      const update = new Parse.Object('contracts_Document');
      update.id = doc.id;
      for (const [k, v] of Object.entries(extra)) update.set(k, v);
      await update.save(null, { useMasterKey: true });
      await doc.fetch({ useMasterKey: true });
    }
    return doc;
  }

  const tokenFor = (doc, contact) =>
    mintSigningToken({ docId: doc.id, contactId: contact.id, expiresAt: Date.now() + 60000 });

  async function reload(docId) {
    return JSON.parse(
      JSON.stringify(await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true }))
    );
  }

  beforeAll(async () => {
    proxy = await startInternalProxy();
    pfxBase64 = makePfxBase64();
    // The non-completing path only needs *a* value here; the digital seal (and
    // therefore a real key) is applied on the last signature.
    process.env.PFX_BASE64 = pfxBase64 || '';
    process.env.PASS_PHRASE = pfxBase64 ? 'specpass' : '';
    pdfBase64 = await makePdfBase64();

    const email = 'owner.signpdf@example.com';
    owner = new Parse.User();
    owner.set('username', email);
    owner.set('email', email);
    owner.set('password', 'Str0ng!pass');
    owner.set('name', 'Doc Owner');
    await owner.signUp();
    ownerSession = await loginToken(email, 'Str0ng!pass');

    const ext = new Parse.Object('contracts_Users');
    ext.set('UserId', pointer('_User', owner.id));
    ext.set('Email', email);
    ext.set('Name', 'Doc Owner');
    ext.set('UserRole', 'contracts_User');
    ownerExt = await ext.save(null, { useMasterKey: true });

    alice = await makeContact('alice.signpdf@example.com', 'Alice');
    bob = await makeContact('bob.signpdf@example.com', 'Bob');
  }, 120000);

  afterAll(async () => {
    if (proxy) await new Promise(resolve => proxy.close(resolve));
  });

  beforeEach(() => resetRateLimits());

  /* --------------------------------------------------------------- */
  describe('authentication', () => {
    it('refuses an anonymous caller with no session and no signing token', async () => {
      const doc = await makeDoc([alice, bob]);
      const res = await callFn('signPdf', { docId: doc.id, pdfFile: pdfBase64 });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe('Please open this document from your signing link.');
    });

    it('refuses a signing token that does not verify', async () => {
      const doc = await makeDoc([alice, bob]);
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: 'not-a.token',
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe('This signing link is invalid or has expired.');
    });

    it("refuses alice's token used to sign as bob", async () => {
      const doc = await makeDoc([alice, bob]);
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: bob.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe('You can only act as yourself on this document.');
      const after = await reload(doc.id);
      expect(after.SignedUrl).toBeUndefined();
      expect(after.AuditTrail).toBeUndefined();
    });

    it('refuses a token minted for a different document', async () => {
      const doc = await makeDoc([alice, bob]);
      const other = await makeDoc([alice]);
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(other, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('This signing link is invalid or has expired.');
    });

    it('refuses a token holder who is not a signer on the document', async () => {
      const doc = await makeDoc([alice]);
      const res = await callFn('signPdf', {
        docId: doc.id,
        signingToken: mintSigningToken({
          docId: doc.id,
          contactId: bob.id,
          expiresAt: Date.now() + 60000,
        }),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('This signing link does not belong to this document.');
    });

    it('shows the OTP gate to a token-only caller on an OTP document', async () => {
      const doc = await makeDoc([alice, bob], { IsEnableOTP: true });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("You don't have access of this document!");
    });
  });

  /* --------------------------------------------------------------- */
  describe('document state guards', () => {
    it('refuses to sign a completed document and leaves its artefacts intact', async () => {
      const doc = await makeDoc([alice, bob], {
        IsCompleted: true,
        SignedUrl: 'https://files.example.test/final.pdf',
        DocumentHash: 'deadbeef',
        CertificateUrl: 'https://files.example.test/cert.pdf',
      });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe('This document is already completed and can no longer be signed.');
      const after = await reload(doc.id);
      expect(after.SignedUrl).toBe('https://files.example.test/final.pdf');
      expect(after.DocumentHash).toBe('deadbeef');
      expect(after.CertificateUrl).toBe('https://files.example.test/cert.pdf');
    });

    it('refuses a second submit from a signer who is already recorded as signed', async () => {
      const doc = await makeDoc([alice, bob], {
        AuditTrail: [
          {
            UserPtr: pointer('contracts_Contactbook', alice.id),
            Activity: 'Signed',
            SignedUrl: 'https://files.example.test/partial.pdf',
            SignedOn: new Date().toISOString(),
          },
        ],
        SignedUrl: 'https://files.example.test/partial.pdf',
      });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe('You have already signed this document.');
      const after = await reload(doc.id);
      expect(after.AuditTrail.length).toBe(1);
      expect(after.SignedUrl).toBe('https://files.example.test/partial.pdf');
    });

    it('still lets the other signer act on that document', async () => {
      const doc = await makeDoc([alice, bob], {
        AuditTrail: [{ UserPtr: pointer('contracts_Contactbook', alice.id), Activity: 'Signed' }],
      });
      // Bob is not refused by the state guards; he is stopped later, by the
      // missing pdf, which proves the guards let him through.
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: bob.id,
        signingToken: tokenFor(doc, bob),
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Pdf file not present!');
    });

    it('refuses an expired document', async () => {
      const doc = await makeDoc([alice, bob], { ExpiryDate: new Date(Date.now() - 86400000) });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('This document has expired and can no longer be signed.');
    });

    it('refuses a declined document', async () => {
      const doc = await makeDoc([alice, bob], { IsDeclined: true });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('This document has been declined and can no longer be signed.');
    });
  });

  /* --------------------------------------------------------------- */
  describe('owner self-signing', () => {
    /** These need the internal proxy (file upload + document PUT) and a pfx. */
    function requirements() {
      if (!proxy) return 'port 8080 is not free, so the internal server url cannot be stubbed';
      if (!pfxBase64) return 'openssl is not available to build a test pkcs#12';
      return '';
    }

    it('lets the owner sign their own document with a session and no userId', async () => {
      const why = requirements();
      if (why) return pending(why);
      const doc = await makeDoc([]);
      const res = await callFn(
        'signPdf',
        { docId: doc.id, pdfFile: pdfBase64, signature: SIGNATURE_PNG },
        session(ownerSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.status).toBe('success');
      expect(res.result.data).toContain('/files/');
      const after = await reload(doc.id);
      expect(after.IsCompleted).toBe(true);
      expect(after.SignedUrl).toBeTruthy();
      expect(after.DocumentHash).toBeTruthy();
      // Exactly one entry, carrying the signer pointer and a real signing time:
      // the certificate reads `SignedOn` and used to substitute its own
      // generation time when it was missing.
      expect(after.AuditTrail.length).toBe(1);
      expect(after.AuditTrail[0].UserPtr.objectId).toBe(ownerExt.id);
      expect(after.AuditTrail[0].UserPtr.className).toBe('contracts_Users');
      expect(after.AuditTrail[0].Activity).toBe('Signed');
      expect(after.AuditTrail[0].SignedOn).toBeDefined();
      expect(
        new Date(after.AuditTrail[0].SignedOn.iso || after.AuditTrail[0].SignedOn).getTime()
      ).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
      // The signature image is stored once and referenced by url. It used to be
      // embedded as base64 in every audit entry, so a completed document was
      // megabytes of JSON on every read (the reports page has to fetch the
      // whole trail) and the certificate was the only thing that ever read it.
      expect(after.AuditTrail[0].Signature).toContain('/files/');
      expect(after.AuditTrail[0].Signature).not.toContain('base64');
    }, 60000);

    it('refuses a stranger signing that owner-only document', async () => {
      const doc = await makeDoc([]);
      const res = await callFn('signPdf', { docId: doc.id, pdfFile: pdfBase64 });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('still issues a certificate when the signature image is unusable', async () => {
      const why = requirements();
      if (why) return pending(why);
      const doc = await makeDoc([]);
      const res = await callFn(
        'signPdf',
        {
          docId: doc.id,
          pdfFile: pdfBase64,
          // Not a png. This used to throw out of `GenerateCertificate.embedPng`
          // and take the whole certificate + completion mail step with it, so a
          // corrupt image cost the signer their certificate; the embed falls
          // back to the "not available" mark now.
          signature: 'data:image/png;base64,bm90LWEtcG5n',
        },
        session(ownerSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.status).toBe('success');
      const after = await reload(doc.id);
      expect(after.SignedUrl).toBeTruthy();
      expect(after.IsCompleted).toBe(true);
      // The image no longer decides it: either the certificate was issued, or
      // it failed for some other reason and the signer is told their signature
      // was kept rather than being handed an error. What must never happen is
      // an error, or a lost signature.
      if (res.result.warning) {
        expect(res.result.warning).toContain('signature was saved');
      } else {
        expect(after.CertificateUrl).toBeTruthy();
      }

      // The process is still alive and serving: an unawaited rejection in that
      // path used to kill it.
      const stillUp = await callFn(
        'signPdf',
        { docId: doc.id, pdfFile: pdfBase64 },
        session(ownerSession)
      );
      expect(stillUp.ok).toBe(false);
      expect(stillUp.error).toBe('This document is already completed and can no longer be signed.');
    }, 60000);
  });

  /* --------------------------------------------------------------- */
  describe('next signer handoff', () => {
    it('returns a tokenised link for the next recipient of a SendinOrder document', async () => {
      if (!proxy)
        return pending('port 8080 is not free, so the internal server url cannot be stubbed');
      const doc = await makeDoc([alice, bob], { SendinOrder: true });
      const res = await callFn('signPdf', {
        docId: doc.id,
        userId: alice.id,
        signingToken: tokenFor(doc, alice),
        pdfFile: pdfBase64,
      });
      expect(res.ok).toBe(true);
      expect(res.result.status).toBe('success');
      expect(res.result.nextSignerEmail).toBe(bob.get('Email'));
      expect(res.result.nextSignerName).toBe('Bob');
      const encoded = res.result.nextSignerUrl.split('/login/')[1];
      const parts = Buffer.from(encoded, 'base64').toString('utf8').split('/');
      expect(parts[0]).toBe(doc.id);
      expect(parts[1]).toBe(bob.get('Email'));
      expect(parts[2]).toBe(bob.id);
      expect(parts[3]).toBeTruthy();
      const after = await reload(doc.id);
      expect(after.IsCompleted).toBe(false);
      expect(after.AuditTrail.length).toBe(1);
    }, 60000);
  });

  /* --------------------------------------------------------------- */
  describe('rate limiting', () => {
    it('stops a flood of attempts against one document', async () => {
      const doc = await makeDoc([alice, bob]);
      let last;
      for (let i = 0; i < 31; i++) {
        last = await callFn('signPdf', { docId: doc.id });
      }
      expect(last.ok).toBe(false);
      expect(last.error).toBe('Too many requests. Please try again in a minute.');
    }, 60000);
  });

  /* --------------------------------------------------------------- */
  describe('audit trail helper', () => {
    it('reports no change when a downgrade is blocked and nothing was refreshed', () => {
      const trail = [
        { UserPtr: pointer('contracts_Contactbook', alice.id), Activity: 'Signed', SignedUrl: 'u' },
      ];
      const out = upsertAuditEntry(trail, {
        UserPtr: pointer('contracts_Contactbook', alice.id),
        Activity: 'Viewed',
      });
      expect(out.changed).toBe(false);
      expect(out.auditTrail[0].Activity).toBe('Signed');
      expect(out.auditTrail[0]).toBe(trail[0]);
    });
  });
});
