// Workflow helpers for placeholder/audit-trail processing. These helpers
// are intentionally agnostic of any role classification: they treat every
// non-prefill placeholder as a participant, and only the 'Signed' activity
// counts toward completion. Builds with role-aware behaviour layer extra
// filtering on top.

// Audit-trail activities that mark a placeholder as having fulfilled its
// completion duty.
export const COMPLETION_ACTIVITIES = ['Signed'];

// A placeholder participates in completion unless it is a prefill entry
// (which only pre-populates field values without acting on the document).
export function isParticipantBasic(placeholder) {
  return placeholder?.Role !== 'prefill';
}

/**
 * Whether a placeholder counts toward document completion.
 *
 * Two things are excluded. 'prefill' is the owner's own boxes, which nobody
 * signs. And a role with no contact behind it has nobody who *could* ever sign
 * it: an unbound placeholder used to be counted, so a document that reached it
 * (a template role a bulk row never bound, a recipient removed from a sent
 * document) could never reach IsCompleted at all. No certificate, no completion
 * mail, "in progress" forever, with nothing in the UI to act on.
 *
 * The comment here used to promise that viewers were filtered out as well, which
 * they are not: no viewer role exists anywhere in the schema or the frontends,
 * and quietly adding one would change when a document is considered complete.
 * Kept as a separate name from `isParticipantBasic` because that is the seam a
 * role-aware build layers viewer/approver filtering onto.
 */
export function isCompletionRelevant(placeholder) {
  if (!isParticipantBasic(placeholder)) return false;
  return Boolean(placeholder?.signerObjId || placeholder?.signerPtr?.objectId);
}

// Locate a placeholder index by signerObjId. Prefill placeholders are
// excluded so caller indices stay aligned with the participant list.
export function findPlaceholderIndex(placeholders, signerObjId) {
  if (!Array.isArray(placeholders) || !signerObjId) return -1;
  return placeholders.findIndex(
    p => (p?.signerObjId || p?.signerPtr?.objectId) === signerObjId && p?.Role !== 'prefill'
  );
}

// Strict-order gating: returns the signerObjId of the prior placeholder
// still pending, or null when the strict-order requirement is satisfied.
export function findPendingPriorSigner(placeholders, idx, auditTrail) {
  if (!Array.isArray(placeholders) || idx <= 0) return null;
  const trail = Array.isArray(auditTrail) ? auditTrail : [];
  for (let i = 0; i < idx; i++) {
    const ph = placeholders[i];
    if (!isCompletionRelevant(ph)) continue;
    const signerObjId = ph?.signerObjId || ph?.signerPtr?.objectId;
    if (!signerObjId) continue;
    const acted = trail.some(
      a => a?.UserPtr?.objectId === signerObjId && COMPLETION_ACTIVITIES.includes(a?.Activity)
    );
    if (!acted) return signerObjId;
  }
  return null;
}
