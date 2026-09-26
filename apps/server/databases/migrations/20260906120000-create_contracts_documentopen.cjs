/**
 * Open tracking (cloud/lib/documentOpens.js).
 *
 * `OpenStats` on the document is `{ [contactId]: { count, firstAt, lastAt } }`,
 * bumped every time a signer opens their signing link. `contracts_DocumentOpen`
 * is one row per open. Master-key only: the REST `classes/` endpoint must not
 * expose who opened what. The server also creates the class on first use if
 * this migration has not run. The (Document, OpenedAt) index lives in
 * migrationdb/createDocumentOpenIndex.js, which runs on every boot.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.addObject('OpenStats');
  await docSchema.update();

  const schema = new Parse.Schema('contracts_DocumentOpen');
  schema.addPointer('Document', 'contracts_Document');
  schema.addPointer('Contact', 'contracts_Contactbook');
  schema.addPointer('Owner', 'contracts_Users');
  schema.addString('ContactId');
  schema.addString('Email');
  schema.addString('Name');
  schema.addString('IpAddress');
  schema.addString('UserAgent');
  schema.addDate('OpenedAt');
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
  const schema = new Parse.Schema('contracts_DocumentOpen');
  await schema.purge().then(() => schema.delete());

  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.deleteField('OpenStats');
  return docSchema.update();
};
