/**
 * Coverage for the contact-book and account-deletion hardening:
 *
 *  - `/delete-account/:userId` (GET, POST, POST /otp) demand the signed link
 *    token or the account's own session, and answer 404 for "no such account"
 *    and "not yours" alike (§#19).
 *  - the deletion OTP is only ever stored as a hash, and the attempt counter
 *    survives a resend (§#19, §#25).
 *  - `editcontact` validates before it writes, so a rejected edit leaves the
 *    original row alone (§#39).
 *  - `recreatedoc` clones only documents the caller owns (§#52).
 *
 * Everything goes over raw HTTP so the credentials on each call are explicit,
 * which is the point: the deletion routes are reached from an emailed link with
 * no session at all.
 */
import axios from 'axios';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { hashOtp } from '../cloud/lib/otp.js';
import {
  issueDeletionLinkToken,
  mintDeletionToken,
  verifyDeletionToken,
} from '../cloud/lib/deletionToken.js';

const ORIGIN = 'http://localhost:30001';
const PARSE_URL = `${ORIGIN}/test`;
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create({ validateStatus: () => true });

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function loginToken(email, password) {
  const res = await http.post(
    `${PARSE_URL}/login`,
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
  user.__session = await loginToken(email, password);
  return user;
}

async function makeExtUser(user, { role = 'contracts_User', tenantId } = {}) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', role);
  if (tenantId) ext.set('TenantId', pointer('partners_Tenant', tenantId));
  return await ext.save(null, { useMasterKey: true });
}

async function makeContact(owner, email, name = 'Contact') {
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', name);
  contact.set('Email', email);
  contact.set('CreatedBy', pointer('_User', owner.id));
  contact.set('UserId', pointer('_User', owner.id));
  contact.set('IsDeleted', false);
  return await contact.save(null, { useMasterKey: true });
}

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  const res = await http.post(`${PARSE_URL}/functions/${name}`, params, {
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': APP_ID,
      'X-Parse-Javascript-Key': JS_KEY,
      'x-real-ip': '10.9.0.1',
      ...headers,
    },
  });
  if (res.status >= 400) return { ok: false, code: res.data?.code, error: res.data?.error };
  return { ok: true, result: res.data.result };
}

const session = token => ({ 'X-Parse-Session-Token': token });

async function reload(className, objectId) {
  return await new Parse.Query(className).get(objectId, { useMasterKey: true });
}

describe('contacts and account deletion', () => {
  Parse.User.enableUnsafeCurrentUser();

  beforeEach(() => resetRateLimits());

  /* ------------------------------------------------------- delete-account */

  describe('/delete-account routes', () => {
    let admin;
    let adminExt;
    let token;
    /** The last code the OTP mail carried, read out of the stubbed transport. */
    let mailedOtp = '';

    const deleteUrl = (userId, query = '') => `${ORIGIN}/delete-account/${userId}${query}`;

    beforeAll(async () => {
      admin = await makeUser('deletion.admin@example.com');
      // A tenant of its own, so the handler's "any team users left?" query is
      // scoped to this fixture and not to every other spec's rows.
      const tenant = await new Parse.Object('partners_Tenant')
        .set('TenantName', 'Deletion tenant')
        .save(null, { useMasterKey: true });
      adminExt = await makeExtUser(admin, { role: 'contracts_Admin', tenantId: tenant.id });
      setMailTransport(async params => {
        const html = params?.html || '';
        const match = /letter-spacing:6px;[^>]*>(\d{6})</.exec(html) || /(\d{6})/.exec(html);
        mailedOtp = match ? match[1] : '';
        return { status: 'success' };
      });
    });

    afterAll(() => setMailTransport(null));

    beforeEach(async () => {
      // A fresh mailed link, exactly what `senddeleterequest` hands out.
      token = await issueDeletionLinkToken(await reload('contracts_Users', adminExt.id), admin.id);
    });

    it('refuses the confirmation page without a token or a session', async () => {
      const res = await http.get(deleteUrl(admin.id));
      expect(res.status).toBe(404);
    });

    it('answers 404 for an unknown userId exactly as for an unauthorised one', async () => {
      const unknown = await http.get(deleteUrl('doesNotExist00'));
      const unauthorised = await http.get(deleteUrl(admin.id));
      expect(unknown.status).toBe(404);
      expect(unauthorised.status).toBe(404);
      expect(String(unknown.data)).toBe(String(unauthorised.data));
    });

    it('renders the page for a valid token', async () => {
      const res = await http.get(deleteUrl(admin.id, `?t=${encodeURIComponent(token)}`));
      expect(res.status).toBe(200);
      expect(String(res.data)).toContain('Confirm Account Deletion');
      // The page carries the token on to the two POSTs it makes.
      expect(String(res.data)).toContain(encodeURIComponent(token));
    });

    it('renders the page for the account holder’s own session', async () => {
      const res = await http.get(deleteUrl(admin.id), {
        headers: { sessiontoken: admin.__session },
      });
      expect(res.status).toBe(200);
      expect(String(res.data)).toContain('Confirm Account Deletion');
    });

    it('rejects a token minted for another account, and a forged one', async () => {
      const other = mintDeletionToken({
        userId: 'someoneElse',
        nonce: 'n',
        expiresAt: Date.now() + 60000,
      });
      const forged = `${token.split('.')[0]}.AAAA`;
      for (const bad of [other, forged]) {
        const res = await http.get(deleteUrl(admin.id, `?t=${encodeURIComponent(bad)}`));
        expect(res.status).toBe(404);
      }
    });

    it('refuses to mail a code without a token or a session', async () => {
      const res = await http.post(deleteUrl(admin.id, '/otp'), {});
      expect(res.status).toBe(404);
    });

    it('refuses the deletion itself without a token or a session', async () => {
      const res = await http.post(deleteUrl(admin.id), { otp: '123456' });
      expect(res.status).toBe(404);
    });

    it('stores only a hash of the mailed code', async () => {
      const res = await http.post(deleteUrl(admin.id, `/otp?t=${encodeURIComponent(token)}`), {});
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(mailedOtp).toMatch(/^\d{6}$/);

      const row = await reload('contracts_Users', adminExt.id);
      expect(row.get('DeleteOTP')).toBeUndefined();
      expect(row.get('DeleteOTPHash')).not.toBe(mailedOtp);
      expect(row.get('DeleteOTPHash')).toBe(hashOtp(admin.id, mailedOtp));
      expect(row.get('DeleteOTPExpiry')).toBeDefined();
    });

    it('keeps counting failed attempts across a resend', async () => {
      const query = `?t=${encodeURIComponent(token)}`;
      const first = await http.post(deleteUrl(admin.id, `/otp${query}`), {});
      expect(first.status).toBe(200);

      const wrong = mailedOtp === '000000' ? '111111' : '000000';
      for (let i = 0; i < 2; i++) {
        const res = await http.post(deleteUrl(admin.id, query), { otp: wrong });
        expect(res.status).toBe(400);
      }
      let row = await reload('contracts_Users', adminExt.id);
      expect(row.get('DeleteOTPTries')).toBe(2);

      // Step past the 30 s resend cooldown and ask for a new code.
      row.set('DeleteOTPSentAt', new Date(Date.now() - 10 * 60 * 1000));
      await row.save(null, { useMasterKey: true });
      const resend = await http.post(deleteUrl(admin.id, `/otp${query}`), {});
      expect(resend.status).toBe(200);

      row = await reload('contracts_Users', adminExt.id);
      expect(row.get('DeleteOTPTries')).toBe(2);
    });

    it('mints link tokens that expire and are bound to one userId', () => {
      const live = mintDeletionToken({
        userId: admin.id,
        nonce: 'nonce',
        expiresAt: Date.now() + 60000,
      });
      expect(verifyDeletionToken(live, { userId: admin.id })?.nonce).toBe('nonce');
      expect(verifyDeletionToken(live, { userId: 'anotherUser' })).toBeNull();
      const stale = mintDeletionToken({ userId: admin.id, nonce: 'n', expiresAt: Date.now() - 1 });
      expect(verifyDeletionToken(stale, { userId: admin.id })).toBeNull();
    });

    it('refuses a deletion request raised for somebody else’s account', async () => {
      const res = await callFn(
        'senddeleterequest',
        { userId: 'someoneElse' },
        session(admin.__session)
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not permitted/i);
    });
  });

  /* ------------------------------------------------------------ editcontact */

  describe('editcontact', () => {
    let owner;
    let first;
    let second;

    beforeAll(async () => {
      owner = await makeUser('contact.owner@example.com');
      first = await makeContact(owner, 'first.contact@example.com', 'First');
      second = await makeContact(owner, 'second.contact@example.com', 'Second');
    });

    it('leaves the original row untouched when the new email is a duplicate', async () => {
      const res = await callFn(
        'editcontact',
        { contactId: first.id, name: 'Renamed', email: 'second.contact@example.com', phone: '' },
        session(owner.__session)
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/already exists/i);

      const row = await reload('contracts_Contactbook', first.id);
      expect(row.get('IsDeleted')).toBe(false);
      expect(row.get('Email')).toBe('first.contact@example.com');
      expect(row.get('Name')).toBe('First');
      expect(second.id).toBeDefined();
    });

    it('updates in place, keeping the objectId documents point at', async () => {
      const res = await callFn(
        'editcontact',
        { contactId: first.id, name: 'First Renamed', email: 'first.renamed@example.com' },
        session(owner.__session)
      );
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(first.id);
      expect(res.result.Email).toBe('first.renamed@example.com');

      const row = await reload('contracts_Contactbook', first.id);
      expect(row.get('Name')).toBe('First Renamed');
      expect(row.get('IsDeleted')).toBe(false);
    });

    it('refuses to edit somebody else’s contact', async () => {
      const stranger = await makeUser('contact.stranger@example.com');
      const res = await callFn(
        'editcontact',
        { contactId: second.id, name: 'Hijacked', email: 'hijack@example.com' },
        session(stranger.__session)
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not found/i);
    });
  });

  /* ---------------------------------------------------------- recreatedoc */

  describe('recreatedoc', () => {
    let owner;
    let ownerExt;
    let stranger;
    let doc;

    beforeAll(async () => {
      owner = await makeUser('recreate.owner@example.com');
      ownerExt = await makeExtUser(owner);
      stranger = await makeUser('recreate.stranger@example.com');
      await makeExtUser(stranger);

      const object = new Parse.Object('contracts_Document');
      object.set('Name', 'Confidential agreement');
      object.set('URL', 'https://example.com/files/agreement.pdf');
      object.set('CreatedBy', pointer('_User', owner.id));
      object.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      object.set('Placeholders', []);
      object.set('IsDeclined', true);
      object.set('DeclineReason', 'not today');
      object.set('SignedUrl', 'https://example.com/files/signed.pdf');
      object.set('AuditTrail', [{ Activity: 'Signed' }]);
      doc = await object.save(null, { useMasterKey: true });
    });

    it('refuses to clone a document the caller does not own', async () => {
      const res = await callFn('recreatedoc', { docId: doc.id }, session(stranger.__session));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not found/i);

      const copies = await new Parse.Query('contracts_Document')
        .equalTo('Name', 'Confidential agreement')
        .count({ useMasterKey: true });
      expect(copies).toBe(1);
    });

    it('clones for the owner without the previous run’s state', async () => {
      const res = await callFn('recreatedoc', { docId: doc.id }, session(owner.__session));
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBeDefined();

      const copy = await reload('contracts_Document', res.result.objectId);
      expect(copy.get('Name')).toBe('Confidential agreement');
      expect(copy.get('IsDeclined')).toBe(false);
      expect(copy.get('DeclineReason')).toBeUndefined();
      expect(copy.get('SignedUrl')).toBeUndefined();
      expect(copy.get('AuditTrail')).toBeUndefined();
      expect(copy.get('CreatedBy')?.id).toBe(owner.id);
      expect(copy.get('ExtUserPtr')?.id).toBe(ownerExt.id);
    });
  });
});
