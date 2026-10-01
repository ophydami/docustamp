/**
 * Requests from a user's AI agent to sign a document someone else sent them
 * (cloud/lib/approvals.js). Master-key only: the REST `classes/` endpoint must
 * not expose any of it, and every row also carries an empty ACL. The server
 * also creates the class, locked, on first use. The lookup indexes live in
 * migrationdb/createSignApprovalIndexes.js, which runs on every boot.
 *
 * @param {Parse} Parse
 */
const LOCKED = { get: {}, find: {}, count: {}, create: {}, update: {}, delete: {}, addField: {} };

async function saveOrUpdate(schema) {
  try {
    return await schema.save();
  } catch (err) {
    if (/already exists/i.test(err?.message || '')) return schema.update();
    throw err;
  }
}

exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  schema.addPointer('Document', 'contracts_Document');
  schema.addString('ContactId');
  schema.addPointer('User', '_User');
  schema.addPointer('ExtUserPtr', 'contracts_Users');
  schema.addObject('Agent');
  schema.addDate('SigningEnabledAt');
  schema.addObject('Fields');
  schema.addArray('Values');
  schema.addObject('DocumentInfo');
  schema.addObject('Review');
  schema.addString('Fingerprint');
  schema.addString('Status');
  schema.addString('NonceHash');
  schema.addDate('NonceExpiresAt');
  schema.addString('NonceClientId');
  schema.addDate('ExpiresAt');
  schema.addDate('DecidedAt');
  schema.addString('DecidedVia');
  schema.addString('Error');
  schema.setCLP(LOCKED);
  return await saveOrUpdate(schema);
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  await schema.purge();
  return await schema.delete();
};
