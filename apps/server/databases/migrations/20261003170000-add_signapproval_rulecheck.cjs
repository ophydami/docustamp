/**
 * `RuleCheck` on a sign approval: whether the user's rules for their AI were
 * on, and why they did not let the agent sign this document without asking
 * ({enabled, allowed, reasons[{code, text}], summary, matched, rulesUpdatedAt},
 * see cloud/lib/agentRules.js). The approval card, the approval page and the
 * email show the reasons. The server also adds the column on first write; the
 * class stays master-key only.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_SignApproval');
  schema.addObject('RuleCheck');
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
  schema.deleteField('RuleCheck');
  await schema.update();
};
