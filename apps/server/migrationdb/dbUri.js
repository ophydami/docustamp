import dotenv from 'dotenv';
dotenv.config({ quiet: true });

/**
 * The database these migrations must run against.
 *
 * It has to follow the same resolution order as the Parse config in index.js
 * (`DATABASE_URI` first, then `MONGODB_URI`). Each migration used to read
 * `MONGODB_URI` on its own, so a deployment that set `DATABASE_URI` created its
 * unique indexes in a different database (or in a local dev database that does
 * not exist) while reporting the migration as done, and the server then ran with
 * no unique constraint on `normalizedEmail` or on imported contacts.
 *
 * @returns {string} a mongodb connection string.
 */
export function migrationDatabaseUri() {
  return (
    process.env.DATABASE_URI?.trim() ||
    process.env.MONGODB_URI?.trim() ||
    'mongodb://localhost:27017/dev'
  );
}

/** How many times one migration is retried across boots before it is given up on. */
export const MAX_MIGRATION_ATTEMPTS = Number(process.env.MAX_MIGRATION_ATTEMPTS || 3);

/**
 * Records that `migrationName` failed, and says whether it is worth trying again.
 *
 * Each index migration used to swallow its failure into a `console.log` and
 * leave no trace, so a pre-existing duplicate that blocks a unique index was
 * retried silently on every boot forever while the server ran believing the
 * constraint existed.
 *
 * @param {import('mongodb').Collection} migrationCollection
 * @param {string} migrationName
 * @param {unknown} error
 * @returns {Promise<number>} the number of attempts recorded so far.
 */
export async function recordMigrationFailure(migrationCollection, migrationName, error) {
  const message = error?.message || String(error);
  let attempts = 1;
  try {
    const result = await migrationCollection.findOneAndUpdate(
      { name: `${migrationName}:failed` },
      {
        $inc: { attempts: 1 },
        $set: { lastError: message, lastAttemptAt: new Date(), _updated_at: new Date() },
        $setOnInsert: { _created_at: new Date() },
      },
      { upsert: true, returnDocument: 'after' }
    );
    attempts = result?.attempts ?? result?.value?.attempts ?? 1;
  } catch (err) {
    console.error(` ERROR  Could not record the ${migrationName} failure:`, err?.message || err);
  }
  if (attempts >= MAX_MIGRATION_ATTEMPTS) {
    console.error(
      ` ERROR  ${migrationName} has now failed ${attempts} times and will not be retried automatically. Fix the data and delete the '${migrationName}:failed' row in Migrationdb. Last error: ${message}`
    );
  } else {
    console.error(
      ` ERROR  ${migrationName} failed (attempt ${attempts} of ${MAX_MIGRATION_ATTEMPTS}): ${message}`
    );
  }
  return attempts;
}

/**
 * True when `migrationName` has already failed too many times to keep retrying.
 * @param {import('mongodb').Collection} migrationCollection
 * @param {string} migrationName
 */
export async function migrationGivenUp(migrationCollection, migrationName) {
  try {
    const row = await migrationCollection.findOne({ name: `${migrationName}:failed` });
    return (row?.attempts || 0) >= MAX_MIGRATION_ATTEMPTS;
  } catch {
    return false;
  }
}
