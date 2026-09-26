/**
 * Document chaining: "when A completes, automatically send B".
 *
 * `Chain` holds the config ({templateId, recipients?, name?, note?, message?},
 * see cloud/lib/documents.js normaliseChain) on both the document and the
 * template it can be inherited from. `ChainResult` records what happened when
 * the chain fired ({status: sent|failed, documentId?, error?, at}), and
 * `ChainedFrom` is the follow-up document's back-pointer to the completed
 * document that triggered it. The runner is cloud/lib/chain.js.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.addObject('Chain');
  docSchema.addObject('ChainResult');
  docSchema.addPointer('ChainedFrom', 'contracts_Document');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.addObject('Chain');
  await templateSchema.update();
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.deleteField('Chain');
  docSchema.deleteField('ChainResult');
  docSchema.deleteField('ChainedFrom');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.deleteField('Chain');
  await templateSchema.update();
};
