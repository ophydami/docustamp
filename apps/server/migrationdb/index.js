import createAgentRulesIndexes from './createAgentRulesIndexes.js';
import createAutoReminderIndex from './createAutoReminderIndex.js';
import createContactIndex from './createContactIndex.js';
import createDocumentIndex from './createDocumentIndex.js';
import createDocumentOpenIndex from './createDocumentOpenIndex.js';
import createDocumentVersionIndex from './createDocumentVersionIndex.js';
import createIdentityIndexes from './createIdentityIndexes.js';
import createNormalizedEmailUnique from './createNormalizedEmailUnqiue.js';
import createOAuthIndexes from './createOAuthIndexes.js';
import createSignApprovalIndexes from './createSignApprovalIndexes.js';
import lowercaseUserEmails from './lowercaseUserEmails.js';
import rotateShadowPasswords from './rotateShadowPasswords.js';

/**
 * Index migrations, run (and awaited) before the server accepts traffic.
 *
 * Each one throws on failure now instead of swallowing it into a `console.log`,
 * and records the attempt so a broken one is not retried silently forever
 * (migrationdb/dbUri.js). They are still run independently: one failing index
 * must not stop the others, and none of them is worth refusing to boot over, so
 * the failures are collected, logged at error level and re-thrown as one.
 */
export default async function runDbMigrations() {
  const migrations = [
    ['contactIndex', createContactIndex],
    ['documentIndex', createDocumentIndex],
    ['documentVersionIndex', createDocumentVersionIndex],
    ['documentOpenIndex', createDocumentOpenIndex],
    ['autoReminderIndex', createAutoReminderIndex],
    ['normalizedEmailUnique', createNormalizedEmailUnique],
    // Ordered: the addresses are folded before the uniqueness constraints that
    // depend on them are created, so a case-variant row is repaired rather than
    // reported as a duplicate that blocks the index.
    ['lowercaseUserEmails', lowercaseUserEmails],
    ['identityIndexes', createIdentityIndexes],
    ['oauthIndexes', createOAuthIndexes],
    ['signApprovalIndexes', createSignApprovalIndexes],
    ['agentRulesIndexes', createAgentRulesIndexes],
  ];
  // Bcrypt-heavy one-off pass over `_User`; specs drive it directly instead.
  if (!process.env.TESTING) migrations.push(['shadowPasswordRotation', rotateShadowPasswords]);

  const failed = [];
  for (const [name, run] of migrations) {
    try {
      // eslint-disable-next-line no-await-in-loop -- migrations are ordered and share one database
      await run();
    } catch (err) {
      failed.push(`${name}: ${err?.message || err}`);
    }
  }
  if (failed.length) throw new Error(`db migrations failed -> ${failed.join(' | ')}`);
}
