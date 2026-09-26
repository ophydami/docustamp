/**
 * Locks down the class-level permissions that let any client rewrite rows of
 * `contracts_Users`, `contracts_Signature`, `contracts_Document` and
 * `contracts_Template` straight through the plain REST class API, hides the
 * API-token and account-deletion secrets stored on `contracts_Users` from
 * every non-master reader, and backfills an owner-only ACL on the rows that
 * were written without one.
 *
 * What was wrong before this migration:
 *
 *   contracts_Users       create/update `'*'` with no row ACL, so anyone who
 *                         knew an objectId could PUT `UserRole:
 *                         'contracts_Admin'`, repoint `TenantId`, or plant an
 *                         `ApiTokenHash` on somebody else's account.
 *   contracts_Signature   get/find/count/create/update `'*'` with no row ACL,
 *                         so anyone could page every stored signature image
 *                         (`SignatureAfterFind` presigns them) and overwrite
 *                         anyone's row.
 *   contracts_Document /  create/update `'*'`, and `DocumentAftersave` /
 *   contracts_Template    `TemplateAfterSave` used to grant every signer WRITE
 *                         on the row, so a signer could rewrite `URL`,
 *                         `SignedUrl`, `IsCompleted`, `AuditTrail` or
 *                         `Placeholders`.
 *
 * Everything the server itself writes to these classes goes through the master
 * key, or (for documents and templates) through the owner's own session plus
 * the row ACL, so the tighter permissions are transparent to the application.
 * The two class-API writes the web app still performs against
 * `contracts_Users` move to the `updateprofile` / `updateteammember` cloud
 * functions.
 */

/** Fields on `contracts_Users` that no non-master reader may ever see. */
const PROTECTED_USER_FIELDS = {
  ApiTokenHash: 'String',
  ApiTokenPrefix: 'String',
  ApiTokenCreatedAt: 'Date',
  ApiTokenLastUsedAt: 'Date',
  DeleteOTP: 'String',
  DeleteOTPExpiry: 'Date',
  DeleteOTPSentAt: 'Date',
  DeleteOTPTries: 'Number',
  DeleteOTPHash: 'String',
  DeleteLinkHash: 'String',
  DeleteLinkExpiry: 'Date',
};

const PAGE_SIZE = 500;

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

/**
 * Parse Server refuses `protectedFields` naming a column the schema does not
 * declare, and these columns are all created lazily on first write. Declare
 * the missing ones (adding a field that already exists with the same type is a
 * no-op) and protect only what the class really has.
 */
async function protectUserSecretFields(Parse) {
  let existing = {};
  try {
    const current = await new Parse.Schema('contracts_Users').get();
    existing = current?.fields || {};
  } catch (err) {
    console.log(`could not read contracts_Users schema: ${err?.message}`);
  }

  const schema = new Parse.Schema('contracts_Users');
  let added = 0;
  for (const [name, type] of Object.entries(PROTECTED_USER_FIELDS)) {
    if (existing[name]) continue;
    if (type === 'String') schema.addString(name);
    else if (type === 'Date') schema.addDate(name);
    else if (type === 'Number') schema.addNumber(name);
    added += 1;
  }
  if (added) {
    try {
      await schema.update();
    } catch (err) {
      console.log(`could not declare contracts_Users secret fields: ${err?.message}`);
    }
  }

  // Re-read so we protect exactly the columns that now exist.
  let fields = {};
  try {
    const current = await new Parse.Schema('contracts_Users').get();
    fields = current?.fields || {};
  } catch (err) {
    fields = existing;
  }
  return Object.keys(PROTECTED_USER_FIELDS).filter(name => fields[name]);
}

/* ------------------------------------------------------------------------- *
 * Row-level ACL backfill
 * ------------------------------------------------------------------------- */

/** True when a row is world-readable/writable or carries no ACL at all. */
function needsAcl(row) {
  const acl = row.getACL();
  if (!acl) return true;
  return acl.getPublicReadAccess() === true || acl.getPublicWriteAccess() === true;
}

function ownerIdOf(row) {
  const userId = row.get('UserId');
  if (userId && userId.id) return userId.id;
  const createdBy = row.get('CreatedBy');
  if (createdBy && createdBy.id) return createdBy.id;
  return null;
}

/**
 * Gives every row of `className` an owner-only ACL. Idempotent: rows that
 * already carry a non-public ACL are left exactly as they are, so re-running
 * the migration never widens or narrows an ACL a later feature set up.
 */
async function backfillOwnerAcls(Parse, className) {
  let skip = 0;
  let patched = 0;
  for (;;) {
    const query = new Parse.Query(className);
    query.limit(PAGE_SIZE);
    query.skip(skip);
    query.ascending('objectId');
    let rows;
    try {
      rows = await query.find({ useMasterKey: true });
    } catch (err) {
      console.log(`could not page ${className}: ${err?.message}`);
      return patched;
    }
    if (!rows.length) break;
    skip += rows.length;

    const dirty = [];
    for (const row of rows) {
      if (!needsAcl(row)) continue;
      const acl = new Parse.ACL();
      acl.setPublicReadAccess(false);
      acl.setPublicWriteAccess(false);
      const ownerId = ownerIdOf(row);
      if (ownerId) {
        acl.setReadAccess(ownerId, true);
        acl.setWriteAccess(ownerId, true);
      }
      // An ownerless row gets an empty ACL: master-key only, which is how
      // every server-side reader of these classes already queries them.
      row.setACL(acl);
      dirty.push(row);
    }
    if (dirty.length) {
      try {
        await Parse.Object.saveAll(dirty, { useMasterKey: true });
        patched += dirty.length;
      } catch (err) {
        console.log(`could not backfill ACLs on ${className}: ${err?.message}`);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  console.log(`${className}: ${patched} row ACLs backfilled`);
  return patched;
}

/**
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const protectedFields = await protectUserSecretFields(Parse);

  // contracts_Users: readable with a session (the row ACL then narrows it to
  // the owner), writable only with the master key. `updateprofile`,
  // `updateteammember`, `updatepreferences`, `adduser` and friends all save
  // with the master key after checking who the caller is.
  await ensureSchema(Parse, 'contracts_Users', schema => {
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      count: { requiresAuthentication: true },
      create: {},
      update: {},
      delete: {},
      addField: {},
      protectedFields: { '*': protectedFields },
    });
  });

  // contracts_Signature: a session is required for every operation and the row
  // ACL (set by savesignature) keeps a row to its owner.
  await ensureSchema(Parse, 'contracts_Signature', schema => {
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      count: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: {},
      addField: {},
    });
  });

  // contracts_Document / contracts_Template: get/find/count are unchanged (the
  // row ACL is what gates reads); create/update now need a session, and since
  // signers only get READ in the afterSave ACL they can no longer write.
  await ensureSchema(Parse, 'contracts_Document', schema => {
    schema.setCLP({
      get: { '*': true },
      find: { requiresAuthentication: true },
      count: { '*': true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: {},
      addField: { requiresAuthentication: true },
    });
  });

  await ensureSchema(Parse, 'contracts_Template', schema => {
    schema.setCLP({
      get: { '*': true },
      find: {},
      count: { '*': true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: {},
      addField: { requiresAuthentication: true },
    });
  });

  await backfillOwnerAcls(Parse, 'contracts_Users');
  await backfillOwnerAcls(Parse, 'contracts_Signature');
};

/**
 * Restores the permissions that were in place before this migration. The ACL
 * backfill is not reverted: an owner-only ACL is correct either way, and the
 * rows it touched had no ACL to restore.
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  await patchSchema(Parse, 'contracts_Users', schema => {
    schema.setCLP({
      get: {},
      find: {},
      count: {},
      create: { '*': true },
      update: { '*': true },
      delete: {},
      addField: {},
      protectedFields: {},
    });
  });

  await patchSchema(Parse, 'contracts_Signature', schema => {
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

  await patchSchema(Parse, 'contracts_Document', schema => {
    schema.setCLP({
      get: { '*': true },
      find: { requiresAuthentication: true },
      count: { '*': true },
      create: { '*': true },
      update: { '*': true },
      delete: {},
      addField: { requiresAuthentication: true },
    });
  });

  await patchSchema(Parse, 'contracts_Template', schema => {
    schema.setCLP({
      get: { '*': true },
      find: {},
      count: { '*': true },
      create: { '*': true },
      update: { '*': true },
      delete: {},
      addField: { requiresAuthentication: true },
    });
  });
};
