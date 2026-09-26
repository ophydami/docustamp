/**
 * Outbound webhooks registered through the API / MCP (cloud/lib/webhooks.js).
 * Master-key only: the REST `classes/` endpoint must not expose anybody's
 * secrets. The server also creates this class on first use.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_Webhook');
  schema.addString('Url');
  schema.addString('Secret');
  schema.addArray('Events');
  schema.addString('Description');
  schema.addBoolean('Active');
  schema.addPointer('CreatedBy', '_User');
  schema.addPointer('ExtUserPtr', 'contracts_Users');
  schema.addDate('LastDeliveryAt');
  schema.addNumber('LastStatus');
  schema.addString('LastError');
  schema.addNumber('Failures');
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
  const schema = new Parse.Schema('contracts_Webhook');
  return schema.purge().then(() => schema.delete());
};
