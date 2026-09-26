import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * Index `contracts_DocumentVersion` by the document it belongs to.
 *
 * Every draft-version read, list, undo and restore (cloud/lib/drafts.js) queries
 * by the `Document` pointer and orders by `Version`, and the class grows by one
 * row on every draft edit made through the API or MCP, so without an index each
 * of those is a collection scan that gets slower with use, on the editor's write
 * path. The class migration
 * (databases/migrations/20260821120000-create_contracts_documentversion.cjs)
 * declares the same index for a fresh install; this one exists because that
 * migration has already run on deployed installs and will not run again.
 *
 * The mongo key uses the storage names parse-server writes: a pointer column
 * `Document` is stored as `_p_Document`. The name matches the one
 * `Parse.Schema.addIndex('Document_idx', ...)` creates, so whichever runs first
 * wins and the other is a no-op.
 */
export default async function createDocumentVersionIndex() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'documentVersionIndex_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      await database
        .collection('contracts_DocumentVersion')
        .createIndex({ _p_Document: 1, Version: -1 }, { name: 'Document_idx' });
    } catch (error) {
      await recordMigrationFailure(migrationCollection, migrationName, error);
      throw error;
    }

    await migrationCollection.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: 'Created index on contracts_DocumentVersion (Document, Version)',
    });
    console.log(' SUCCESS  The contracts_DocumentVersion index is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
