import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../../Utils.js';
import { setTemplateCount } from '../../utils/CountUtils.js';
import { extUserPointer, userPointer } from './context.js';
import {
  assertSettingsInput,
  groupFieldsByRecipient,
  normaliseChain,
  normaliseSettings,
  templateJson,
} from './documents.js';
import { assertStoredFileUrl } from './files.js';
import { PREFILL_ROLE, buildPlaceholders } from './widgets.js';
import saveAsTemplate from '../parsefunction/saveAsTemplate.js';

/**
 * The write half of templates. `list_templates` and `create_document_from_template`
 * existed; the only way to mint a template was the web app.
 *
 *  - `createTemplate`: a template from a PDF, a list of roles and fields (same
 *    field shape as create_document, `recipient` = role index / role label /
 *    "prefill"), settings and message. Roles have no email: they bind when a
 *    document is created from the template.
 *  - `saveDocumentAsTemplate`: the web app's "Save as template" (the
 *    `saveastemplate` cloud function) for any owned document: layout, roles,
 *    settings and message are copied, recipients and answers are dropped.
 */

const MAX_ROLES = 25;

function text(value, max) {
  const t = String(value ?? '').trim();
  return t ? t.slice(0, max) : '';
}

function normaliseRoles(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'At least one role is required.');
  }
  if (list.length > MAX_ROLES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `At most ${MAX_ROLES} roles.`);
  }
  const seen = new Set();
  return list.map((r, i) => {
    const role = text(typeof r === 'string' ? r : r?.role || r?.name, 60) || `Role ${i + 1}`;
    const key = role.toLowerCase();
    if (seen.has(key)) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Duplicate role "${role}".`);
    }
    seen.add(key);
    // `email: ''` so the recipient lookup in groupFieldsByRecipient matches by
    // role label or index only.
    return { role, name: role, email: '' };
  });
}

/**
 * @param {import('./context.js').Caller} caller
 * @param {Object} input name, url | fileBase64 (resolved by the caller), roles, fields, settings, message, note, description
 */
export async function createTemplate(caller, input = {}) {
  const name = text(input.name, MAX_NAME_LENGTH) || 'Untitled template';
  const url = await assertStoredFileUrl(input.url, caller, { fileName: input.fileName });
  const roles = normaliseRoles(input.roles);
  assertSettingsInput(input.settings);
  const settings = normaliseSettings(input.settings);
  const grouped = groupFieldsByRecipient(input.fields || [], roles);
  const roleSpecs = roles.map((r, i) => ({ role: r.role, name: '', email: '', fields: grouped.perRecipient[i] }));
  if (grouped.prefill.length) roleSpecs.push({ role: PREFILL_ROLE, isPrefill: true, fields: grouped.prefill });
  const placeholders = buildPlaceholders(roleSpecs);

  const t = new Parse.Object('contracts_Template');
  t.set('Name', name);
  t.set('URL', url);
  t.set('ExtUserPtr', extUserPointer(caller));
  t.set('CreatedBy', userPointer(caller));
  if (input.note) t.set('Note', text(input.note, MAX_NOTE_LENGTH));
  if (input.description) t.set('Description', text(input.description, MAX_DESCRIPTION_LENGTH));
  t.set('Placeholders', placeholders);
  t.set('Signers', []);
  t.set('SendinOrder', settings.sendInOrder);
  t.set('SendInOrderStrict', settings.strictOrder);
  t.set('IsEnableOTP', settings.otp);
  t.set('NotifyOnSignatures', settings.notifyOnSignatures);
  t.set('AllowModifications', settings.allowModifications);
  t.set('AutomaticReminders', settings.remindEveryDays > 0);
  t.set('RemindOnceInEvery', settings.remindEveryDays || 5);
  t.set('TimeToCompleteDays', settings.expiryDays);
  if (settings.redirectUrl) t.set('RedirectUrl', settings.redirectUrl);
  if (settings.bcc.length) t.set('Bcc', settings.bcc);
  if (settings.cc.length) t.set('Cc', settings.cc);
  if (input.message?.subject) t.set('RequestSubject', text(input.message.subject, 998));
  if (input.message?.body) t.set('RequestBody', text(input.message.body, 20000));
  // Documents created from this template inherit the chain (an explicit
  // chain on the create call still wins).
  const chain = input.chain !== undefined ? await normaliseChain(caller, input.chain) : null;
  if (chain) t.set('Chain', chain);
  t.set('IsTourEnabled', false);
  t.set('CreatedVia', text(input.origin, 40) || 'mcp');
  const saved = await t.save(null, { useMasterKey: true });
  setTemplateCount(caller.extUserId);
  return { ...templateJson(JSON.parse(JSON.stringify(saved))), fieldCount: placeholders.reduce((n, g) => n + (g.placeHolder || []).reduce((m, p) => m + (p.pos || []).length, 0), 0), created: true };
}

/**
 * Save an owned document as a template (the web app's action), optionally
 * under another name.
 */
export async function saveDocumentAsTemplate(caller, docId, { name } = {}) {
  const saved = await saveAsTemplate({
    params: { docId: String(docId || '') },
    user: caller.user,
    headers: {},
  });
  const id = saved?.id || saved?.objectId;
  if (!id) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'The template could not be saved.');
  const rename = text(name, MAX_NAME_LENGTH);
  if (rename) {
    const t = new Parse.Object('contracts_Template');
    t.id = id;
    t.set('Name', rename);
    await t.save(null, { useMasterKey: true });
  }
  const fresh = await new Parse.Query('contracts_Template').get(id, { useMasterKey: true });
  const json = JSON.parse(JSON.stringify(fresh));
  return { ...templateJson(json), sourceDocumentId: String(docId), created: true };
}

/** Soft-delete an owned template (IsArchive), the web app's delete. */
export async function deleteTemplate(caller, templateId) {
  const row = await new Parse.Query('contracts_Template')
    .get(String(templateId || ''), { useMasterKey: true })
    .catch(() => null);
  const owner = row?.get('CreatedBy')?.id;
  const extOwner = row?.get('ExtUserPtr')?.id;
  if (!row || (owner !== caller.userId && extOwner !== caller.extUserId)) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found.');
  }
  if (row.get('IsArchive') === true) {
    return { objectId: row.id, name: row.get('Name') || '', deleted: true, alreadyDeleted: true };
  }
  row.set('IsArchive', true);
  await row.save(null, { useMasterKey: true });
  return { objectId: row.id, name: row.get('Name') || '', deleted: true };
}
