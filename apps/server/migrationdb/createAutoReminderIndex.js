import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';
import { migrationDatabaseUri, migrationGivenUp, recordMigrationFailure } from './dbUri.js';

/**
 * Index the documents the hourly auto-reminder sweep looks for.
 *
 * cloud/jobs/autoReminders.js runs a query for every due reminder
 * (`AutomaticReminders == true`, `NextReminderDate <= now`, not completed, not
 * declined, ordered by `NextReminderDate`) on a timer, forever. Without an index
 * that is a full scan of `contracts_Document` on every tick, and that collection
 * only grows.
 *
 * The partial filter keeps the index to the small subset of documents that have
 * reminders switched on, so it costs almost nothing to maintain.
 */
export default async function createAutoReminderIndex() {
  const uri = migrationDatabaseUri();
  const client = new MongoClient(uri);
  const migrationName = 'autoReminderIndex_1';
  try {
    await client.connect();
    const database = client.db();
    const migrationCollection = database.collection('Migrationdb');

    if (await migrationCollection.findOne({ name: migrationName })) return;
    if (await migrationGivenUp(migrationCollection, migrationName)) return;

    try {
      await database
        .collection('contracts_Document')
        .createIndex(
          { NextReminderDate: 1 },
          { name: 'auto_reminders_due', partialFilterExpression: { AutomaticReminders: true } }
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
      details: 'Created auto_reminders_due index on contracts_Document (NextReminderDate)',
    });
    console.log(' SUCCESS  The auto_reminders_due index for contracts_Document is created.');
  } finally {
    await client.close().catch(() => {});
  }
}
