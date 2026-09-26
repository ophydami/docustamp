import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

export default async function createContactIndex() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'contactIndex_1';
  try {
    await client.connect();
    const database = client.db();

    const migrationCollection = database.collection('Migrationdb');

    // Check if the migration has already been executed
    const migrationExists = await migrationCollection.findOne({ name: migrationName });

    if (migrationExists) {
      console.log(' INFO  The unique index for contracts_Contactbook is already present.');
      return;
    }
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    const collection = database.collection('contracts_Contactbook');

    try {
      // Create the unique index, but only on documents where IsImported is true
      const query = {
        IsImported: { $eq: true },
        $or: [{ IsDeleted: false }, { IsDeleted: { $eq: false } }],
      }; // Include documents with IsImported: true and IsDeleted not true
      await collection.createIndex(
        { _p_CreatedBy: 1, Email: 1, IsImported: 1 },
        { unique: true, partialFilterExpression: query }
      );
    } catch (error) {
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
      details: 'Created unique index on CreatedBy, IsImported, Email',
    });

    const migrationdb = database.collection('_SCHEMA');
    // create migrationdb SCHEM migrationdb

    // Document to be inserted
    const schemaDocument = {
      _id: 'Migrationdb',
      objectId: 'string',
      name: 'string',
      updatedAt: 'date',
      createdAt: 'date',
      executedAt: 'date',
      details: 'string',
    };

    // Insert the document, unless a previous run already created the schema row.
    try {
      await migrationdb.insertOne(schemaDocument);
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    console.log(' SUCCESS  The unique index for contracts_Contactbook is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
