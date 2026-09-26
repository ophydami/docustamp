/**
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.addString('SenderName');
  docSchema.addString('SenderMail');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.addString('SenderName');
  templateSchema.addString('SenderMail');
  await templateSchema.update();
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.deleteField('SenderName');
  docSchema.deleteField('SenderMail');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.deleteField('SenderName');
  templateSchema.deleteField('SenderMail');
  await templateSchema.update();
};
