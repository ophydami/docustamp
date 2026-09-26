import crypto from 'node:crypto';
import { mintSigningToken, signingTokenExpiry, verifySigningToken } from '../cloud/lib/signingToken.js';
import { upsertAuditEntry, completedContactIds } from '../cloud/lib/auditTrail.js';
import {
  OTP_GATE_MESSAGE,
  documentContactIds,
  resolveDocumentActor,
} from '../cloud/parsefunction/authGuard.js';

describe('signing-link tokens', () => {
  it('round-trips a token bound to a document and a contact', () => {
    const token = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() + 60_000 });
    expect(typeof token).toBe('string');
    expect(token).not.toContain('doc1');
    expect(verifySigningToken(token, { docId: 'doc1' })).toEqual(
      jasmine.objectContaining({ contactId: 'c1' })
    );
  });

  it('rejects another document, tampering, garbage and expiry', () => {
    const token = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() + 60_000 });
    expect(verifySigningToken(token, { docId: 'doc2' })).toBeNull();
    expect(verifySigningToken(token.slice(0, -3) + 'abc', { docId: 'doc1' })).toBeNull();
    expect(verifySigningToken('nope', { docId: 'doc1' })).toBeNull();
    expect(verifySigningToken('', { docId: 'doc1' })).toBeNull();
    const expired = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() - 1 });
    expect(verifySigningToken(expired, { docId: 'doc1' })).toBeNull();
  });

  describe('secret rotation', () => {
    const saved = {};
    beforeEach(() => {
      saved.secret = process.env.SIGNING_LINK_SECRET;
      saved.previous = process.env.SIGNING_LINK_PREVIOUS_SECRET;
    });
    afterEach(() => {
      for (const [key, name] of [
        ['secret', 'SIGNING_LINK_SECRET'],
        ['previous', 'SIGNING_LINK_PREVIOUS_SECRET'],
      ]) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
    });

    it('keeps verifying links signed with a previous secret, and only those', () => {
      process.env.SIGNING_LINK_SECRET = 'old-secret';
      const old = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() + 60_000 });

      process.env.SIGNING_LINK_SECRET = 'new-secret';
      delete process.env.SIGNING_LINK_PREVIOUS_SECRET;
      expect(verifySigningToken(old, { docId: 'doc1' })).toBeNull();

      process.env.SIGNING_LINK_PREVIOUS_SECRET = 'unrelated, old-secret';
      expect(verifySigningToken(old, { docId: 'doc1' })).toEqual(
        jasmine.objectContaining({ contactId: 'c1' })
      );
      const fresh = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() + 60_000 });
      expect(fresh).not.toBe(old);
      expect(verifySigningToken(fresh, { docId: 'doc1' })).not.toBeNull();
    });

    it('accepts raw key bytes through the hex: and base64: prefixes', () => {
      const raw = crypto.randomBytes(32);
      process.env.SIGNING_LINK_SECRET = `hex:${raw.toString('hex')}`;
      const token = mintSigningToken({ docId: 'doc1', contactId: 'c1', expiresAt: Date.now() + 60_000 });
      process.env.SIGNING_LINK_SECRET = 'something-else';
      process.env.SIGNING_LINK_PREVIOUS_SECRET = `base64:${raw.toString('base64')}`;
      expect(verifySigningToken(token, { docId: 'doc1' })).not.toBeNull();
    });
  });

  it('derives the expiry from ExpiryDate when it is in the future', () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    const exp = signingTokenExpiry({ ExpiryDate: { iso: future.toISOString() } });
    expect(exp).toBeGreaterThan(future.getTime());
    const fallback = signingTokenExpiry({});
    expect(fallback).toBeGreaterThan(Date.now() + 30 * 86_400_000);
  });
});

describe('audit-trail upsert', () => {
  const signed = { UserPtr: { objectId: 'c1' }, Activity: 'Signed', SignedOn: new Date() };
  it('never downgrades Signed to Viewed', () => {
    const r = upsertAuditEntry([signed], { UserPtr: { objectId: 'c1' }, Activity: 'Viewed' });
    expect(r.auditTrail[0].Activity).toBe('Signed');
    expect(completedContactIds(r.auditTrail).has('c1')).toBeTrue();
  });
  it('upgrades Viewed to Signed and appends new contacts', () => {
    const r = upsertAuditEntry([{ UserPtr: { objectId: 'c1' }, Activity: 'Viewed' }], signed);
    expect(r.auditTrail[0].Activity).toBe('Signed');
    const r2 = upsertAuditEntry(r.auditTrail, { UserPtr: { objectId: 'c2' }, Activity: 'Viewed' });
    expect(r2.auditTrail.length).toBe(2);
    expect(completedContactIds(r2.auditTrail).has('c2')).toBeFalse();
  });
});

describe('resolveDocumentActor', () => {
  const freshDoc = () => ({
    objectId: 'docA',
    // created well after the token cutover so legacy links are not honoured
    createdAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    CreatedBy: { objectId: 'ownerUser' },
    Signers: [
      { objectId: 'c1', Email: 'one@example.com' },
      { objectId: 'c2', Email: 'two@example.com' },
    ],
    Placeholders: [{ signerObjId: 'c1' }, { signerObjId: 'c2' }],
  });

  it('lists every contact of a document', () => {
    expect([...documentContactIds(freshDoc())].sort()).toEqual(['c1', 'c2']);
  });

  it('refuses an anonymous caller with no token', async () => {
    await expectAsync(resolveDocumentActor({ params: {} }, freshDoc(), { contactId: 'c1' })).toBeRejectedWithError(
      /signing link/i
    );
  });

  it('accepts a valid token and binds the actor to that contact only', async () => {
    const doc = freshDoc();
    const token = mintSigningToken({ docId: 'docA', contactId: 'c1', expiresAt: Date.now() + 60_000 });
    const actor = await resolveDocumentActor({ params: { signingToken: token } }, doc, {});
    expect(actor).toEqual(jasmine.objectContaining({ kind: 'signer', contactId: 'c1' }));
    await expectAsync(
      resolveDocumentActor({ params: { signingToken: token } }, doc, { contactId: 'c2' })
    ).toBeRejectedWithError(/only act as yourself/i);
    const other = mintSigningToken({ docId: 'docB', contactId: 'c1', expiresAt: Date.now() + 60_000 });
    await expectAsync(resolveDocumentActor({ params: { signingToken: other } }, doc, {})).toBeRejectedWithError(
      /invalid or has expired/i
    );
  });

  it('asks OTP documents for a session even with a valid token', async () => {
    const doc = { ...freshDoc(), IsEnableOTP: true };
    const token = mintSigningToken({ docId: 'docA', contactId: 'c1', expiresAt: Date.now() + 60_000 });
    await expectAsync(resolveDocumentActor({ params: { signingToken: token } }, doc, {})).toBeRejectedWithError(
      OTP_GATE_MESSAGE
    );
  });

  it('treats the master key as master', async () => {
    const actor = await resolveDocumentActor({ master: true, params: {} }, freshDoc(), { contactId: 'c2' });
    expect(actor.kind).toBe('master');
  });

  it('honours legacy docId+contactId links only for documents older than the cutover', async () => {
    const old = { ...freshDoc(), createdAt: '2020-01-01T00:00:00.000Z' };
    const actor = await resolveDocumentActor({ params: {} }, old, { contactId: 'c2' });
    expect(actor).toEqual(jasmine.objectContaining({ kind: 'signer', contactId: 'c2', legacy: true }));
    await expectAsync(resolveDocumentActor({ params: {} }, old, { contactId: 'nope' })).toBeRejected();
  });
});
