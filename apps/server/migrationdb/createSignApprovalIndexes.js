import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * Index the agent approval lookups (cloud/lib/approvals.js).
 *
 * The Approvals page and its sidebar badge list a user's requests by status,
 * and every sign_document on a document someone else sent looks for the open
 * request on that document's seat first.
 */
export default async function createSignApprovalIndexes() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'signApprovalIndexes_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      const approvals = database.collection('contracts_SignApproval');
      await approvals.createIndex(
        { _p_User: 1, Status: 1, _created_at: -1 },
        { name: 'User_Status_idx' }
      );
      await approvals.createIndex(
        { _p_Document: 1, ContactId: 1, Status: 1 },
        { name: 'Document_Contact_Status_idx' }
      );
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
      details: 'Created the agent approval indexes',
    });
    console.log(' SUCCESS  The agent approval indexes are created.');
  } finally {
    await client.close().catch(() => {});
  }
}
