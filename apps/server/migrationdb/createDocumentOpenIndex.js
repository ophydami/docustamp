import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * Index `contracts_DocumentOpen` by document, newest open first.
 *
 * The class grows by one row every time a signer opens a signing link, and the
 * only read (cloud/lib/documentOpens.js recentOpens) is "the opens of this
 * document, newest first", so without the index every document page and API
 * read is a collection scan that gets slower with use. The mongo key uses the
 * storage names parse-server writes: a pointer column `Document` is stored as
 * `_p_Document`, and a date column keeps its name.
 */
export default async function createDocumentOpenIndex() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'documentOpenIndex_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      await database
        .collection('contracts_DocumentOpen')
        .createIndex({ _p_Document: 1, OpenedAt: -1 }, { name: 'Document_idx' });
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
      details: 'Created index on contracts_DocumentOpen (Document, OpenedAt)',
    });
    console.log(' SUCCESS  The contracts_DocumentOpen index is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
