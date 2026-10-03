/**
 * The account's rules for its AI apps (cloud/lib/agentRules.js): one row per
 * `_User`. Master-key only: the REST `classes/` endpoint must not expose them,
 * and every row also carries an empty ACL. The server also creates the class,
 * locked, on first use. The one-row-per-user index lives in
 * migrationdb/createAgentRulesIndexes.js, which runs on every boot.
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
  const schema = new Parse.Schema('contracts_AgentRules');
  schema.addPointer('User', '_User');
  schema.addObject('AutoSign');
  schema.addObject('AlwaysAsk');
  schema.addArray('SendOnlyTo');
  schema.addObject('UpdatedBy');
  schema.setCLP(LOCKED);
  return await saveOrUpdate(schema);
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_AgentRules');
  await schema.purge();
  return await schema.delete();
};
