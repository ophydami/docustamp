/**
 * Environment defaults for the test run.
 *
 * This module must be evaluated before anything that reads process.env at
 * import time (index.js, Utils.js, getSignedUrl.js and friends). ESM hoists
 * imports, so assigning these at the top of helper.js is too late: helper.js's
 * own import of test-runner.js pulls in index.js first. Importing this file as
 * helper.js's first import fixes the order, because module evaluation follows
 * import order.
 *
 * Everything a spec needs from the environment belongs here rather than at the
 * top of one spec file: a value set in a spec module's own scope leaks into
 * every other file in the run (jasmine loads them all into one process), and
 * whether it arrives in time then depends on the file load order.
 */
process.env.TESTING = process.env.TESTING || 'true';
process.env.SERVER_URL = process.env.SERVER_URL || 'http://localhost:30001/test';
// The spec harness starts Parse Server with masterKey 'test' (spec/utils/test-runner.js),
// so anything reading process.env.MASTER_KEY directly has to agree with it.
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
// The origin signing links, reminder mails and the MCP handshake are built from.
process.env.PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:30001';
// AI is off by default until a provider is configured; the specs exercise it
// through a fake client (setAiClientForTests), so switch it on explicitly.
process.env.AI_ENABLED = process.env.AI_ENABLED || 'true';

/**
 * A fixture identity that cannot collide with another run.
 *
 * The database is dropped in the global beforeAll and afterAll, but a run that
 * never reaches afterAll (a crash, a Ctrl-C, a CI timeout) leaves rows behind,
 * and a spec using fixed addresses then fails its own beforeAll with 'Account
 * already exists' and takes the whole file down with it.
 *
 * @param {string} prefix e.g. 'owner.hardening'
 * @returns {string} e.g. 'owner.hardening+k3f9a1@example.com'
 */
export const RUN_SUFFIX = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
export function uniqueEmail(prefix, domain = 'example.com') {
  return `${prefix}+${RUN_SUFFIX}@${domain}`;
}
