import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../../Utils.js';

const LENGTH_LIMITS = [
  { field: 'Name', max: MAX_NAME_LENGTH },
  { field: 'Note', max: MAX_NOTE_LENGTH },
  { field: 'Description', max: MAX_DESCRIPTION_LENGTH },
];

/** The most reminder mails one document may ever generate. */
const MAX_REMINDERS = 15;

/**
 * Validation for `contracts_Document`.
 *
 * Every check used to sit inside `if (!request.original)`, i.e. inserts only,
 * while the class allows authenticated updates and the SPA, the MCP tools and
 * the REST draft tools write nearly every field with a plain PUT after the
 * insert. Creating an empty document and then PUTting a 300KB `Name` with
 * `TimeToCompleteDays: 365`, `RemindOnceInEvery: 1` and `AutomaticReminders`
 * bypassed both limits and signed the recipient up for a daily mail for a year.
 *
 * The checks run on every save now, and each one is skipped when the request did
 * not touch the field it is about, so an update that changes something else is
 * never rejected because of a value it did not write.
 */
async function DocumentBeforesave(request) {
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

  try {
    // Below code is used to update document when user sent document or self signed.
    // The quota increment that used to live here moved to `DocumentAftersave`:
    // it was unawaited, so a save that was rejected afterwards still charged the
    // account, and the counter is what the quota display and the reports read.
    const oldDocument = request.original;
    if (oldDocument && !oldDocument?.get('SignedUrl') && object?.get('SignedUrl')) {
      if (object?.get('Signers') && object.get('Signers').length > 0) {
        object.set('DocSentAt', new Date());
      }
    }
  } catch (err) {
    console.log('err in document beforesave', err.message);
  }
}
export default DocumentBeforesave;
