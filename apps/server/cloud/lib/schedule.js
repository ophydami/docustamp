/**
 * The one place that turns a document's schedule settings into dates.
 *
 * `ExpiryDate` and `NextReminderDate` used to be computed in exactly one spot:
 * the contracts_Document afterSave trigger, on insert only, anchored on
 * `createdAt`. So changing TimeToCompleteDays, RemindOnceInEvery or
 * AutomaticReminders on an existing document changed nothing the server acts on:
 * the expiry stayed where the insert put it, and turning reminders on never
 * produced a `NextReminderDate`, which is the only field the reminder sweep
 * (cloud/jobs/autoReminders.js) queries on, so those reminders never fired.
 *
 * The rules implemented here:
 *  - the schedule is anchored on `DocSentAt` when the document has been sent,
 *    otherwise on `createdAt` (a draft's clock has not started yet, and the
 *    afterSave trigger re-anchors it the moment DocSentAt appears),
 *  - `ExpiryDate` = anchor + TimeToCompleteDays,
 *  - `NextReminderDate` exists only while AutomaticReminders is on: it is the
 *    first anchor + n * RemindOnceInEvery that lies after `now`, so switching
 *    reminders on for an old document schedules the next one instead of firing
 *    a backlog,
 *  - a reminder that would land after the expiry is not scheduled at all, which
 *    is the same rule the sweep applies when it advances the date.
 */

/** What the document classes fall back to when the field is unset. */
export const DEFAULT_EXPIRY_DAYS = 15;
export const DEFAULT_REMINDER_DAYS = 5;

/** Fields that change the schedule, so a save that touches one triggers a recompute. */
export const SCHEDULE_INPUT_FIELDS = Object.freeze([
  'TimeToCompleteDays',
  'RemindOnceInEvery',
  'AutomaticReminders',
  'DocSentAt',
]);

/** Accepts a Date, an iso string or Parse's {__type:'Date'} shape. */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = typeof value === 'string' ? value : value.iso;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInt(value) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function addDays(from, days) {
  const date = new Date(from.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * The moment the document's clock starts: when it was sent, else when it was created.
 * @param {Object} docJson contracts_Document as JSON.
 * @param {Date} now fallback for a document that has neither.
 * @returns {Date} the anchor.
 */
export function scheduleAnchor(docJson, now = new Date()) {
  return toDate(docJson?.DocSentAt) || toDate(docJson?.createdAt) || now;
}

/**
 * Compute the schedule a document's settings ask for.
 *
 * @param {Object} docJson contracts_Document as JSON (DocSentAt, createdAt,
 *   TimeToCompleteDays, AutomaticReminders, RemindOnceInEvery).
 * @param {Object} [options] options.
 * @param {Date} [options.now] reference time, injectable for tests.
 * @param {number|null} [options.defaultExpiryDays] used when TimeToCompleteDays
 *   is unset; pass null to leave ExpiryDate alone in that case.
 * @returns {{ExpiryDate: Date|null, NextReminderDate: Date|null}} null means "clear this field".
 */
export function scheduleFieldsFor(docJson, options = {}) {
  const now = options.now || new Date();
  const defaultExpiryDays =
    options.defaultExpiryDays === undefined ? DEFAULT_EXPIRY_DAYS : options.defaultExpiryDays;
  const anchor = scheduleAnchor(docJson, now);

  const days = positiveInt(docJson?.TimeToCompleteDays) || defaultExpiryDays;
  const ExpiryDate = days ? addDays(anchor, days) : null;

  let NextReminderDate = null;
  if (docJson?.AutomaticReminders === true) {
    const every = positiveInt(docJson?.RemindOnceInEvery) || DEFAULT_REMINDER_DAYS;
    let next = addDays(anchor, every);
    // Bounded so a corrupt anchor cannot spin forever.
    for (let i = 0; i < 1000 && next <= now; i++) next = addDays(next, every);
    if (next > now && (!ExpiryDate || next <= ExpiryDate)) NextReminderDate = next;
  }
  return { ExpiryDate, NextReminderDate };
}
