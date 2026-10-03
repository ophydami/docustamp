import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * One rules row per account (cloud/lib/agentRules.js). Every agent signature
 * on a document someone else sent, and every send from an agent, reads the
 * account's rules by `User`; unique, so two saves racing on a new account
 * cannot leave two rows that disagree.
 */
export default async function createAgentRulesIndexes() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'agentRulesIndexes_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      const rules = database.collection('contracts_AgentRules');
      await rules.createIndex(
        { _p_User: 1 },
        { name: 'User_unique', unique: true, partialFilterExpression: { _p_User: { $type: 'string' } } }
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
      details: 'Created the agent rules index',
    });
    console.log(' SUCCESS  The agent rules index is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
