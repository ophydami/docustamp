/**
 * Coverage for the one-time-code flow (`SendOTPMailV1` / `AuthLoginAsMail`,
 * cloud/lib/otp.js) and for the shadow-account passwords.
 *
 * `AuthLoginAsMail` mints a session for an arbitrary account with the master
 * key and takes no credentials at all, so everything that keeps it safe is
 * asserted here: 6 digit codes, nothing readable at rest, an expiry, an attempt
 * ceiling, single use, and a class no anonymous client can query.
 */
import axios from 'axios';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { OTP_CLASS, __lastOtpForTests } from '../cloud/lib/otp.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { ensureContact } from '../cloud/lib/contacts.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { loadCaller } from '../cloud/lib/context.js';
import rotateShadowPasswords from '../migrationdb/rotateShadowPasswords.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const TEST_DB_URI = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/parse-test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();
const require = createRequire(import.meta.url);

const anonHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': APP_ID,
  'X-Parse-Javascript-Key': JS_KEY,
  'x-real-ip': '10.0.0.9',
};
const masterHeaders = { ...anonHeaders, 'X-Parse-Master-Key': 'test' };

/** Calls a cloud function over REST and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: { ...anonHeaders, ...headers },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error, status: err.response.status };
  }
}

let seq = 0;
function uniqueEmail(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}@example.test`.toLowerCase();
}

async function makeUser(email, password = 'Str0ng!pass') {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', password);
  user.set('name', email.split('@')[0]);
  return await user.signUp();
}

async function makeExtUser(user) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', user.get('name'));
  extUser.set('Email', user.get('email'));
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_User');
  return await extUser.save(null, { useMasterKey: true });
}

/** The live `defaultdata_Otp` row for an address, read with the master key. */
async function otpRow(email) {
  const query = new Parse.Query(OTP_CLASS);
  query.equalTo('Email', email);
  return await query.first({ useMasterKey: true });
}

/** Emails a code and hands back the cleartext through the TESTING-only seam. */
async function sendCode(email, params = {}) {
  const res = await callFn('SendOTPMailV1', { email, ...params });
  expect(res.result).toBe('Otp send', JSON.stringify(res));
  return __lastOtpForTests.get(email);
}

async function restLogin(username, password) {
  try {
    const res = await http.post(
      `${TEST_SERVER}/login`,
      { username, password },
      { headers: anonHeaders }
    );
    return { ok: true, sessionToken: res.data.sessionToken };
  } catch (err) {
    return { ok: false, code: err?.response?.data?.code, status: err?.response?.status };
  }
}

describe('one-time codes and shadow-account passwords', () => {
  /** Every message this suite "sends", so delivery can be asserted on. */
  const mailbox = [];

  beforeAll(async () => {
    // The spec runner boots the server without running parse-dbtool, so apply
    // the CLP migration by hand; it is the thing under test in one case below.
    const migration = require('../databases/migrations/20260822000100-lock_otp_class.cjs');
    await migration.up(Parse);
    // `SendOTPMailV1` reports a refused message as a failure now, and the test
    // server has no mail provider configured, so stub the transport.
    setMailTransport(async params => {
      mailbox.push(params);
      return { status: 'success' };
    });
  }, 60000);

  afterAll(() => setMailTransport(null));

  beforeEach(() => {
    mailbox.length = 0;
    resetRateLimits();
  });

  describe('SendOTPMailV1', () => {
    it('issues a 6 digit code and stores only its hash', async () => {
      const email = uniqueEmail('otp');
      await makeUser(email);
      const code = await sendCode(email);

      expect(code).toMatch(/^\d{6}$/);

      const row = await otpRow(email);
      expect(row).toBeDefined();
      const json = row.toJSON();
      for (const [key, value] of Object.entries(json)) {
        expect(String(value)).not.toBe(code, `field ${key} holds the code in the clear`);
      }
      expect(json.OTP).toBeUndefined();
      expect(json.OTPHash).toBe(
        crypto.createHash('sha256').update(`${email}:${code}`).digest('hex')
      );
      expect(Number(json.Attempts)).toBe(0);
      expect(new Date(json.ExpiresAt.iso || json.ExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('keeps one live row per address, so a resend replaces the old code', async () => {
      const email = uniqueEmail('otp');
      await makeUser(email);
      const first = await sendCode(email);
      const second = await sendCode(email);
      expect(second).not.toBe(first);

      const query = new Parse.Query(OTP_CLASS);
      query.equalTo('Email', email);
      expect(await query.count({ useMasterKey: true })).toBe(1);

      const stale = await callFn('AuthLoginAsMail', { email, otp: first });
      expect(stale.result).toBe('Invalid Otp');
    });

    it('mails nothing for a document the address is not on, without saying so', async () => {
      const owner = await makeUser(uniqueEmail('owner'));
      const doc = new Parse.Object('contracts_Document');
      doc.set('Name', 'Lease');
      doc.set('CreatedBy', owner.toPointer());
      doc.set('Signers', []);
      doc.set('Placeholders', []);
      await doc.save(null, { useMasterKey: true });

      const stranger = uniqueEmail('stranger');
      await makeUser(stranger);
      const res = await callFn('SendOTPMailV1', { email: stranger, docId: doc.id });
      expect(res.result).toBe('Otp send');
      expect(await otpRow(stranger)).toBeUndefined();
    });

    it('reports a refused message instead of answering "Otp send"', async () => {
      const email = uniqueEmail('otpfail');
      await makeUser(email);
      setMailTransport(async () => ({ status: 'error', reason: 'smtp is not configured' }));
      try {
        const res = await callFn('SendOTPMailV1', { email });
        expect(res.ok).toBeFalse(JSON.stringify(res));
        expect(res.error).toContain('could not be emailed');
        // The unsent code is not left behind to burn the resend budget.
        expect(await otpRow(email)).toBeUndefined();
      } finally {
        setMailTransport(async params => {
          mailbox.push(params);
          return { status: 'success' };
        });
      }
    });

    it('is rate limited per address', async () => {
      const email = uniqueEmail('flood');
      await makeUser(email);
      let limited = null;
      for (let i = 0; i < 8 && !limited; i += 1) {
        const res = await callFn('SendOTPMailV1', { email });
        if (!res.ok) limited = res;
      }
      expect(limited).not.toBeNull();
      expect(limited.code).toBe(155);
    });
  });

  describe('AuthLoginAsMail', () => {
    it('destroys the row after five wrong codes', async () => {
      const email = uniqueEmail('wrong');
      await makeUser(email);
      const code = await sendCode(email);
      const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await callFn('AuthLoginAsMail', { email, otp: wrong });
        expect(res.result).toBe('Invalid Otp');
        const row = await otpRow(email);
        expect(row).toBeDefined(`row gone after ${attempt} wrong tries`);
        expect(row.get('Attempts')).toBe(attempt);
      }

      const fifth = await callFn('AuthLoginAsMail', { email, otp: wrong });
      expect(fifth.result).toBe('Invalid Otp');
      expect(await otpRow(email)).toBeUndefined();

      // Even the right code is worthless now.
      const late = await callFn('AuthLoginAsMail', { email, otp: code });
      expect(late.result).toBe('Invalid Otp');
    });

    it('rejects a code past its expiry', async () => {
      const email = uniqueEmail('stale');
      await makeUser(email);
      const code = await sendCode(email);

      const row = await otpRow(email);
      row.set('ExpiresAt', new Date(Date.now() - 1000));
      await row.save(null, { useMasterKey: true });

      const res = await callFn('AuthLoginAsMail', { email, otp: code });
      expect(res.result).toBe('Invalid Otp');
      expect(await otpRow(email)).toBeUndefined();
    });

    it('answers "user not found!" for an address with no account', async () => {
      const res = await callFn('AuthLoginAsMail', { email: uniqueEmail('ghost'), otp: '123456' });
      expect(res.result).toBe('user not found!');
    });

    it('exchanges a good code for a working session and burns the row', async () => {
      const email = uniqueEmail('good');
      const user = await makeUser(email);
      const code = await sendCode(email);

      const res = await callFn('AuthLoginAsMail', { email, otp: code });
      expect(typeof res.result).toBe('object', JSON.stringify(res));
      expect(res.result.objectId).toBe(user.id);
      expect(typeof res.result.sessionToken).toBe('string');

      const me = await http.get(`${TEST_SERVER}/users/me`, {
        headers: { ...anonHeaders, 'X-Parse-Session-Token': res.result.sessionToken },
      });
      expect(me.data.objectId).toBe(user.id);

      expect(await otpRow(email)).toBeUndefined();
      const replay = await callFn('AuthLoginAsMail', { email, otp: code });
      expect(replay.result).toBe('Invalid Otp');
    });
  });

  describe('defaultdata_Otp permissions', () => {
    it('is not readable or writable without the master key', async () => {
      const email = uniqueEmail('acl');
      await makeUser(email);
      await sendCode(email);

      let anonymous;
      try {
        const res = await http.get(`${TEST_SERVER}/classes/${OTP_CLASS}`, { headers: anonHeaders });
        anonymous = { ok: true, results: res.data.results };
      } catch (err) {
        anonymous = { ok: false, code: err?.response?.data?.code };
      }
      expect(anonymous.ok).toBeFalse(JSON.stringify(anonymous));
      expect(anonymous.code).toBe(Parse.Error.OPERATION_FORBIDDEN);

      let written;
      try {
        await http.post(
          `${TEST_SERVER}/classes/${OTP_CLASS}`,
          { Email: email, OTPHash: 'x' },
          { headers: anonHeaders }
        );
        written = { ok: true };
      } catch (err) {
        written = { ok: false, code: err?.response?.data?.code };
      }
      expect(written.ok).toBeFalse(JSON.stringify(written));

      // The master key still sees it, which is how the cloud functions work.
      const master = await http.get(`${TEST_SERVER}/classes/${OTP_CLASS}`, {
        headers: masterHeaders,
      });
      expect(master.data.results.length).toBeGreaterThan(0);
    });
  });

  describe('shadow accounts', () => {
    it('does not give a new contact its own email as its password', async () => {
      const owner = await makeUser(uniqueEmail('holder'));
      await makeExtUser(owner);
      const caller = await loadCaller(owner);

      const contactEmail = uniqueEmail('signer');
      const contact = await ensureContact(caller, { name: 'Signer Person', email: contactEmail });
      expect(contact.created).toBeTrue();

      const login = await restLogin(contactEmail, contactEmail);
      expect(login.ok).toBeFalse(JSON.stringify(login));
      expect(login.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    });

    it('rotates an existing account whose password is its own email', async () => {
      const email = uniqueEmail('legacy');
      const user = await makeUser(email, email);

      const before = await restLogin(email, email);
      expect(before.ok).toBeTrue('the weak account should log in before rotation');

      const result = await rotateShadowPasswords({ uri: TEST_DB_URI });
      expect(result.rotated).toBeGreaterThan(0);

      const after = await restLogin(email, email);
      expect(after.ok).toBeFalse(JSON.stringify(after));

      const rotated = await new Parse.Query(Parse.User).get(user.id, { useMasterKey: true });
      expect(rotated.get('PasswordRotatedAt')).toBeDefined();

      // The session it had is gone too.
      const sessions = new Parse.Query(Parse.Session);
      sessions.equalTo('user', user.toPointer());
      expect(await sessions.count({ useMasterKey: true })).toBe(0);
    }, 120000);

    it('is a no-op on the next boot', async () => {
      const again = await rotateShadowPasswords({ uri: TEST_DB_URI });
      expect(again.skipped).toBeTrue();
      expect(again.rotated).toBe(0);
    });
  });
});
