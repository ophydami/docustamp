import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

export default async function createNormalizedEmailUnique() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'normalizedEmailUnique_1';
  try {
    await client.connect();
    const database = client.db();

    const migrationCollection = database.collection('Migrationdb');

    // Check if the migration has already been executed
    const migrationExists = await migrationCollection.findOne({ name: migrationName });

    if (migrationExists) {
      console.log(' INFO  The unique index for normalizedEmail is already present.');
      return;
    }
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    const collection = database.collection('_User');

    try {
      // Create the unique index, but only on documents where NormalizedEmail exists
      await collection.createIndex({ normalizedEmail: 1 }, { unique: true, sparse: true });
    } catch (error) {
      // Almost always a pre-existing duplicate. Signup relies on this constraint,
      // so the failure has to be loud and recorded rather than logged once and
      // retried silently on every boot.
      await recordMigrationFailure(migrationCollection, migrationName, error);
      throw error;
    }

    // Save the migration record in the migrationdb collection
    await migrationCollection.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: 'Created unique index on NormalizedEmail',
    });

    console.log(' SUCCESS  The unique index for normalizedEmail is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
