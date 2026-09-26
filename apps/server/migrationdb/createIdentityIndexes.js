import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * The indexes the identity model has always assumed and never had.
 *
 * Three invariants are enforced everywhere in the code and nowhere in the
 * database, which is why the code is full of tie-break rules for a situation
 * that should not be representable:
 *
 *   contracts_Users (UserId, TenantId)  one profile per account per workspace.
 *       `authGuard.extUserForUser`, `lib/context.loadCaller` and
 *       `lib/apiTokens.extUserForUserId` all had to invent a "the oldest row
 *       wins" rule because a duplicate meant tenant, role, API token and
 *       branding could differ between two requests of the same user. Not unique
 *       on `UserId` alone: `adduser` deliberately reuses an existing `_User` and
 *       gives it a second profile inside the inviting workspace, which is how a
 *       person belongs to two organisations.
 *
 *   partners_Tenant  UserId  one tenant per owner. Signup writes `_User`,
 *       `partners_Tenant` and `contracts_Users` as three separate saves with no
 *       transaction, so a failure between them used to leave an orphan tenant and
 *       a retry created a second one: storage accounting then accrued to one
 *       tenant while branding and templates came from the other.
 *
 *   contracts_DocumentVersion (Document, Version)  snapshot numbers are handed
 *       out by counting the existing rows, so two overlapping draft edits could
 *       both take the same number and `restore_draft_version` would then restore
 *       whichever one the query returned first.
 *
 * Plus one supporting index: `contracts_Users.ApiTokenHash` is looked up on every
 * REST and MCP request, and without it that is a collection scan on the hot path.
 *
 * Why here and not in `databases/migrations`: those run through
 * `Parse.Schema.addIndex`, which passes a key spec and no options, so it cannot
 * express uniqueness, sparseness or a partial filter. Every unique index in this
 * product is created here for that reason (see `createContactIndex`,
 * `createNormalizedEmailUnqiue`), and this file runs on a fresh install as well
 * as an existing one, so nothing is missed.
 *
 * All four are partial or sparse, so rows that predate the column are not
 * constrained. A failure is almost always a pre-existing duplicate: it is
 * recorded and re-thrown rather than logged once and retried forever, and
 * `runDbMigrations` collects it so one bad index does not stop the others.
 */

/** Pointer columns are stored by parse-server as `_p_<Field>`. */
const INDEXES = [
  {
    collection: 'contracts_Users',
    name: 'UserId_TenantId_unique',
    key: { _p_UserId: 1, _p_TenantId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { _p_UserId: { $exists: true }, _p_TenantId: { $exists: true } },
    },
  },
  {
    collection: 'contracts_Users',
    name: 'ApiTokenHash_idx',
    key: { ApiTokenHash: 1 },
    // Sparse rather than unique: a collision is not credible for a 238-bit
    // token, and a unique index would refuse the day two rows were both left
    // with the column unset by a partial write.
    options: { sparse: true },
  },
  {
    collection: 'partners_Tenant',
    name: 'UserId_unique',
    key: { _p_UserId: 1 },
    options: { unique: true, partialFilterExpression: { _p_UserId: { $exists: true } } },
  },
  {
    collection: 'contracts_DocumentVersion',
    name: 'Document_Version_unique',
    key: { _p_Document: 1, Version: 1 },
    options: {
      unique: true,
      partialFilterExpression: { _p_Document: { $exists: true }, Version: { $exists: true } },
    },
  },
];

export default async function createIdentityIndexes() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'identityIndexes_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    for (const index of INDEXES) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one connection, four small DDL calls
        await database
          .collection(index.collection)
          .createIndex(index.key, { name: index.name, ...index.options });
      } catch (error) {
        // IndexOptionsConflict (85) / IndexKeySpecsConflict (86) mean an index
        // with this name or shape is already there, which is the desired state.
        if (error?.code === 85 || error?.code === 86) continue;
        // eslint-disable-next-line no-await-in-loop -- the failure is recorded before it is re-thrown
        await recordMigrationFailure(
          migrationCollection,
          migrationName,
          new Error(`${index.collection}.${index.name}: ${error?.message || error}`)
        );
        throw error;
      }
    }

    await migrationCollection.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: INDEXES.map(i => `${i.collection}.${i.name}`).join(', '),
    });
    console.log(' SUCCESS  The identity and version uniqueness indexes are created.');
  } finally {
    await client.close().catch(() => {});
  }
}
