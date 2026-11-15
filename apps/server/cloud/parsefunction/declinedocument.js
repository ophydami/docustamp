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
import { pendingRequestRecipients, resolveRecipient } from '../lib/requestMail.js';
import { signingTokenFromRequest } from '../lib/signingToken.js';
import { COMPLETION_ACTIVITIES, isParticipantBasic } from '../../utils/workflowUtils.js';
import { extUserForUser, resolveDocumentActor } from './authGuard.js';
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
 *
 * A void (the owner, or an admin of their workspace, withdrawing the document)
 * also tells everyone who was asked to sign. It used to tell nobody, while the
 * dialog in front of it promised that everyone on the document is emailed: a
 * signer who had not opened their link yet simply found it dead.
 *
 * An admin of the owner's workspace may void a teammate's document, and only
 * when the call says so (`asAdmin: true`). The flag is what tells that apart
 * from the same person declining their own part as a signer, which the signing
 * page does with the same function and no contact id. The admin goes on the
 * record as `DeclineBy`, and the owner is emailed who voided it and why.
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

/**
 * What the owner is told when an admin of their workspace voided the document:
 * who did it, and that it can no longer be signed.
 */
function adminVoidMail({ pdfName, creatorName, admin, reason, viewDocUrl }) {
  const who = admin.name || admin.email || 'A workspace admin';
  return {
    subject: `Document "${pdfName}" was voided by ${who}`,
    html: renderMail({
      title: `Voided by ${who}`,
      preheader: `${pdfName} was voided by ${who}`,
      greeting: creatorName ? `Hi ${creatorName},` : '',
      paragraphs: [
        `${strong(pdfName)} was voided by ${strong(who)}` +
          (admin.name && admin.email ? ` (${escapeHtml(admin.email)})` : '') +
          `, an admin of your workspace, on ${escapeHtml(new Date().toLocaleDateString())}.`,
        'It can no longer be signed.',
        `${strong('Reason:')} ${escapeHtml(reason || 'Not specified')}`,
      ],
      cta: { url: viewDocUrl, label: 'View document' },
    }),
  };
}

/** @returns {Promise<boolean>} whether the owner was actually told. */
async function sendDeclineMail(doc, publicUrl, actorIds, reason, agent, admin) {
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
    const voided = admin
      ? adminVoidMail({
          pdfName,
          creatorName,
          admin,
          reason,
          viewDocUrl: `${publicUrl}/documents/${doc.objectId}`,
        })
      : null;
    const subject = voided?.subject || `Document "${pdfName}" has been declined by ${signerName}`;
    const byAgent = agentLine(agent);
    const body =
      voided?.html ||
      renderMail({
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
 * @param {{name: string, email: string}} [opts.admin] set when an admin of the
 *   owner's workspace voids the document: named in the owner email and in the
 *   `declined` webhook. `declineByUserId` is then the admin's account.
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
  admin,
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
          : admin
            ? { kind: 'admin', name: admin.name, email: admin.email.toLowerCase() }
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
      agent,
      admin
    );
  }
  return { declined: true, notified, recorded };
}

/**
 * Everyone a void has to tell: the people who have signed, and the people the
 * document is waiting on now. On a document signed in order that leaves out
 * whoever comes later, because they were never asked and have nothing to stop
 * waiting for.
 *
 * @param {Object} doc document JSON as `loadDeclineTarget` reads it.
 * @returns {Array<{email: string, name: string, signerObjId: string}>}
 */
export function voidNoticeRecipients(doc) {
  const signedIds = new Set(
    (doc?.AuditTrail || [])
      .filter(entry => COMPLETION_ACTIVITIES.includes(entry?.Activity))
      .map(entry => entry?.UserPtr?.objectId)
      .filter(Boolean)
  );
  const signed = (doc?.Placeholders || [])
    .filter(isParticipantBasic)
    .map(group => resolveRecipient(group, doc?.Signers))
    .filter(r => r.email && r.signerObjId && signedIds.has(r.signerObjId));
  const seen = new Set();
  return [...signed, ...pendingRequestRecipients(doc)].filter(r => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
}

/** The mail a signer gets when the document they were sent has been voided. */
function withdrawnMailHtml({ docName, senderName, senderEmail, admin, reason }) {
  const sender = senderName || senderEmail;
  const who = admin ? admin.name || admin.email : '';
  const lead = who
    ? `${strong(who)} has withdrawn ${strong(docName)}, which ` +
      (sender ? `${escapeHtml(sender)} sent` : 'was sent') +
      ' to you for signature.'
    : `${strong(sender || 'The sender')} has withdrawn ${strong(docName)}, which was sent to you for signature.`;
  return renderMail({
    title: 'Signature request withdrawn',
    preheader: `${docName} has been withdrawn and can no longer be signed`,
    paragraphs: [
      lead,
      'It will not be completed. No further action is needed, and the signing link no longer works.',
      reason ? `${strong('Reason:')} ${escapeHtml(reason)}` : '',
    ],
    sender: { senderName, senderMail: senderEmail },
  });
}

/**
 * Tell the signers a document was voided. Never throws: the void has already
 * committed, so a mail that fails is reported, not allowed to undo anything.
 *
 * @param {Object} doc document JSON as `loadDeclineTarget` reads it.
 * @param {{reason?: string, admin?: {name: string, email: string}}} opts `admin`
 *   when an admin of the owner's workspace voided it, so the mail says who.
 * @returns {Promise<{notified: string[], failed: string[]}>} addresses.
 */
async function notifySignersOfVoid(doc, { reason = '', admin } = {}) {
  const senderName = doc?.SenderName || doc?.ExtUserPtr?.Name || '';
  const senderEmail = doc?.SenderMail || doc?.ExtUserPtr?.Email || '';
  const html = withdrawnMailHtml({ docName: doc?.Name, senderName, senderEmail, admin, reason });
  const notified = [];
  const failed = [];
  await Promise.all(
    voidNoticeRecipients(doc).map(async recipient => {
      try {
        const res = await sendSystemMail({
          params: {
            extUserId: doc?.ExtUserPtr?.objectId,
            recipient: recipient.email,
            subject: `Signature request withdrawn: "${doc?.Name}"`,
            html,
            replyto: senderEmail,
          },
        });
        if (res?.status === 'success') {
          notified.push(recipient.email);
          return;
        }
        console.error(
          `declinedoc: ${recipient.email} was not told that ${doc?.objectId} was voided`,
          res?.message || res?.status || 'no result'
        );
      } catch (err) {
        console.error(
          `declinedoc: could not tell ${recipient.email} that ${doc?.objectId} was voided`,
          err?.message || err
        );
      }
      failed.push(recipient.email);
    })
  );
  return { notified, failed };
}

/** The name and address an admin goes by in their workspace, for the owner's email. */
async function adminIdentity(user) {
  const profile = await extUserForUser(user, { activeOnly: true });
  return {
    name: profile?.get('Name') || user?.get?.('name') || '',
    email: profile?.get('Email') || user?.get?.('email') || user?.get?.('username') || '',
  };
}

export default async function declinedocument(request) {
  const docId = request.params?.docId;
  const reason = request.params?.reason || '';
  // Only the documents page sends this, for a teammate's document. Without it
  // an admin who is also one of the signers declines their own part, as before.
  const asAdmin = request.params?.asAdmin === true;
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
      allowWorkspaceAdmin: asAdmin,
    });

    // An admin voids what a teammate has sent. A draft has nobody waiting on
    // it, so there is nothing to void and it stays its owner's to finish.
    if (actor.kind === 'admin' && !_doc.SignedUrl) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        'Only a document that has been sent can be voided.'
      );
    }

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

    const admin = actor.kind === 'admin' ? await adminIdentity(actor.user) : undefined;
    const { notified, recorded } = await applyDecline({
      doc: _doc,
      contactId: actor.contactId || '',
      declineByUserId,
      isOwner: actor.kind === 'owner',
      admin,
      reason,
      ipAddress: request.headers?.['x-real-ip'] || '',
      publicUrl,
    });

    // The owner or an admin withdrew it, as opposed to a signer declining their
    // part: everyone who was asked to sign is told it is off.
    const voided = (actor.kind === 'owner' || actor.kind === 'admin') && !actor.contactId;
    const signers = voided
      ? await notifySignersOfVoid(_doc, { reason, admin })
      : { notified: [], failed: [] };
    return {
      declined: true,
      notified,
      recorded,
      signersNotified: signers.notified,
      signersFailed: signers.failed,
      message: 'document declined',
    };
  } catch (err) {
    console.log('err while decling doc', err);
    throw err;
  }
}
