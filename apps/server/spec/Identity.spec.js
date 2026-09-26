/**
 * Coverage for the identity / tenant hardening:
 *
 *   gettenant            authenticated branch derives the tenant from the
 *                        caller, contact branch is a public branding projection
 *   getuserlistbyorg     explicit projection, no per-user secrets
 *   resetpassword        role and organisation scoping, session + token teardown
 *   usersignup           server-side role allow-list, fixed class name
 *   resolveApiToken      suspended accounts
 *   _User CLP            databases/migrations/20260822000200-lock_user_class.cjs
 *
 * Like spec/Permissions.spec.js, this suite applies its own migration in
 * `beforeAll` and reverts it in `afterAll`, because the test server never runs
 * `parse-dbtool migrate` (see `index.js`, the `if (!process.env.TESTING)` branch).
 */
import axios from 'axios';
import { generateRawToken, hashToken, resolveApiToken } from '../cloud/lib/apiTokens.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const PASSWORD = 'Str0ng!pass';
const MIGRATION = '../databases/migrations/20260822000200-lock_user_class.cjs';

const http = axios.create();

const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': APP_ID,
  'X-Parse-Javascript-Key': JS_KEY,
};

const session = token => ({ 'X-Parse-Session-Token': token });

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: { ...baseHeaders, 'x-real-ip': '10.9.0.1', ...headers },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

/** REST class API request, normalised the same way. */
async function rest(method, path, body, headers = {}) {
  try {
    const res = await http.request({
      method,
      url: `${TEST_SERVER}/${path}`,
      data: body,
      headers: { ...baseHeaders, ...headers },
    });
    return { ok: true, status: res.status, result: res.data };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

async function loginToken(email, password = PASSWORD) {
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: baseHeaders }
  );
  return res.data.sessionToken;
}

async function makeUser(email) {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', PASSWORD);
  user.set('name', email.split('@')[0]);
  await user.signUp();
  return user;
}

async function makeExtUser(user, { tenantId, orgId, role, disabled }) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', role);
  ext.set('TenantId', pointer('partners_Tenant', tenantId));
  if (orgId) ext.set('OrganizationId', pointer('contracts_Organizations', orgId));
  if (disabled) ext.set('IsDisabled', true);
  return await ext.save(null, { useMasterKey: true });
}

async function fetchExt(objectId) {
  return await new Parse.Query('contracts_Users').get(objectId, { useMasterKey: true });
}

describe('identity and tenant hardening', () => {
  Parse.User.enableUnsafeCurrentUser();

  let migration;
  let tenantAId;
  let tenantBId;
  let orgOneId;
  let orgTwoId;
  let admin;
  let adminSession;
  let secondAdmin;
  let orgAdmin;
  let orgAdminSession;
  let memberOne;
  let memberOneExt;
  let memberTwo;
  let disabledUser;
  let disabledExt;
  let disabledToken;
  let outsider;
  let outsiderSession;
  let contactId;

  beforeAll(async () => {
    const tenantA = new Parse.Object('partners_Tenant');
    tenantA.set('TenantName', 'Identity Ltd');
    tenantA.set('EmailAddress', 'tenant.identity@example.com');
    tenantA.set('ContactNumber', '+4700000000');
    tenantA.set('Address', '1 Secret Street');
    tenantA.set('Logo', 'https://example.com/identity-logo.png');
    tenantA.set('IsActive', true);
    // Secrets that must never reach a client through this function.
    tenantA.set('google_refresh_token', 'refresh-token-should-never-leak');
    tenantA.set('SMTPPassword', 'smtp-password-should-never-leak');
    tenantAId = (await tenantA.save(null, { useMasterKey: true })).id;

    const tenantB = new Parse.Object('partners_Tenant');
    tenantB.set('TenantName', 'Other Ltd');
    tenantB.set('EmailAddress', 'tenant.other@example.com');
    tenantB.set('IsActive', true);
    tenantBId = (await tenantB.save(null, { useMasterKey: true })).id;

    admin = await makeUser('admin.identity@example.com');
    secondAdmin = await makeUser('admin2.identity@example.com');
    orgAdmin = await makeUser('orgadmin.identity@example.com');
    memberOne = await makeUser('member1.identity@example.com');
    memberTwo = await makeUser('member2.identity@example.com');
    disabledUser = await makeUser('disabled.identity@example.com');
    outsider = await makeUser('outsider.identity@example.com');

    const orgOne = new Parse.Object('contracts_Organizations');
    orgOne.set('Name', 'Identity Ltd');
    orgOne.set('IsActive', true);
    orgOne.set('TenantId', pointer('partners_Tenant', tenantAId));
    orgOne.set('CreatedBy', pointer('_User', admin.id));
    orgOneId = (await orgOne.save(null, { useMasterKey: true })).id;

    const orgTwo = new Parse.Object('contracts_Organizations');
    orgTwo.set('Name', 'Identity Ltd North');
    orgTwo.set('IsActive', true);
    orgTwo.set('TenantId', pointer('partners_Tenant', tenantAId));
    orgTwo.set('CreatedBy', pointer('_User', admin.id));
    orgTwoId = (await orgTwo.save(null, { useMasterKey: true })).id;

    await makeExtUser(admin, { tenantId: tenantAId, orgId: orgOneId, role: 'contracts_Admin' });
    await makeExtUser(secondAdmin, {
      tenantId: tenantAId,
      orgId: orgOneId,
      role: 'contracts_Admin',
    });
    await makeExtUser(orgAdmin, {
      tenantId: tenantAId,
      orgId: orgOneId,
      role: 'contracts_OrgAdmin',
    });
    memberOneExt = await makeExtUser(memberOne, {
      tenantId: tenantAId,
      orgId: orgOneId,
      role: 'contracts_User',
    });
    await makeExtUser(memberTwo, {
      tenantId: tenantAId,
      orgId: orgTwoId,
      role: 'contracts_User',
    });
    disabledExt = await makeExtUser(disabledUser, {
      tenantId: tenantAId,
      orgId: orgOneId,
      role: 'contracts_User',
      disabled: true,
    });
    await makeExtUser(outsider, { tenantId: tenantBId, role: 'contracts_Admin' });

    // Per-user secrets the team list must never hand out.
    const memberRow = await fetchExt(memberOneExt.id);
    memberRow.set('ApiTokenHash', hashToken('os_' + 'm'.repeat(40)));
    memberRow.set('ApiTokenPrefix', 'os_member1x');
    memberRow.set('Webhook', 'https://hooks.example.com/member-one-secret');
    memberRow.set('DeleteOTP', '424242');
    await memberRow.save(null, { useMasterKey: true });

    // The disabled account holds a working-looking API token.
    disabledToken = generateRawToken();
    const disabledRow = await fetchExt(disabledExt.id);
    disabledRow.set('ApiTokenHash', hashToken(disabledToken));
    disabledRow.set('ApiTokenPrefix', disabledToken.slice(0, 11));
    await disabledRow.save(null, { useMasterKey: true });

    const contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'Guest Signer');
    contact.set('Email', 'guest.identity@example.com');
    contact.set('TenantId', pointer('partners_Tenant', tenantAId));
    contact.set('CreatedBy', pointer('_User', admin.id));
    contact.set('IsDeleted', false);
    contactId = (await contact.save(null, { useMasterKey: true })).id;

    adminSession = await loginToken(admin.get('email'));
    orgAdminSession = await loginToken(orgAdmin.get('email'));
    outsiderSession = await loginToken(outsider.get('email'));

    migration = await import(MIGRATION);
    const up = migration.up || migration.default?.up;
    await up(Parse);
  }, 120000);

  afterAll(async () => {
    const down = migration?.down || migration?.default?.down;
    if (down) await down(Parse);
  }, 60000);

  /* ------------------------------------------------------------ gettenant */
  describe('gettenant', () => {
    it('refuses the userId branch without a session', async () => {
      const res = await callFn('gettenant', { userId: admin.id });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });

    it("ignores the userId parameter and answers with the caller's own tenant", async () => {
      // The caller belongs to tenant B but asks for the tenant of a user in A.
      const res = await callFn('gettenant', { userId: admin.id }, session(outsiderSession));
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(tenantBId);
      expect(res.result.TenantName).toBe('Other Ltd');
    });

    it('gives a member the settings fields but no secrets', async () => {
      const res = await callFn('gettenant', {}, session(adminSession));
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(tenantAId);
      expect(res.result.EmailAddress).toBe('tenant.identity@example.com');
      expect(res.result.google_refresh_token).toBeUndefined();
      expect(res.result.SMTPPassword).toBeUndefined();
      expect(res.result.FileAdapters).toBeUndefined();
      expect(res.result.PfxFile).toBeUndefined();
    });

    it('answers the anonymous contact branch with branding only', async () => {
      const res = await callFn('gettenant', { contactId });
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(tenantAId);
      expect(res.result.TenantName).toBe('Identity Ltd');
      expect(res.result.Logo).toBeDefined();
      // Not branding: contact details, postal address and every secret.
      expect(res.result.EmailAddress).toBeUndefined();
      expect(res.result.ContactNumber).toBeUndefined();
      expect(res.result.Address).toBeUndefined();
      expect(res.result.google_refresh_token).toBeUndefined();
      expect(res.result.SMTPPassword).toBeUndefined();
      expect(res.result.FileAdapters).toBeUndefined();
      expect(res.result.PfxFile).toBeUndefined();
    });
  });

  /* ----------------------------------------------------- getuserlistbyorg */
  describe('getuserlistbyorg', () => {
    it('projects the row and hands out no per-user secrets', async () => {
      const res = await callFn(
        'getuserlistbyorg',
        { organizationId: orgOneId },
        session(adminSession)
      );
      expect(res.ok).toBe(true);
      const row = res.result.find(entry => entry.objectId === memberOneExt.id);
      expect(row).toBeDefined();
      expect(row.Email).toBe(memberOne.get('email'));
      expect(row.UserRole).toBe('contracts_User');
      expect(row.ApiTokenHash).toBeUndefined();
      expect(row.ApiTokenPrefix).toBeUndefined();
      expect(row.Webhook).toBeUndefined();
      expect(row.DeleteOTP).toBeUndefined();
      // The UserId pointer is trimmed to its objectId.
      expect(row.UserId.objectId).toBe(memberOne.id);
      expect(Object.keys(row.UserId)).toEqual(['objectId']);
    });
  });

  /* -------------------------------------------------------- resetpassword */
  describe('resetpassword', () => {
    it('refuses an OrgAdmin reaching into another organisation', async () => {
      const res = await callFn(
        'resetpassword',
        { userId: memberTwo.id, password: 'An0ther!pass' },
        session(orgAdminSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    });

    it('refuses an admin resetting another admin', async () => {
      const res = await callFn(
        'resetpassword',
        { userId: secondAdmin.id, password: 'An0ther!pass' },
        session(adminSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('resets a member in its own organisation, killing sessions and the API token', async () => {
      const memberSession = await loginToken(memberOne.get('email'));
      const before = await rest('GET', 'users/me', undefined, session(memberSession));
      expect(before.ok).toBe(true);

      const res = await callFn(
        'resetpassword',
        { userId: memberOne.id, password: 'Rot4ted!pass' },
        session(orgAdminSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.status).toBe('success');

      const after = await rest('GET', 'users/me', undefined, session(memberSession));
      expect(after.ok).toBe(false);
      expect(after.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);

      const row = await fetchExt(memberOneExt.id);
      expect(row.get('ApiTokenHash')).toBeUndefined();
      expect(row.get('ApiTokenPrefix')).toBeUndefined();
    }, 30000);
  });

  /* ------------------------------------------------------------ usersignup */
  describe('usersignup', () => {
    it('refuses a role that is not on the allow-list', async () => {
      const res = await callFn(
        'usersignup',
        {
          userDetails: {
            name: 'Role Injector',
            email: 'role.injector@example.com',
            password: PASSWORD,
            role: 'contracts_Admin',
            company: 'Acme',
            jobTitle: 'Tester',
          },
        },
        { 'x-real-ip': '10.9.0.21' }
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('never derives a class name from the role', async () => {
      const res = await callFn(
        'usersignup',
        {
          userDetails: {
            name: 'Class Injector',
            email: 'class.injector@example.com',
            password: PASSWORD,
            role: 'partners_Admin',
            company: 'Acme',
            jobTitle: 'Tester',
          },
        },
        { 'x-real-ip': '10.9.0.22' }
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);

      // Nothing was written to a `partners_Users` class, and no account exists.
      const foreign = await new Parse.Query('partners_Users')
        .find({ useMasterKey: true })
        .catch(() => []);
      expect(foreign.length).toBe(0);
      const user = await new Parse.Query(Parse.User)
        .equalTo('username', 'class.injector@example.com')
        .first({ useMasterKey: true });
      expect(user).toBeUndefined();
    });

    it('still signs a new account up as contracts_User', async () => {
      const res = await callFn(
        'usersignup',
        {
          userDetails: {
            name: 'Good Signup',
            email: 'good.signup.identity@example.com',
            password: PASSWORD,
            role: 'contracts_User',
            company: 'Acme',
            jobTitle: 'Tester',
          },
        },
        { 'x-real-ip': '10.9.0.23' }
      );
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User sign up');
      const row = await new Parse.Query('contracts_Users')
        .equalTo('Email', 'good.signup.identity@example.com')
        .first({ useMasterKey: true });
      expect(row.get('UserRole')).toBe('contracts_User');
    }, 30000);

    it('stores the typed password when a shadow user signs up holding its own session', async () => {
      // A shadow user as cloud/lib/contacts.js makes one: a password nobody knows.
      const email = 'shadow.claim.identity@example.com';
      const shadow = new Parse.User();
      shadow.set('username', email);
      shadow.set('email', email);
      shadow.set('password', 'random-shadow-value-nobody-types');
      await shadow.signUp();
      // The session an OTP login (AuthLoginAsMail) mints for it.
      const loginAs = await http.post(
        `${TEST_SERVER}/loginAs`,
        { userId: shadow.id },
        { headers: { ...baseHeaders, 'X-Parse-Master-Key': 'test' } }
      );
      const guestToken = loginAs.data.sessionToken;

      const res = await callFn(
        'usersignup',
        {
          userDetails: {
            name: 'Shadow Claim',
            email,
            password: PASSWORD,
            role: 'contracts_User',
            company: 'Acme',
            jobTitle: 'Signer',
          },
        },
        { ...session(guestToken), 'x-real-ip': '10.9.0.24' }
      );
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User sign up');
      expect(res.result.sessionToken).toBeTruthy();

      // The password typed at signup now opens the account.
      expect(await loginToken(email, PASSWORD)).toBeTruthy();
      // And the session handed back is alive (the password write killed the old one).
      const me = await rest('GET', 'users/me', undefined, session(res.result.sessionToken));
      expect(me.ok).toBe(true);
      expect(me.result.objectId).toBe(shadow.id);
    }, 30000);
  });

  /* -------------------------------------------------------- disabled users */
  describe('suspended accounts', () => {
    it('does not resolve an API token belonging to a disabled account', async () => {
      expect(await resolveApiToken(disabledToken)).toBeNull();
    });
  });

  /* -------------------------------------------------------------- _User CLP */
  describe('_User class permissions', () => {
    it('refuses an anonymous find on _User', async () => {
      const res = await rest('GET', 'classes/_User');
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses an authenticated find on _User', async () => {
      const res = await rest('GET', 'classes/_User', undefined, session(adminSession));
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('still lets a signed-in user read their own row', async () => {
      const res = await rest('GET', `classes/_User/${admin.id}`, undefined, session(adminSession));
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(admin.id);
      expect(res.result.email).toBe(admin.get('email'));
    });

    it('does not hand another account to a signed-in caller', async () => {
      // `enforcePrivateUsers` gives every `_User` an owner-only ACL, so with
      // `find` closed there is no way left to read somebody else's row.
      const res = await rest(
        'GET',
        `classes/_User/${memberOne.id}`,
        undefined,
        session(adminSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    });

    it('declares protectedFields, so a widened ACL still hides the identifiers', async () => {
      const res = await rest('GET', 'schemas/_User', undefined, {
        'X-Parse-Master-Key': 'test',
      });
      expect(res.ok).toBe(true);
      const protectedFields = res.result.classLevelPermissions.protectedFields['*'];
      expect(protectedFields).toContain('email');
      expect(protectedFields).toContain('username');
      expect(protectedFields).toContain('phone');
      expect(protectedFields).toContain('authData');
    });
  });
});
