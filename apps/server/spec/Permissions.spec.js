/**
 * Coverage for the authorization work in
 * `databases/migrations/20260822000000-lock_down_class_permissions.cjs` and the
 * cloud functions that replace the class-API writes it closes.
 *
 * Everything goes over raw HTTP with a real session token, because the whole
 * point is what a non-master client is allowed to do through the plain REST
 * class API (`PUT /classes/contracts_Users/<id>` and friends).
 *
 * The test server does not run migrations: `index.js` only shells out to
 * `parse-dbtool migrate` inside the `if (!process.env.TESTING)` branch. So this
 * suite applies the migration itself in `beforeAll` and reverts it in
 * `afterAll`, which keeps the permissive CLPs the other suites were written
 * against.
 */
import axios from 'axios';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const PASSWORD = 'Str0ng!pass';
const MIGRATION = '../databases/migrations/20260822000000-lock_down_class_permissions.cjs';

const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': APP_ID,
  'X-Parse-Javascript-Key': JS_KEY,
};

const session = token => ({ 'X-Parse-Session-Token': token });

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: { ...baseHeaders, 'x-real-ip': '10.0.0.9', ...headers },
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

/** A `contracts_Users` row saved the legacy way: with the master key, no ACL. */
async function makeExtUser(user, { tenantId, orgId, role }) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', role);
  ext.set('TenantId', pointer('partners_Tenant', tenantId));
  if (orgId) ext.set('OrganizationId', pointer('contracts_Organizations', orgId));
  return await ext.save(null, { useMasterKey: true });
}

async function fetchExt(objectId) {
  return await new Parse.Query('contracts_Users').get(objectId, { useMasterKey: true });
}

/** `DocumentAftersave.updateAclDoc` does not await its own save. */
async function waitForAcl(className, objectId, predicate, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const obj = await new Parse.Query(className).get(objectId, { useMasterKey: true });
    const acl = obj.getACL();
    if (acl && predicate(acl)) return acl;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const obj = await new Parse.Query(className).get(objectId, { useMasterKey: true });
  return obj.getACL();
}

describe('class permissions', () => {
  Parse.User.enableUnsafeCurrentUser();

  let migration;
  let tenantId;
  let orgId;
  let teamId;
  let admin;
  let adminExt;
  let adminSession;
  let member;
  let memberExt;
  let memberSession;
  let signer;
  let signerSession;
  let signatureId;
  let docId;

  beforeAll(async () => {
    // Fixtures are created BEFORE the migration runs, deliberately without an
    // ACL, so the run also exercises the backfill on legacy rows.
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Permissions Ltd');
    tenant.set('EmailAddress', 'tenant.permissions@example.com');
    tenant.set('IsActive', true);
    tenantId = (await tenant.save(null, { useMasterKey: true })).id;

    admin = await makeUser('admin.permissions@example.com');
    member = await makeUser('member.permissions@example.com');
    signer = await makeUser('signer.permissions@example.com');

    const org = new Parse.Object('contracts_Organizations');
    org.set('Name', 'Permissions Ltd');
    org.set('IsActive', true);
    org.set('TenantId', pointer('partners_Tenant', tenantId));
    org.set('CreatedBy', pointer('_User', admin.id));
    orgId = (await org.save(null, { useMasterKey: true })).id;

    const team = new Parse.Object('contracts_Teams');
    team.set('Name', 'All Users');
    team.set('IsActive', true);
    team.set('OrganizationId', pointer('contracts_Organizations', orgId));
    teamId = (await team.save(null, { useMasterKey: true })).id;

    adminExt = await makeExtUser(admin, { tenantId, orgId, role: 'contracts_Admin' });
    memberExt = await makeExtUser(member, { tenantId, orgId, role: 'contracts_User' });
    await makeExtUser(signer, { tenantId, orgId, role: 'contracts_User' });

    adminSession = await loginToken(admin.get('email'));
    memberSession = await loginToken(member.get('email'));
    signerSession = await loginToken(signer.get('email'));

    // A legacy signature row: master key, no ACL, on the world-readable class.
    const signature = new Parse.Object('contracts_Signature');
    signature.set('UserId', pointer('_User', admin.id));
    signature.set('ImageURL', 'https://example.com/admin-signature.png');
    signatureId = (await signature.save(null, { useMasterKey: true })).id;

    // A document the signer only signs. `DocumentAftersave` rewrites its ACL.
    const contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'Signer');
    contact.set('Email', signer.get('email'));
    contact.set('UserId', pointer('_User', signer.id));
    contact.set('CreatedBy', pointer('_User', admin.id));
    contact.set('IsDeleted', false);
    const contactRes = await contact.save(null, { useMasterKey: true });

    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', 'Permissions test document');
    doc.set('URL', 'https://example.com/doc.pdf');
    doc.set('CreatedBy', pointer('_User', admin.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', adminExt.id));
    doc.set('Signers', [pointer('contracts_Contactbook', contactRes.id)]);
    doc.set('Placeholders', []);
    docId = (await doc.save(null, { useMasterKey: true })).id;

    migration = await import(MIGRATION);
    const up = migration.up || migration.default?.up;
    await up(Parse);

    // A secret the class must never hand to a non-master reader.
    const withSecret = await fetchExt(memberExt.id);
    withSecret.set('ApiTokenHash', 'deadbeef');
    withSecret.set('ApiTokenPrefix', 'os_deadbee');
    await withSecret.save(null, { useMasterKey: true });
  }, 120000);

  afterAll(async () => {
    const down = migration?.down || migration?.default?.down;
    if (down) await down(Parse);
  }, 60000);

  describe('contracts_Users', () => {
    it('backfills an owner-only ACL onto rows that were saved without one', async () => {
      const row = await fetchExt(memberExt.id);
      const acl = row.getACL();
      expect(acl).toBeTruthy();
      expect(acl.getPublicReadAccess()).toBe(false);
      expect(acl.getPublicWriteAccess()).toBe(false);
      expect(acl.getReadAccess(member.id)).toBe(true);
      expect(acl.getWriteAccess(member.id)).toBe(true);
      expect(acl.getReadAccess(admin.id)).toBe(false);
    });

    it("refuses a PUT that raises the caller's own UserRole", async () => {
      const res = await rest(
        'PUT',
        `classes/contracts_Users/${memberExt.id}`,
        { UserRole: 'contracts_Admin' },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
      const row = await fetchExt(memberExt.id);
      expect(row.get('UserRole')).toBe('contracts_User');
    });

    it("refuses a PUT that repoints another user's row", async () => {
      const res = await rest(
        'PUT',
        `classes/contracts_Users/${adminExt.id}`,
        { ApiTokenHash: 'planted', UserRole: 'contracts_Admin' },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
      const row = await fetchExt(adminExt.id);
      expect(row.get('ApiTokenHash')).toBeUndefined();
    });

    it('refuses a POST that creates a row from a client session', async () => {
      const res = await rest(
        'POST',
        'classes/contracts_Users',
        { Email: 'intruder@example.com', UserRole: 'contracts_Admin' },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
    });

    it('lets the owner read their own row and hides the API token fields', async () => {
      const res = await rest('GET', `classes/contracts_Users/${memberExt.id}`, undefined, {
        ...session(memberSession),
      });
      expect(res.ok).toBe(true);
      expect(res.result.UserRole).toBe('contracts_User');
      expect(res.result.ApiTokenHash).toBeUndefined();
      expect(res.result.ApiTokenPrefix).toBeUndefined();
    });
  });

  describe('contracts_Signature', () => {
    it("hides another user's signature from a GET", async () => {
      const res = await rest(
        'GET',
        `classes/contracts_Signature/${signatureId}`,
        undefined,
        session(memberSession)
      );
      expect(res.ok).toBe(false);
    });

    it("hides another user's signature from a find", async () => {
      const res = await rest('GET', 'classes/contracts_Signature', undefined, {
        ...session(memberSession),
      });
      expect(res.ok).toBe(true);
      expect(res.result.results.length).toBe(0);
    });

    it('still lets the owner read their own signature', async () => {
      const res = await rest(
        'GET',
        `classes/contracts_Signature/${signatureId}`,
        undefined,
        session(adminSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(signatureId);
    });

    it('refuses savesignature on a row the caller does not own', async () => {
      const res = await callFn(
        'savesignature',
        { userId: member.id, id: signatureId, signature: 'https://example.com/hijack.png' },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      const row = await new Parse.Query('contracts_Signature').get(signatureId, {
        useMasterKey: true,
      });
      expect(row.get('ImageURL')).toBe('https://example.com/admin-signature.png');
    });

    it('gives a new signature an owner-only ACL', async () => {
      const res = await callFn(
        'savesignature',
        { userId: member.id, signature: 'https://example.com/member.png' },
        session(memberSession)
      );
      expect(res.ok).toBe(true);
      const row = await new Parse.Query('contracts_Signature').get(res.result.objectId, {
        useMasterKey: true,
      });
      const acl = row.getACL();
      expect(acl.getPublicReadAccess()).toBe(false);
      expect(acl.getReadAccess(member.id)).toBe(true);
      expect(acl.getReadAccess(admin.id)).toBe(false);
    });
  });

  describe('contracts_Document', () => {
    it('grants a signer read but not write', async () => {
      const acl = await waitForAcl('contracts_Document', docId, a => a.getReadAccess(signer.id));
      expect(acl.getReadAccess(signer.id)).toBe(true);
      expect(acl.getWriteAccess(signer.id)).toBe(false);
      expect(acl.getReadAccess(admin.id)).toBe(true);
      expect(acl.getWriteAccess(admin.id)).toBe(true);
    });

    it('lets a signer read the document they have to sign', async () => {
      const res = await rest(
        'GET',
        `classes/contracts_Document/${docId}`,
        undefined,
        session(signerSession)
      );
      expect(res.ok).toBe(true);
    });

    it('refuses a signer PUT on a document they only sign', async () => {
      const res = await rest(
        'PUT',
        `classes/contracts_Document/${docId}`,
        { IsCompleted: true, SignedUrl: 'https://example.com/forged.pdf' },
        session(signerSession)
      );
      expect(res.ok).toBe(false);
      const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
      expect(doc.get('IsCompleted')).not.toBe(true);
      expect(doc.get('SignedUrl')).toBeUndefined();
    });

    it('still lets the owner write their own document', async () => {
      const res = await rest(
        'PUT',
        `classes/contracts_Document/${docId}`,
        { Note: 'owner edit' },
        session(adminSession)
      );
      expect(res.ok).toBe(true);
    });

    it('refuses an anonymous create', async () => {
      const res = await rest('POST', 'classes/contracts_Document', { Name: 'anon' });
      expect(res.ok).toBe(false);
    });
  });

  describe('adduser', () => {
    it('never resets the password of an account that already exists', async () => {
      const res = await callFn(
        'adduser',
        {
          name: 'Member Again',
          email: member.get('email'),
          password: 'Attacker!pass1',
          role: 'User',
          team: teamId,
          tenantId,
          organization: { objectId: orgId, company: 'Permissions Ltd' },
        },
        session(adminSession)
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain('already exists');

      // The original password still works, and the attacker's does not.
      const token = await loginToken(member.get('email'));
      expect(typeof token).toBe('string');
      let rejected = false;
      try {
        await loginToken(member.get('email'), 'Attacker!pass1');
      } catch (err) {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  describe('updateteammember', () => {
    it('rejects a caller who is not an admin', async () => {
      const res = await callFn(
        'updateteammember',
        { extUserId: adminExt.id, role: 'contracts_User' },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect((await fetchExt(adminExt.id)).get('UserRole')).toBe('contracts_Admin');
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await callFn('updateteammember', {
        extUserId: memberExt.id,
        role: 'contracts_Admin',
      });
      expect(res.ok).toBe(false);
    });

    it('refuses to let an admin change their own row', async () => {
      const res = await callFn(
        'updateteammember',
        { extUserId: adminExt.id, isDisabled: true },
        session(adminSession)
      );
      expect(res.ok).toBe(false);
      expect((await fetchExt(adminExt.id)).get('IsDisabled')).not.toBe(true);
    });

    it("lets an admin change a member's role and access", async () => {
      const res = await callFn(
        'updateteammember',
        { extUserId: memberExt.id, role: 'contracts_OrgAdmin', isDisabled: true },
        session(adminSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.UserRole).toBe('contracts_OrgAdmin');
      expect(res.result.IsDisabled).toBe(true);
      expect(res.result.ApiTokenHash).toBeUndefined();

      // Suspending an account revokes what it already holds: the member's old
      // session no longer works.
      const withOldSession = await callFn('updateprofile', { patch: { Name: 'Still here' } }, session(memberSession));
      expect(withOldSession.ok).toBe(false);

      // Put the fixture back so the later specs still see a plain member, and
      // give them a fresh session since the old one was revoked.
      const restore = await callFn(
        'updateteammember',
        { extUserId: memberExt.id, role: 'contracts_User', isDisabled: false },
        session(adminSession)
      );
      expect(restore.ok).toBe(true);
      expect((await fetchExt(memberExt.id)).get('UserRole')).toBe('contracts_User');
      memberSession = await loginToken(member.get('email'));
    });

    it('rejects an unknown role', async () => {
      const res = await callFn(
        'updateteammember',
        { extUserId: memberExt.id, role: 'contracts_Root' },
        session(adminSession)
      );
      expect(res.ok).toBe(false);
    });
  });

  describe('updateprofile', () => {
    it('refuses a patch that carries UserRole', async () => {
      const res = await callFn(
        'updateprofile',
        { patch: { Name: 'Sneaky', UserRole: 'contracts_Admin' } },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      const row = await fetchExt(memberExt.id);
      expect(row.get('UserRole')).toBe('contracts_User');
      expect(row.get('Name')).not.toBe('Sneaky');
    });

    it('refuses a patch that carries TenantId or IsDisabled', async () => {
      const res = await callFn(
        'updateprofile',
        { patch: { TenantId: pointer('partners_Tenant', tenantId), IsDisabled: false } },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
    });

    it('applies the whitelisted profile fields', async () => {
      const res = await callFn(
        'updateprofile',
        { patch: { Name: 'Member Renamed', JobTitle: 'Tester', Company: 'Permissions Ltd' } },
        session(memberSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.Name).toBe('Member Renamed');
      expect(res.result.JobTitle).toBe('Tester');
      expect(res.result.ApiTokenHash).toBeUndefined();
      expect((await fetchExt(memberExt.id)).get('Name')).toBe('Member Renamed');
    });

    it('rejects a field that is not a profile field', async () => {
      const res = await callFn(
        'updateprofile',
        { patch: { Nickname: 'nope' } },
        session(memberSession)
      );
      expect(res.ok).toBe(false);
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await callFn('updateprofile', { patch: { Name: 'Anon' } });
      expect(res.ok).toBe(false);
    });
  });
});
