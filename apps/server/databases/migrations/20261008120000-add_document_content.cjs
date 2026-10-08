/**
 * Written documents (docs/TEXT_DOCUMENTS.md).
 *
 * `Content` holds the document a user typed in the app (headings, paragraphs,
 * lists, the page size) that the draft's PDF was rendered from. It stays on
 * the row so the text can be edited and re-rendered until the document is
 * sent; the title lives in `Name` as it always has.
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const schema = new Parse.Schema('contracts_Document');
  schema.addObject('Content');
  await schema.update();
};

/**
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('contracts_Document');
  schema.deleteField('Content');
  await schema.update();
};
