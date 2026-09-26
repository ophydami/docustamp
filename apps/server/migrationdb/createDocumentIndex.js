import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

export default async function createDocumentIndex() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const docMigration = 'documentIndex_1';
  try {
    await client.connect();
    const database = client.db();

    const migrationCollection = database.collection('Migrationdb');

    // Check if the migration has already been executed
    const docMigrationExists = await migrationCollection.findOne({ name: docMigration });

    if (docMigrationExists) {
      console.log(' INFO  The completed report index for contracts_document is already present.');
      return;
    }
    if (await migrationGivenUp(migrationCollection, docMigration)) return;

    const docCollection = database.collection('contracts_Document');

    try {
      await docCollection.createIndex(
        { _p_CreatedBy: 1, _updated_at: -1 },
        {
          name: 'idx_docs_by_creator_recent_completed',
          partialFilterExpression: { IsCompleted: true },
        }
      );

      await docCollection.createIndex(
        { Signers: 1, _updated_at: -1 },
        {
          name: 'idx_docs_by_signer_recent_completed',
          partialFilterExpression: { IsCompleted: true },
        }
      );
    } catch (error) {
      await recordMigrationFailure(migrationCollection, docMigration, error);
      throw error;
    }

    // Save the migration record in the migrationdb collection
    await migrationCollection.insertOne({
      _id: generateId(10),
      name: docMigration,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: 'Created unique index on CreatedBy, IsImported, Email',
    });

    console.log(' SUCCESS  The completed report index for contracts_document is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
