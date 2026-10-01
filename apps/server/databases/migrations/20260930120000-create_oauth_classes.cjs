/**
 * "Sign in with DocuStamp" for MCP clients (cloud/lib/oauth.js): registered
 * clients, authorization requests and the connections (grants) they produce.
 * Master-key only: the REST `classes/` endpoint must not expose any of it. The
 * server also creates these classes on first use. The token-hash indexes live
 * in migrationdb/createOAuthIndexes.js, which runs on every boot.
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
  const client = new Parse.Schema('contracts_OAuthClient');
  client.addString('ClientId');
  client.addString('ClientName');
  client.addArray('RedirectUris');
  client.addObject('Info');
  client.setCLP(LOCKED);
  await saveOrUpdate(client);

  const request = new Parse.Schema('contracts_OAuthRequest');
  request.addString('RequestId');
  request.addString('ClientId');
  request.addString('ClientName');
  request.addString('RedirectUri');
  request.addString('CodeChallenge');
  request.addString('State');
  request.addArray('Scopes');
  request.addString('Resource');
  request.addString('Status');
  request.addDate('ExpiresAt');
  request.addString('CodeHash');
  request.addDate('CodeExpiresAt');
  request.addPointer('User', '_User');
  request.addPointer('ExtUserPtr', 'contracts_Users');
  request.setCLP(LOCKED);
  await saveOrUpdate(request);

  const grant = new Parse.Schema('contracts_OAuthGrant');
  grant.addString('ClientId');
  grant.addString('ClientName');
  grant.addString('RedirectHost');
  grant.addPointer('User', '_User');
  grant.addPointer('ExtUserPtr', 'contracts_Users');
  grant.addArray('Scopes');
  grant.addString('Resource');
  grant.addString('RequestId');
  grant.addString('AccessTokenHash');
  grant.addDate('AccessExpiresAt');
  grant.addString('RefreshTokenHash');
  grant.addDate('RefreshExpiresAt');
  grant.addDate('LastUsedAt');
  grant.setCLP(LOCKED);
  return await saveOrUpdate(grant);
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  for (const name of ['contracts_OAuthGrant', 'contracts_OAuthRequest', 'contracts_OAuthClient']) {
    const schema = new Parse.Schema(name);
    // eslint-disable-next-line no-await-in-loop -- three classes, in order
    await schema.purge().then(() => schema.delete());
  }
};
