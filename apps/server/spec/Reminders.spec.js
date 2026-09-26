import { runAutoReminders } from '../cloud/jobs/autoReminders.js';
import {
  buildSigningUrl,
  selectReminderRecipients,
  setReminderMailTransport,
} from '../cloud/parsefunction/sendReminder.js';

// `presignedlocalUrl` (reached through the contracts_Document afterFind trigger)
// signs local file URLs with MASTER_KEY, which the spec runner does not set.
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
process.env.PUBLIC_URL = 'https://sign.example.test';

const SENT_URL = 'http://localhost:30001/files/sent.pdf';

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
}

async function makeUser(prefix) {
  const email = `${unique(prefix)}@example.test`;
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  // signUp does not hand back a session token under this spec setup, so log in
  // explicitly to get one the cloud-function calls can present.
  return await Parse.User.logIn(email, 'pa55word!');
}

async function makeTenant(user) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  return await tenant.save(null, { useMasterKey: true });
}

async function makeExtUser(user, tenant, role) {
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', user.get('email'));
  extUser.set('Company', 'Acme Inc');
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', role || 'contracts_User');
  return await extUser.save(null, { useMasterKey: true });
}

async function makeContact(name, tenant) {
  const email = `${unique(name)}@example.test`;
  const shadow = new Parse.User();
  shadow.set('username', email);
  shadow.set('password', email);
  shadow.set('email', email);
  await shadow.signUp();

  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', name);
  contact.set('Email', email);
  contact.set('UserId', shadow.toPointer());
  contact.set('TenantId', tenant.toPointer());
  contact.set('UserRole', 'contracts_Guest');
  return await contact.save(null, { useMasterKey: true });
}

/**
 * Build a sent, in-progress document with the given contacts as signers.
 * @param {Object} options document options.
 * @returns {Promise<Parse.Object>} the saved document.
 */
async function makeDocument({ owner, extUser, contacts, extra = {} }) {
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', 'Master Services Agreement');
  doc.set('Note', 'Please review');
  doc.set('URL', 'http://localhost:30001/files/source.pdf');
  doc.set('SignedUrl', SENT_URL);
  doc.set('DocSentAt', new Date());
  doc.set('SentToOthers', true);
  doc.set('CreatedBy', owner.toPointer());
  doc.set('ExtUserPtr', extUser.toPointer());
  doc.set(
    'Signers',
    contacts.map(c => c.toPointer())
  );
  doc.set(
    'Placeholders',
    contacts.map((c, idx) => ({
      Id: 10000000 + idx,
      Role: `Role ${idx + 1}`,
      blockColor: '#93a3db',
      signerObjId: c.id,
      signerPtr: c.toPointer(),
      email: c.get('Email'),
      placeHolder: [{ pageNumber: 1, pos: [] }],
    }))
  );
  await doc.save(null, { useMasterKey: true });

  // The afterSave trigger recomputes ExpiryDate and NextReminderDate on insert,
  // so fixture values have to land in a follow-up update where it does not run.
  if (Object.keys(extra).length > 0) {
    const update = new Parse.Object('contracts_Document');
    update.id = doc.id;
    Object.entries(extra).forEach(([key, value]) => update.set(key, value));
    await update.save(null, { useMasterKey: true });
    await doc.fetch({ useMasterKey: true });
  }
  return doc;
}

/**
 * Cloud-run options that authenticate as the given user. Passing the session
 * token explicitly avoids depending on the shared currentUser, which the contact
 * fixtures churn as they sign up shadow users.
 * @param {Parse.User} user the caller.
 * @returns {{sessionToken: string}} run options.
 */
function asUser(user) {
  return { sessionToken: user.getSessionToken() };
}

async function reload(docId) {
  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', docId);
  // `first()` on a 1-result query still trips afterFind, so exclude nothing and
  // read the fields directly.
  const results = await query.find({ useMasterKey: true });
  return results[0];
}

describe('reminders', () => {
  Parse.User.enableUnsafeCurrentUser();

  let mailbox;

  beforeEach(() => {
    mailbox = [];
    setReminderMailTransport(async params => {
      mailbox.push(params);
      return { status: 'success' };
    });
  });

  afterEach(() => {
    setReminderMailTransport(null);
  });

  describe('unit helpers', () => {
    it('encodes the guest signing link as origin/login/base64(docId/email/contactId)', () => {
      const url = buildSigningUrl('https://sign.example.test', 'doc123', 'a@b.test', 'contact9');
      expect(url.startsWith('https://sign.example.test/login/')).toBe(true);
      const encoded = url.split('/login/')[1];
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('doc123/a@b.test/contact9');
    });

    it('falls back to a two segment link when the signer has no contact id', () => {
      const url = buildSigningUrl('https://sign.example.test', 'doc123', 'a@b.test', '');
      const encoded = url.split('/login/')[1];
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('doc123/a@b.test');
    });

    it('skips prefill placeholders and signers who already signed', () => {
      const { pending, skipped } = selectReminderRecipients({
        Placeholders: [
          { Role: 'prefill', email: 'owner@example.test' },
          { Role: 'Role 1', signerObjId: 'c1', email: 'one@example.test' },
          { Role: 'Role 2', signerObjId: 'c2', email: 'two@example.test' },
        ],
        AuditTrail: [{ UserPtr: { objectId: 'c1' }, Activity: 'Signed' }],
      });
      expect(pending.map(p => p.email)).toEqual(['two@example.test']);
      expect(skipped).toContain(jasmine.objectContaining({ reason: 'already_signed' }));
    });
  });

  describe('sendreminder cloud function', () => {
    let owner, extUser, tenant, contacts, doc;

    beforeEach(async () => {
      owner = await makeUser('owner');
      tenant = await makeTenant(owner);
      extUser = await makeExtUser(owner, tenant);
      contacts = [await makeContact('Ada', tenant), await makeContact('Grace', tenant)];
      doc = await makeDocument({ owner, extUser, contacts });
    });

    it('lets the owner remind every outstanding signer', async () => {
      const res = await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));

      expect(res.sent.length).toBe(2);
      expect(res.sent.sort()).toEqual(contacts.map(c => c.get('Email')).sort());
      expect(mailbox.length).toBe(2);
      expect(mailbox[0].subject).toBe(
        'Reminder: Master Services Agreement is waiting for your signature'
      );
      expect(mailbox[0].html).toContain('/login/');
    });

    it('records the reminder on the document without touching AuditTrail', async () => {
      await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));

      const saved = await reload(doc.id);
      const reminders = saved.get('Reminders');
      expect(reminders.length).toBe(1);
      expect(reminders[0].To.length).toBe(2);
      expect(reminders[0].By).toBe(owner.id);
      expect(reminders[0].SentAt).toBeDefined();
      expect(saved.get('LastReminderAt')).toBeDefined();
      expect(saved.get('AuditTrail')).toBeUndefined();
    });

    it('rejects a caller who is neither the owner nor a tenant admin', async () => {
      const stranger = await makeUser('stranger');
      const strangerTenant = await makeTenant(stranger);
      await makeExtUser(stranger, strangerTenant);

      try {
        await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(stranger));
        fail('a non-owner should not be able to send reminders');
      } catch (err) {
        expect(err.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      }
      expect(mailbox.length).toBe(0);
    });

    it('allows an admin of the same tenant', async () => {
      const admin = await makeUser('admin');
      await makeExtUser(admin, tenant, 'contracts_Admin');

      const res = await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(admin));
      expect(res.sent.length).toBe(2);
    });

    it('only mails the current signer when SendinOrder is set', async () => {
      doc.set('SendinOrder', true);
      await doc.save(null, { useMasterKey: true });

      const res = await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));

      expect(res.sent).toEqual([contacts[0].get('Email')]);
      expect(res.skipped).toContain(
        jasmine.objectContaining({ email: contacts[1].get('Email'), reason: 'not_their_turn' })
      );
      expect(mailbox.length).toBe(1);
      expect(mailbox[0].recipient).toBe(contacts[0].get('Email'));
    });

    it('moves to the next signer in order once the first has signed', async () => {
      doc.set('SendinOrder', true);
      doc.set('AuditTrail', [
        { UserPtr: contacts[0].toPointer(), Activity: 'Signed', SignedOn: new Date() },
      ]);
      await doc.save(null, { useMasterKey: true });

      const res = await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));

      expect(res.sent).toEqual([contacts[1].get('Email')]);
      expect(res.skipped).toContain(
        jasmine.objectContaining({ email: contacts[0].get('Email'), reason: 'already_signed' })
      );
    });

    it('refuses to remind on a completed document', async () => {
      doc.set('IsCompleted', true);
      await doc.save(null, { useMasterKey: true });

      try {
        await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));
        fail('should not remind on a completed document');
      } catch (err) {
        expect(err.message).toContain('already completed');
      }
      expect(mailbox.length).toBe(0);
    });

    it('refuses a second reminder inside the minimum interval', async () => {
      await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));
      mailbox = [];
      let error;
      try {
        await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(owner));
      } catch (err) {
        error = err;
      }
      // Nothing capped manual reminders: no limiter, and LastReminderAt was
      // written but never read.
      expect(error).toBeDefined();
      expect(error.message).toContain('reminded recently');
      expect(mailbox.length).toBe(0);
    });

    it('refuses to remind on an expired document', async () => {
      const expired = await makeDocument({
        owner,
        extUser,
        contacts,
        extra: { ExpiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      let error;
      try {
        await Parse.Cloud.run('sendreminder', { docId: expired.id }, asUser(owner));
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.message).toBe('Document has expired.');
      expect(mailbox.length).toBe(0);
    });

    it('refuses a suspended admin of the same tenant', async () => {
      const admin = await makeUser('suspended');
      const adminExt = await makeExtUser(admin, tenant, 'contracts_Admin');
      adminExt.set('IsDisabled', true);
      await adminExt.save(null, { useMasterKey: true });

      let error;
      try {
        await Parse.Cloud.run('sendreminder', { docId: doc.id }, asUser(admin));
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(mailbox.length).toBe(0);
    });

    it('refuses to remind on a draft that was never sent', async () => {
      const draft = await makeDocument({ owner, extUser, contacts });
      const clear = new Parse.Object('contracts_Document');
      clear.id = draft.id;
      clear.unset('SignedUrl');
      clear.unset('DocSentAt');
      await clear.save(null, { useMasterKey: true });

      try {
        await Parse.Cloud.run('sendreminder', { docId: draft.id }, asUser(owner));
        fail('should not remind on a draft');
      } catch (err) {
        expect(err.message).toContain('not been sent');
      }
    });
  });

  describe('autoReminders job', () => {
    let owner, extUser, tenant, contacts;

    const daysFromNow = days => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };

    beforeEach(async () => {
      owner = await makeUser('jobowner');
      tenant = await makeTenant(owner);
      extUser = await makeExtUser(owner, tenant);
      contacts = [await makeContact('Linus', tenant)];
    });

    it('reminds a due document and advances NextReminderDate by RemindOnceInEvery days', async () => {
      const doc = await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(30),
        },
      });

      const summary = await runAutoReminders();

      expect(summary.reminded).toBe(1);
      expect(mailbox.length).toBe(1);
      expect(mailbox[0].recipient).toBe(contacts[0].get('Email'));

      const saved = await reload(doc.id);
      const next = saved.get('NextReminderDate');
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // Previous date was yesterday, so one 3 day step lands 2 days out.
      const expected = daysFromNow(2);
      expect(Math.abs(next.getTime() - expected.getTime())).toBeLessThan(60 * 1000);
      expect(saved.get('Reminders')[0].By).toBe('system');
    });

    it('skips completed, declined and expired documents', async () => {
      await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(30),
          IsCompleted: true,
        },
      });
      await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(30),
          IsDeclined: true,
        },
      });
      await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(-2),
        },
      });

      const summary = await runAutoReminders();

      expect(summary.scanned).toBe(0);
      expect(mailbox.length).toBe(0);
    });

    it('does not pick up documents whose reminder is not yet due', async () => {
      await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(2),
          ExpiryDate: daysFromNow(30),
        },
      });

      const summary = await runAutoReminders();
      expect(summary.scanned).toBe(0);
    });

    it('stops reminding when the next reminder would fall after ExpiryDate', async () => {
      const doc = await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 10,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(2),
        },
      });

      const summary = await runAutoReminders();

      expect(summary.reminded).toBe(1);
      expect(summary.stopped).toBe(1);
      const saved = await reload(doc.id);
      expect(saved.get('NextReminderDate')).toBeUndefined();
    });

    it('advances NextReminderDate even when every mail fails', async () => {
      setReminderMailTransport(async () => {
        throw new Error('smtp down');
      });
      const doc = await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(30),
        },
      });

      const summary = await runAutoReminders();
      expect(summary.reminded).toBe(0);

      // The date used to be advanced only after the mails went out, so a
      // failure left it in the past and the next tick mailed everyone again.
      const saved = await reload(doc.id);
      expect(saved.get('NextReminderDate').getTime()).toBeGreaterThan(Date.now());
    });

    it('honours the per run document cap', async () => {
      for (let i = 0; i < 3; i++) {
        await makeDocument({
          owner,
          extUser,
          contacts,
          extra: {
            AutomaticReminders: true,
            RemindOnceInEvery: 3,
            NextReminderDate: daysFromNow(-1),
            ExpiryDate: daysFromNow(30),
          },
        });
      }

      const summary = await runAutoReminders({ limit: 2 });
      expect(summary.scanned).toBe(2);
      expect(mailbox.length).toBe(2);
    });

    it('skips a document reminded inside its RemindOnceInEvery window', async () => {
      const doc = await makeDocument({
        owner,
        extUser,
        contacts,
        extra: {
          AutomaticReminders: true,
          RemindOnceInEvery: 3,
          NextReminderDate: daysFromNow(-1),
          ExpiryDate: daysFromNow(30),
          LastReminderAt: new Date(),
        },
      });

      const summary = await runAutoReminders();
      expect(summary.skipped).toBeGreaterThan(0);
      const saved = await reload(doc.id);
      // Skipped means untouched: the claim only happens for a document we mail.
      expect(saved.get('NextReminderDate').getTime()).toBeLessThan(Date.now());

      // Leave nothing due behind for the next spec.
      const cleanup = new Parse.Object('contracts_Document');
      cleanup.id = doc.id;
      cleanup.unset('NextReminderDate');
      await cleanup.save(null, { useMasterKey: true });
    });
  });
});
