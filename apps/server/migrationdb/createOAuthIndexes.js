import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * Index the OAuth lookups (cloud/lib/oauth.js).
 *
 * Every MCP request made through ChatGPT or another OAuth client looks its
 * connection up by access-token hash, and every refresh by refresh-token hash,
 * so both are indexed; clients are found by their client id and requests by
 * their request id or code hash. Sparse, because a row only holds a code hash
 * once the user has allowed access.
 */
export default async function createOAuthIndexes() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'oauthIndexes_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      await database
        .collection('contracts_OAuthGrant')
        .createIndex({ AccessTokenHash: 1 }, { name: 'AccessTokenHash_idx' });
      await database
        .collection('contracts_OAuthGrant')
        .createIndex({ RefreshTokenHash: 1 }, { name: 'RefreshTokenHash_idx' });
      await database
        .collection('contracts_OAuthGrant')
        .createIndex({ _p_User: 1 }, { name: 'User_idx' });
      await database
        .collection('contracts_OAuthClient')
        .createIndex({ ClientId: 1 }, { name: 'ClientId_idx', unique: true });
      await database
        .collection('contracts_OAuthRequest')
        .createIndex({ RequestId: 1 }, { name: 'RequestId_idx', unique: true });
      await database
        .collection('contracts_OAuthRequest')
        .createIndex({ CodeHash: 1 }, { name: 'CodeHash_idx', sparse: true });
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
      details: 'Created the OAuth token, client and request indexes',
    });
    console.log(' SUCCESS  The OAuth indexes are created.');
  } finally {
    await client.close().catch(() => {});
  }
}
