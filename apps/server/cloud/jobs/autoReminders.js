import { fetchReminderDoc, sendReminderForDoc } from '../parsefunction/sendReminder.js';

const DEFAULT_MAX_DOCS = 200;
const DEFAULT_INTERVAL_MINUTES = 60;
// Spread ticks a little so restarts do not line every instance up on the hour.
const MAX_JITTER_MINUTES = 5;
// A deployment that restarts more often than the interval never swept, because
// the first tick was only scheduled a full interval after boot.
const FIRST_TICK_MINUTES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// In-process lock. This build runs as a single container, so a boolean is enough
// to stop a slow run from overlapping the next tick.
let isRunning = false;
let timer = null;

function isEnabled() {
  const flag = process.env.AUTO_REMINDERS;
  return !flag || flag.toLowerCase() !== 'false';
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Advance a reminder date past `now` in whole `everyDays` steps. Looping keeps a
 * document that was missed for several cycles from firing a burst of reminders.
 * @param {Date} from previous NextReminderDate.
 * @param {number} everyDays RemindOnceInEvery.
 * @param {Date} now reference time.
 * @returns {Date} the next reminder date, strictly after `now`.
 */
export function nextReminderDate(from, everyDays, now) {
  const step = positiveInt(everyDays, 5);
  const next = new Date(from.getTime());
  // Bounded so a corrupt date cannot spin forever.
  for (let i = 0; i < 1000 && next <= now; i++) {
    next.setDate(next.getDate() + step);
  }
  return next;
}

function toTime(value) {
  const raw = value?.iso || value;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : NaN;
}

/**
 * Is this document (re-read just now) still worth a reminder?
 *
 * The sweep used to filter once and then mail from that snapshot for the whole
 * run, so a document completed early in a long run was still chased twenty
 * minutes later, and a fresh NextReminderDate was written onto it.
 *
 * @param {Object} json plain (JSON) document, freshly read.
 * @param {Date} now reference time.
 * @returns {string} '' when it is due, otherwise the reason it was skipped.
 */
export function reminderSkipReason(json, now) {
  if (json?.AutomaticReminders !== true) return 'reminders_off';
  if (json?.IsCompleted === true) return 'completed';
  if (json?.IsDeclined === true) return 'declined';
  if (json?.IsArchive === true) return 'archived';
  if (!json?.SignedUrl) return 'not_sent';
  const expiry = toTime(json?.ExpiryDate);
  if (Number.isFinite(expiry) && expiry <= now.getTime()) return 'expired';
  const next = toTime(json?.NextReminderDate);
  if (!Number.isFinite(next)) return 'no_next_date';
  if (next > now.getTime()) return 'not_due';
  // Belt and braces on top of NextReminderDate: nothing used to read
  // LastReminderAt, so a document whose date had been left in the past was
  // mailed again on every tick.
  const last = toTime(json?.LastReminderAt);
  if (Number.isFinite(last)) {
    const everyDays = positiveInt(json?.RemindOnceInEvery, 5);
    if (last + everyDays * DAY_MS > now.getTime()) return 'reminded_recently';
  }
  return '';
}

/**
 * Find and process every document whose automatic reminder is due.
 *
 * The sweep selects ids, then loads and re-checks each document immediately
 * before mailing it, and claims the document by advancing `NextReminderDate`
 * *before* the mails leave. Sending first meant that any later failure (a save
 * conflict, a transient Mongo error) left the date in the past, so the next tick
 * mailed everyone again, every hour, until the document expired.
 *
 * @param {Object} [options] options.
 * @param {number} [options.limit] max documents per run.
 * @param {Date} [options.now] reference time, injectable for tests.
 * @returns {Promise<{scanned: number, reminded: number, mailed: number, stopped: number, skipped: number, failed: number}>} run summary.
 */
export async function runAutoReminders(options = {}) {
  const now = options.now || new Date();
  const limit = options.limit || positiveInt(process.env.AUTO_REMINDERS_MAX_DOCS, DEFAULT_MAX_DOCS);

  const query = new Parse.Query('contracts_Document');
  query.equalTo('AutomaticReminders', true);
  query.exists('NextReminderDate');
  query.lessThanOrEqualTo('NextReminderDate', now);
  query.notEqualTo('IsCompleted', true);
  query.notEqualTo('IsDeclined', true);
  query.notEqualTo('IsArchive', true);
  query.greaterThan('ExpiryDate', now);
  query.exists('SignedUrl');
  query.ascending('NextReminderDate');
  query.limit(limit);
  // Only the ids: the rows carry base64 signature images inside AuditTrail and
  // the run re-reads each document anyway.
  query.select('objectId');

  const dueIds = (await query.find({ useMasterKey: true })).map(doc => doc.id);
  const summary = {
    scanned: dueIds.length,
    reminded: 0,
    mailed: 0,
    stopped: 0,
    skipped: 0,
    failed: 0,
  };

  for (const docId of dueIds) {
    try {
      const doc = await fetchReminderDoc(docId);
      const json = JSON.parse(JSON.stringify(doc));
      const skipReason = reminderSkipReason(json, now);
      if (skipReason) {
        summary.skipped += 1;
        console.log(`autoReminders: skipping doc ${docId} (${skipReason})`);
        continue;
      }

      // Claim first. Written through a bare object so the presigned
      // SignedUrl/URL that the afterFind trigger may have set on `doc` is never
      // persisted.
      const previous = doc.get('NextReminderDate') || now;
      const expiry = doc.get('ExpiryDate');
      const next = nextReminderDate(new Date(previous), doc.get('RemindOnceInEvery'), now);
      const update = new Parse.Object('contracts_Document');
      update.id = docId;
      const stopping = Boolean(expiry && next > new Date(expiry));
      if (stopping) {
        // The document expires before the next reminder would land, so this is
        // the last time we chase it.
        update.unset('NextReminderDate');
      } else {
        update.set('NextReminderDate', next);
      }
      await update.save(null, { useMasterKey: true });
      if (stopping) summary.stopped += 1;

      // The claim above is the cooldown for this send, so the per-document
      // minimum interval `sendreminder` enforces would only double-count here.
      const result = await sendReminderForDoc({ doc, by: 'system', skipCooldown: true });
      if (result.sent.length > 0) {
        summary.reminded += 1;
        summary.mailed += result.sent.length;
      }
    } catch (err) {
      summary.failed += 1;
      console.log(`autoReminders error on doc ${docId}: `, err?.message || err);
    }
  }

  console.log(
    `autoReminders: scanned=${summary.scanned} reminded=${summary.reminded} mailed=${summary.mailed} ` +
      `stopped=${summary.stopped} skipped=${summary.skipped} failed=${summary.failed}`
  );
  return summary;
}

/**
 * Guarded entry point shared by the Parse job and the interval scheduler.
 * @returns {Promise<Object|null>} the run summary, or null when disabled or already running.
 */
export async function runAutoRemindersOnce() {
  if (!isEnabled()) return null;
  if (isRunning) {
    console.log('autoReminders: previous run still in progress, skipping this tick');
    return null;
  }
  isRunning = true;
  try {
    return await runAutoReminders();
  } catch (err) {
    console.log('autoReminders run failed: ', err?.message || err);
    return null;
  } finally {
    isRunning = false;
  }
}

/**
 * Start the hourly (jittered) reminder tick. No-op when AUTO_REMINDERS=false.
 * @returns {void}
 */
export function startAutoReminderScheduler() {
  if (!isEnabled()) {
    console.log('autoReminders: disabled via AUTO_REMINDERS=false');
    return;
  }
  if (timer) return;

  const intervalMinutes = positiveInt(
    process.env.AUTO_REMINDERS_INTERVAL_MINUTES,
    DEFAULT_INTERVAL_MINUTES
  );

  const schedule = delayMs => {
    timer = setTimeout(async () => {
      await runAutoRemindersOnce();
      schedule(
        intervalMinutes * 60 * 1000 + Math.floor(Math.random() * MAX_JITTER_MINUTES * 60000)
      );
    }, delayMs);
    // Never hold the process open just for reminders.
    timer.unref?.();
  };

  // First tick shortly after boot rather than a full interval later: a
  // deployment that restarts more often than the interval never swept at all.
  schedule(FIRST_TICK_MINUTES * 60 * 1000);
  console.log(
    `autoReminders: scheduler started, first sweep in ~${FIRST_TICK_MINUTES}m then every ~${intervalMinutes}m`
  );
}

/**
 * Stop the scheduler. Used by tests and graceful shutdown.
 * @returns {void}
 */
export function stopAutoReminderScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * `autoReminders` Parse job. Lets an operator trigger a sweep on demand through
 * the jobs API instead of waiting for the next tick.
 *
 * It goes through the guarded entry point: calling `runAutoReminders` directly
 * ignored `AUTO_REMINDERS=false` (the documented kill switch) and the in-process
 * lock, so triggering the job while the hourly tick was in flight ran two sweeps
 * over the same due documents.
 *
 * @param {Object} request Parse job request.
 * @returns {Promise<Object>} run summary, or `{skipped: true}` when it did not run.
 */
export default async function autoRemindersJob(request) {
  const summary = await runAutoRemindersOnce();
  if (!summary) {
    const reason = isEnabled() ? 'a sweep is already running' : 'AUTO_REMINDERS=false';
    request?.message?.(`skipped: ${reason}`);
    return { skipped: true, reason };
  }
  request?.message?.(
    `scanned ${summary.scanned}, reminded ${summary.reminded}, mailed ${summary.mailed}`
  );
  return summary;
}
