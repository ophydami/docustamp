/**
 * `SignatureSaved` on a sign approval: approving signed with the typed
 * signature (the user had none saved), and that signature was saved as the
 * user's own (cloud/lib/savedSignature.js). The approval page and the chat card
 * tell the user once. The server also adds the column on first write; the
 * class stays master-key only.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  schema.addBoolean('SignatureSaved');
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
  schema.deleteField('SignatureSaved');
  await schema.update();
};
