/**
 * Coverage for the identity fixes agent signing depends on:
 *
 *  - `beforeSave(_User)` (cloud/parsefunction/emailVerification.js): a client
 *    can no longer rewrite its own `email` / `username` / `emailVerified`, and a
 *    master-key address change drops the verified flag.
 *  - `getemailverification` / `sendemailverification` / `verifyemail`.
 *  - `resolveDocumentActor` (cloud/parsefunction/authGuard.js): an owner may only
 *    sign their own seat, a signed-in signer only counts as that signer once
 *    their address is verified (otherwise their link still works, and without
 *    one they get the emailed-code gate), and a session with no seat of its own
 *    never gets one by claiming a contactId.
 */
import axios from 'axios';
import http from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { __lastOtpForTests } from '../cloud/lib/otp.js';
import { shadowUserFor } from '../cloud/lib/contacts.js';
import {
  OTP_GATE_MESSAGE,
  resetRateLimits,
  resolveDocumentActor,
} from '../cloud/parsefunction/authGuard.js';
import { userBeforeSave } from '../cloud/parsefunction/emailVerification.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const MASTER_KEY = 'test';
const PASSWORD = 'Str0ng!pass';
/** Utils.js `cloudServerUrl`; signPdf calls the server back here. */
const INTERNAL_PORT = 8080;
const INTERNAL_PREFIX = '/app';

const client = axios.create({ validateStatus: () => true });
const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': APP_ID,
  'X-Parse-Javascript-Key': 'test',
  'x-real-ip': '10.7.7.7',
  public_url: 'https://sign.example.test',
};
const session = token => ({ 'X-Parse-Session-Token': token });
const master = { 'X-Parse-Master-Key': MASTER_KEY };

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  const res = await client.post(`${TEST_SERVER}/functions/${name}`, params, {
    headers: { ...baseHeaders, ...headers },
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, result: res.data.result };
  return { ok: false, code: res.data?.code, error: res.data?.error };
}

async function rest(method, path, body, headers = {}) {
  const res = await client.request({
    method,
    url: `${TEST_SERVER}/${path}`,
    data: body,
    headers: { ...baseHeaders, ...headers },
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, result: res.data };
  return { ok: false, code: res.data?.code, error: res.data?.error };
}

async function loginToken(username, password = PASSWORD) {
  const res = await rest('POST', 'login', { username, password });
  return res.result?.sessionToken;
}

/** A password account, as signup makes one: username = email, not verified. */
async function makeUser(prefix) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', PASSWORD);
  user.set('name', prefix);
  await user.signUp();
  return { user, email, token: await loginToken(email) };
}

async function readUser(id) {
  return await new Parse.Query(Parse.User).get(id, { useMasterKey: true });
}

async function markVerified(id, value = true) {
  const user = await readUser(id);
  user.set('emailVerified', value);
  await user.save(null, { useMasterKey: true });
  return await readUser(id);
}

/** An unsigned JWT with these claims; the trigger trusts the adapter's earlier check. */
function fakeIdToken(claims) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'spec' })}.${part(claims)}.sig`;
}

/** Same reverse proxy as SignPdf.spec.js: PDF.js uploads and saves through it. */
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

async function makePdfBase64() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Agent identity spec', { x: 72, y: 700, size: 14, font });
  return Buffer.from(await pdf.save()).toString('base64');
}

describe('agent identity', () => {
  Parse.User.enableUnsafeCurrentUser();

  const mailbox = [];

  beforeAll(() => {
    setMailTransport(async params => {
      mailbox.push(params);
      return { status: 'success' };
    });
  });

  afterAll(() => setMailTransport(null));

  beforeEach(() => {
    mailbox.length = 0;
    resetRateLimits();
  });

  /* ------------------------------------------------------------------- */
  describe('_User beforeSave', () => {
    it('refuses a signed-in user changing their own email or username', async () => {
      const { user, email, token } = await makeUser('freeze');
      const other = uniqueEmail('victim', 'example.test');

      const byEmail = await rest('PUT', `users/${user.id}`, { email: other }, session(token));
      expect(byEmail.ok).toBe(false);
      expect(byEmail.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(byEmail.error).toMatch(/cannot be changed/i);

      const byName = await rest('PUT', `users/${user.id}`, { username: other }, session(token));
      expect(byName.ok).toBe(false);
      expect(byName.code).toBe(Parse.Error.OPERATION_FORBIDDEN);

      const both = await rest(
        'PUT',
        `users/${user.id}`,
        { email: other, username: other, name: 'Sneaky' },
        session(token)
      );
      expect(both.ok).toBe(false);

      const after = await readUser(user.id);
      expect(after.get('email')).toBe(email);
      expect(after.get('username')).toBe(email);
      expect(after.get('name')).toBe('freeze');
    });

    it('refuses a client marking its own address verified', async () => {
      const { user, token } = await makeUser('selfverify');
      const res = await rest('PUT', `users/${user.id}`, { emailVerified: true }, session(token));
      expect(res.ok).toBe(false);
      expect((await readUser(user.id)).get('emailVerified')).not.toBe(true);
    });

    it('still lets the user save their name, and the same address again', async () => {
      const { user, email, token } = await makeUser('ownedit');
      const res = await rest(
        'PUT',
        `users/${user.id}`,
        { name: 'New Name', email, username: email },
        session(token)
      );
      expect(res.ok).toBe(true, JSON.stringify(res));
      expect((await readUser(user.id)).get('name')).toBe('New Name');
    });

    it('lets a master-key write change the address, and clears emailVerified', async () => {
      const { user } = await makeUser('masteredit');
      await markVerified(user.id);

      const moved = uniqueEmail('moved', 'example.test');
      const row = await readUser(user.id);
      row.set('email', moved);
      row.set('username', moved);
      await row.save(null, { useMasterKey: true });
      let after = await readUser(user.id);
      expect(after.get('email')).toBe(moved);
      expect(after.get('emailVerified')).toBe(false);

      // Only the address changing resets it: a master write of anything else keeps it.
      await markVerified(user.id);
      after = await readUser(user.id);
      after.set('name', 'Still verified');
      await after.save(null, { useMasterKey: true });
      expect((await readUser(user.id)).get('emailVerified')).toBe(true);

      // A write that sets the flag itself keeps what it set.
      const again = uniqueEmail('again', 'example.test');
      after = await readUser(user.id);
      after.set('email', again);
      after.set('emailVerified', true);
      await after.save(null, { useMasterKey: true });
      expect((await readUser(user.id)).get('emailVerified')).toBe(true);

      // Over REST with the master key as well.
      const third = uniqueEmail('third', 'example.test');
      const res = await rest('PUT', `users/${user.id}`, { email: third }, master);
      expect(res.ok).toBe(true, JSON.stringify(res));
      expect((await readUser(user.id)).get('emailVerified')).toBe(false);
    });

    it('leaves new accounts alone: signup, contact shadow users, cloud signup', async () => {
      const { user } = await makeUser('newacct');
      expect(user.id).toBeTruthy();

      const shadowEmail = uniqueEmail('shadow', 'example.test');
      const shadow = await shadowUserFor('Shadow', shadowEmail);
      expect(shadow.get('username')).toBe(shadowEmail);
      expect(shadow.get('emailVerified')).not.toBe(true);

      const email = uniqueEmail('cloudsignup', 'example.test');
      const res = await callFn('usersignup', {
        userDetails: {
          name: 'Cloud Signup',
          email,
          password: PASSWORD,
          role: 'contracts_User',
          company: 'Acme',
          jobTitle: 'Tester',
        },
      });
      expect(res.ok).toBe(true, JSON.stringify(res));
      expect(await loginToken(email)).toBeTruthy();
    });

    describe('Google sign-in', () => {
      async function newGoogleUser(claims, sub = claims.sub) {
        const user = new Parse.User();
        user.set('authData', { google: { id: sub, id_token: fakeIdToken(claims) } });
        await userBeforeSave({ object: user, original: undefined, master: false });
        return user;
      }

      it("takes the new account's address from the verified Google token", async () => {
        const address = uniqueEmail('google.fill', 'example.test');
        const user = await newGoogleUser({
          sub: 'g-fill',
          email: address.toUpperCase(),
          email_verified: true,
        });
        expect(user.get('email')).toBe(address);
        expect(user.get('username')).toBe(address);
        expect(user.get('normalizedEmail')).toBe(address);
        expect(user.get('emailVerified')).toBe(true);
      });

      it('leaves an address another account holds, or an unverified one, alone', async () => {
        const { email } = await makeUser('google.taken');
        const taken = await newGoogleUser({
          sub: 'g-taken',
          email: email.toUpperCase(),
          email_verified: true,
        });
        expect(taken.get('email')).toBeUndefined();
        expect(taken.get('username')).toBeUndefined();

        const unverified = await newGoogleUser({
          sub: 'g-unverified',
          email: uniqueEmail('google.unverified', 'example.test'),
          email_verified: false,
        });
        expect(unverified.get('email')).toBeUndefined();

        const mismatched = await newGoogleUser(
          {
            sub: 'g-other',
            email: uniqueEmail('google.sub', 'example.test'),
            email_verified: true,
          },
          'g-mine'
        );
        expect(mismatched.get('email')).toBeUndefined();
      });
    });
  });

  /* ------------------------------------------------------------------- */
  describe('email verification', () => {
    it('needs a session', async () => {
      for (const name of ['getemailverification', 'sendemailverification', 'verifyemail']) {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose
        const res = await callFn(name, { otp: '123456' });
        expect(res.ok).toBe(false);
        expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
      }
    });

    it('sends a code, refuses a wrong one, and verifies with the right one', async () => {
      const { user, email, token } = await makeUser('verify.flow');

      let state = await callFn('getemailverification', {}, session(token));
      expect(state.result).toEqual({ email, verified: false });

      const sent = await callFn(
        'sendemailverification',
        { email: 'someone@else.test' },
        session(token)
      );
      expect(sent.result).toEqual({ sent: true, email });
      // Always the account's own address, whatever the request says.
      expect(mailbox.length).toBe(1);
      expect(mailbox[0].recipient).toBe(email);
      const code = __lastOtpForTests.get(email);
      expect(code).toMatch(/^\d{6}$/);
      expect(mailbox[0].text).toContain(code);
      expect(mailbox[0].html).toContain(code);

      const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
      const bad = await callFn('verifyemail', { otp: wrong }, session(token));
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/not right/i);
      expect((await readUser(user.id)).get('emailVerified')).not.toBe(true);

      const malformed = await callFn('verifyemail', { otp: '12ab' }, session(token));
      expect(malformed.ok).toBe(false);
      expect(malformed.error).toMatch(/6 digit/i);

      const good = await callFn('verifyemail', { otp: code }, session(token));
      expect(good.result).toEqual({ verified: true });
      expect((await readUser(user.id)).get('emailVerified')).toBe(true);

      state = await callFn('getemailverification', {}, session(token));
      expect(state.result).toEqual({ email, verified: true });

      // Nothing more to send once verified, and the code is spent.
      const again = await callFn('sendemailverification', {}, session(token));
      expect(again.result).toEqual({ sent: false, email, verified: true });
      expect(mailbox.length).toBe(1);
    });

    it('does not keep a code the mail provider refused', async () => {
      const { email, token } = await makeUser('verify.mailfail');
      setMailTransport(async () => ({ status: 'error', reason: 'provider down' }));
      try {
        const res = await callFn('sendemailverification', {}, session(token));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('provider down');
        const row = await new Parse.Query('defaultdata_Otp')
          .equalTo('Email', email)
          .first({ useMasterKey: true });
        expect(row).toBeUndefined();
      } finally {
        setMailTransport(async params => {
          mailbox.push(params);
          return { status: 'success' };
        });
      }
    });

    it('rate limits sending', async () => {
      const { token } = await makeUser('verify.rate');
      let last;
      for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop -- the limiter counts in order
        last = await callFn('sendemailverification', {}, session(token));
      }
      expect(last.ok).toBe(false);
      expect(last.error).toMatch(/too many requests/i);
    });
  });

  /* ------------------------------------------------------------------- */
  describe('who may sign', () => {
    let proxy;
    let pdfBase64;
    let owner;
    let ownerExt;
    let ownerSeat;
    let alice;
    let aliceSeat;
    let bob;
    let bobSeat;
    let seq = 0;

    async function makeContact(person, name) {
      const contact = new Parse.Object('contracts_Contactbook');
      contact.set('Name', name);
      contact.set('Email', person.email);
      contact.set('CreatedBy', pointer('_User', owner.user.id));
      contact.set('UserId', pointer('_User', person.user.id));
      contact.set('IsDeleted', false);
      return await contact.save(null, { useMasterKey: true });
    }

    async function makeDoc(contacts, extra = {}) {
      seq += 1;
      const doc = new Parse.Object('contracts_Document');
      doc.set('Name', `agent identity ${seq}`);
      doc.set('URL', `${TEST_SERVER}/files/${APP_ID}/agent-identity.pdf`);
      doc.set('CreatedBy', pointer('_User', owner.user.id));
      doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      doc.set('IsSendMail', false);
      if (contacts.length) {
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
      if (Object.keys(extra).length) {
        const update = new Parse.Object('contracts_Document');
        update.id = doc.id;
        for (const [k, v] of Object.entries(extra)) update.set(k, v);
        await update.save(null, { useMasterKey: true });
      }
      return await new Parse.Query('contracts_Document')
        .include('Signers')
        .get(doc.id, { useMasterKey: true });
    }

    const tokenFor = (doc, contact) =>
      mintSigningToken({ docId: doc.id, contactId: contact.id, expiresAt: Date.now() + 60000 });

    let savedPfx;

    beforeAll(async () => {
      proxy = await startInternalProxy();
      pdfBase64 = await makePdfBase64();
      // None of these signatures completes a document, so the digital seal is
      // never applied; signPdf only needs *a* key to be configured.
      savedPfx = process.env.PFX_BASE64;
      process.env.PFX_BASE64 = savedPfx || Buffer.from('not-a-real-key').toString('base64');
      owner = await makeUser('owner.identity');
      const ext = new Parse.Object('contracts_Users');
      ext.set('UserId', pointer('_User', owner.user.id));
      ext.set('Email', owner.email);
      ext.set('Name', 'Doc Owner');
      ext.set('UserRole', 'contracts_User');
      ownerExt = await ext.save(null, { useMasterKey: true });

      alice = await makeUser('alice.identity');
      bob = await makeUser('bob.identity');
      ownerSeat = await makeContact(owner, 'Doc Owner');
      aliceSeat = await makeContact(alice, 'Alice');
      bobSeat = await makeContact(bob, 'Bob');
    }, 60000);

    afterAll(async () => {
      if (proxy) await new Promise(resolve => proxy.close(resolve));
      if (savedPfx === undefined) delete process.env.PFX_BASE64;
      else process.env.PFX_BASE64 = savedPfx;
    });

    describe('the owner', () => {
      it('cannot sign as a co-signer through signPdf', async () => {
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const res = await callFn(
          'signPdf',
          { docId: doc.id, userId: aliceSeat.id, pdfFile: pdfBase64 },
          session(owner.token)
        );
        expect(res.ok).toBe(false);
        expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
        expect(res.error).toMatch(/only sign as yourself/i);
        const after = await new Parse.Query('contracts_Document').get(doc.id, {
          useMasterKey: true,
        });
        expect(after.get('AuditTrail') || []).toEqual([]);
      });

      it("signs as a co-signer only with that co-signer's own link, like anyone holding it", async () => {
        // A sender testing on one computer opens a signer's emailed link while
        // still signed in. The link decides; the session adds nothing.
        const ownerUser = await readUser(owner.user.id);
        const doc = await makeDoc([ownerSeat, aliceSeat, bobSeat]);
        const request = { user: ownerUser, params: {} };

        const withLink = await resolveDocumentActor(request, doc, {
          contactId: aliceSeat.id,
          signingToken: tokenFor(doc, aliceSeat),
          ownerMayActForContact: false,
        });
        expect(withLink).toEqual(
          jasmine.objectContaining({ kind: 'signer', user: null, contactId: aliceSeat.id })
        );

        // Bob's link does not make the sender Alice.
        await expectAsync(
          resolveDocumentActor(request, doc, {
            contactId: aliceSeat.id,
            signingToken: tokenFor(doc, bobSeat),
            ownerMayActForContact: false,
          })
        ).toBeRejectedWithError(/only sign as yourself/i);

        // A document that asks for the emailed code still asks for it.
        const coded = await makeDoc([ownerSeat, aliceSeat], { IsEnableOTP: true });
        await expectAsync(
          resolveDocumentActor(request, coded, {
            contactId: aliceSeat.id,
            signingToken: tokenFor(coded, aliceSeat),
            ownerMayActForContact: false,
          })
        ).toBeRejectedWithError(OTP_GATE_MESSAGE);
      });

      it('can still self-sign, claim their own seat, and read any seat', async () => {
        const ownerUser = await readUser(owner.user.id);
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const request = { user: ownerUser, params: {} };

        const self = await resolveDocumentActor(request, doc, { ownerMayActForContact: false });
        expect(self).toEqual(jasmine.objectContaining({ kind: 'owner', contactId: '' }));

        const own = await resolveDocumentActor(request, doc, {
          contactId: ownerSeat.id,
          ownerMayActForContact: false,
        });
        expect(own).toEqual(jasmine.objectContaining({ kind: 'owner', contactId: ownerSeat.id }));

        // Reads, declines and placeholder edits still act for any contact.
        const read = await resolveDocumentActor(request, doc, {
          contactId: aliceSeat.id,
          ownerMayActForContact: true,
        });
        expect(read.kind).toBe('owner');

        await expectAsync(
          resolveDocumentActor(request, doc, {
            contactId: 'notOnDoc',
            ownerMayActForContact: false,
          })
        ).toBeRejectedWithError(/not on this document/i);
      });

      it('signs their own seat end to end', async () => {
        if (!proxy)
          return pending('port 8080 is not free, so the internal server url cannot be stubbed');
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const res = await callFn(
          'signPdf',
          { docId: doc.id, userId: ownerSeat.id, pdfFile: pdfBase64 },
          session(owner.token)
        );
        expect(res.ok).toBe(true, JSON.stringify(res));
        expect(res.result.status).toBe('success');
        const after = JSON.parse(
          JSON.stringify(
            await new Parse.Query('contracts_Document').get(doc.id, { useMasterKey: true })
          )
        );
        expect(after.AuditTrail.length).toBe(1);
        expect(after.AuditTrail[0].UserPtr.objectId).toBe(ownerSeat.id);
        expect(after.IsCompleted).not.toBe(true);
      }, 60000);
    });

    describe('a signed-in signer', () => {
      beforeEach(async () => {
        await markVerified(alice.user.id, false);
      });

      it('who is not verified still gets in with their signing link', async () => {
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const res = await callFn(
          'getDocument',
          { docId: doc.id, signingToken: tokenFor(doc, aliceSeat) },
          session(alice.token)
        );
        expect(res.ok).toBe(true, JSON.stringify(res));
        expect(res.result.objectId).toBe(doc.id);

        const aliceUser = await readUser(alice.user.id);
        const actor = await resolveDocumentActor(
          { user: aliceUser, params: { signingToken: tokenFor(doc, aliceSeat) } },
          doc,
          {}
        );
        // The link decided it, not the session.
        expect(actor).toEqual(
          jasmine.objectContaining({ kind: 'signer', user: null, contactId: aliceSeat.id })
        );
      });

      it('who is not verified signs with their link', async () => {
        if (!proxy)
          return pending('port 8080 is not free, so the internal server url cannot be stubbed');
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const res = await callFn(
          'signPdf',
          {
            docId: doc.id,
            userId: aliceSeat.id,
            signingToken: tokenFor(doc, aliceSeat),
            pdfFile: pdfBase64,
          },
          session(alice.token)
        );
        expect(res.ok).toBe(true, JSON.stringify(res));
      }, 60000);

      it('who is not verified gets the emailed-code gate without a link', async () => {
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const res = await callFn('getDocument', { docId: doc.id }, session(alice.token));
        expect(res.ok).toBe(false);
        expect(res.error).toBe(OTP_GATE_MESSAGE);

        const sign = await callFn(
          'signPdf',
          { docId: doc.id, userId: aliceSeat.id, pdfFile: pdfBase64 },
          session(alice.token)
        );
        expect(sign.ok).toBe(false);
        expect(sign.error).toBe(OTP_GATE_MESSAGE);

        // A link that does not verify gets the gate too: the code is the way in.
        const stale = await callFn(
          'getDocument',
          { docId: doc.id, signingToken: 'not-a-token' },
          session(alice.token)
        );
        expect(stale.error).toBe(OTP_GATE_MESSAGE);
      });

      it('who signed in with an emailed code is verified and needs no link', async () => {
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const sent = await callFn('SendOTPMailV1', { email: alice.email, docId: doc.id });
        expect(sent.result).toBe('Otp send');
        const login = await callFn('AuthLoginAsMail', {
          email: alice.email,
          otp: __lastOtpForTests.get(alice.email),
        });
        expect(login.result?.sessionToken).toBeTruthy();
        expect((await readUser(alice.user.id)).get('emailVerified')).toBe(true);

        const res = await callFn(
          'getDocument',
          { docId: doc.id },
          session(login.result.sessionToken)
        );
        expect(res.ok).toBe(true, JSON.stringify(res));
      });

      it('who is verified works without a link, but only as themselves', async () => {
        const doc = await makeDoc([ownerSeat, aliceSeat, bobSeat]);
        await markVerified(alice.user.id);

        // The same session as before: the verified flag is read fresh.
        const res = await callFn('getDocument', { docId: doc.id }, session(alice.token));
        expect(res.ok).toBe(true, JSON.stringify(res));

        const aliceUser = await readUser(alice.user.id);
        const actor = await resolveDocumentActor({ user: aliceUser, params: {} }, doc, {});
        expect(actor).toEqual(
          jasmine.objectContaining({ kind: 'signer', contactId: aliceSeat.id })
        );

        await expectAsync(
          resolveDocumentActor({ user: aliceUser, params: {} }, doc, { contactId: bobSeat.id })
        ).toBeRejectedWithError(/only act as yourself/i);

        const sign = await callFn(
          'signPdf',
          { docId: doc.id, userId: bobSeat.id, pdfFile: pdfBase64 },
          session(alice.token)
        );
        expect(sign.ok).toBe(false);
        expect(sign.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      });

      it('with no seat of their own can never claim one', async () => {
        const carol = await makeUser('carol.identity');
        const carolUser = await markVerified(carol.user.id);
        // Carol is on the document by address only (an unbound placeholder).
        const doc = await makeDoc([ownerSeat, aliceSeat]);
        const json = doc.toJSON();
        json.Placeholders.push({ Id: 9, email: carol.email });

        await expectAsync(
          resolveDocumentActor({ user: carolUser, params: {} }, json, { contactId: aliceSeat.id })
        ).toBeRejectedWithError(/do not have access/i);
        await expectAsync(
          resolveDocumentActor({ user: carolUser, params: {} }, json, {})
        ).toBeRejectedWithError(/do not have access/i);
      });
    });
  });
});
