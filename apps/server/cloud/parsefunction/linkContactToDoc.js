import { MAX_WRITE_ATTEMPTS, readFresh, updateWithVersion } from '../lib/atomic.js';
import { ensureContact } from '../lib/contacts.js';
import { signingTokenFromRequest } from '../lib/signingToken.js';
import { normaliseEmail, resolveDocumentActor } from './authGuard.js';

/**
 * `linkcontacttodoc` binds an unbound placeholder to a real contact.
 *
 * It used to run with no authentication at all: anyone who knew a docId could
 * name any email, and the function created a `_User` whose password was that
 * email, added it to the document ACL with write access, and answered with the
 * new contactId, which was then enough to sign. Now the caller must resolve to
 * the document owner or to a participant binding their own address, the shadow
 * user is created by `ensureContact` (random password), and the document ACL
 * only grants that user read.
 */

/** The email the resolved signer is allowed to bind. */
async function actorEmail(actor) {
  if (actor.user) {
    return normaliseEmail(actor.user.get?.('email') || actor.user.get?.('username'));
  }
  if (!actor.contactId) return '';
  const contact = await new Parse.Query('contracts_Contactbook')
    .get(actor.contactId, { useMasterKey: true })
    .catch(() => null);
  return normaliseEmail(contact?.get('Email'));
}

export default async function linkContactToDoc(req) {
  const email = normaliseEmail(req.params?.email);
  const docId = req.params?.docId;
  const name = req.params?.name;
  const phone = req.params?.phone;
  const jobTitle = req.params?.jobTitle;
  const company = req.params?.company;

  if (!docId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
  }
  if (!email) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Please provide an email.');
  }

  try {
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.include('ExtUserPtr');
    docQuery.include('ExtUserPtr.TenantId');
    docQuery.include('Signers');
    docQuery.include('Placeholders.signerPtr');
    const docRes = await docQuery.get(docId, { useMasterKey: true }).catch(() => null);
    if (!docRes) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }

    const _docRes = JSON.parse(JSON.stringify(docRes));
    const Placeholders = _docRes?.Placeholders || [];
    const index = Placeholders.findIndex(x => normaliseEmail(x?.email) === email);
    if (index === -1) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'unauthorized');
    }

    const actor = await resolveDocumentActor(req, docRes, {
      contactId: req.params?.contactId,
      signingToken: signingTokenFromRequest(req),
      ownerMayActForContact: true,
    });
    if (actor.kind === 'signer') {
      // A guest may only claim the placeholder that carries their own address.
      const mine = await actorEmail(actor);
      if (!mine || mine !== email) {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          'You can only sign as yourself on this document.'
        );
      }
    }

    // Already bound: nothing to do, and the answer is the same either way.
    const alreadyBound = Placeholders[index]?.signerObjId;
    if (alreadyBound) {
      return { contactId: alreadyBound };
    }

    // The contact belongs to the document owner's address book, exactly as it
    // did before, but is created through the shared helper.
    const ownerCaller = {
      userId: _docRes?.CreatedBy?.objectId || _docRes?.ExtUserPtr?.UserId?.objectId || '',
      extUserId: _docRes?.ExtUserPtr?.objectId || '',
      tenantId: _docRes?.ExtUserPtr?.TenantId?.objectId || '',
    };
    if (!ownerCaller.userId) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document owner not found.');
    }
    const contact = await ensureContact(ownerCaller, { name, email, phone, jobTitle, company });

    const contactObj = await new Parse.Query('contracts_Contactbook').get(contact.objectId, {
      useMasterKey: true,
    });
    const contactUserId = contactObj.get('UserId')?.id || '';

    // `Signers` and `Placeholders` are parallel arrays kept in sync by index, and
    // this function rewrites both of them whole. Building them from the snapshot
    // read at the top meant two recipients binding themselves at the same moment
    // erased each other: the second write carried the first one's placeholder
    // back to unbound. So re-read, re-check and write under an optimistic lock on
    // `updatedAt`, retrying when someone else got in between.
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const fresh = await readFresh('contracts_Document', docId);
      if (!fresh) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
      }
      const placeholders = Array.isArray(fresh.Placeholders) ? [...fresh.Placeholders] : [];
      const slot = placeholders.findIndex(x => normaliseEmail(x?.email) === email);
      if (slot === -1) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'unauthorized');
      }
      const bound = placeholders[slot]?.signerObjId || placeholders[slot]?.signerPtr?.objectId;
      if (bound) {
        // Someone bound this placeholder while we were creating the contact.
        // The answer is the contact that is actually on the document.
        return { contactId: bound };
      }

      const signers = Array.isArray(fresh.Signers) ? [...fresh.Signers] : [];
      signers.splice(slot, 0, {
        __type: 'Pointer',
        className: 'contracts_Contactbook',
        objectId: contact.objectId,
      });
      placeholders[slot] = {
        ...placeholders[slot],
        signerObjId: contact.objectId,
        signerPtr: {
          __type: 'Pointer',
          className: 'contracts_Contactbook',
          objectId: contact.objectId,
        },
      };

      const fields = {
        Signers: signers.map(s => ({
          __type: 'Pointer',
          className: 'contracts_Contactbook',
          objectId: s?.objectId,
        })),
        Placeholders: placeholders,
      };
      if (contactUserId && fresh.ACL) {
        // Read only: signing goes through cloud functions, not a direct write.
        // Only ever extended, never replaced: an ACL built from scratch here
        // would drop the owner's own grant.
        const acl = new Parse.ACL(fresh.ACL);
        acl.setReadAccess(contactUserId, true);
        fields.ACL = acl.toJSON();
      }
      if (await updateWithVersion('contracts_Document', docId, fresh.updatedAt, fields)) {
        return { contactId: contact.objectId };
      }
    }
    throw new Parse.Error(
      Parse.Error.OTHER_CAUSE,
      'This document is being updated by someone else. Please try again.'
    );
  } catch (err) {
    console.log('err in linkcontacttodoc', err);
    throw err;
  }
}
