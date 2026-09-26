/**
 * History of draft edits made through the API / MCP (cloud/lib/drafts.js).
 * Master-key only: the REST `classes/` endpoint must not expose other users'
 * drafts. The server also creates this class on first use if the migration has
 * not run.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_DocumentVersion');
  schema.addPointer('Document', 'contracts_Document');
  schema.addPointer('CreatedBy', '_User');
  schema.addNumber('Version');
  schema.addString('Reason');
  schema.addString('Label');
  schema.addString('Origin');
  schema.addString('Name');
  schema.addNumber('FieldCount');
  schema.addArray('Recipients');
  schema.addObject('State');
  // The (Document, Version) index lives in migrationdb/createDocumentVersionIndex.js,
  // which runs on every boot (fresh and existing installs). Declaring it here as
  // well made Mongo reject the schema save with "index already exists with a
  // different name" and stopped every later migration on a fresh database.
  schema.setCLP({ get: {}, find: {}, count: {}, create: {}, update: {}, delete: {}, addField: {} });
  try {
    return await schema.save();
  } catch (err) {
    if (/already exists/i.test(err?.message || '')) return schema.update();
    throw err;
  }
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_DocumentVersion');
  return schema.purge().then(() => schema.delete());
};
