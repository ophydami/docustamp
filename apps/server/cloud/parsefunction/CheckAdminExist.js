import { anyAdminExists } from './authGuard.js';

/**
 * `checkadminexist` answers whether this installation has been bootstrapped.
 *
 * Both frontends turn the answer into "is this the very first account?" and
 * send the signup to `addadmin` when it is `not_exist`. The test used to be
 * "exactly one admin", so two admins answered `not_exist` just like zero did,
 * which made every later signup a tenant admin and kept the count above one
 * for good. It is now "at least one", evaluated with a `limit(1)` query.
 *
 * @returns {Promise<'exist'|'not_exist'>}
 */
export default async function CheckAdminExist() {
  try {
    return (await anyAdminExists()) ? 'exist' : 'not_exist';
  } catch (err) {
    console.log('err in isAdminExist', err);
    const code = err?.code || 400;
    const msg = err?.message || 'something went wrong.';
    throw new Parse.Error(code, msg);
  }
}
