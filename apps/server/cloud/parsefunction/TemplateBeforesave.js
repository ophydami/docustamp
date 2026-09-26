import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../../Utils.js';

const LENGTH_LIMITS = [
  { field: 'Name', max: MAX_NAME_LENGTH },
  { field: 'Note', max: MAX_NOTE_LENGTH },
  { field: 'Description', max: MAX_DESCRIPTION_LENGTH },
];

/** The most reminder mails one template may ever generate. */
const MAX_REMINDERS = 15;

/**
 * Validation for `contracts_Template`.
 *
 * Every check used to sit inside `if (!request.original)`, i.e. inserts only,
 * while the class allows authenticated updates and both clients write nearly
 * every field with a plain PUT after the insert, so the length and reminder
 * limits were bypassed by creating an empty template and then updating it.
 * The checks run on every save now, and each is skipped when the request did not
 * touch the field it is about.
 *
 * The template counter moved to `TemplateAfterSave`: it was incremented here
 * without `await`, so a save rejected afterwards still charged the account.
 */
async function TemplateBeforeSave(request) {
  const object = request.object;
  const isInsert = !request.original;

  for (const { field, max } of LENGTH_LIMITS) {
    if (!isInsert && !object.dirty(field)) continue;
    const value = object.get(field);
    if (typeof value === 'string' && value.length > max) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `The "${field}" field must be at most ${max} characters long.`
      );
    }
  }

  const reminderFields = ['TimeToCompleteDays', 'RemindOnceInEvery', 'AutomaticReminders'];
  if (isInsert || reminderFields.some(field => object.dirty(field))) {
    const TimeToCompleteDays = object.get('TimeToCompleteDays') || 15;
    const RemindOnceInEvery = object.get('RemindOnceInEvery') || 5;
    const AutoReminder = object.get('AutomaticReminders') || false;
    const reminderCount = TimeToCompleteDays / RemindOnceInEvery;
    if (AutoReminder && reminderCount > MAX_REMINDERS) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `only ${MAX_REMINDERS} reminder allowed`);
    }
  }
}
export default TemplateBeforeSave;
