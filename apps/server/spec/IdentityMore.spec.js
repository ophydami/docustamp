/**
 * Coverage for the second round of identity / tenant fixes:
 *
 *   checkadminexist       "at least one admin", not "exactly one"
 *   addadmin              refuses an anonymous bootstrap once an admin exists
 *   getteams              a caller with no organisation has no teams, not a 400
 *   getuserdetails        the email branch is not an anonymous existence oracle
 *   updatepreferences     any single writable key is a valid patch; bad zones
 *   setwidgetpreferences  appends the date widget instead of dropping it
 *   updatetenant          the mail-template keys are validated too
 *   tenantBranding        footer placement, text-only mail, logo host
 */
import axios from 'axios';
import {
  EMPTY_BRANDING,
  applyBranding,
  normaliseLogoUrl,
} from '../cloud/parsefunction/tenantBranding.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { serverAppId } from '../Utils.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const PASSWORD = 'Str0ng!pass';
const http = axios.create();

const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': 'test',
  'X-Parse-Javascript-Key': 'test',
};

const session = token => ({ 'X-Parse-Session-Token': token });

let seq = 0;
function uniqueEmail(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}@example.test`.toLowerCase();
}

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: { ...baseHeaders, 'x-real-ip': '10.11.0.1', ...headers },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

async function loginToken(email) {
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password: PASSWORD },
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

async function makeExtUser(user, { tenantId, orgId, role }) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', role || 'contracts_User');
  if (tenantId) ext.set('TenantId', pointer('partners_Tenant', tenantId));
  if (orgId) ext.set('OrganizationId', pointer('contracts_Organizations', orgId));
  return await ext.save(null, { useMasterKey: true });
}

describe('identity and tenant fixes, second round', () => {
  Parse.User.enableUnsafeCurrentUser();

  let tenantId;
  let orgId;
  let admin;
  let adminSession;
  let member;
  let memberSession;
  let outsider;
  let outsiderSession;

  beforeAll(async () => {
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Second Round Ltd');
    tenant.set('IsActive', true);
    tenantId = (await tenant.save(null, { useMasterKey: true })).id;

    const org = new Parse.Object('contracts_Organizations');
    org.set('Name', 'Second Round Ltd');
    org.set('IsActive', true);
    org.set('TenantId', pointer('partners_Tenant', tenantId));
    orgId = (await org.save(null, { useMasterKey: true })).id;

    admin = await makeUser(uniqueEmail('secondadmin'));
    await makeExtUser(admin, { tenantId, orgId, role: 'contracts_Admin' });
    adminSession = await loginToken(admin.get('email'));

    // A member of the same tenant with no organisation, which is exactly what
    // `usersignup` produces and what `getteams` used to throw on.
    member = await makeUser(uniqueEmail('secondmember'));
    await makeExtUser(member, { tenantId, role: 'contracts_User' });
    memberSession = await loginToken(member.get('email'));

    outsider = await makeUser(uniqueEmail('secondoutsider'));
    outsiderSession = await loginToken(outsider.get('email'));
  }, 120000);

  beforeEach(() => resetRateLimits());

  describe('checkadminexist', () => {
    it('answers "exist" when at least one admin has an organisation', async () => {
      const res = await callFn('checkadminexist');
      expect(res.ok).toBeTrue();
      expect(res.result).toBe('exist');
    });

    it('keeps answering "exist" once a second admin exists', async () => {
      const second = await makeUser(uniqueEmail('secondadmin2'));
      await makeExtUser(second, { tenantId, orgId, role: 'contracts_Admin' });
      const res = await callFn('checkadminexist');
      expect(res.result).toBe('exist');
    }, 30000);
  });

  describe('addadmin', () => {
    it('refuses an anonymous bootstrap once the installation has an admin', async () => {
      const res = await callFn(
        'addadmin',
        {
          userDetails: {
            name: 'Second Admin',
            email: uniqueEmail('driveby'),
            password: PASSWORD,
            role: 'contracts_Admin',
            company: 'Acme',
            jobTitle: 'Boss',
          },
        },
        { 'x-real-ip': '10.11.0.2' }
      );
      expect(res.ok).toBeTrue();
      expect(res.result.sessionToken).toBeUndefined();
      expect(res.result.message).toMatch(/already exist/i);
    }, 30000);
  });

  describe('one signup core (usersignup and addadmin)', () => {
    it('stores a mixed-case address folded, and sets normalizedEmail', async () => {
      // `usersignup` used to store the username exactly as typed while every
      // lookup in the product matches it case-sensitively, so the account could
      // not be signed into, could not have its password reset, and was invisible
      // to the signup pre-check. `addadmin` lowercased it but never wrote
      // `normalizedEmail`, so the unique index only constrained one of the two
      // doors.
      const typed = `Mixed.Case${Date.now()}@Example.TEST`;
      const res = await callFn('usersignup', {
        userDetails: { email: typed, password: PASSWORD, name: 'Mixed Case', company: 'Acme' },
      });
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User sign up');
      expect(res.result.sessionToken).toBeTruthy();

      const folded = typed.toLowerCase();
      const user = await new Parse.Query(Parse.User)
        .equalTo('username', folded)
        .first({ useMasterKey: true });
      expect(user).toBeDefined();
      expect(user.get('email')).toBe(folded);
      expect(user.get('normalizedEmail')).toBe(folded);

      // And the profile and tenant the provisioning writes.
      const ext = await new Parse.Query('contracts_Users')
        .equalTo('UserId', pointer('_User', user.id))
        .first({ useMasterKey: true });
      expect(ext.get('Email')).toBe(folded);
      expect(ext.get('UserRole')).toBe('contracts_User');
      expect(ext.get('TenantId')).toBeDefined();
      // Owner-only ACL: the class used to be writable by anyone, which is how an
      // objectId was enough to grant yourself contracts_Admin.
      expect(ext.getACL().getWriteAccess(user.id)).toBeTrue();
      expect(ext.getACL().getPublicWriteAccess()).toBeFalse();
    }, 60000);

    it('finds an account stored under a different case instead of claiming it exists', async () => {
      // The pre-check queried `username` case-sensitively, so for such an account
      // it missed, signUp threw 202, and the correct-password branch was never
      // reached: a user typing the right password was told to sign in instead.
      const address = uniqueEmail('legacycase');
      const legacy = new Parse.User();
      legacy.set('username', address.replace('legacycase', 'LegacyCase'));
      legacy.set('email', address);
      legacy.set('password', PASSWORD);
      legacy.set('name', 'Legacy Case');
      await legacy.signUp();

      const res = await callFn('usersignup', {
        userDetails: { email: address, password: PASSWORD, name: 'Legacy Case', company: 'Acme' },
      });
      expect(res.ok).toBe(true);
      // The right password was typed, so a session comes back rather than a
      // bare "already exists".
      expect(res.result.sessionToken).toBeTruthy();
    }, 60000);

    it('still refuses an existing account when the password is wrong', async () => {
      const address = uniqueEmail('wrongpass');
      const existing = new Parse.User();
      existing.set('username', address);
      existing.set('email', address);
      existing.set('password', PASSWORD);
      await existing.signUp();

      const res = await callFn('usersignup', {
        userDetails: { email: address, password: 'not-the-password', name: 'X', company: 'Acme' },
      });
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User already exist');
      expect(res.result.sessionToken).toBeUndefined();
      expect(res.result.error).toBeUndefined();
    }, 60000);

    it('refuses a role outside its own allow-list', async () => {
      const res = await callFn('usersignup', {
        userDetails: {
          email: uniqueEmail('badrole'),
          password: PASSWORD,
          name: 'X',
          role: 'contracts_Admin',
        },
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    }, 60000);
  });

  describe('getteams', () => {
    it('answers with an empty list for a caller with no organisation', async () => {
      const res = await callFn('getteams', { active: true }, session(memberSession));
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result).toEqual([]);
    });

    it('answers with an empty list for a caller with no profile row at all', async () => {
      const res = await callFn('getteams', { active: true }, session(outsiderSession));
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result).toEqual([]);
    });
  });

  describe('getuserdetails', () => {
    it('refuses the email branch without a session', async () => {
      const res = await callFn('getUserDetails', { email: admin.get('email') });
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });

    it('hides an address the caller has nothing to do with', async () => {
      const res = await callFn(
        'getUserDetails',
        { email: admin.get('email') },
        session(outsiderSession)
      );
      expect(res.ok).toBeTrue();
      expect(res.result).toBe('');
    });

    it('answers for someone in the caller own tenant', async () => {
      const res = await callFn(
        'getUserDetails',
        { email: member.get('email') },
        session(adminSession)
      );
      expect(res.ok).toBeTrue();
      expect(typeof res.result.objectId).toBe('string');
    });

    it('never hands the caller their own token hash or webhook', async () => {
      const ext = await new Parse.Query('contracts_Users')
        .equalTo('UserId', pointer('_User', admin.id))
        .first({ useMasterKey: true });
      ext.set('ApiTokenHash', 'planted-hash');
      ext.set('Webhook', 'https://hooks.example.test/planted');
      await ext.save(null, { useMasterKey: true });

      const res = await callFn('getUserDetails', {}, session(adminSession));
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result.ApiTokenHash).toBeUndefined();
      expect(res.result.Webhook).toBeUndefined();
      expect(res.result.Email).toBe(admin.get('email'));
    }, 30000);
  });

  describe('updatepreferences', () => {
    it('accepts a patch that only touches one of the eight extra keys', async () => {
      const res = await callFn(
        'updatepreferences',
        { DateFormat: 'dd/MM/yyyy' },
        session(adminSession)
      );
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result.DateFormat).toBe('dd/MM/yyyy');
    });

    it('refuses a time zone the runtime does not know', async () => {
      const res = await callFn(
        'updatepreferences',
        { Timezone: 'not/a/zone' },
        session(adminSession)
      );
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('stores a real time zone', async () => {
      const res = await callFn(
        'updatepreferences',
        { Timezone: 'Europe/Oslo' },
        session(adminSession)
      );
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result.Timezone).toBe('Europe/Oslo');
    });

    it('still refuses a patch with nothing writable in it', async () => {
      const res = await callFn('updatepreferences', { Nonsense: true }, session(adminSession));
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });
  });

  describe('setwidgetpreferences', () => {
    it('appends the date widget when the row already holds another preference', async () => {
      const ext = await new Parse.Query('contracts_Users')
        .equalTo('UserId', pointer('_User', member.id))
        .first({ useMasterKey: true });
      ext.set('WidgetPreferences', [{ type: 'signature', isReadOnly: false }]);
      await ext.save(null, { useMasterKey: true });

      const res = await callFn(
        'setwidgetpreferences',
        { dateWidget: { isSigningDate: true, isReadOnly: true, format: 'dd/MM/yyyy' } },
        session(memberSession)
      );
      expect(res.ok).toBeTrue(JSON.stringify(res));
      const stored = res.result.WidgetPreferences;
      expect(stored.length).toBe(2);
      const date = stored.find(w => w.type === 'date');
      expect(date).toBeDefined();
      expect(date.format).toBe('dd/MM/yyyy');
    }, 30000);
  });

  describe('updatetenant mail templates', () => {
    it('refuses a subject that is not text', async () => {
      const res = await callFn(
        'updatetenant',
        { tenantId, details: { RequestSubject: { $ne: '' } } },
        session(adminSession)
      );
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.VALIDATION_ERROR);
    });

    it('strips CR/LF out of a subject', async () => {
      const res = await callFn(
        'updatetenant',
        { tenantId, details: { RequestSubject: 'Please sign\r\nBcc: someone@evil.example' } },
        session(adminSession)
      );
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result.RequestSubject).not.toContain('\n');
      expect(res.result.RequestSubject).not.toContain('\r');
    });

    it('refuses an editor type outside the allowed set', async () => {
      const res = await callFn(
        'updatetenant',
        { tenantId, details: { EmailEditorType: { request: 'whatever' } } },
        session(adminSession)
      );
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.VALIDATION_ERROR);
    });

    it('accepts and clears a valid editor type', async () => {
      const set = await callFn(
        'updatetenant',
        { tenantId, details: { EmailEditorType: { request: 'basic', completion: 'basic' } } },
        session(adminSession)
      );
      expect(set.ok).toBeTrue(JSON.stringify(set));
      expect(set.result.EmailEditorType.request).toBe('basic');

      const cleared = await callFn(
        'updatetenant',
        { tenantId, details: { EmailEditorType: null } },
        session(adminSession)
      );
      expect(cleared.ok).toBeTrue(JSON.stringify(cleared));
      expect(cleared.result.EmailEditorType).toBeUndefined();
    }, 30000);
  });

  describe('applyBranding', () => {
    const branding = { ...EMPTY_BRANDING, footer: 'Acme AS, Oslo', hidePoweredBy: true };

    it('puts the footer inside the document, not after </body>', () => {
      const out = applyBranding(
        { html: '<html><body><p>Hello</p></body></html>', from: 'Jane' },
        branding
      );
      expect(out.html).toBe('<html><body><p>Hello</p>' + footerOf(out) + '</body></html>');
      expect(out.html.endsWith('</body></html>')).toBeTrue();
    });

    it('leaves a text-only mail without an empty html part, and footers the text', () => {
      const out = applyBranding({ text: 'Hello there', from: 'Jane' }, branding);
      expect(out.html).toBeUndefined();
      expect(out.text).toContain('Hello there');
      expect(out.text).toContain('Acme AS, Oslo');
    });

    it('keeps the per-document sender when the tenant has not set one', () => {
      const out = applyBranding({ html: '<p>hi</p>', from: 'jane@example.test' }, EMPTY_BRANDING);
      expect(out.from).toBe('jane@example.test');
    });
  });

  describe('normaliseLogoUrl', () => {
    it('refuses a /files/ path on a host this server does not answer on', () => {
      const previous = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = 'https://sign.example.test';
      try {
        expect(() =>
          normaliseLogoUrl(`https://evil.example/files/${serverAppId}/logo.png`)
        ).toThrow();
      } finally {
        if (previous === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = previous;
      }
    });

    it('accepts a /files/ path on the configured public host', () => {
      const previous = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = 'https://sign.example.test';
      try {
        expect(
          normaliseLogoUrl(`https://sign.example.test/files/${serverAppId}/logo.png?token=x`)
        ).toBe(`https://sign.example.test/files/${serverAppId}/logo.png`);
      } finally {
        if (previous === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = previous;
      }
    });
  });
});

/** The footer `applyBranding` inserted, read back out of the result. */
function footerOf(branded) {
  const match = branded.html.match(/<p style="font-size: 13px;[\s\S]*?<\/p>/g);
  return (match || []).join('');
}
