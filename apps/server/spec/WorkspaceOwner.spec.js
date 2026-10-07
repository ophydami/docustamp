/**
 * Coverage for making the owner of a workspace its admin
 * (`ensureWorkspaceAdmin` in cloud/lib/signup.js, run by `usersignup` and
 * `addadmin`, and once over existing accounts by
 * databases/migrations/20261007120000-promote_workspace_owners.cjs).
 *
 * Self-service signup used to leave the owner of a new tenant as a plain
 * `contracts_User` with no organisation, so nobody who signed up after the
 * installation's first admin could add a teammate. The owner is an admin now,
 * which is only safe because every admin power stops at the caller's own
 * tenant; the second block pins that down for owners specifically.
 */
import axios from 'axios';
import { ensureWorkspaceAdmin } from '../cloud/lib/signup.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const PASSWORD = 'Str0ng!pass';
const MIGRATION = '../databases/migrations/20261007120000-promote_workspace_owners.cjs';

const client = axios.create({ validateStatus: () => true });
const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': 'test',
  'X-Parse-Javascript-Key': 'test',
  'x-real-ip': '10.7.7.7',
};
const session = token => ({ 'X-Parse-Session-Token': token });
const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });

async function callFn(name, params = {}, headers = {}) {
  const res = await client.post(`${TEST_SERVER}/functions/${name}`, params, {
    headers: { ...baseHeaders, ...headers },
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, result: res.data.result };
  return { ok: false, code: res.data?.code, error: res.data?.error };
}

/** A self-service signup, returning its session and its profile row. */
async function signUp(prefix, company) {
  const email = uniqueEmail(prefix, 'example.test');
  const res = await callFn('usersignup', {
    userDetails: {
      name: `${prefix} Owner`,
      email,
      password: PASSWORD,
      role: 'contracts_User',
      company,
      jobTitle: 'Founder',
    },
  });
  expect(res.ok).toBeTrue(JSON.stringify(res));
  expect(res.result.message).toBe('User sign up');
  const ext = await new Parse.Query('contracts_Users')
    .equalTo('Email', email)
    .first({ useMasterKey: true });
  return { email, token: res.result.sessionToken, ext };
}

async function orgsFor(ext) {
  return await new Parse.Query('contracts_Organizations')
    .equalTo('ExtUserId', pointer('contracts_Users', ext.id))
    .find({ useMasterKey: true });
}

/**
 * The state the old signup left behind: a `_User`, the tenant it owns, and a
 * plain `contracts_User` profile with no organisation.
 */
async function legacyOwner(prefix, { disabled = false } = {}) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', PASSWORD);
  await user.signUp();
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('UserId', pointer('_User', user.id));
  tenant.set('TenantName', `${prefix} Co`);
  await tenant.save(null, { useMasterKey: true });
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('UserRole', 'contracts_User');
  ext.set('Email', email);
  ext.set('Name', `${prefix} Legacy`);
  ext.set('Company', `${prefix} Co`);
  ext.set('TenantId', pointer('partners_Tenant', tenant.id));
  if (disabled) ext.set('IsDisabled', true);
  await ext.save(null, { useMasterKey: true });
  return { email, user, tenant, ext };
}

describe('workspace owners are admins of their own workspace', () => {
  let owner;
  let other;
  let teammateEmail;

  beforeAll(async () => {
    resetRateLimits();
    owner = await signUp('wsowner', 'Owner Co');
    other = await signUp('wsother', 'Other Co');
  }, 120000);

  beforeEach(() => resetRateLimits());

  it('gives a self-signup an organisation and an "All Users" team', async () => {
    const ext = await new Parse.Query('contracts_Users')
      .include(['OrganizationId', 'TeamIds'])
      .get(owner.ext.id, { useMasterKey: true });
    expect(ext.get('UserRole')).toBe('contracts_Admin');
    const org = ext.get('OrganizationId');
    expect(org.get('Name')).toBe('Owner Co');
    expect(org.get('TenantId').id).toBe(ext.get('TenantId').id);
    const teams = ext.get('TeamIds');
    expect(teams.length).toBe(1);
    expect(teams[0].get('Name')).toBe('All Users');
    expect(teams[0].get('OrganizationId').id).toBe(org.id);
  });

  it('lets that owner add a teammate', async () => {
    const ext = await new Parse.Query('contracts_Users').get(owner.ext.id, { useMasterKey: true });
    teammateEmail = uniqueEmail('wsmate', 'example.test');
    const res = await callFn(
      'adduser',
      {
        name: 'Mate',
        email: teammateEmail,
        password: PASSWORD,
        organization: { objectId: ext.get('OrganizationId').id },
        team: ext.get('TeamIds')[0].id,
        tenantId: ext.get('TenantId').id,
        role: 'User',
      },
      session(owner.token)
    );
    expect(res.ok).toBeTrue(JSON.stringify(res));
    const mate = await new Parse.Query('contracts_Users')
      .equalTo('Email', teammateEmail)
      .first({ useMasterKey: true });
    expect(mate.get('TenantId').id).toBe(ext.get('TenantId').id);
    expect(mate.get('UserRole')).toBe('contracts_User');
  });

  it('never promotes a teammate who signs up again', async () => {
    const res = await callFn('usersignup', {
      userDetails: { name: 'Mate', email: teammateEmail, password: PASSWORD, company: 'Mate Co' },
    });
    expect(res.ok).toBeTrue(JSON.stringify(res));
    expect(res.result.message).toBe('User already exist');
    const mate = await new Parse.Query('contracts_Users')
      .equalTo('Email', teammateEmail)
      .first({ useMasterKey: true });
    expect(mate.get('UserRole')).toBe('contracts_User');
    const ownerExt = await new Parse.Query('contracts_Users').get(owner.ext.id, {
      useMasterKey: true,
    });
    expect(mate.get('OrganizationId').id).toBe(ownerExt.get('OrganizationId').id);
    // And no workspace of their own appeared.
    const ownTenant = await new Parse.Query('partners_Tenant')
      .equalTo('UserId', mate.get('UserId'))
      .first({ useMasterKey: true });
    expect(ownTenant).toBeUndefined();
  });

  describe("an owner's admin powers stop at their own workspace", () => {
    let otherExt;

    beforeAll(async () => {
      otherExt = await new Parse.Query('contracts_Users').get(other.ext.id, { useMasterKey: true });
    });

    it('cannot add a user to another workspace', async () => {
      const res = await callFn(
        'adduser',
        {
          name: 'Intruder',
          email: uniqueEmail('wsintruder', 'example.test'),
          password: PASSWORD,
          organization: { objectId: otherExt.get('OrganizationId').id },
          team: otherExt.get('TeamIds')[0].id,
          tenantId: otherExt.get('TenantId').id,
          role: 'User',
        },
        session(owner.token)
      );
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('cannot list, change, suspend or reset people in another workspace', async () => {
      const list = await callFn(
        'getuserlistbyorg',
        { organizationId: otherExt.get('OrganizationId').id },
        session(owner.token)
      );
      expect(list.ok).toBeFalse();

      const role = await callFn(
        'updateteammember',
        { extUserId: otherExt.id, isDisabled: true },
        session(owner.token)
      );
      expect(role.ok).toBeFalse();

      const reset = await callFn(
        'resetpassword',
        { userId: otherExt.get('UserId').id, password: 'An0ther!pass' },
        session(owner.token)
      );
      expect(reset.ok).toBeFalse();

      // Nothing changed on the other owner's row.
      const after = await new Parse.Query('contracts_Users').get(otherExt.id, {
        useMasterKey: true,
      });
      expect(after.get('IsDisabled')).not.toBeTrue();
      expect(after.get('UserRole')).toBe('contracts_Admin');
    });

    it('cannot rename another workspace', async () => {
      const res = await callFn(
        'updatetenant',
        { tenantId: otherExt.get('TenantId').id, details: { TenantName: 'Taken over' } },
        session(owner.token)
      );
      expect(res.ok).toBeFalse();
      const tenant = await new Parse.Query('partners_Tenant').get(otherExt.get('TenantId').id, {
        useMasterKey: true,
      });
      expect(tenant.get('TenantName')).toBe('Other Co');
    });
  });

  describe('ensureWorkspaceAdmin', () => {
    it('does nothing to a row that already has an organisation', async () => {
      expect(await ensureWorkspaceAdmin(owner.ext.id)).toBeFalse();
      expect((await orgsFor(owner.ext)).length).toBe(1);
    });

    it('finishes a half-done signup, reusing the organisation it left', async () => {
      const legacy = await legacyOwner('wshalf');
      const leftover = new Parse.Object('contracts_Organizations');
      leftover.set('Name', 'wshalf Co');
      leftover.set('ExtUserId', pointer('contracts_Users', legacy.ext.id));
      leftover.set('TenantId', pointer('partners_Tenant', legacy.tenant.id));
      await leftover.save(null, { useMasterKey: true });

      // Signing up again with the right password reaches the "already
      // provisioned" branch, which now completes the admin step.
      const res = await callFn('usersignup', {
        userDetails: {
          name: 'Half',
          email: legacy.email,
          password: PASSWORD,
          company: 'wshalf Co',
        },
      });
      expect(res.ok).toBeTrue(JSON.stringify(res));
      expect(res.result.sessionToken).toBeTruthy();

      const ext = await new Parse.Query('contracts_Users').get(legacy.ext.id, {
        useMasterKey: true,
      });
      expect(ext.get('UserRole')).toBe('contracts_Admin');
      expect(ext.get('OrganizationId').id).toBe(leftover.id);
      expect((await orgsFor(legacy.ext)).length).toBe(1);
    });

    it('never promotes someone in a workspace they do not own', async () => {
      const host = await legacyOwner('wshost');
      const guestUser = new Parse.User();
      const guestEmail = uniqueEmail('wsguest', 'example.test');
      guestUser.set('username', guestEmail);
      guestUser.set('email', guestEmail);
      guestUser.set('password', PASSWORD);
      await guestUser.signUp();
      const guest = new Parse.Object('contracts_Users');
      guest.set('UserId', pointer('_User', guestUser.id));
      guest.set('UserRole', 'contracts_User');
      guest.set('Email', guestEmail);
      guest.set('TenantId', pointer('partners_Tenant', host.tenant.id));
      await guest.save(null, { useMasterKey: true });

      expect(await ensureWorkspaceAdmin(guest.id)).toBeFalse();
      const after = await new Parse.Query('contracts_Users').get(guest.id, { useMasterKey: true });
      expect(after.get('UserRole')).toBe('contracts_User');
      expect(after.get('OrganizationId')).toBeUndefined();
    });
  });

  describe('the one-time migration for existing owners', () => {
    let migration;
    let legacy;
    let suspended;
    let stray;

    beforeAll(async () => {
      legacy = await legacyOwner('wsmigrate');
      suspended = await legacyOwner('wssuspended', { disabled: true });
      // A row with no organisation inside a workspace it does not own.
      const strayUser = new Parse.User();
      const strayEmail = uniqueEmail('wsstray', 'example.test');
      strayUser.set('username', strayEmail);
      strayUser.set('email', strayEmail);
      strayUser.set('password', PASSWORD);
      await strayUser.signUp();
      stray = new Parse.Object('contracts_Users');
      stray.set('UserId', pointer('_User', strayUser.id));
      stray.set('UserRole', 'contracts_User');
      stray.set('Email', strayEmail);
      stray.set('TenantId', pointer('partners_Tenant', legacy.tenant.id));
      await stray.save(null, { useMasterKey: true });

      migration = await import(MIGRATION);
      const up = migration.up || migration.default?.up;
      await up(Parse);
      // Twice: it must be safe to run again.
      await up(Parse);
    }, 120000);

    it('makes the owner the admin, with an organisation and a team', async () => {
      const ext = await new Parse.Query('contracts_Users')
        .include(['OrganizationId', 'TeamIds'])
        .get(legacy.ext.id, { useMasterKey: true });
      expect(ext.get('UserRole')).toBe('contracts_Admin');
      expect(ext.get('OrganizationId').get('Name')).toBe('wsmigrate Co');
      expect(ext.get('OrganizationId').get('TenantId').id).toBe(legacy.tenant.id);
      expect(ext.get('TeamIds')[0].get('Name')).toBe('All Users');
      expect((await orgsFor(legacy.ext)).length).toBe(1);
    });

    it("leaves suspended owners and rows in somebody else's workspace alone", async () => {
      const s = await new Parse.Query('contracts_Users').get(suspended.ext.id, {
        useMasterKey: true,
      });
      expect(s.get('UserRole')).toBe('contracts_User');
      expect(s.get('OrganizationId')).toBeUndefined();

      const t = await new Parse.Query('contracts_Users').get(stray.id, { useMasterKey: true });
      expect(t.get('UserRole')).toBe('contracts_User');
      expect(t.get('OrganizationId')).toBeUndefined();
    });
  });
});
