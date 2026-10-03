/**
 * quick_send's duplicate guard.
 *
 * `SendFingerprint` is a hash of the file and the recipients a quick_send went
 * out with (cloud/api/shared.js sendFingerprint). An identical quick_send within
 * a few minutes of a live one sends nothing and points at the first document,
 * so a host that retries a call it gave up waiting for does not mail every
 * signer twice.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_Document');
  schema.addString('SendFingerprint');
  await schema.update();
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_Document');
  schema.deleteField('SendFingerprint');
  await schema.update();
};
