/**
 * Closes the `_User` class to anonymous clients.
 *
 * `20250424104819-change_permission.cjs` left `_User` at
 * `get/find/count/create/update: { '*': true }`, so anyone holding only the
 * application id could page the whole user table (`GET /classes/_User`) and
 * read every account's `username` (which is the email address in this product),
 * `phone` and `ProfilePic`, count the install's users, and write to any row
 * whose ACL allowed it.
 *
 * What the application actually needs:
 *
 *   get      a signed-in client fetches other `_User` rows through pointers
 *            (`getuserlistbyorg`, document `CreatedBy`), so a session is
 *            required and `protectedFields` hides the identifying columns.
 *   find     nothing in either frontend runs a `_User` query; every listing
 *            goes through a cloud function with the master key.
 *   count    same.
 *   create   still `'*'`: the old first-admin page saves a `Parse.User`
 *            straight from the browser (apps/OpenSign/src/pages/AddAdmin.jsx),
 *            and `Parse.User.logInWith('google', ...)` in the new web app
 *            (apps/web/src/features/auth/api.ts) creates the `_User` through
 *            `POST /users` as well. Signup itself is rate limited in
 *            `usersignup` / `addadmin`.
 *   update   `requiresAuthentication`. Parse Server gives a new `_User` an ACL
 *            of public-read plus owner-write, so the row ACL is what confines a
 *            write to its owner; the settings screen saves `name`, `phone`,
 *            `ProfilePic` and the new password with the session owner's own
 *            `Parse.User.save()` (apps/web/src/features/settings/api.ts).
 *            A CLP of `{}` would block the owner too.
 *   delete   already closed; account deletion is an Express route.
 *
 * `protectedFields` restates Parse Server's default hiding of `email` and adds
 * `username` (the email again), `phone` and `authData`. Parse Server skips
 * protected fields when the query is the requester reading their own row, so
 * the signed-in user still sees their own address.
 */

const PROTECTED_USER_FIELDS = ['email', 'username', 'phone', 'authData'];

/**
 * Columns the application writes to `_User` that no migration ever declared,
 * so they are created lazily on first write. Two reasons to declare them here:
 * Parse Server refuses `protectedFields` that name a column the schema does
 * not have, and `addField` has been closed on `_User` since
 * `20250424104819-change_permission.cjs`, which means a fresh install cannot
 * create them at signup time at all.
 */
const LAZY_USER_FIELDS = ['phone', 'ProfilePic', 'normalizedEmail', 'name'];

async function declareLazyUserFields(Parse) {
  let fields = {};
  try {
    const current = await new Parse.Schema('_User').get();
    fields = current?.fields || {};
  } catch (err) {
    console.log(`could not read _User schema: ${err?.message}`);
  }

  const missing = LAZY_USER_FIELDS.filter(name => !fields[name]);
  if (missing.length) {
    try {
      const schema = new Parse.Schema('_User');
      for (const name of missing) schema.addString(name);
      await schema.update();
      for (const name of missing) fields[name] = { type: 'String' };
    } catch (err) {
      console.log(`could not declare _User fields ${missing.join(', ')}: ${err?.message}`);
    }
  }
  return PROTECTED_USER_FIELDS.filter(name => fields[name]);
}

/** The CLP `20250424104819-change_permission.cjs` left `_User` on. */
const PREVIOUS_CLP = {
  get: { '*': true },
  find: { '*': true },
  count: { '*': true },
  create: { '*': true },
  update: { '*': true },
  delete: {},
  addField: {},
};

const lockedClp = protectedFields => ({
  get: { requiresAuthentication: true },
  find: {},
  count: {},
  // Kept open: browser-side signup and Google sign-in both POST /users.
  create: { '*': true },
  // The built-in owner-write ACL is what narrows this to the row's owner.
  update: { requiresAuthentication: true },
  delete: {},
  addField: {},
  protectedFields: { '*': protectedFields },
});

/** Applies `clp` to `_User`. Idempotent: re-running simply sets it again. */
async function setUserClp(Parse, clp) {
  const schema = new Parse.Schema('_User');
  schema.setCLP(clp);
  try {
    await schema.update();
  } catch (err) {
    // `_User` always exists on a live server; save() is the create path a
    // brand new database needs.
    await schema.save();
  }
}

/**
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const protectedFields = await declareLazyUserFields(Parse);
  await setUserClp(Parse, lockedClp(protectedFields));
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  await setUserClp(Parse, PREVIOUS_CLP);
};
