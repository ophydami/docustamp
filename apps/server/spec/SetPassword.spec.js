/**
 * Coverage for setting a password with an emailed code
 * (`sendpasswordcode` / `setpasswordwithcode`).
 *
 * The people this is for have never known a password: a contact's shadow
 * `_User` carries a random one (lib/contacts.js), and they get in with an
 * emailed sign-in code. So the flow below starts exactly there, with a shadow
 * account signing in through `SendOTPMailV1` / `AuthLoginAsMail`.
 */
import axios from 'axios';
import { __lastOtpForTests } from '../cloud/lib/otp.js';
import { shadowUserFor } from '../cloud/lib/contacts.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const NEW_PASSWORD = 'N3w!passw0rd';

const client = axios.create({ validateStatus: () => true });
const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': 'test',
  'X-Parse-Javascript-Key': 'test',
  'x-real-ip': '10.8.8.8',
};
const session = token => ({ 'X-Parse-Session-Token': token });

async function callFn(name, params = {}, headers = {}) {
  const res = await client.post(`${TEST_SERVER}/functions/${name}`, params, {
    headers: { ...baseHeaders, ...headers },
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, result: res.data.result };
  return { ok: false, code: res.data?.code, error: res.data?.error };
}

async function restLogin(username, password) {
  const res = await client.post(
    `${TEST_SERVER}/login`,
    { username, password },
    { headers: baseHeaders }
  );
  return res.status === 200 ? res.data.sessionToken : undefined;
}

/** True when parse-server still accepts this session token. */
async function sessionWorks(token) {
  const res = await client.get(`${TEST_SERVER}/users/me`, {
    headers: { ...baseHeaders, ...session(token) },
  });
  return res.status === 200;
}

/** A contact's shadow account, signed in the only way it can be: an emailed code. */
async function codeOnlyAccount(prefix) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = await shadowUserFor(prefix, email);
  await callFn('SendOTPMailV1', { email });
  const otp = __lastOtpForTests.get(email);
  const login = await callFn('AuthLoginAsMail', { email, otp });
  expect(login.result?.sessionToken).toBeTruthy(JSON.stringify(login));
  return { user, email, token: login.result.sessionToken };
}

/** Mails a password code and returns it through the TESTING-only seam. */
async function passwordCode(email, token) {
  const sent = await callFn('sendpasswordcode', {}, session(token));
  expect(sent.result).toEqual({ sent: true, email });
  return __lastOtpForTests.get(email);
}

describe('setting a password with an emailed code', () => {
  const mailbox = [];
  const deliver = async params => {
    mailbox.push(params);
    return { status: 'success' };
  };

  beforeAll(() => setMailTransport(deliver));
  afterAll(() => setMailTransport(null));

  beforeEach(() => {
    mailbox.length = 0;
    resetRateLimits();
  });

  it('needs a session', async () => {
    for (const name of ['sendpasswordcode', 'setpasswordwithcode']) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose
      const res = await callFn(name, { otp: '123456', password: NEW_PASSWORD });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    }
  });

  it('lets a code-only account set a password and sign in with it', async () => {
    const { user, email, token } = await codeOnlyAccount('setpw.flow');
    mailbox.length = 0;

    const sent = await callFn('sendpasswordcode', { email: 'someone@else.test' }, session(token));
    expect(sent.result).toEqual({ sent: true, email });
    // Always the account's own address, whatever the request says.
    expect(mailbox.length).toBe(1);
    expect(mailbox[0].recipient).toBe(email);
    expect(mailbox[0].subject).toMatch(/set a password/i);
    const code = __lastOtpForTests.get(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(mailbox[0].text).toContain(code);
    expect(mailbox[0].html).toContain(code);

    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    const bad = await callFn(
      'setpasswordwithcode',
      { otp: wrong, password: NEW_PASSWORD },
      session(token)
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not right/i);
    expect(await restLogin(email, NEW_PASSWORD)).toBeUndefined();

    const good = await callFn(
      'setpasswordwithcode',
      { otp: code, password: NEW_PASSWORD },
      session(token)
    );
    expect(good.ok).toBe(true, JSON.stringify(good));
    const fresh = good.result.sessionToken;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(token);

    // The new password works, the session it was set from does not, the one
    // handed back does, and the code proved the address.
    expect(await restLogin(email, NEW_PASSWORD)).toBeTruthy();
    expect(await sessionWorks(token)).toBe(false);
    expect(await sessionWorks(fresh)).toBe(true);
    const saved = await new Parse.Query(Parse.User).get(user.id, { useMasterKey: true });
    expect(saved.get('emailVerified')).toBe(true);

    // The code is spent.
    const again = await callFn(
      'setpasswordwithcode',
      { otp: code, password: 'An0ther!pass' },
      session(fresh)
    );
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/expired/i);
    expect(await restLogin(email, NEW_PASSWORD)).toBeTruthy();
  });

  it('refuses a weak password or a malformed code without spending the code', async () => {
    const { email, token } = await codeOnlyAccount('setpw.rules');
    const code = await passwordCode(email, token);

    const cases = [
      ['Sh0rt!', /at least 8/i],
      ['alllower1!', /upper and lower/i],
      ['NoDigits!!', /upper and lower/i],
      ['NoSpecial12', /special/i],
      [{ $ne: '' }, /at least 8/i],
    ];
    for (const [password, message] of cases) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose
      const res = await callFn('setpasswordwithcode', { otp: code, password }, session(token));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(message);
    }

    const malformed = await callFn(
      'setpasswordwithcode',
      { otp: '12ab', password: NEW_PASSWORD },
      session(token)
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toMatch(/6 digit/i);

    const good = await callFn(
      'setpasswordwithcode',
      { otp: code, password: NEW_PASSWORD },
      session(token)
    );
    expect(good.ok).toBe(true, JSON.stringify(good));
    expect(await restLogin(email, NEW_PASSWORD)).toBeTruthy();
  });

  it('works for an account that already has a password', async () => {
    const email = uniqueEmail('setpw.forgot', 'example.test');
    const user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('password', 'Old!passw0rd');
    await user.signUp();
    const token = await restLogin(email, 'Old!passw0rd');

    const code = await passwordCode(email, token);
    const res = await callFn(
      'setpasswordwithcode',
      { otp: code, password: NEW_PASSWORD },
      session(token)
    );
    expect(res.ok).toBe(true, JSON.stringify(res));
    expect(await restLogin(email, 'Old!passw0rd')).toBeUndefined();
    expect(await restLogin(email, NEW_PASSWORD)).toBeTruthy();
  });

  it('does not keep a code the mail provider refused', async () => {
    const { email, token } = await codeOnlyAccount('setpw.mailfail');
    setMailTransport(async () => ({ status: 'error', reason: 'provider down' }));
    try {
      const res = await callFn('sendpasswordcode', {}, session(token));
      expect(res.ok).toBe(false);
      expect(res.error).toContain('provider down');
      const row = await new Parse.Query('defaultdata_Otp')
        .equalTo('Email', email)
        .first({ useMasterKey: true });
      expect(row).toBeUndefined();
    } finally {
      setMailTransport(deliver);
    }
  });

  it('rate limits sending', async () => {
    const { token } = await codeOnlyAccount('setpw.rate');
    let last;
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts in order
      last = await callFn('sendpasswordcode', {}, session(token));
    }
    expect(last.ok).toBe(false);
    expect(last.error).toMatch(/too many requests/i);
  });
});
