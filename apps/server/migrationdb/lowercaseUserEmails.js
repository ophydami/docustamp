import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri } from './dbUri.js';

/**
 * Lowercase the `username`, `email` and `normalizedEmail` of every `_User`.
 *
 * Signup used to store the address exactly as it was typed while every lookup in
 * the product matches it case-sensitively: `Parse.User.logIn`,
 * `setPasswordResetToken`, `shadowUserFor` (the `_User` behind every contact) and
 * the signup pre-check all do `equalTo('username', <lowercased address>)`. An
 * account stored as `Bob@Acme.com` therefore could not be signed into, could not
 * have its password reset, and was invisible to the signup pre-check, so
 * `signUp()` threw 202 and the caller was told the account already exists even
 * when they had typed the right password. `cloud/lib/signup.js` normalises on the
 * way in now; this fixes the rows already written.
 *
 * Parse-server enforces username and email uniqueness case-insensitively, so
 * `bob@acme.com` and `Bob@Acme.com` cannot both exist as usernames. A collision
 * is still possible across *columns* (one account's `username` colliding with
 * another's, once both are folded, on an install where the constraint was added
 * later or the rows were written straight into mongo), so every write is checked
 * first and a row that would collide is left alone and logged by objectId, for a
 * human to merge.
 *
 * Never throws: a boot must not fail over this. Runs once and records itself.
 *
 * @param {{uri?: string}} [opts]
 * @returns {Promise<{scanned: number, updated: number, collisions: string[], skipped?: boolean}>}
 */
export default async function lowercaseUserEmails(opts = {}) {
  const uri = opts.uri || migrationDatabaseUri();
  const migrationName = 'lowercaseUserEmails_1';
  const client = new MongoClient(uri);
  let scanned = 0;
  let updated = 0;
  const collisions = [];
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');
    if (await migrationCollection.findOne({ name: migrationName })) {
      return { scanned: 0, updated: 0, collisions: [], skipped: true };
    }
    const users = database.collection('_User');

    // Only the rows that actually have an upper-case character in one of the
    // three columns; on a clean install this matches nothing.
    const needsWork = {
      $or: [
        { username: /[A-Z]/ },
        { email: /[A-Z]/ },
        { normalizedEmail: /[A-Z]/ },
        { normalizedEmail: { $exists: false }, email: { $exists: true } },
      ],
    };
    const cursor = users.find(needsWork, {
      projection: { username: 1, email: 1, normalizedEmail: 1 },
    });

    for await (const row of cursor) {
      scanned += 1;
      const fold = value => (typeof value === 'string' ? value.trim().toLowerCase() : value);
      const username = fold(row.username);
      const email = fold(row.email);
      const normalizedEmail = fold(row.normalizedEmail) || email || username;
      const set = {};
      if (username && username !== row.username) set.username = username;
      if (email && email !== row.email) set.email = email;
      if (normalizedEmail && normalizedEmail !== row.normalizedEmail) {
        set.normalizedEmail = normalizedEmail;
      }
      if (!Object.keys(set).length) continue;

      // Would the folded values land on somebody else's row?
      const clashQuery = { _id: { $ne: row._id }, $or: [] };
      if (set.username) clashQuery.$or.push({ username: set.username });
      if (set.normalizedEmail) clashQuery.$or.push({ normalizedEmail: set.normalizedEmail });
      if (clashQuery.$or.length) {
        const clash = await users.findOne(clashQuery, { projection: { _id: 1 } });
        if (clash) {
          collisions.push(String(row._id));
          console.error(
            ` WARN  lowercaseUserEmails: _User ${row._id} would collide with ${clash._id} once folded; left as it is. Merge the two accounts by hand.`
          );
          continue;
        }
      }
      await users.updateOne({ _id: row._id }, { $set: { ...set, _updated_at: new Date() } });
      updated += 1;
    }

    await migrationCollection.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: `Lowercased ${updated} of ${scanned} _User rows; ${collisions.length} left for a human`,
    });
    if (updated || collisions.length) {
      console.log(
        ` SUCCESS  lowercaseUserEmails: ${updated} of ${scanned} accounts normalised, ${collisions.length} collisions left alone.`
      );
    }
    return { scanned, updated, collisions };
  } catch (err) {
    console.error(' ERROR  lowercaseUserEmails failed:', err?.message || err);
    return { scanned, updated, collisions };
  } finally {
    await client.close().catch(() => {});
  }
}
