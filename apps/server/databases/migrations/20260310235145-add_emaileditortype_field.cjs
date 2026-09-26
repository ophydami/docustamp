/**
 *
 * @param {Parse} Parse
 */
exports.up = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.addObject('EmailEditorType');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.addObject('EmailEditorType');
  await templateSchema.update();

  const tenantSchema = new Parse.Schema('partners_Tenant');
  tenantSchema.addObject('EmailEditorType');
  await tenantSchema.update();
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const docSchema = new Parse.Schema('contracts_Document');
  docSchema.deleteField('EmailEditorType');
  await docSchema.update();

  const templateSchema = new Parse.Schema('contracts_Template');
  templateSchema.deleteField('EmailEditorType');
  await templateSchema.update();

  const tenantSchema = new Parse.Schema('partners_Tenant');
  tenantSchema.deleteField('EmailEditorType');
  await tenantSchema.update();
};
