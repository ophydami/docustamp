/**
 * Workspace admins can look at every document in their workspace:
 * `getworkspacedocuments` lists them, `getDocument` and `getsignedurl` open and
 * download them. They can also remind and void a teammate's document
 * (`sendreminder`, `declinedoc` with `asAdmin`). Every other path that changes
 * a document still answers to its owner alone.
 *
 * Everything goes over raw HTTP with a real session token, because the point
 * is what one signed-in person may do to another person's document.
 */
import axios from 'axios';
import { serverAppId } from '../Utils.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const PASSWORD = 'Str0ng!pass';
const NOT_ADMIN = "Only workspace admins can see everyone's documents.";

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

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: { ...baseHeaders, 'x-real-ip': '10.0.0.21', ...headers },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

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

async function makeUser(prefix) {
  const email = uniqueEmail(prefix);
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', PASSWORD);
  user.set('name', prefix);
  await user.signUp();
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password: PASSWORD },
    { headers: baseHeaders }
  );
  return { id: user.id, email, token: res.data.sessionToken };
}

async function makeTenant(name) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', name);
  tenant.set('IsActive', true);
  return (await tenant.save(null, { useMasterKey: true })).id;
}

async function makeOrg(name, tenantId) {
  const org = new Parse.Object('contracts_Organizations');
  org.set('Name', name);
  org.set('IsActive', true);
  org.set('TenantId', pointer('partners_Tenant', tenantId));
  return (await org.save(null, { useMasterKey: true })).id;
}

async function makeProfile(user, { tenantId, orgId, role, disabled = false }) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.email);
  ext.set('Name', user.email.split('+')[0]);
  ext.set('UserRole', role);
  ext.set('TenantId', pointer('partners_Tenant', tenantId));
  if (orgId) ext.set('OrganizationId', pointer('contracts_Organizations', orgId));
  if (disabled) ext.set('IsDisabled', true);
  return (await ext.save(null, { useMasterKey: true })).id;
}

/** A document row. `owner` is `{ userId?, extId? }`; either pointer may be left out. */
async function makeDoc(name, owner, fields = {}) {
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', name);
  doc.set('URL', localFileUrl(`${name.replace(/\W+/g, '-')}.pdf`));
  if (owner.userId) doc.set('CreatedBy', pointer('_User', owner.userId));
  if (owner.extId) doc.set('ExtUserPtr', pointer('contracts_Users', owner.extId));
  for (const [key, value] of Object.entries(fields)) doc.set(key, value);
  return (await doc.save(null, { useMasterKey: true })).id;
}

/**
 * `DocumentAftersave` writes the ACL and the default expiry date after the save
 * has already answered, so a fixture waits for both before it is relied on.
 */
async function waitForAfterSave(docId, ownerId, tries = 40) {
  /* eslint-disable no-await-in-loop -- polling, one look at a time */
  for (let i = 0; i < tries; i++) {
    const row = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    if (row.getACL()?.getWriteAccess(ownerId) && row.get('ExpiryDate')) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(`document ${docId} never got its owner ACL and expiry date`);
}

const namesOf = rows => rows.map(row => row.Name).sort();

describe('workspace admins and their teammates documents', () => {
  Parse.User.enableUnsafeCurrentUser();

  const future = new Date(Date.now() + 10 * 86400000);
  const past = new Date(Date.now() - 86400000);

  let admin;
  let adminExt;
  let orgAdmin;
  let member;
  let memberExt;
  let otherOrgMember;
  let former;
  let outsider;
  let docs;
  let owners;

  beforeAll(async () => {
    const tenantA = await makeTenant('Workspace A');
    const tenantB = await makeTenant('Workspace B');
    const orgA1 = await makeOrg('A one', tenantA);
    const orgA2 = await makeOrg('A two', tenantA);
    const orgB = await makeOrg('B', tenantB);

    admin = await makeUser('ws.admin');
    orgAdmin = await makeUser('ws.orgadmin');
    member = await makeUser('ws.member');
    otherOrgMember = await makeUser('ws.otherorg');
    former = await makeUser('ws.former');
    outsider = await makeUser('ws.outsider');

    adminExt = await makeProfile(admin, {
      tenantId: tenantA,
      orgId: orgA1,
      role: 'contracts_Admin',
    });
    await makeProfile(orgAdmin, { tenantId: tenantA, orgId: orgA1, role: 'contracts_OrgAdmin' });
    memberExt = await makeProfile(member, {
      tenantId: tenantA,
      orgId: orgA1,
      role: 'contracts_User',
    });
    const otherOrgExt = await makeProfile(otherOrgMember, {
      tenantId: tenantA,
      orgId: orgA2,
      role: 'contracts_User',
    });
    const formerExt = await makeProfile(former, {
      tenantId: tenantA,
      orgId: orgA1,
      role: 'contracts_User',
      disabled: true,
    });
    const outsiderExt = await makeProfile(outsider, {
      tenantId: tenantB,
      orgId: orgB,
      role: 'contracts_Admin',
    });

    // Columns an admin must never be handed along with a teammate's document.
    const secretive = await new Parse.Query('contracts_Users').get(memberExt, {
      useMasterKey: true,
    });
    secretive.set('ApiTokenHash', 'deadbeef');
    secretive.set('Webhook', 'https://hooks.example.com/member');
    await secretive.save(null, { useMasterKey: true });

    // The admin is also asked to sign one of the member's documents.
    const adminUser = await new Parse.Query(Parse.User).get(admin.id, { useMasterKey: true });
    adminUser.set('emailVerified', true);
    await adminUser.save(null, { useMasterKey: true });
    const adminContact = new Parse.Object('contracts_Contactbook');
    adminContact.set('Name', 'The admin');
    adminContact.set('Email', admin.email);
    adminContact.set('UserId', pointer('_User', admin.id));
    adminContact.set('CreatedBy', pointer('_User', member.id));
    const adminContactId = (await adminContact.save(null, { useMasterKey: true })).id;
    // Somebody outside the workspace, for a document the admin has no seat on.
    const clientContact = new Parse.Object('contracts_Contactbook');
    clientContact.set('Name', 'A client');
    clientContact.set('Email', uniqueEmail('ws.client'));
    clientContact.set('CreatedBy', pointer('_User', member.id));
    const clientContactId = (await clientContact.save(null, { useMasterKey: true })).id;

    const memberOwner = { userId: member.id, extId: memberExt };
    owners = {
      member: memberOwner,
      admin: { userId: admin.id, extId: adminExt },
      otherOrg: { userId: otherOrgMember.id, extId: otherOrgExt },
      clientContactId,
    };
    const memberFolder = await makeDoc('Member folder', memberOwner, { Type: 'Folder' });
    const adminFolder = await makeDoc(
      'Admin folder',
      { userId: admin.id, extId: adminExt },
      {
        Type: 'Folder',
      }
    );

    docs = {
      adminContactId,
      memberDraft: await makeDoc('Member draft', memberOwner, {
        Folder: pointer('contracts_Document', memberFolder),
      }),
      memberSent: await makeDoc('Member sent', memberOwner, {
        SignedUrl: localFileUrl('member-sent-signed.pdf'),
        ExpiryDate: future,
        Signers: [pointer('contracts_Contactbook', adminContactId)],
        Placeholders: [],
      }),
      memberWaiting: await makeDoc('Member waiting', memberOwner, {
        SignedUrl: localFileUrl('member-waiting-signed.pdf'),
        ExpiryDate: future,
        Signers: [pointer('contracts_Contactbook', clientContactId)],
        Placeholders: [],
      }),
      memberDone: await makeDoc('Member done', memberOwner, {
        SignedUrl: localFileUrl('member-done-signed.pdf'),
        IsCompleted: true,
        ExpiryDate: future,
        // The owner signed it too, so the audit trail points at their profile.
        AuditTrail: [
          {
            UserPtr: pointer('contracts_Users', memberExt),
            Activity: 'Signed',
            SignedOn: new Date().toISOString(),
          },
        ],
      }),
      memberExpired: await makeDoc('Member expired', memberOwner, {
        SignedUrl: localFileUrl('member-expired-signed.pdf'),
      }),
      memberArchived: await makeDoc('Member archived', memberOwner, { IsArchive: true }),
      // An older row: no profile pointer, only the account.
      memberLegacy: await makeDoc('Member legacy', { userId: member.id }),
      adminOwn: await makeDoc(
        'Admin own',
        { userId: admin.id, extId: adminExt },
        {
          Folder: pointer('contracts_Document', adminFolder),
        }
      ),
      otherOrg: await makeDoc('Other org draft', { userId: otherOrgMember.id, extId: otherOrgExt }),
      former: await makeDoc('Former teammate draft', { userId: former.id, extId: formerExt }),
      outsider: await makeDoc('Outsider draft', { userId: outsider.id, extId: outsiderExt }),
    };
    await waitForAfterSave(docs.memberSent, member.id);
    await waitForAfterSave(docs.memberWaiting, member.id);
    await waitForAfterSave(docs.memberDraft, member.id);
    // A new document is given an expiry date of its own once it is saved, so
    // the expired one is dated afterwards: an explicit date is left alone.
    const expired = await waitForAfterSave(docs.memberExpired, member.id);
    expired.set('ExpiryDate', past);
    await expired.save(null, { useMasterKey: true });
  });

  beforeEach(() => resetRateLimits());

  describe('getworkspacedocuments', () => {
    it('refuses a plain member', async () => {
      const res = await callFn('getworkspacedocuments', {}, session(member.token));
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(res.error).toBe(NOT_ADMIN);
    });

    it('refuses a caller with no session', async () => {
      const res = await callFn('getworkspacedocuments', {});
      expect(res.ok).toBe(false);
    });

    it('refuses an admin whose account is suspended', async () => {
      const row = await new Parse.Query('contracts_Users').get(adminExt, { useMasterKey: true });
      row.set('IsDisabled', true);
      await row.save(null, { useMasterKey: true });
      try {
        const res = await callFn('getworkspacedocuments', {}, session(admin.token));
        expect(res.ok).toBe(false);
        expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      } finally {
        row.set('IsDisabled', false);
        await row.save(null, { useMasterKey: true });
      }
    });

    it('shows an admin every document in the workspace and nothing outside it', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(namesOf(res.result.results)).toEqual(
        [
          'Admin own',
          'Former teammate draft',
          'Member done',
          'Member draft',
          'Member expired',
          'Member legacy',
          'Member sent',
          'Member waiting',
          'Other org draft',
        ].sort()
      );
      expect(res.result.count).toBe(9);
    });

    it('keeps an organisation admin to their own organisation', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(orgAdmin.token));
      expect(res.ok).toBe(true);
      const names = namesOf(res.result.results);
      expect(names).toContain('Member draft');
      expect(names).toContain('Admin own');
      expect(names).not.toContain('Other org draft');
      expect(names).not.toContain('Outsider draft');
    });

    it('shows the admin of another workspace only their own workspace', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(outsider.token));
      expect(res.ok).toBe(true);
      expect(namesOf(res.result.results)).toEqual(['Outsider draft']);
    });

    it('does not match an older document by account when that account also works elsewhere', async () => {
      // The member gets a second profile, in the outsider's workspace.
      const second = new Parse.Object('contracts_Users');
      second.set('UserId', pointer('_User', member.id));
      second.set('Email', member.email);
      second.set('UserRole', 'contracts_User');
      const outsiderProfile = await new Parse.Query('contracts_Users')
        .equalTo('UserId', pointer('_User', outsider.id))
        .first({ useMasterKey: true });
      second.set('TenantId', outsiderProfile.get('TenantId'));
      second.set('OrganizationId', outsiderProfile.get('OrganizationId'));
      await second.save(null, { useMasterKey: true });
      try {
        const mine = await callFn('getworkspacedocuments', { perPage: 100 }, session(admin.token));
        expect(namesOf(mine.result.results)).not.toContain('Member legacy');
        // Documents written under the workspace's own profile are unaffected.
        expect(namesOf(mine.result.results)).toContain('Member draft');
        const theirs = await callFn(
          'getworkspacedocuments',
          { perPage: 100 },
          session(outsider.token)
        );
        expect(namesOf(theirs.result.results)).toEqual(['Outsider draft']);
        const open = await callFn(
          'getDocument',
          { docId: docs.memberLegacy },
          session(admin.token)
        );
        expect(open.ok).toBe(false);
      } finally {
        await second.destroy({ useMasterKey: true });
      }
    });

    it('answers each filter chip', async () => {
      const list = async filter =>
        namesOf(
          (await callFn('getworkspacedocuments', { filter, perPage: 100 }, session(admin.token)))
            .result.results
        );
      expect(await list('in_progress')).toEqual(['Member sent', 'Member waiting']);
      expect(await list('completed')).toEqual(['Member done']);
      expect(await list('expired')).toEqual(['Member expired']);
      expect(await list('declined')).toEqual([]);
      expect(await list('draft')).toEqual(
        [
          'Admin own',
          'Former teammate draft',
          'Member draft',
          'Member legacy',
          'Other org draft',
        ].sort()
      );
    });

    it('counts every chip in one call', async () => {
      const res = await callFn('getworkspacedocuments', { mode: 'counts' }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(res.result.counts).toEqual({
        all: 9,
        in_progress: 2,
        completed: 1,
        declined: 0,
        expired: 1,
        draft: 5,
      });
    });

    it('narrows by search and pages', async () => {
      const found = await callFn(
        'getworkspacedocuments',
        { search: 'member s', perPage: 100 },
        session(admin.token)
      );
      expect(namesOf(found.result.results)).toEqual(['Member sent']);

      const first = await callFn(
        'getworkspacedocuments',
        { page: 1, perPage: 3 },
        session(admin.token)
      );
      const second = await callFn(
        'getworkspacedocuments',
        { page: 2, perPage: 3 },
        session(admin.token)
      );
      expect(first.result.results.length).toBe(3);
      expect(first.result.count).toBe(9);
      const seen = new Set(first.result.results.map(row => row.objectId));
      expect(second.result.results.some(row => seen.has(row.objectId))).toBe(false);
    });

    it('treats a search as text, not as a pattern', async () => {
      const res = await callFn(
        'getworkspacedocuments',
        { search: '.*', perPage: 100 },
        session(admin.token)
      );
      expect(res.result.results).toEqual([]);
    });

    it('has no "needs you" bucket', async () => {
      const res = await callFn(
        'getworkspacedocuments',
        { filter: 'needs_you' },
        session(admin.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('hands back list rows without the owner account or profile behind them', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(admin.token));
      const row = res.result.results.find(r => r.objectId === docs.memberSent);
      expect(Object.keys(row.CreatedBy).sort()).toEqual(['email', 'name', 'objectId', 'username']);
      expect(Object.keys(row.ExtUserPtr).sort()).toEqual(['Email', 'Name', 'objectId']);
      expect(row.Signers.length).toBe(1);
      expect(row.Signers[0].Email).toBe(admin.email);
      expect(row.Signers[0].UserId.objectId).toBe(admin.id);
      expect(JSON.stringify(res.result)).not.toContain('deadbeef');
      expect(JSON.stringify(res.result)).not.toContain('hooks.example.com');
    });

    it('keeps folders to the rows the admin owns', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(admin.token));
      const byId = Object.fromEntries(res.result.results.map(r => [r.objectId, r]));
      expect(byId[docs.memberDraft].Folder).toBeUndefined();
      expect(byId[docs.adminOwn].Folder.Name).toBe('Admin folder');
    });

    it('marks the rows that are a teammate document, and not the admin own', async () => {
      const res = await callFn('getworkspacedocuments', { perPage: 100 }, session(admin.token));
      const byId = Object.fromEntries(res.result.results.map(r => [r.objectId, r]));
      expect(byId[docs.memberDraft].ViewAs).toBe('workspace_admin');
      expect(byId[docs.former].ViewAs).toBe('workspace_admin');
      expect(byId[docs.adminOwn].ViewAs).toBeUndefined();
    });
  });

  describe('opening a teammate document', () => {
    it('gives the admin the document, marked as a view, without the owner secrets', async () => {
      const res = await callFn('getDocument', { docId: docs.memberDraft }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(res.result.Name).toBe('Member draft');
      expect(res.result.ViewAs).toBe('workspace_admin');
      expect(res.result.CreatedBy.objectId).toBe(member.id);
      expect(res.result.ExtUserPtr.Email).toBe(member.email);
      expect(res.result.ExtUserPtr.UserRole).toBeUndefined();
      expect(JSON.stringify(res.result)).not.toContain('deadbeef');
      expect(JSON.stringify(res.result)).not.toContain('hooks.example.com');
    });

    it('keeps the owner secrets out of the audit trail as well', async () => {
      const res = await callFn('getDocument', { docId: docs.memberDone }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(res.result.AuditTrail.length).toBe(1);
      expect(res.result.AuditTrail[0].UserPtr.Email).toBe(member.email);
      expect(JSON.stringify(res.result)).not.toContain('deadbeef');
      expect(JSON.stringify(res.result)).not.toContain('hooks.example.com');
    });

    it('does not mark the owner as a viewer', async () => {
      const res = await callFn('getDocument', { docId: docs.memberDraft }, session(member.token));
      expect(res.ok).toBe(true);
      expect(res.result.ViewAs).toBeUndefined();
    });

    it('opens an older document that only names the account', async () => {
      const res = await callFn('getDocument', { docId: docs.memberLegacy }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(res.result.ViewAs).toBe('workspace_admin');
    });

    it('opens a former teammate document', async () => {
      const res = await callFn('getDocument', { docId: docs.former }, session(admin.token));
      expect(res.ok).toBe(true);
      expect(res.result.ViewAs).toBe('workspace_admin');
    });

    it('refuses a member looking at the admin document', async () => {
      const res = await callFn('getDocument', { docId: docs.adminOwn }, session(member.token));
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses a member looking at another member document', async () => {
      const res = await callFn('getDocument', { docId: docs.former }, session(member.token));
      expect(res.ok).toBe(false);
    });

    it('refuses the admin of another workspace', async () => {
      const res = await callFn('getDocument', { docId: docs.memberDraft }, session(outsider.token));
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses an organisation admin outside their organisation', async () => {
      const inside = await callFn(
        'getDocument',
        { docId: docs.memberDraft },
        session(orgAdmin.token)
      );
      expect(inside.ok).toBe(true);
      const outside = await callFn(
        'getDocument',
        { docId: docs.otherOrg },
        session(orgAdmin.token)
      );
      expect(outside.ok).toBe(false);
    });

    it('still treats the admin as a signer when they open their own seat', async () => {
      const res = await callFn(
        'getDocument',
        { docId: docs.memberSent, contactId: docs.adminContactId },
        session(admin.token)
      );
      expect(res.ok).toBe(true);
      expect(res.result.ViewAs).toBeUndefined();
      // The signer's projection, not the owner's row.
      expect(res.result.IsArchive).toBeUndefined();
      expect(res.result.ExtUserPtr.UserRole).toBeUndefined();
    });

    it('lets the admin fetch the file, and nobody outside the workspace', async () => {
      const url = localFileUrl('Member-draft.pdf');
      const ok = await callFn(
        'getsignedurl',
        { url, docId: docs.memberDraft },
        session(admin.token)
      );
      expect(ok.ok).toBe(true);
      expect(typeof ok.result).toBe('string');
      expect(ok.result).toContain('Member-draft.pdf');

      const refused = await callFn(
        'getsignedurl',
        { url, docId: docs.memberDraft },
        session(outsider.token)
      );
      expect(refused.ok).toBe(false);
    });
  });

  describe('changing a teammate document', () => {
    it('is refused through the class API', async () => {
      const put = await rest(
        'PUT',
        `classes/contracts_Document/${docs.memberDraft}`,
        { Name: 'Renamed by the admin' },
        session(admin.token)
      );
      expect(put.ok).toBe(false);
      const row = await new Parse.Query('contracts_Document').get(docs.memberDraft, {
        useMasterKey: true,
      });
      expect(row.get('Name')).toBe('Member draft');
    });

    it('is not opened up to plain class queries either', async () => {
      const res = await rest(
        'GET',
        `classes/contracts_Document/${docs.memberDraft}`,
        undefined,
        session(admin.token)
      );
      expect(res.ok).toBe(false);
    });

    it('is not voided by an admin who does not say they act as the admin', async () => {
      // A document the admin has no seat on. (Where the admin is one of the
      // signers they may decline their own part, like any signer.)
      const res = await callFn(
        'declinedoc',
        { docId: docs.memberWaiting, reason: 'Admin says no' },
        session(admin.token)
      );
      expect(res.ok).toBe(false);
      const row = await new Parse.Query('contracts_Document').get(docs.memberWaiting, {
        useMasterKey: true,
      });
      expect(row.get('IsDeclined')).not.toBe(true);
    });

    it('keeps the open log and the signing links with the owner', async () => {
      const opens = await callFn(
        'getdocumentopens',
        { docId: docs.memberSent },
        session(admin.token)
      );
      expect(opens.ok).toBe(false);
      const links = await callFn(
        'getsigninglinks',
        { docId: docs.memberSent },
        session(admin.token)
      );
      expect(links.ok).toBe(false);
    });
  });
  describe('reminding and voiding a teammate document', () => {
    const mailbox = [];
    let sent;

    const fresh = async id =>
      await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });

    const sentDoc = async (name, owner, signerContactId) =>
      await makeDoc(name, owner, {
        SignedUrl: localFileUrl(`${name.replace(/\W+/g, '-')}-signed.pdf`),
        ExpiryDate: future,
        Signers: [pointer('contracts_Contactbook', signerContactId)],
        Placeholders: [],
      });

    beforeAll(async () => {
      setMailTransport(async params => {
        mailbox.push(params);
        return { status: 'success' };
      });
      sent = {
        toVoid: await sentDoc('Void me', owners.member, owners.clientContactId),
        untouched: await sentDoc('Leave me', owners.member, owners.clientContactId),
        adminSeatVoid: await sentDoc('Admin seat void', owners.member, docs.adminContactId),
        adminSeatDecline: await sentDoc('Admin seat decline', owners.member, docs.adminContactId),
        adminOwn: await sentDoc('Admin sent', owners.admin, owners.clientContactId),
        otherOrg: await sentDoc('Other org sent', owners.otherOrg, owners.clientContactId),
      };
    });

    afterAll(() => setMailTransport(null));

    beforeEach(() => {
      mailbox.length = 0;
    });

    /** A signer outside the workspace, with the placeholder group that seats them. */
    const makeSigner = async name => {
      const email = uniqueEmail(`ws.${name}`);
      const contact = new Parse.Object('contracts_Contactbook');
      contact.set('Name', name);
      contact.set('Email', email);
      contact.set('CreatedBy', pointer('_User', member.id));
      const id = (await contact.save(null, { useMasterKey: true })).id;
      return {
        id,
        email,
        group: {
          Id: id,
          Role: name,
          signerObjId: id,
          signerPtr: pointer('contracts_Contactbook', id),
          email,
          placeHolder: [],
        },
        signed: {
          UserPtr: pointer('contracts_Contactbook', id),
          Activity: 'Signed',
          SignedOn: new Date().toISOString(),
        },
      };
    };

    /** A sent document of the member's, with real seats on it. */
    const seatedDoc = async (name, signers, fields = {}) =>
      await makeDoc(name, owners.member, {
        SignedUrl: localFileUrl(`${name.replace(/\W+/g, '-')}-signed.pdf`),
        ExpiryDate: future,
        Signers: signers.map(signer => pointer('contracts_Contactbook', signer.id)),
        Placeholders: signers.map(signer => signer.group),
        ...fields,
      });

    const sentTo = () => mailbox.map(mail => mail.recipient).sort();

    it('lets the admin void it, puts the admin on the record and tells the owner', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.toVoid, reason: 'Client pulled out', asAdmin: true },
        session(admin.token)
      );
      expect(res.ok).toBe(true);
      expect(res.result.declined).toBe(true);
      expect(res.result.notified).toBe(true);

      const row = await fresh(sent.toVoid);
      expect(row.get('IsDeclined')).toBe(true);
      expect(row.get('DeclineReason')).toBe('Client pulled out');
      expect(row.get('DeclineBy').id).toBe(admin.id);
      expect(row.get('DeclineByContact')).toBeUndefined();

      expect(mailbox.length).toBe(1);
      expect(mailbox[0].recipient).toBe(member.email);
      expect(mailbox[0].subject).toBe('Document "Void me" was voided by ws.admin');
      expect(mailbox[0].html).toContain('an admin of your workspace');
      expect(mailbox[0].html).toContain('Client pulled out');
      expect(mailbox[0].html).toContain(`/documents/${sent.toVoid}`);
    });

    it('shows the owner who voided it', async () => {
      const res = await callFn('getDocument', { docId: sent.toVoid }, session(member.token));
      expect(res.ok).toBe(true);
      expect(res.result.IsDeclined).toBe(true);
      expect(res.result.DeclineBy.objectId).toBe(admin.id);
      expect(res.result.DeclineBy.name).toBe('ws.admin');
      expect(res.result.DeclineByContact).toBeUndefined();
    });

    it('will not void it twice', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.toVoid, reason: 'Again', asAdmin: true },
        session(admin.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.SCRIPT_FAILED);
      expect(mailbox.length).toBe(0);
    });

    it('refuses the admin of another workspace', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.untouched, reason: 'Not mine', asAdmin: true },
        session(outsider.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect((await fresh(sent.untouched)).get('IsDeclined')).not.toBe(true);
      expect(mailbox.length).toBe(0);
    });

    it('refuses a member who claims to act as an admin', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.adminOwn, reason: 'Nope', asAdmin: true },
        session(member.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect((await fresh(sent.adminOwn)).get('IsDeclined')).not.toBe(true);
    });

    it('refuses an organisation admin outside their organisation', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.otherOrg, reason: 'Nope', asAdmin: true },
        session(orgAdmin.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect((await fresh(sent.otherOrg)).get('IsDeclined')).not.toBe(true);
    });

    it('lets an organisation admin void inside their organisation', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.untouched, reason: 'Wrong client', asAdmin: true },
        session(orgAdmin.token)
      );
      expect(res.ok).toBe(true);
      expect((await fresh(sent.untouched)).get('DeclineBy').id).toBe(orgAdmin.id);
    });

    it('will not void a draft', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: docs.memberDraft, reason: 'Nope', asAdmin: true },
        session(admin.token)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.SCRIPT_FAILED);
      expect(res.error).toBe('Only a document that has been sent can be voided.');
      expect((await fresh(docs.memberDraft)).get('IsDeclined')).not.toBe(true);
    });

    it('records a void, not a signer decline, when the admin also has a seat', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.adminSeatVoid, reason: 'Voided as admin', asAdmin: true },
        session(admin.token)
      );
      expect(res.ok).toBe(true);
      const row = await fresh(sent.adminSeatVoid);
      expect(row.get('DeclineBy').id).toBe(admin.id);
      expect(row.get('DeclineByContact')).toBeUndefined();
      expect(mailbox[0].subject).toContain('was voided by');
    });

    it('still lets the admin decline their own part as a signer', async () => {
      const res = await callFn(
        'declinedoc',
        { docId: sent.adminSeatDecline, reason: 'Not signing this' },
        session(admin.token)
      );
      expect(res.ok).toBe(true);
      const row = await fresh(sent.adminSeatDecline);
      expect(row.get('IsDeclined')).toBe(true);
      expect(row.get('DeclineByContact').id).toBe(docs.adminContactId);
      expect(mailbox[0].subject).toContain('has been declined by');
    });

    it('tells everyone who was asked to sign when the owner voids', async () => {
      const first = await makeSigner('first');
      const second = await makeSigner('second');
      const docId = await seatedDoc('Owner void', [first, second], { AuditTrail: [first.signed] });

      const res = await callFn(
        'declinedoc',
        { docId, reason: 'Deal is off', userId: member.id },
        session(member.token)
      );
      expect(res.ok).toBe(true);
      // The one who signed and the one still being waited on. Not the owner.
      expect(sentTo()).toEqual([first.email, second.email].sort());
      expect(res.result.signersNotified.sort()).toEqual([first.email, second.email].sort());
      expect(res.result.signersFailed).toEqual([]);
      expect(mailbox[0].subject).toBe('Signature request withdrawn: "Owner void"');
      expect(mailbox[0].html).toContain('ws.member');
      expect(mailbox[0].html).toContain('has withdrawn');
      expect(mailbox[0].html).toContain('Deal is off');
    });

    it('tells the signers which admin withdrew it, and tells the owner', async () => {
      const only = await makeSigner('only');
      const docId = await seatedDoc('Admin void with signers', [only]);

      const res = await callFn(
        'declinedoc',
        { docId, reason: 'Wrong price', asAdmin: true },
        session(admin.token)
      );
      expect(res.ok).toBe(true);
      expect(sentTo()).toEqual([member.email, only.email].sort());
      const toSigner = mailbox.find(mail => mail.recipient === only.email);
      expect(toSigner.subject).toBe('Signature request withdrawn: "Admin void with signers"');
      expect(toSigner.html).toContain('ws.admin');
      expect(toSigner.html).toContain('ws.member');
      expect(toSigner.html).toContain('Wrong price');
      const toOwner = mailbox.find(mail => mail.recipient === member.email);
      expect(toOwner.subject).toContain('was voided by');
    });

    it('leaves out whoever was not asked yet on a document signed in order', async () => {
      const first = await makeSigner('one');
      const second = await makeSigner('two');
      const third = await makeSigner('three');
      const docId = await seatedDoc('Ordered void', [first, second, third], {
        SendinOrder: true,
        AuditTrail: [first.signed],
      });

      const res = await callFn(
        'declinedoc',
        { docId, reason: '', userId: member.id },
        session(member.token)
      );
      expect(res.ok).toBe(true);
      expect(sentTo()).toEqual([first.email, second.email].sort());
    });

    it('sends no withdrawal when a signer declines their own part', async () => {
      const other = await makeSigner('other');
      const adminSeat = {
        id: docs.adminContactId,
        group: {
          Id: docs.adminContactId,
          Role: 'Admin seat',
          signerObjId: docs.adminContactId,
          signerPtr: pointer('contracts_Contactbook', docs.adminContactId),
          email: admin.email,
          placeHolder: [],
        },
      };
      const docId = await seatedDoc('Signer decline', [adminSeat, other]);

      const res = await callFn('declinedoc', { docId, reason: 'Not for me' }, session(admin.token));
      expect(res.ok).toBe(true);
      // Only the owner hears about a decline, as before.
      expect(sentTo()).toEqual([member.email]);
      expect(mailbox[0].subject).toContain('has been declined by');
      expect(res.result.signersNotified).toEqual([]);
    });

    it('lets the admin send a reminder, and nobody outside the workspace', async () => {
      const mine = await callFn(
        'sendreminder',
        { docId: docs.memberWaiting },
        session(admin.token)
      );
      expect(mine.code).not.toBe(Parse.Error.OPERATION_FORBIDDEN);
      const theirs = await callFn(
        'sendreminder',
        { docId: docs.memberWaiting },
        session(outsider.token)
      );
      expect(theirs.ok).toBe(false);
      expect(theirs.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });
  });
});
