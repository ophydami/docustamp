/**
 * Closes the class-level permissions 20250424104819-change_permission.cjs left
 * wide open on `partners_DataFiles`, `partners_TenantCredits` and
 * `contracts_Contactbook`, which the 20260822 lockdown did not cover.
 *
 * What was wrong before this migration:
 *
 *   partners_DataFiles      create `'*'` and, worse, addField `'*'`, so an
 *                           anonymous caller with the (public) app id could
 *                           insert rows and permanently extend the class schema.
 *                           `allowClientClassCreation: false` only stops new
 *                           classes, not new columns on an existing one.
 *   partners_TenantCredits  every operation `'*'`, and `saveFileUsage` writes
 *                           its rows with no ACL, so any anonymous caller could
 *                           read and rewrite every tenant's storage usage.
 *   contracts_Contactbook   every operation `'*'`, so the contact book of every
 *                           account was anonymously listable wherever a row had
 *                           been written without an ACL.
 *
 * Why `requiresAuthentication` rather than master-key only: both front ends
 * write all three classes through the plain `classes/` REST API with a session
 * (apps/web/src/features/settings/api.ts, .../send/upload.ts,
 * .../contacts/api.ts). Locking them to the master key would need those writes
 * moved into cloud functions first. What this migration does remove is the
 * anonymous access, which is the part reachable from any web page in a victim's
 * browser, plus anonymous schema extension. Narrowing an authenticated read to
 * the caller's own tenant still depends on the row ACL, and for
 * `partners_TenantCredits` there is none yet: that is the remaining gap.
 *
 * `addField` moves to master-key only, so the columns the front ends write have
 * to exist. They are declared here rather than created lazily on first write.
 */

/** Applies `setupFn` to a schema, creating the class when it does not exist. */
async function ensureSchema(Parse, className, setupFn) {
  const schema = new Parse.Schema(className);
  setupFn(schema);
  try {
    await schema.update();
  } catch (err) {
    await schema.save();
  }
}

/** Same, but a missing/undeployable class is not an error (optional classes). */
async function patchSchema(Parse, className, setupFn) {
  try {
    await ensureSchema(Parse, className, setupFn);
  } catch (err) {
    console.log(`skipping ${className}: ${err?.message}`);
  }
}

/** Adds a field only when the class does not already declare it. */
function addMissing(schema, existing, name, add) {
  if (!existing[name]) add(schema, name);
}

async function existingFields(Parse, className) {
  try {
    const current = await new Parse.Schema(className).get();
    return current?.fields || {};
  } catch (err) {
    return {};
  }
}

const SESSION_ONLY = {
  get: { requiresAuthentication: true },
  find: { requiresAuthentication: true },
  count: { requiresAuthentication: true },
  create: { requiresAuthentication: true },
  update: { requiresAuthentication: true },
  delete: {},
  addField: {},
};

/**
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const dataFileFields = await existingFields(Parse, 'partners_DataFiles');
  await patchSchema(Parse, 'partners_DataFiles', schema => {
    addMissing(schema, dataFileFields, 'FileUrl', (s, n) => s.addString(n));
    addMissing(schema, dataFileFields, 'FileSize', (s, n) => s.addNumber(n));
    addMissing(schema, dataFileFields, 'TenantPtr', (s, n) => s.addPointer(n, 'partners_Tenant'));
    addMissing(schema, dataFileFields, 'UserId', (s, n) => s.addPointer(n, '_User'));
    schema.setCLP(SESSION_ONLY);
  });

  const creditFields = await existingFields(Parse, 'partners_TenantCredits');
  await patchSchema(Parse, 'partners_TenantCredits', schema => {
    addMissing(schema, creditFields, 'usedStorage', (s, n) => s.addNumber(n));
    addMissing(schema, creditFields, 'PartnersTenant', (s, n) =>
      s.addPointer(n, 'partners_Tenant')
    );
    schema.setCLP(SESSION_ONLY);
  });

  await patchSchema(Parse, 'contracts_Contactbook', schema => {
    schema.setCLP(SESSION_ONLY);
  });
};

/**
 * Restores the permissions that were in place before this migration.
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  await patchSchema(Parse, 'partners_DataFiles', schema => {
    schema.setCLP({
      get: {},
      find: {},
      count: {},
      create: { '*': true },
      update: {},
      delete: {},
      addField: { '*': true },
    });
  });

  await patchSchema(Parse, 'partners_TenantCredits', schema => {
    schema.setCLP({
      get: { '*': true },
      find: { '*': true },
      count: { '*': true },
      create: { '*': true },
      update: { '*': true },
      delete: {},
      addField: { '*': true },
    });
  });

  await patchSchema(Parse, 'contracts_Contactbook', schema => {
    schema.setCLP({
      get: { '*': true },
      find: { '*': true },
      count: { '*': true },
      create: { '*': true },
      update: { '*': true },
      delete: {},
      addField: {},
    });
  });
};
