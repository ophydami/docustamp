/**
 * `NameCheck` on a sign approval: whether the document prints the user's own
 * name for the party their agent asked to sign ({status: match|mismatch|unknown,
 * expected, role, printed[]}, see cloud/lib/signerName.js). The approval card,
 * the approval page and the email warn when it is a mismatch. The server also
 * adds the column on first write; the class stays master-key only.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  schema.addObject('NameCheck');
  try {
    await schema.update();
  } catch (err) {
    if (!/exists/i.test(err?.message || '')) throw err;
  }
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  schema.deleteField('NameCheck');
  await schema.update();
};
