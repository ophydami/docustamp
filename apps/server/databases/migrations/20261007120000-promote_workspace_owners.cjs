/**
 * Make every existing workspace owner the admin of their own workspace.
 *
 * Self-service signup used to leave the account that owns a new tenant as a
 * plain `contracts_User` with no organisation, so everyone who signed up after
 * the installation's first admin had a workspace they could not add a teammate
 * to, brand, or delete. Signup now promotes the owner straight away
 * (`ensureWorkspaceAdmin` in cloud/lib/signup.js); this does the same, once,
 * for the accounts created before that.
 *
 * A row is promoted when it has no organisation, is not suspended, and its user
 * is the tenant's owner (`partners_Tenant.UserId`). Teammates added by an admin
 * live in someone else's tenant and already have an organisation, so they are
 * never touched. An organisation or team left by a half-finished signup is
 * reused. Every admin power in the server is confined to the caller's own
 * tenant, so a promoted owner gains nothing outside their workspace.
 *
 * The steps are copied rather than imported: a migration has to keep doing what
 * it did on the day it was written, whatever the app code becomes.
 *
 * @param {Parse} Parse
 */

const PAGE_SIZE = 200;

const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });

async function promote(Parse, profile) {
  const tenant = profile.get('TenantId');
  const userId = profile.get('UserId')?.id;
  if (!tenant?.id || !userId || tenant.get('UserId')?.id !== userId) return false;

  const profilePtr = pointer('contracts_Users', profile.id);
  const org =
    (await new Parse.Query('contracts_Organizations')
      .equalTo('ExtUserId', profilePtr)
      .equalTo('TenantId', pointer('partners_Tenant', tenant.id))
      .ascending('createdAt')
      .first({ useMasterKey: true })) || new Parse.Object('contracts_Organizations');
  if (!org.id) {
    org.set(
      'Name',
      profile.get('Company') || tenant.get('TenantName') || profile.get('Name') || ''
    );
    org.set('IsActive', true);
    org.set('ExtUserId', profilePtr);
    org.set('CreatedBy', pointer('_User', userId));
    org.set('TenantId', pointer('partners_Tenant', tenant.id));
    await org.save(null, { useMasterKey: true });
  }
  const orgPtr = pointer('contracts_Organizations', org.id);

  const team =
    (await new Parse.Query('contracts_Teams')
      .equalTo('OrganizationId', orgPtr)
      .equalTo('Name', 'All Users')
      .ascending('createdAt')
      .first({ useMasterKey: true })) || new Parse.Object('contracts_Teams');
  if (!team.id) {
    team.set('Name', 'All Users');
    team.set('OrganizationId', orgPtr);
    team.set('IsActive', true);
    await team.save(null, { useMasterKey: true });
  }

  profile.set('UserRole', 'contracts_Admin');
  profile.set('OrganizationId', orgPtr);
  profile.set('TeamIds', [pointer('contracts_Teams', team.id)]);
  await profile.save(null, { useMasterKey: true });
  return true;
}

exports.up = async Parse => {
  let promoted = 0;
  let lastCreatedAt = null;
  for (;;) {
    const query = new Parse.Query('contracts_Users');
    query.doesNotExist('OrganizationId');
    query.notEqualTo('IsDisabled', true);
    query.exists('TenantId');
    query.include('TenantId');
    query.ascending('createdAt');
    if (lastCreatedAt) query.greaterThan('createdAt', lastCreatedAt);
    query.limit(PAGE_SIZE);
    // eslint-disable-next-line no-await-in-loop -- paged, ordered scan
    const rows = await query.find({ useMasterKey: true });
    if (!rows.length) break;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- a handful of rows, one at a time
      if (await promote(Parse, row)) promoted += 1;
    }
    lastCreatedAt = rows[rows.length - 1].createdAt;
    if (rows.length < PAGE_SIZE) break;
  }
  console.log(`promote_workspace_owners: ${promoted} workspace owner(s) made admin`);
};

/**
 * Not reversed: demoting owners would take Team, branding and account deletion
 * away from people who may have added teammates since. Roll back the app
 * version alone; the extra organisation and role are harmless to it.
 *
 * @param {Parse} Parse
 */
exports.down = async () => {};
