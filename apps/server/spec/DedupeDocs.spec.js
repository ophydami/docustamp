/**
 * The helpers the duplication pass extracted, and the invariants that used to be
 * decided independently in each copy.
 *
 * Every case here is a rule that had drifted between two or more implementations
 * of the same operation: how big a page is, who owns a document, what a copy
 * carries, what a new `contracts_Document` row gets, and what counts toward
 * completion.
 */
import { isDocumentOwner, ownerUserIdOf, participantAcl, signerIdsOf } from '../cloud/lib/acl.js';
import { contactAcl } from '../cloud/lib/contacts.js';
import { documentFields, normaliseSettings, settingsFromDoc } from '../cloud/lib/documents.js';
import {
  isUpright,
  normaliseRotation,
  pageBox,
  pageBoxFromViewport,
} from '../cloud/lib/pageBox.js';
import { mapWithConcurrency } from '../cloud/parsefunction/authGuard.js';
import { resetPlaceholdersForCopy, resetWidgetForCopy } from '../cloud/lib/widgets.js';
import { isCompletionRelevant } from '../utils/workflowUtils.js';

const CALLER = { userId: 'user1', extUserId: 'ext1' };

/** A signed, filled-in widget: everything a copy must leave behind. */
function signedWidget() {
  return {
    key: 11111111,
    type: 'signature',
    xPosition: 10,
    yPosition: 20,
    Width: 150,
    Height: 60,
    signatureType: 'draw',
    SignUrl: 'https://files.example.test/sig.png',
    IsSigned: true,
    options: {
      name: 'signature-abc-1',
      status: 'required',
      response: 'data:image/png;base64,AAAA',
      defaultValue: 'Ada Lovelace',
      isReadOnly: true,
    },
  };
}

function signedGroup() {
  return {
    Id: 42,
    Role: 'Role 1',
    signerObjId: 'contact1',
    signerPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: 'contact1' },
    email: 'ada@example.test',
    SignedUrl: 'https://files.example.test/doc.pdf',
    placeHolder: [{ pageNumber: 1, pos: [signedWidget()] }],
  };
}

describe('dedupe: one formula per rule', () => {
  /* ------------------------------------------------------------- pageBox */

  describe('pageBox', () => {
    it('folds the CropBox origin into the height only while the page is upright', () => {
      // A cropped, upright page: the visible page starts 20pt up, and every
      // renderer lays fields out against a box that starts at the MediaBox top.
      expect(pageBox({ y: 20, width: 612, height: 700, rotation: 0 })).toEqual({
        width: 612,
        height: 720,
        rotation: 0,
      });
      expect(pageBox({ y: 20, width: 612, height: 700, rotation: 180 })).toEqual({
        width: 612,
        height: 720,
        rotation: 180,
      });
    });

    it('swaps the axes and drops the offset on a quarter turn', () => {
      // On 90/270 the CropBox y offset runs along the rendered x axis, so adding
      // it to the height would move fields in the wrong direction.
      expect(pageBox({ y: 20, width: 612, height: 700, rotation: 90 })).toEqual({
        width: 700,
        height: 612,
        rotation: 90,
      });
      expect(pageBox({ y: 20, width: 612, height: 700, rotation: 270 })).toEqual({
        width: 700,
        height: 612,
        rotation: 270,
      });
    });

    it('agrees with the pdf.js reading of the same page', () => {
      // pdf.js hands back a viewport that has already applied the rotation, so
      // only the offset is left to fold in. The two readings have to land on the
      // same box or the server, the editor and the stamping step disagree about
      // where the page ends.
      for (const rotation of [0, 90, 180, 270]) {
        const upright = rotation === 0 || rotation === 180;
        const viewport = upright ? { width: 612, height: 700 } : { width: 700, height: 612 };
        expect(pageBoxFromViewport(viewport, 20, rotation)).toEqual(
          pageBox({ y: 20, width: 612, height: 700, rotation })
        );
      }
    });

    it('normalises a rotation of any sign or size', () => {
      expect(normaliseRotation(-90)).toBe(270);
      expect(normaliseRotation(450)).toBe(90);
      expect(normaliseRotation(undefined)).toBe(0);
      expect(isUpright(-180)).toBeTrue();
      expect(isUpright(-90)).toBeFalse();
    });
  });

  /* --------------------------------------------------------- ownership */

  describe('isDocumentOwner', () => {
    it('accepts either pointer, because different creation paths write different ones', () => {
      expect(isDocumentOwner({ CreatedBy: { objectId: 'u1' } }, 'u1')).toBeTrue();
      expect(isDocumentOwner({ ExtUserPtr: { UserId: { objectId: 'u1' } } }, 'u1')).toBeTrue();
      expect(isDocumentOwner({ CreatedBy: { objectId: 'u2' } }, 'u1')).toBeFalse();
    });

    it('never treats a missing owner or a missing caller as a match', () => {
      // Both used to be `undefined === undefined` in one of the four copies.
      expect(isDocumentOwner({}, '')).toBeFalse();
      expect(isDocumentOwner({}, undefined)).toBeFalse();
      expect(isDocumentOwner({ CreatedBy: {} }, undefined)).toBeFalse();
      expect(ownerUserIdOf({})).toBe('');
    });
  });

  /* ---------------------------------------------------------------- ACL */

  describe('participantAcl', () => {
    it('gives the owner write, every linked signer read, and the public nothing', () => {
      const acl = participantAcl({
        CreatedBy: { objectId: 'owner' },
        Signers: [{ objectId: 'c1', UserId: { objectId: 'signer1' } }],
      }).toJSON();
      expect(acl.owner).toEqual({ read: true, write: true });
      expect(acl.signer1).toEqual({ read: true });
      expect(acl['*']).toBeUndefined();
    });

    it('skips a hole in Signers and a contact with no linked user', () => {
      // Both used to throw inside a log-only catch, so the whole rebuild was
      // skipped and the row silently kept the previous permissions.
      const acl = participantAcl({
        CreatedBy: { objectId: 'owner' },
        Signers: [null, { objectId: 'c1' }, { objectId: 'c2', UserId: { objectId: 'signer2' } }],
      }).toJSON();
      expect(acl.signer2).toEqual({ read: true });
      expect(Object.keys(acl).sort()).toEqual(['owner', 'signer2']);
    });

    it('locks a row that has no owner rather than leaving it open', () => {
      const acl = participantAcl({ Signers: [] }).toJSON();
      expect(acl['*']).toBeUndefined();
    });

    it('detects a changed signer list regardless of pointer shape or order', () => {
      const obj = signers => ({ get: () => signers });
      expect(signerIdsOf(obj([{ id: 'b' }, { objectId: 'a' }]))).toBe('a,b');
      expect(signerIdsOf(obj([{ objectId: 'a' }, { id: 'b' }]))).toBe('a,b');
      expect(signerIdsOf(obj([{ objectId: 'a' }]))).not.toBe('a,b');
      expect(signerIdsOf(obj(undefined))).toBe('');
    });

    it('grants a contact to its owner and to its own shadow user', () => {
      const acl = contactAcl('owner', 'shadow').toJSON();
      expect(acl.owner).toEqual({ read: true, write: true });
      expect(acl.shadow).toEqual({ read: true, write: true });
      expect(acl['*']).toBeUndefined();
      // A row with no owner still must not fall back to public.
      expect(contactAcl('', 'shadow').toJSON()['*']).toBeUndefined();
    });
  });

  /* ------------------------------------------------------ copy and reset */

  describe('resetPlaceholdersForCopy', () => {
    it('leaves nothing of the previous signing run behind', () => {
      const [copy] = resetPlaceholdersForCopy([signedGroup()]);
      const json = JSON.stringify(copy);
      expect(json).not.toContain('SignUrl');
      expect(json).not.toContain('IsSigned');
      expect(json).not.toContain('signatureType');
      expect(json).not.toContain('response');
      expect(copy.SignedUrl).toBeUndefined();
    });

    it('keeps the sender pre-fill unless the copy is meant to start blank', () => {
      const [kept] = resetPlaceholdersForCopy([signedGroup()]);
      expect(kept.placeHolder[0].pos[0].options.defaultValue).toBe('Ada Lovelace');
      const [blank] = resetPlaceholdersForCopy([signedGroup()], { clearDefaults: true });
      expect(blank.placeHolder[0].pos[0].options.defaultValue).toBe('');
    });

    it('draws fresh field keys only when asked, and never repeats one', () => {
      const same = resetPlaceholdersForCopy([signedGroup()]);
      expect(same[0].placeHolder[0].pos[0].key).toBe(11111111);

      const groups = [signedGroup(), { ...signedGroup(), Role: 'Role 2' }];
      const fresh = resetPlaceholdersForCopy(groups, { newKeys: true });
      const keys = fresh.flatMap(g => g.placeHolder.flatMap(p => p.pos.map(w => w.key)));
      expect(keys).not.toContain(11111111);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('unbinds the recipients and drops the prefill for a template', () => {
      const groups = [signedGroup(), { Role: 'prefill', placeHolder: [] }];
      const out = resetPlaceholdersForCopy(groups, { keepPrefill: false, unbind: true });
      expect(out.length).toBe(1);
      expect(out[0].signerObjId).toBe('');
      expect(out[0].signerPtr).toEqual({});
      expect(out[0].email).toBe('');
      expect(out[0].Role).toBe('Role 1');
    });

    it('rewrites the original app`s `text` type only where that was always done', () => {
      // `text` is a real type of its own here (a static label), so rewriting it
      // unconditionally would turn every label on a duplicate into an input box.
      const label = { type: 'text', options: {} };
      expect(resetWidgetForCopy(label).type).toBe('text');
      expect(resetWidgetForCopy(label, { legacyTextType: true }).type).toBe('text input');
    });

    it('never mutates the source', () => {
      const source = signedGroup();
      resetPlaceholdersForCopy([source], { clearDefaults: true, newKeys: true, unbind: true });
      expect(source.signerObjId).toBe('contact1');
      expect(source.placeHolder[0].pos[0].options.response).toBe('data:image/png;base64,AAAA');
      expect(source.placeHolder[0].pos[0].key).toBe(11111111);
    });
  });

  /* ---------------------------------------------------- the single writer */

  describe('documentFields', () => {
    const base = { name: 'Deal', url: 'https://files.example.test/a.pdf' };

    it('takes ownership from the caller and never from the input', () => {
      const f = documentFields(CALLER, {
        ...base,
        settings: normaliseSettings(),
        CreatedBy: { __type: 'Pointer', className: '_User', objectId: 'attacker' },
        ExtUserPtr: { __type: 'Pointer', className: 'contracts_Users', objectId: 'attacker' },
      });
      expect(f.CreatedBy.objectId).toBe('user1');
      expect(f.ExtUserPtr.objectId).toBe('ext1');
    });

    it('never stores strict order without sequential sending', () => {
      // The signer page and the server both refuse a signature on
      // `SendInOrderStrict`, so a stored `true` under a document that is not sent
      // in order blocked every signer for a rule the sender had turned off.
      const f = documentFields(CALLER, {
        ...base,
        settings: normaliseSettings({ sendInOrder: false, strictOrder: true }),
      });
      expect(f.SendinOrder).toBeFalse();
      expect(f.SendInOrderStrict).toBeFalse();

      const on = documentFields(CALLER, {
        ...base,
        settings: normaliseSettings({ sendInOrder: true, strictOrder: true }),
      });
      expect(on.SendInOrderStrict).toBeTrue();
    });

    it('leaves absent columns out entirely rather than writing empties', () => {
      const f = documentFields(CALLER, { ...base, settings: normaliseSettings() });
      for (const column of [
        'Note',
        'Description',
        'RedirectUrl',
        'Bcc',
        'Cc',
        'TemplateId',
        'Folder',
        'PenColors',
        'SignedUrl',
        'DocSentAt',
        'BatchKey',
        'ACL',
      ]) {
        expect(column in f).toBeFalse();
      }
      // A document is a draft until it is sent.
      expect(f.SentToOthers).toBeFalse();
    });

    it('offers the same optional columns to every creation path', () => {
      // `PenColors` was set by two of the five old creation paths and by none of
      // the other three, so the signer UI offered different pen colours
      // depending on which path had made the document.
      const f = documentFields(CALLER, {
        ...base,
        settings: normaliseSettings(),
        penColors: ['#000000'],
        signatureType: [{ name: 'draw', enabled: true }],
        batchKey: 'batch-1',
        acl: { user1: { read: true, write: true } },
      });
      expect(f.PenColors).toEqual(['#000000']);
      expect(f.SignatureType.length).toBe(1);
      expect(f.BatchKey).toBe('batch-1');
      expect(f.ACL).toEqual({ user1: { read: true, write: true } });
    });

    it('caps the free-text columns', () => {
      const f = documentFields(CALLER, {
        ...base,
        name: 'n'.repeat(500),
        note: 'x'.repeat(5000),
        message: { subject: 's'.repeat(2000), body: 'b'.repeat(50000) },
        settings: normaliseSettings(),
      });
      expect(f.Name.length).toBeLessThanOrEqual(250);
      expect(f.RequestSubject.length).toBe(998);
      expect(f.RequestBody.length).toBe(20000);
      expect(f.Note.length).toBeLessThan(5000);
    });

    it('round-trips a stored row through settingsFromDoc unchanged', () => {
      // `settingsFromDoc` is the inverse every partial update goes through, so a
      // change that touches one column must not reset the rest.
      const settings = normaliseSettings({
        expiryDays: 30,
        remindEveryDays: 3,
        sendInOrder: true,
        strictOrder: true,
        otp: true,
        notifyOnSignatures: false,
        allowModifications: true,
        redirectUrl: 'https://example.test/done',
        bcc: [{ name: 'Legal', email: 'Legal@Example.test' }],
      });
      const stored = documentFields(CALLER, { ...base, settings });
      expect(normaliseSettings(settingsFromDoc(stored))).toEqual(settings);
      expect(stored.Bcc).toEqual([{ Name: 'Legal', Email: 'legal@example.test' }]);
    });
  });

  /* -------------------------------------------------------- completion */

  describe('isCompletionRelevant', () => {
    it('ignores a role nobody is bound to', () => {
      // Counting one meant the document could never reach IsCompleted: no
      // certificate, no completion mail, "in progress" forever.
      expect(isCompletionRelevant({ Role: 'Role 1', signerObjId: 'c1' })).toBeTrue();
      expect(isCompletionRelevant({ Role: 'Role 1', signerPtr: { objectId: 'c1' } })).toBeTrue();
      expect(isCompletionRelevant({ Role: 'Role 1' })).toBeFalse();
      expect(isCompletionRelevant({ Role: 'Role 1', signerPtr: {} })).toBeFalse();
      expect(isCompletionRelevant({ Role: 'prefill', signerObjId: 'c1' })).toBeFalse();
    });
  });

  /* ---------------------------------------------------- one concurrency map */

  describe('mapWithConcurrency', () => {
    it('swallows a single failure by default and returns the other results', async () => {
      const out = await mapWithConcurrency([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('nope');
        return n * 10;
      });
      expect(out[0]).toBe(10);
      expect(out[1]).toBeUndefined();
      expect(out[2]).toBe(30);
    });

    it('propagates when the caller asks it to', async () => {
      // The two old copies had opposite contracts, so a maintainer importing
      // "the" helper got whichever their file happened to import.
      await expectAsync(
        mapWithConcurrency([1, 2], 2, async n => {
          if (n === 2) throw new Error('nope');
          return n;
        })
      ).toBeResolved();
      await expectAsync(
        mapWithConcurrency(
          [1, 2],
          2,
          async n => {
            if (n === 2) throw new Error('nope');
            return n;
          },
          { throwOnError: true }
        )
      ).toBeRejected();
    });

    it('runs every item exactly once with a limit larger than the list', async () => {
      const seen = [];
      const out = await mapWithConcurrency([1, 2, 3], 10, async n => {
        seen.push(n);
        return n;
      });
      expect(seen.sort()).toEqual([1, 2, 3]);
      expect(out).toEqual([1, 2, 3]);
      expect(await mapWithConcurrency([], 5, async n => n)).toEqual([]);
    });
  });
});
