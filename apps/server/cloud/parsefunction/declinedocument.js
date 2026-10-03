import { appName, escapeHtml } from '../../Utils.js';
import { renderMail, strong } from '../lib/mailShell.js';
import {
  MAX_WRITE_ATTEMPTS,
  readFresh,
  tryMarkDeclined,
  updateWithVersion,
} from '../lib/atomic.js';
import { agentLabel } from '../lib/agentIdentity.js';
import { upsertAuditEntry } from '../lib/auditTrail.js';
import { signingTokenFromRequest } from '../lib/signingToken.js';
import { resolveDocumentActor } from './authGuard.js';
import sendSystemMail from './sendSystemMail.js';
import { emitInBackground } from '../lib/webhooks.js';

/**
 * Declining used to be fully unauthenticated: `declinedoc` took a docId, a
 * reason and a `userId`, and wrote `IsDeclined` plus a `DeclineBy` pointer
 * straight from those parameters. Anyone who learned a docId could kill a
 * document and pin it on any `_User` they liked.
 *
 * Now `resolveDocumentActor` decides who is calling (owner, signed-in signer or
 * signing-link token), and `DeclineBy` is derived from that actor. The `userId`
 * parameter survives only as a hint and is ignored when it disagrees.
 *
 * The decline itself (`applyDecline`) is shared with lib/decline.js, where an AI
 * agent declines its own user's part: both go through the same conditional
 * write, audit entry, owner email and `declined` webhook.
 */

function findSigner(doc, { contactId, userId }) {
  const placeholders = (doc?.Placeholders || []).filter(x => x?.Role !== 'prefill');
  if (contactId) {
    const byContact = placeholders.find(
      x => x?.signerObjId === contactId || x?.signerPtr?.objectId === contactId
    );
    if (byContact) return byContact;
  }
  if (userId) {
    return placeholders.find(x => x?.signerPtr?.UserId?.objectId === userId);
  }
  return undefined;
}

/**
 * Record the decline in `AuditTrail`, the array the Certificate of Completion
 * and the document history are rendered from.
 *
 * A decline used to leave `IsDeclined`, `DeclineReason` and `DeclineBy` and
 * nothing else: no actor timestamp, no IP, no entry beside the "Viewed" and
 * "Signed" ones, and no decline time at all beyond `updatedAt`, which the next
 * save moves. The entry is keyed on the contact, like every other activity.
 *
 * Written after the decline itself and under an optimistic lock, so a "Viewed"
 * entry landing at the same moment is merged rather than overwritten.
 *
 * An agent's decline (lib/decline.js) also passes `agent`, the same
 * `{Method, Agent, OnBehalfOf, AllowedBy}` record an agent signature carries,
 * so the trail says which app declined and for whom.
 *
 * @returns {Promise<boolean>} false when the entry could not be stored.
 */
async function recordDeclineAudit(docId, contactId, ipAddress, agent) {
  if (!contactId) return false;
  const declinedOn = new Date().toISOString();
  const agentFields = agent
    ? {
        Method: 'agent',
        Agent: agent.Agent,
        OnBehalfOf: agent.OnBehalfOf,
        AllowedBy: agent.AllowedBy,
      }
    : {};
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    // `updatedAt` is part of the projection on purpose: it is the version the
    // conditional write is keyed on, and a projected read that leaves it out
    // comes back without it.
    const fresh = await readFresh('contracts_Document', docId, [
      'AuditTrail',
      'SignedUrl',
      'updatedAt',
    ]);
    if (!fresh) return false;
    const { auditTrail, changed } = upsertAuditEntry(
      Array.isArray(fresh.AuditTrail) ? fresh.AuditTrail : [],
      {
        UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId },
        SignedUrl: fresh?.SignedUrl || '',
        Activity: 'Declined',
        ipAddress: ipAddress || '',
        DeclinedOn: declinedOn,
        ...agentFields,
      }
    );
    if (!changed) return true;
    const stored = await updateWithVersion('contracts_Document', docId, fresh.updatedAt, {
      AuditTrail: auditTrail,
    });
    if (stored) return true;
  }
  console.error(`declinedoc: could not record the decline of ${docId} in the audit trail`);
  return false;
}

/**
 * The line that tells the owner an agent declined, or '' for a person. An API
 * key does not say which program holds it, so only an app is named.
 */
function agentLine(agent) {
  if (!agent) return '';
  const app = agent.Agent || {};
  const label = app.kind === 'api_token' && !app.host ? '' : agentLabel(app);
  return `Declined on their behalf by their AI agent${label ? `, ${escapeHtml(label)}` : ''}.`;
}

/** @returns {Promise<boolean>} whether the owner was actually told. */
async function sendDeclineMail(doc, publicUrl, actorIds, reason, agent) {
  try {
    const TenantAppName = appName;

    const signUser = findSigner(doc, actorIds);
    const sender = doc.ExtUserPtr;
    const pdfName = doc.Name;
    // Optional chained: an `ExtUserPtr` that the include did not resolve (the
    // `contracts_Users` row was deleted) used to throw here, and the catch-all
    // swallowed it, so the owner was never told and nothing recorded why.
    const creatorName = sender?.Name || '';
    const creatorEmail = sender?.Email || '';
    if (!creatorEmail) {
      console.error(`declinedoc: document ${doc.objectId} has no owner address to notify`);
      return false;
    }
    const signerName = signUser?.signerPtr?.Name || '';
    const signerEmail = signUser?.signerPtr?.Email || signUser?.email || '';
    const viewDocUrl = `${publicUrl}/recipientSignPdf/${doc.objectId}`;
    const subject = `Document "${pdfName}" has been declined by ${signerName}`;
    const byAgent = agentLine(agent);
    const body = renderMail({
      title: `Declined by ${signerName || signerEmail}`,
      preheader: `${pdfName} was declined by ${signerName || signerEmail}`,
      greeting: creatorName ? `Hi ${creatorName},` : '',
      paragraphs: [
        `${strong(pdfName)} was declined by ${strong(signerName || signerEmail)}` +
          (signerName && signerEmail ? ` (${escapeHtml(signerEmail)})` : '') +
          ` on ${escapeHtml(new Date().toLocaleDateString())}.`,
        ...(byAgent ? [byAgent] : []),
        `${strong('Reason:')} ${escapeHtml(reason || 'Not specified')}`,
      ],
      cta: { url: viewDocUrl, label: 'View document' },
    });

    const params = {
      extUserId: sender?.objectId,
      from: TenantAppName,
      recipient: creatorEmail,
      subject: subject,
      pdfName: pdfName,
      html: body,
    };
    // The result was never inspected, so a `{status: 'error'}` reply counted as
    // a delivered notification.
    const res = await sendSystemMail({ params });
    if (res?.status === 'success') return true;
    console.error(
      `declinedoc: the decline notification for ${doc.objectId} was not sent`,
      res?.message || res?.status || 'no result'
    );
    return false;
  } catch (err) {
    console.error('declinedoc: could not send the decline notification', err?.message || err);
    return false;
  }
}

/** The `_User` behind a contact, when the contact has one. */
async function userIdForContact(doc, contactId) {
  if (!contactId) return '';
  const fromDoc = (doc?.Signers || []).find(s => s?.objectId === contactId);
  if (fromDoc?.UserId?.objectId) return fromDoc.UserId.objectId;
  const fromPlaceholder = (doc?.Placeholders || []).find(
    p => p?.signerPtr?.objectId === contactId && p?.signerPtr?.UserId?.objectId
  );
  if (fromPlaceholder) return fromPlaceholder.signerPtr.UserId.objectId;
  const contact = await new Parse.Query('contracts_Contactbook')
    .get(contactId, { useMasterKey: true })
    .catch(() => null);
  return contact?.get('UserId')?.id || '';
}

/**
 * The document a decline is about, with everything the decline reads (the
 * owner for the email, the signers for the seat). Archived documents are not
 * found.
 *
 * @param {string} docId
 * @returns {Promise<Parse.Object|undefined>}
 */
export async function loadDeclineTarget(docId) {
  const docCls = new Parse.Query('contracts_Document');
  docCls.include('ExtUserPtr');
  docCls.include('ExtUserPtr.TenantId');
  docCls.include('Placeholders.signerPtr');
  docCls.include('Signers');
  docCls.notEqualTo('IsArchive', true);
  docCls.equalTo('objectId', String(docId || ''));
  return await docCls.first({ useMasterKey: true });
}

/**
 * Decline a document once the caller has been resolved: the person on the web
 * (`declinedocument` below) or an AI agent for its own user (lib/decline.js).
 *
 * @param {Object} opts
 * @param {Object} opts.doc document JSON as `loadDeclineTarget` reads it.
 * @param {string} [opts.contactId] the seat that declines ('' for the owner).
 * @param {string} [opts.declineByUserId] the `_User` on the record.
 * @param {boolean} [opts.isOwner] the sender withdrawing: no email to themselves.
 * @param {string} [opts.reason]
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.publicUrl] origin of the link in the owner email.
 * @param {Object} [opts.agent] `{Method, Agent, OnBehalfOf, AllowedBy}` when an
 *   agent declines for its user: recorded on the audit entry and named in the
 *   owner email.
 * @returns {Promise<{declined: true, notified: boolean, recorded: boolean}>}
 */
export async function applyDecline({
  doc,
  contactId = '',
  declineByUserId = '',
  isOwner = false,
  reason = '',
  ipAddress = '',
  publicUrl = '',
  agent,
}) {
  if (doc.IsDeclined === true) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document has already been declined.');
  }
  if (doc.IsCompleted === true) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Document is already completed.');
  }

  // Write the fields directly, never the queried object: that carries the
  // presigned urls the afterFind trigger swapped in, and saving it would
  // persist those. The write is conditional (`IsDeclined != true` and
  // `IsCompleted != true`), so a decline that races the last signature either
  // wins outright or loses outright: the document can never end up declined
  // *and* completed, and two declines cannot both mail the owner.
  const fields = { DeclineReason: reason };
  if (declineByUserId) {
    fields.DeclineBy = { __type: 'Pointer', className: '_User', objectId: declineByUserId };
  }
  if (contactId) {
    fields.DeclineByContact = {
      __type: 'Pointer',
      className: 'contracts_Contactbook',
      objectId: contactId,
    };
  }
  const declined = await tryMarkDeclined(doc.objectId, fields);
  if (!declined) {
    const latest = await readFresh('contracts_Document', doc.objectId, [
      'IsDeclined',
      'IsCompleted',
    ]);
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      latest?.IsCompleted === true
        ? 'Document was completed while you were declining it, so it can no longer be declined.'
        : 'Document has already been declined.'
    );
  }

  // The decline itself has already committed, so nothing here may undo it: a
  // missing audit entry is worth reporting, not worth failing the decline for.
  const recorded = await recordDeclineAudit(doc.objectId, contactId, ipAddress, agent).catch(
    err => {
      console.error('declinedoc: could not write the decline audit entry', err?.message || err);
      return false;
    }
  );

  // Awaited and inspected. It used to be fire-and-forget behind a catch-all,
  // so a failed notification left no trace anywhere except one log line and
  // the owner discovered the decline by opening the document.
  {
    const who = findSigner(doc, { contactId, userId: declineByUserId });
    emitInBackground(
      'declined',
      { ...doc, IsDeclined: true, DeclineReason: reason },
      {
        reason,
        signer: isOwner
          ? { kind: 'sender' }
          : {
              name: who?.signerPtr?.Name || '',
              email: (who?.signerPtr?.Email || who?.email || '').toLowerCase(),
              contactId: contactId || undefined,
            },
      }
    );
  }
  let notified = false;
  if (!isOwner) {
    notified = await sendDeclineMail(
      doc,
      publicUrl,
      { contactId, userId: declineByUserId },
      reason,
      agent
    );
  }
  return { declined: true, notified, recorded };
}

export default async function declinedocument(request) {
  const docId = request.params?.docId;
  const reason = request.params?.reason || '';
  const hintedUserId = request.params?.userId;
  const publicUrl = request.headers?.public_url;
  if (!docId) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'missing parameter docId.');
  }
  try {
    const updateDoc = await loadDeclineTarget(docId);
    if (!updateDoc) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }

    const _doc = JSON.parse(JSON.stringify(updateDoc));
    const actor = await resolveDocumentActor(request, updateDoc, {
      contactId: request.params?.contactId,
      signingToken: signingTokenFromRequest(request),
      ownerMayActForContact: true,
    });

    // Who is on the record: the resolved actor, never the `userId` parameter,
    // except for a master-key call, which is server-side by definition.
    let declineByUserId = '';
    if (actor.user?.id) {
      declineByUserId = actor.user.id;
    } else if (actor.kind === 'master') {
      declineByUserId = typeof hintedUserId === 'string' ? hintedUserId : '';
    } else {
      declineByUserId = await userIdForContact(_doc, actor.contactId);
    }

    const { notified, recorded } = await applyDecline({
      doc: _doc,
      contactId: actor.contactId || '',
      declineByUserId,
      isOwner: actor.kind === 'owner',
      reason,
      ipAddress: request.headers?.['x-real-ip'] || '',
      publicUrl,
    });
    return { declined: true, notified, recorded, message: 'document declined' };
  } catch (err) {
    console.log('err while decling doc', err);
    throw err;
  }
}
