import { MAX_WRITE_ATTEMPTS, readFresh, updateWithVersion } from '../lib/atomic.js';
import { emitInBackground } from '../lib/webhooks.js';
import { upsertAuditEntry } from '../lib/auditTrail.js';
import { bumpOpenStats, recordOpen } from '../lib/documentOpens.js';
import { signingTokenFromRequest } from '../lib/signingToken.js';
import { resolveDocumentActor } from './authGuard.js';

/**
 * `triggerevent` writes into a document's `AuditTrail`, and used to do it for
 * anyone who could name a docId and a contactId: a stranger could mark any
 * signer as having viewed a document, and because the write rebuilt the slot
 * with `Activity: 'Viewed'` it also erased that signer's `Signed` record.
 *
 * Now the caller must resolve to the owner or to the signer whose slot is being
 * written (`resolveDocumentActor`), `ipAddress` is read from the request rather
 * than from the parameters, and the write goes through `upsertAuditEntry`, which
 * never downgrades a completed slot.
 *
 * Every open is also counted (lib/documentOpens.js): `OpenStats` on the row is
 * bumped in the same conditional write as the audit entry, and one
 * `contracts_DocumentOpen` row is logged afterwards. The audit slot itself still
 * only says *that* the signer opened the document.
 */
export default async function triggerEvent(request) {
  const event = request.params?.event;
  const body = request.params?.body || {};
  const docId = body.objectId;
  const claimedContactId = request.params?.contactId;

  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'missing parameter body.objectId.');
  }

  const docQuery = new Parse.Query('contracts_Document');
  docQuery.include('ExtUserPtr');
  docQuery.include('Signers');
  const docRes = await docQuery.get(docId, { useMasterKey: true }).catch(() => null);
  if (!docRes) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
  }

  // Throws when the caller is neither the owner nor the signer they claim to be.
  const actor = await resolveDocumentActor(request, docRes, {
    contactId: claimedContactId,
    signingToken: signingTokenFromRequest(request),
  });

  if (event !== 'viewed') {
    return { message: 'event called!' };
  }

  const contactId =
    actor.kind === 'owner' || actor.kind === 'master' ? claimedContactId : actor.contactId;
  if (!contactId) {
    return { message: 'event called!' };
  }

  const openedAt = new Date();
  // Never trust a client-supplied address for an audit record.
  const ipAddress = request.headers?.['x-real-ip'] || '';
  const entry = {
    UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId },
    Activity: 'Viewed',
    ipAddress,
    ViewedOn: openedAt.toISOString(),
  };

  // `AuditTrail` is an array that has to be read, merged and written back whole,
  // and both writers (this and signPdf) used to do that from a snapshot with no
  // concurrency control: one signer opening the document while another submitted
  // a signature dropped whichever write landed first, and because completion is
  // derived by counting entries, a dropped entry meant the document silently
  // never completed.
  //
  // The write is conditional on `updatedAt`, so a losing write is not applied,
  // and instead of giving up (which is what dropped the entry) the entry is
  // merged into the row as it now stands and tried again. The re-read goes
  // through `readFresh`, never a Parse query: a query would run the afterFind
  // trigger, which swaps in presigned urls that must never be persisted.
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    // `updatedAt` is part of the projection on purpose: it is the version the
    // conditional write is keyed on, and a projected read that leaves it out
    // comes back without it.
    const fresh = await readFresh('contracts_Document', docRes.id, [
      'AuditTrail',
      'SignedUrl',
      'OpenStats',
      'updatedAt',
    ]);
    if (!fresh) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
    const { auditTrail: updated, changed } = upsertAuditEntry(
      Array.isArray(fresh.AuditTrail) ? fresh.AuditTrail : [],
      { ...entry, SignedUrl: fresh?.SignedUrl || '' }
    );
    // The audit slot may have nothing to gain (they have signed, so "viewed"
    // must not downgrade it), but the open itself is always counted.
    const openStats = bumpOpenStats(fresh.OpenStats, contactId, openedAt);
    const stored = await updateWithVersion('contracts_Document', docRes.id, fresh.updatedAt, {
      ...(changed ? { AuditTrail: updated } : {}),
      OpenStats: openStats,
    });
    if (stored) {
      const json = typeof docRes.toJSON === 'function' ? docRes.toJSON() : docRes;
      await recordOpen({
        doc: json,
        contactId,
        ip: ipAddress,
        userAgent: request.headers?.['user-agent'] || '',
        at: openedAt,
      });
      if (changed) {
        const contact = (json?.Signers || []).find(x => x?.objectId === contactId);
        emitInBackground(
          'viewed',
          { ...json, AuditTrail: updated, OpenStats: openStats },
          {
            signer: {
              name: contact?.Name || '',
              email: (contact?.Email || '').toLowerCase(),
              contactId,
              opens: openStats[contactId]?.count || 1,
            },
          }
        );
      }
      return { message: 'event called!' };
    }
  }

  // Every attempt lost the race. Real failures are reported rather than answered
  // with the success shape, which is what made a missing "Viewed" entry on the
  // certificate impossible to notice.
  throw new Parse.Error(
    Parse.Error.OTHER_CAUSE,
    'This document is being updated by someone else. Please try again.'
  );
}
