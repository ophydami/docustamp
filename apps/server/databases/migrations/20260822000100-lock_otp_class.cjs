/**
 * `defaultdata_Otp` holds the one-time login codes (cloud/lib/otp.js). It was
 * never declared in a migration, so parse-server auto-created it with the
 * default public CLP: anyone holding the app id could `find` every live code
 * and `update` one onto any address, which is a full account takeover through
 * `AuthLoginAsMail`. Declare it and take every permission away from everyone;
 * only the master key touches it.
 *
 * Idempotent: the class exists on every deployment that has ever mailed a
 * code, and its columns differ between old and new installs, so only the
 * missing fields are added.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const probe = new Parse.Schema('defaultdata_Otp');
  let existing;
  try {
    existing = await probe.get();
  } catch {
    existing = null;
  }
  const fields = existing?.fields || {};

  const schema = new Parse.Schema('defaultdata_Otp');
  if (!fields.Email) schema.addString('Email');
  if (!fields.OTPHash) schema.addString('OTPHash');
  if (!fields.ExpiresAt) schema.addDate('ExpiresAt');
  if (!fields.Attempts) schema.addNumber('Attempts');
  if (!fields.TenantId) schema.addString('TenantId');
  schema.setCLP({ get: {}, find: {}, count: {}, create: {}, update: {}, delete: {}, addField: {} });

  if (existing) return schema.update();
  try {
    return await schema.save();
  } catch (err) {
    if (/already exists/i.test(err?.message || '')) return schema.update();
    throw err;
  }
};

/**
 * Back to the auto-created public CLP. Only useful to undo the migration; the
 * columns are left in place because rows may depend on them.
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('defaultdata_Otp');
  schema.setCLP({
    get: { '*': true },
    find: { '*': true },
    count: { '*': true },
    create: { '*': true },
    update: { '*': true },
    delete: { '*': true },
    addField: { '*': true },
  });
  return schema.update();
};
