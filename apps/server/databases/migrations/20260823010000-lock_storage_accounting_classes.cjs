/**
 * Takes `partners_DataFiles` and `partners_TenantCredits` off client writes.
 *
 * 20260823000000 closed the anonymous hole on both classes but had to leave
 * `create`/`update` at `requiresAuthentication`, because the web app wrote the
 * rows itself: a POST to `partners_DataFiles` and a read-modify-write of
 * `partners_TenantCredits.usedStorage`, with the tenant taken from the payload.
 * Any signed-in user could therefore add usage rows for another workspace and
 * set its `usedStorage` to whatever they liked, and two uploads finishing
 * together lost an increment.
 *
 * The `recordfileusage` cloud function (cloud/parsefunction/recordFileUsage.js)
 * now does both writes with the master key: it resolves the tenant from the
 * caller's own `contracts_Users` row and increments the counter atomically. So
 * writes move to master key only here.
 *
 * Reads stay `requiresAuthentication`: the settings page reads the workspace's
 * own `usedStorage`, and which rows a session may see is decided by the row ACL
 * (`recordfileusage` writes an owner-read ACL on every new `partners_DataFiles`
 * row). `partners_TenantCredits` rows still carry no ACL; that is the remaining
 * gap and it is a read-only one now.
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

/** Reads need a session; every write goes through the master key. */
const READ_ONLY_TO_CLIENTS = {
  get: { requiresAuthentication: true },
  find: { requiresAuthentication: true },
  count: { requiresAuthentication: true },
  create: {},
  update: {},
  delete: {},
  addField: {},
};

/** What 20260823000000 left in place, restored by `down`. */
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
  await patchSchema(Parse, 'partners_DataFiles', schema => {
    schema.setCLP(READ_ONLY_TO_CLIENTS);
  });
  await patchSchema(Parse, 'partners_TenantCredits', schema => {
    schema.setCLP(READ_ONLY_TO_CLIENTS);
  });
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  await patchSchema(Parse, 'partners_DataFiles', schema => {
    schema.setCLP(SESSION_ONLY);
  });
  await patchSchema(Parse, 'partners_TenantCredits', schema => {
    schema.setCLP(SESSION_ONLY);
  });
};
