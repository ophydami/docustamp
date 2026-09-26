import { MongoClient } from 'mongodb';
import { compare } from 'bcryptjs';
import { generateId } from '../Utils.js';
import { randomShadowPassword } from '../cloud/lib/contacts.js';
import { migrationDatabaseUri } from './dbUri.js';

/**
 * Retire the "password == email" shadow accounts.
 *
 * Every contact/signer used to get a `_User` whose password was its own email
 * address (savecontact, editContact, the contactbook afterSave trigger and
 * cloud/lib/contacts.js, all fixed now). Anyone who knew a signer's address
 * could therefore log in as them, read every document they
 * had been sent, and claim the account. Existing rows stay exploitable until
 * the hash is replaced, which is what this does.
 *
 * How a weak password is detected: parse-server stores bcrypt (cost 10) in
 * `_User._hashed_password`, so `bcrypt.compare(username, hash)` (and the email,
 * when it differs) tells us whether the account's password is its own address.
 * That costs roughly 55 ms per candidate, so about a minute per 1000 users on
 * the first boot. It only happens once: the pass is recorded in `Migrationdb`
 * and every rotated user is stamped `PasswordRotatedAt`, so later boots do one
 * `findOne` and return.
 *
 * The rotation itself goes through the Parse SDK (`setPassword` + a master-key
 * save) so parse-server hashes the new value the way it hashes any other, and
 * the account's `_Session` rows are deleted so anything logged in with the old
 * password is cut off.
 *
 * Never throws: a boot must not fail because of this.
 *
 * @param {{uri?: string, batchSize?: number}} [opts]
 * @returns {Promise<{scanned: number, rotated: number, skipped?: boolean}>}
 */
export default async function rotateShadowPasswords(opts = {}) {
  const uri = opts.uri || migrationDatabaseUri();
  const batchSize = opts.batchSize || 500;
  const migrationName = 'shadowPasswordRotation_1';
  const client = new MongoClient(uri);
  let scanned = 0;
  let rotated = 0;
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');
    const users = database.collection('_User');
    const sessions = database.collection('_Session');

    const record = await migrationCollection.findOne({ name: migrationName });
    if (record?.completedAt) {
      return { scanned: 0, rotated: 0, skipped: true };
    }
    if (!record) {
      await migrationCollection.insertOne({
        _id: generateId(10),
        name: migrationName,
        _created_at: new Date(),
        _updated_at: new Date(),
        details: 'Rotating shadow accounts whose password is their own email address',
        lastId: '',
        rotated: 0,
      });
    }
    // Resume where a previous boot stopped rather than re-hashing everything.
    let lastId = record?.lastId || '';

    for (;;) {
      const batch = await users
        .find(
          {
            _id: { $gt: lastId },
            PasswordRotatedAt: { $exists: false },
            _hashed_password: { $exists: true, $ne: null },
          },
          { projection: { _id: 1, username: 1, email: 1, _hashed_password: 1 } }
        )
        .sort({ _id: 1 })
        .limit(batchSize)
        .toArray();
      if (!batch.length) break;

      for (const row of batch) {
        lastId = row._id;
        scanned += 1;
        const hash = row._hashed_password;
        const candidates = [row.username, row.email].filter(
          (value, index, all) => typeof value === 'string' && value && all.indexOf(value) === index
        );
        let weak = false;
        for (const candidate of candidates) {
          if (await compare(candidate, hash).catch(() => false)) {
            weak = true;
            break;
          }
        }
        if (!weak) continue;

        try {
          const user = Parse.User.createWithoutData(row._id);
          user.setPassword(randomShadowPassword());
          user.set('PasswordRotatedAt', new Date());
          await user.save(null, { useMasterKey: true });
          // Anything holding a session obtained with the old password loses it.
          await sessions.deleteMany({ _p_user: `_User$${row._id}` });
          rotated += 1;
        } catch (err) {
          console.log(` WARN  Could not rotate the password of ${row._id}:`, err?.message || err);
        }
      }

      await migrationCollection.updateOne(
        { name: migrationName },
        { $set: { lastId, rotated, _updated_at: new Date() } }
      );
    }

    await migrationCollection.updateOne(
      { name: migrationName },
      { $set: { completedAt: new Date(), lastId, rotated, scanned, _updated_at: new Date() } }
    );
    console.log(
      ` SUCCESS  Shadow password rotation finished: ${rotated} of ${scanned} accounts rotated.`
    );
    return { scanned, rotated };
  } catch (error) {
    console.log(' ERROR  Running shadow password rotation:', error?.message || error);
    return { scanned, rotated };
  } finally {
    await client.close().catch(() => {});
  }
}
