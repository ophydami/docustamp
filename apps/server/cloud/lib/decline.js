/**
 * Declining a document someone else sent the user, from a connected app or an
 * API token (the `decline_document` MCP tool).
 *
 * The decline itself is the web's (`applyDecline` in
 * parsefunction/declinedocument.js): the same conditional write, audit entry,
 * owner email and `declined` webhook. What differs is who may ask. Only the
 * user's own seat is ever declined, found the way agent signing finds it (the
 * contact bound to the account that carries its verified address), and the
 * audit entry records the agent and the person it acted for, as an agent
 * signature does. A document the user sent is withdrawn with void_document,
 * never declined here.
 */
import { applyDecline, loadDeclineTarget } from '../parsefunction/declinedocument.js';
import { agentIdentity, verifiedIdentityProblem } from './agentIdentity.js';
import { findAgentSeat, isOwnDocument } from './agentSign.js';
import { completedContactIds } from './auditTrail.js';
import { normaliseEmail } from './email.js';
import { getParticipantDocument } from './inbox.js';

/** Longest reason accepted; the sender reads it in an email. */
const MAX_REASON = 500;

function fail(message, code = Parse.Error.SCRIPT_FAILED) {
  return new Parse.Error(code, message);
}

/** Why this seat cannot decline any more, or null while it can. */
function closedReason(d, contactId) {
  if (d.IsCompleted === true) {
    return 'This document is already completed, so it can no longer be declined.';
  }
  if (d.IsDeclined === true && d.IsVoided === true) {
    return 'The sender voided this document, so there is nothing to decline.';
  }
  if (d.IsDeclined === true) return 'This document has already been declined.';
  const expiry = Date.parse(d?.ExpiryDate?.iso || d?.ExpiryDate || '');
  if (Number.isFinite(expiry) && expiry < Date.now()) {
    return 'This document has expired, so it can no longer be declined.';
  }
  if (completedContactIds(d.AuditTrail).has(contactId)) {
    return 'You have already signed this document, so it can no longer be declined.';
  }
  return null;
}

/**
 * The audit record of an agent's decline, in the shape an agent signature
 * carries (lib/agentSign.js). `AllowedBy.via` is 'connection': declining needs
 * no separate approval, the connection the user made (an app they connected,
 * or their own API key) is what allowed it.
 */
function agentRecord(caller) {
  const name = String(caller.name || '').trim();
  const email = normaliseEmail(caller.email);
  return {
    Method: 'agent',
    Agent: agentIdentity(caller),
    OnBehalfOf: { name, email, userId: caller.userId },
    AllowedBy: { via: 'connection', name, email, at: new Date(), signingEnabledAt: null },
  };
}

/**
 * Decline the user's own part of a document someone else sent them.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string} documentId
 * @param {{reason?: string}} [opts]
 * @returns {Promise<{status: 'declined', documentId: string, senderNotified: boolean,
 *   document: Object|null}>}
 */
export async function declineForUser(caller, documentId, { reason } = {}) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) {
    throw fail(
      'Say why the user is declining: the sender sees the reason.',
      Parse.Error.VALIDATION_ERROR
    );
  }
  if (why.length > MAX_REASON) {
    throw fail(
      `The reason is too long (at most ${MAX_REASON} characters).`,
      Parse.Error.VALIDATION_ERROR
    );
  }
  const identityProblem = verifiedIdentityProblem(caller);
  if (identityProblem) throw fail(identityProblem, Parse.Error.OPERATION_FORBIDDEN);

  const obj = await loadDeclineTarget(documentId);
  if (!obj) throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
  const d = JSON.parse(JSON.stringify(obj));
  if (isOwnDocument(d, caller)) {
    throw fail(
      'You sent this document; use void_document to cancel it.',
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  const seat = findAgentSeat(d, caller);
  // An unsent document is nobody's business but its owner's, like in list_inbox.
  if (!seat || (!d.SignedUrl && !d.DocSentAt)) {
    throw fail('Document not found.', Parse.Error.OBJECT_NOT_FOUND);
  }
  const closed = closedReason(d, seat.contactId);
  if (closed) throw fail(closed, Parse.Error.OPERATION_FORBIDDEN);

  const { notified } = await applyDecline({
    doc: d,
    contactId: seat.contactId,
    declineByUserId: caller.userId,
    isOwner: false,
    reason: why,
    ipAddress: caller.ip || '',
    publicUrl: caller.publicUrl || '',
    agent: agentRecord(caller),
  });

  let document = null;
  try {
    document = await getParticipantDocument(caller, d.objectId);
  } catch (err) {
    // The decline has landed; the summary is a nicety.
    console.log('decline_document: no summary', err?.message || err);
  }
  return { status: 'declined', documentId: d.objectId, senderNotified: notified, document };
}
