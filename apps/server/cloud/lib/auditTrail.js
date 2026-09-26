/**
 * One place that knows how the per-signer AuditTrail slot may change.
 *
 * `AuditTrail` on contracts_Document holds at most one entry per contact
 * (`UserPtr`), and every downstream rule keys off that entry's `Activity`:
 * completion counting in signPdf, strict-order gating, reminders, the status the
 * API and the inbox report. Until now triggerEvent's "viewed" blindly rewrote the
 * slot to `Viewed`, un-signing anyone who reopened their link. This helper makes
 * the rule explicit: an entry may move forward (Viewed -> Signed/Approved/...) but
 * never back.
 */

/** Activities that mean "this signer is done"; never downgrade away from these. */
export const COMPLETION_ACTIVITIES = Object.freeze(['Signed', 'Approved', 'Declined']);

/** Rank so that a later activity never overwrites an earlier-ranked "done" state. */
const RANK = { Created: 0, Viewed: 1, Signed: 2, Approved: 2, Declined: 2 };

export function isCompletionActivity(activity) {
  return COMPLETION_ACTIVITIES.includes(activity);
}

function rankOf(activity) {
  return RANK[activity] ?? 1;
}

/**
 * Upsert the audit entry for one contact.
 *
 * @param {Array} auditTrail current array (not mutated)
 * @param {Object} entry new entry, must carry `UserPtr` (pointer to contracts_Contactbook) and `Activity`
 * @param {{allowDowngrade?: boolean}} [opts] set allowDowngrade only for explicit administrative resets
 * @returns {{auditTrail: Array, changed: boolean, previous: Object|null}}
 */
export function upsertAuditEntry(auditTrail, entry, opts = {}) {
  const list = Array.isArray(auditTrail) ? [...auditTrail] : [];
  const contactId = entry?.UserPtr?.objectId;
  if (!contactId) return { auditTrail: list, changed: false, previous: null };
  const index = list.findIndex(x => x?.UserPtr?.objectId === contactId);
  if (index === -1) {
    list.push(entry);
    return { auditTrail: list, changed: true, previous: null };
  }
  const previous = list[index];
  const downgrade = rankOf(entry.Activity) < rankOf(previous?.Activity);
  if (downgrade && !opts.allowDowngrade) {
    // Keep the stronger record; only refresh incidental fields that carry no state.
    const refreshed = { ...previous };
    let changed = false;
    if (entry.SignedUrl && !previous.SignedUrl) {
      refreshed.SignedUrl = entry.SignedUrl;
      changed = true;
    }
    // `{...previous}` is always a new object, so comparing identity would report
    // a change even when the downgrade was blocked and nothing was refreshed.
    list[index] = changed ? refreshed : previous;
    return { auditTrail: list, changed, previous };
  }
  list[index] = { ...previous, ...entry };
  return { auditTrail: list, changed: true, previous };
}

/** contactIds whose entry is a completion activity. */
export function completedContactIds(auditTrail) {
  const ids = new Set();
  for (const e of auditTrail || []) {
    if (isCompletionActivity(e?.Activity) && e?.UserPtr?.objectId) ids.add(e.UserPtr.objectId);
  }
  return ids;
}
