/**
 * Coverage for the data-integrity fixes:
 *
 *  - cloud/lib/atomic.js: conditional (compare-and-set) writes, and the
 *    decline/complete pair that must never both win,
 *  - cloud/parsefunction/linkContactToDoc.js: two recipients binding themselves
 *    at the same moment must both end up on the document,
 *  - cloud/parsefunction/DocumentAftersave.js: a master-key created document
 *    with no signers still gets an owner ACL, and a settings change reschedules
 *    ExpiryDate / NextReminderDate on an existing document,
 *  - cloud/parsefunction/reportsJson.js: the reports carry the status fields the
 *    inbox needs to tell a declined document from a waiting one.
 */
import {
  conditionalUpdate,
  readFresh,
  tryMarkCompleted,
  tryMarkDeclined,
  updateWithVersion,
} from '../cloud/lib/atomic.js';
import { scheduleFieldsFor } from '../cloud/lib/schedule.js';
import reportJson from '../cloud/parsefunction/reportsJson.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const DOC_CLASS = 'contracts_Document';

// Every account this suite creates carries this marker so `afterAll` can remove
// them again: a `Parse.Query(Parse.User)` elsewhere returns the first 100 users,
// and a suite that leaves accounts behind pushes other suites past that page.
const SPEC_MARKER = 'intspec';

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${SPEC_MARKER}-${Date.now()}${seq}`.toLowerCase();
}

async function makeUser(prefix) {
  const email = `${unique(prefix)}@example.test`;
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  return await Parse.User.logIn(email, 'pa55word!');
}

async function makeTenant(user) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  return await tenant.save(null, { useMasterKey: true });
}

async function makeExtUser(user, tenant) {
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', user.get('email'));
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_User');
  return await extUser.save(null, { useMasterKey: true });
}

/** A sent document; `placeholders` may be unbound (no signerObjId) on purpose. */
async function makeDocument({ owner, extUser, placeholders = [], signers = [], extra = {} }) {
  const doc = new Parse.Object(DOC_CLASS);
  doc.set('Name', 'Integrity agreement');
  doc.set('URL', 'http://localhost:30001/files/source.pdf');
  doc.set('SignedUrl', 'http://localhost:30001/files/sent.pdf');
  doc.set('DocSentAt', new Date());
  doc.set('CreatedBy', owner.toPointer());
  doc.set('ExtUserPtr', extUser.toPointer());
  if (placeholders.length) doc.set('Placeholders', placeholders);
  if (signers.length) doc.set('Signers', signers);
  Object.entries(extra).forEach(([key, value]) => doc.set(key, value));
  await doc.save(null, { useMasterKey: true });
  return doc;
}

/** Reload without the afterFind url signing getting in the way of the fields we read. */
async function reload(docId) {
  return await new Parse.Query(DOC_CLASS).get(docId, { useMasterKey: true });
}

function asUser(user) {
  return { sessionToken: user.getSessionToken() };
}

describe('document integrity', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner, extUser, tenant;

  beforeAll(async () => {
    owner = await makeUser('integrityowner');
    tenant = await makeTenant(owner);
    extUser = await makeExtUser(owner, tenant);
  }, 60000);

  afterAll(async () => {
    const stale = await new Parse.Query(Parse.User)
      .contains('username', SPEC_MARKER)
      .limit(500)
      .find({ useMasterKey: true });
    if (stale.length) await Parse.Object.destroyAll(stale, { useMasterKey: true });
  }, 60000);

  describe('conditional writes', () => {
    it('writes when the row still matches and reports a miss when it does not', async () => {
      const doc = await makeDocument({ owner, extUser });

      const hit = await conditionalUpdate(
        DOC_CLASS,
        doc.id,
        { IsCompleted: { $ne: true } },
        { Note: 'first' }
      );
      expect(hit).toBe(true);
      expect((await reload(doc.id)).get('Note')).toBe('first');

      const miss = await conditionalUpdate(
        DOC_CLASS,
        doc.id,
        { Note: 'something else' },
        { Note: 'second' }
      );
      expect(miss).toBe(false);
      expect((await reload(doc.id)).get('Note')).toBe('first');
    });

    it('refuses a write built on a stale version', async () => {
      const doc = await makeDocument({ owner, extUser });
      const before = await readFresh(DOC_CLASS, doc.id);

      expect(await updateWithVersion(DOC_CLASS, doc.id, before.updatedAt, { Note: 'a' })).toBe(
        true
      );
      // The same snapshot a second time: someone else has written since.
      expect(await updateWithVersion(DOC_CLASS, doc.id, before.updatedAt, { Note: 'b' })).toBe(
        false
      );
      expect((await reload(doc.id)).get('Note')).toBe('a');
    });
  });

  describe('decline and completion are mutually exclusive', () => {
    it('refuses to decline a document that has completed', async () => {
      const doc = await makeDocument({ owner, extUser });
      expect(await tryMarkCompleted(doc.id)).toBe(true);

      let error;
      try {
        await Parse.Cloud.run('declinedoc', { docId: doc.id, reason: 'no' }, asUser(owner));
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.message).toContain('completed');

      const after = await reload(doc.id);
      expect(after.get('IsDeclined')).toBeUndefined();
      expect(after.get('IsCompleted')).toBe(true);
    });

    it('refuses to complete a document that has been declined', async () => {
      const doc = await makeDocument({ owner, extUser });
      await Parse.Cloud.run('declinedoc', { docId: doc.id, reason: 'not for me' }, asUser(owner));

      const declined = await reload(doc.id);
      expect(declined.get('IsDeclined')).toBe(true);
      expect(declined.get('DeclineReason')).toBe('not for me');

      // This is the write signPdf makes for the final signature.
      expect(await tryMarkCompleted(doc.id, { SignedUrl: 'http://example.test/x.pdf' })).toBe(
        false
      );
      const after = await reload(doc.id);
      expect(after.get('IsCompleted')).toBeUndefined();
      expect(after.get('SignedUrl')).not.toBe('http://example.test/x.pdf');
    });

    it('lets only one of two simultaneous declines through', async () => {
      const doc = await makeDocument({ owner, extUser });
      const [first, second] = await Promise.all([
        tryMarkDeclined(doc.id, { DeclineReason: 'one' }),
        tryMarkDeclined(doc.id, { DeclineReason: 'two' }),
      ]);
      expect([first, second].filter(Boolean).length).toBe(1);
      expect((await reload(doc.id)).get('IsDeclined')).toBe(true);
    });
  });

  describe('linkcontacttodoc', () => {
    it('keeps both bindings when two recipients link themselves at once', async () => {
      const first = `${unique('linkone')}@example.test`;
      const second = `${unique('linktwo')}@example.test`;
      const doc = await makeDocument({
        owner,
        extUser,
        placeholders: [
          { Id: 1, Role: 'Role 1', email: first, placeHolder: [{ pageNumber: 1, pos: [] }] },
          { Id: 2, Role: 'Role 2', email: second, placeHolder: [{ pageNumber: 1, pos: [] }] },
        ],
      });

      const [one, two] = await Promise.all([
        Parse.Cloud.run(
          'linkcontacttodoc',
          { docId: doc.id, email: first, name: 'One' },
          asUser(owner)
        ),
        Parse.Cloud.run(
          'linkcontacttodoc',
          { docId: doc.id, email: second, name: 'Two' },
          asUser(owner)
        ),
      ]);
      expect(one.contactId).toBeTruthy();
      expect(two.contactId).toBeTruthy();
      expect(one.contactId).not.toBe(two.contactId);

      const after = await reload(doc.id);
      const placeholders = after.get('Placeholders');
      expect(placeholders[0].signerObjId).toBe(one.contactId);
      expect(placeholders[1].signerObjId).toBe(two.contactId);
      const signerIds = (after.get('Signers') || []).map(s => s.id || s.objectId).sort();
      expect(signerIds).toEqual([one.contactId, two.contactId].sort());
    });

    it('hands back the existing contact when the placeholder is already bound', async () => {
      const email = `${unique('linkagain')}@example.test`;
      const doc = await makeDocument({
        owner,
        extUser,
        placeholders: [{ Id: 1, Role: 'Role 1', email, placeHolder: [{ pageNumber: 1, pos: [] }] }],
      });
      const first = await Parse.Cloud.run(
        'linkcontacttodoc',
        { docId: doc.id, email, name: 'Again' },
        asUser(owner)
      );
      const second = await Parse.Cloud.run(
        'linkcontacttodoc',
        { docId: doc.id, email, name: 'Again' },
        asUser(owner)
      );
      expect(second.contactId).toBe(first.contactId);
      const after = await reload(doc.id);
      expect(after.get('Signers').length).toBe(1);

      // The binding extends the ACL rather than replacing it: the owner keeps
      // write, the new signer only gets read.
      const contact = await new Parse.Query('contracts_Contactbook').get(first.contactId, {
        useMasterKey: true,
      });
      const contactUserId = contact.get('UserId')?.id;
      expect(contactUserId).toBeTruthy();
      const acl = after.getACL();
      expect(acl.getReadAccess(contactUserId)).toBe(true);
      expect(acl.getWriteAccess(contactUserId)).toBe(false);
      expect(acl.getWriteAccess(owner.id)).toBe(true);
    });
  });

  describe('afterSave', () => {
    it('gives a master-key created signerless document an owner ACL', async () => {
      const doc = await makeDocument({ owner, extUser });
      const acl = (await reload(doc.id)).getACL();

      expect(acl).toBeDefined();
      expect(acl.getPublicReadAccess()).toBe(false);
      expect(acl.getPublicWriteAccess()).toBe(false);
      expect(acl.getReadAccess(owner.id)).toBe(true);
      expect(acl.getWriteAccess(owner.id)).toBe(true);
    });

    it('schedules a reminder when reminders are switched on, and clears it when off', async () => {
      const doc = await makeDocument({ owner, extUser });
      expect((await reload(doc.id)).get('NextReminderDate')).toBeUndefined();

      const on = new Parse.Object(DOC_CLASS);
      on.id = doc.id;
      on.set('AutomaticReminders', true);
      on.set('RemindOnceInEvery', 3);
      await on.save(null, { useMasterKey: true });

      const scheduled = (await reload(doc.id)).get('NextReminderDate');
      expect(scheduled).toBeDefined();
      expect(scheduled.getTime()).toBeGreaterThan(Date.now());
      expect(scheduled.getTime()).toBeLessThan(Date.now() + 4 * 24 * 60 * 60 * 1000);

      const off = new Parse.Object(DOC_CLASS);
      off.id = doc.id;
      off.set('AutomaticReminders', false);
      await off.save(null, { useMasterKey: true });
      expect((await reload(doc.id)).get('NextReminderDate')).toBeUndefined();
    });

    it('moves ExpiryDate when the completion window changes', async () => {
      const doc = await makeDocument({ owner, extUser });
      const update = new Parse.Object(DOC_CLASS);
      update.id = doc.id;
      update.set('TimeToCompleteDays', 40);
      await update.save(null, { useMasterKey: true });

      const expiry = (await reload(doc.id)).get('ExpiryDate');
      const expected = new Date();
      expected.setDate(expected.getDate() + 40);
      expect(Math.abs(expiry.getTime() - expected.getTime())).toBeLessThan(5 * 60 * 1000);
    });

    it('leaves an explicitly written schedule alone', async () => {
      const doc = await makeDocument({ owner, extUser });
      const chosen = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const update = new Parse.Object(DOC_CLASS);
      update.id = doc.id;
      update.set('TimeToCompleteDays', 40);
      update.set('ExpiryDate', chosen);
      await update.save(null, { useMasterKey: true });

      expect((await reload(doc.id)).get('ExpiryDate').getTime()).toBe(chosen.getTime());
    });
  });

  describe('schedule helper', () => {
    it('anchors on DocSentAt and skips a reminder that would land after the expiry', () => {
      const sentAt = new Date('2026-01-01T00:00:00.000Z');
      const now = new Date('2026-01-02T00:00:00.000Z');
      const { ExpiryDate, NextReminderDate } = scheduleFieldsFor(
        {
          DocSentAt: sentAt,
          createdAt: new Date('2025-12-01T00:00:00.000Z'),
          TimeToCompleteDays: 4,
          AutomaticReminders: true,
          RemindOnceInEvery: 10,
        },
        { now }
      );
      expect(ExpiryDate.toISOString()).toBe('2026-01-05T00:00:00.000Z');
      expect(NextReminderDate).toBe(null);
    });

    it('schedules the next step in the future for a document that was sent long ago', () => {
      const now = new Date('2026-01-20T00:00:00.000Z');
      const { NextReminderDate } = scheduleFieldsFor(
        {
          DocSentAt: new Date('2026-01-01T00:00:00.000Z'),
          TimeToCompleteDays: 60,
          AutomaticReminders: true,
          RemindOnceInEvery: 5,
        },
        { now }
      );
      expect(NextReminderDate.toISOString()).toBe('2026-01-21T00:00:00.000Z');
    });
  });

  describe('report keys', () => {
    it('asks for the status fields the inbox reads', () => {
      for (const reportId of ['1MwEuxLEkF', 'kQUoW4hUXz', 'UPr2Fm5WY3', '5Go51Q7T8r']) {
        const keys = reportJson(reportId, 'someUserId').keys;
        for (const field of [
          'IsDeclined',
          'IsCompleted',
          'DeclineReason',
          'DocSentAt',
          'LastReminderAt',
          'SendinOrder',
        ]) {
          expect(keys).toContain(field);
        }
      }
    });
  });
});
