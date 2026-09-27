import {
  fetchReminderDoc,
  sendReminderForDoc,
  setReminderMailTransport,
} from '../cloud/parsefunction/sendReminder.js';
import { resetTenantBrandingCache } from '../cloud/parsefunction/tenantBranding.js';

// `presignedlocalUrl` (reached through the afterFind triggers) signs local file
// URLs with MASTER_KEY, which the spec runner does not set.
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
process.env.PUBLIC_URL = 'https://sign.example.test';

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
  return await Parse.User.logIn(email, 'pa55word!');
}

async function makeTenant(user, extra = {}) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  Object.entries(extra).forEach(([key, value]) => tenant.set(key, value));
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

async function makeDocument({ owner, extUser, contacts }) {
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', 'Master Services Agreement');
  doc.set('URL', 'http://localhost:30001/files/source.pdf');
  doc.set('SignedUrl', 'http://localhost:30001/files/sent.pdf');
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
      Id: 20000000 + idx,
      Role: `Role ${idx + 1}`,
      blockColor: '#93a3db',
      signerObjId: c.id,
      signerPtr: c.toPointer(),
      email: c.get('Email'),
      placeHolder: [{ pageNumber: 1, pos: [] }],
    }))
  );
  await doc.save(null, { useMasterKey: true });
  // The reminder builder reads the sender and the tenant off the document, so
  // hand back the same fully-included row the `sendreminder` function fetches.
  return await fetchReminderDoc(doc.id);
}

function asUser(user) {
  return { sessionToken: user.getSessionToken() };
}

async function expectError(promise, code) {
  try {
    await promise;
    fail('expected the call to be rejected');
  } catch (err) {
    expect(err.code).toBe(code);
    return err;
  }
}

describe('tenant branding', () => {
  Parse.User.enableUnsafeCurrentUser();

  afterEach(() => {
    setReminderMailTransport(null);
    resetTenantBrandingCache();
  });

  describe('updatetenant', () => {
    it('lets a tenant admin write the branding keys and returns the tenant without secrets', async () => {
      const admin = await makeUser('brandadmin');
      const tenant = await makeTenant(admin, { PfxFile: { base64: 'x', password: 'y' } });
      await makeExtUser(admin, tenant, 'contracts_Admin');

      const res = await Parse.Cloud.run(
        'updatetenant',
        {
          tenantId: tenant.id,
          details: {
            TenantName: 'Acme',
            EmailSenderName: 'Acme Agreements',
            EmailFooter: 'Acme Inc., Springfield',
            HidePoweredBy: true,
            ReplyTo: 'Contracts@Acme.example',
            RequestSubject: 'Please sign {{document_title}}',
          },
        },
        asUser(admin)
      );

      expect(res.TenantName).toBe('Acme');
      expect(res.EmailSenderName).toBe('Acme Agreements');
      expect(res.EmailFooter).toBe('Acme Inc., Springfield');
      expect(res.HidePoweredBy).toBe(true);
      expect(res.ReplyTo).toBe('contracts@acme.example');
      expect(res.RequestSubject).toBe('Please sign {{document_title}}');
      expect(res.PfxFile).toBeUndefined();
      expect(res.FileAdapters).toBeUndefined();
    });

    it('clears an optional key when it is sent empty', async () => {
      const admin = await makeUser('brandclear');
      const tenant = await makeTenant(admin, { EmailFooter: 'old footer' });
      await makeExtUser(admin, tenant, 'contracts_Admin');

      const res = await Parse.Cloud.run(
        'updatetenant',
        { tenantId: tenant.id, details: { EmailFooter: '' } },
        asUser(admin)
      );
      expect(res.EmailFooter).toBeUndefined();
    });

    it('refuses a member who is not an admin of the tenant', async () => {
      const member = await makeUser('brandmember');
      const tenant = await makeTenant(member);
      await makeExtUser(member, tenant, 'contracts_User');

      await expectError(
        Parse.Cloud.run(
          'updatetenant',
          { tenantId: tenant.id, details: { TenantName: 'Not allowed' } },
          asUser(member)
        ),
        Parse.Error.OPERATION_FORBIDDEN
      );
    });

    it('refuses a key that is not an editable workspace setting', async () => {
      const admin = await makeUser('brandunknown');
      const tenant = await makeTenant(admin);
      await makeExtUser(admin, tenant, 'contracts_Admin');

      await expectError(
        Parse.Cloud.run(
          'updatetenant',
          { tenantId: tenant.id, details: { PfxFile: { base64: 'evil' } } },
          asUser(admin)
        ),
        Parse.Error.INVALID_KEY_NAME
      );
    });

    it('refuses a logo that is not a file on this server', async () => {
      const admin = await makeUser('brandlogo');
      const tenant = await makeTenant(admin);
      await makeExtUser(admin, tenant, 'contracts_Admin');

      await expectError(
        Parse.Cloud.run(
          'updatetenant',
          { tenantId: tenant.id, details: { Logo: 'https://evil.example/logo.png' } },
          asUser(admin)
        ),
        Parse.Error.VALIDATION_ERROR
      );
    });

    it('refuses a sender name carrying a line break', async () => {
      const admin = await makeUser('brandheader');
      const tenant = await makeTenant(admin);
      await makeExtUser(admin, tenant, 'contracts_Admin');

      await expectError(
        Parse.Cloud.run(
          'updatetenant',
          {
            tenantId: tenant.id,
            details: { EmailSenderName: 'Acme\r\nBcc: someone@evil.example' },
          },
          asUser(admin)
        ),
        Parse.Error.VALIDATION_ERROR
      );
    });
  });

  describe('gettenant', () => {
    it('returns the branding fields to a member of the tenant', async () => {
      const admin = await makeUser('brandget');
      const tenant = await makeTenant(admin, {
        EmailSenderName: 'Acme Agreements',
        HidePoweredBy: true,
        EmailFooter: 'Acme Inc',
      });
      await makeExtUser(admin, tenant, 'contracts_Admin');

      const res = await Parse.Cloud.run('gettenant', { userId: admin.id }, asUser(admin));
      const json = JSON.parse(JSON.stringify(res));
      expect(json.EmailSenderName).toBe('Acme Agreements');
      expect(json.HidePoweredBy).toBe(true);
      expect(json.EmailFooter).toBe('Acme Inc');
    });
  });

  describe('getlogobydomain', () => {
    it('answers with the tenant name for a matching domain', async () => {
      const owner = await makeUser('branddomain');
      const domain = `${unique('brand')}.example.test`;
      await makeTenant(owner, {
        Domain: domain,
        TenantName: 'Acme',
        HidePoweredBy: true,
        EmailFooter: 'Acme Inc.',
      });

      const res = await Parse.Cloud.run('getlogobydomain', { domain });
      expect(res.tenantName).toBe('Acme');
      expect(res.appname).toBe('Acme');
      expect(res.hidePoweredBy).toBe(true);
      expect(res.footer).toBe('Acme Inc.');
      expect(res.user).toBe('exist');
      expect(res.hostMatch).toBe(true);
      expect(res.platformName).toBe('DocuStamp');
    });

    it('does not claim a host that no tenant has set as its domain', async () => {
      const owner = await makeUser('brandnodomain');
      await makeTenant(owner, { TenantName: 'Unclaimed' });

      const res = await Parse.Cloud.run('getlogobydomain', { domain: `${unique('nohost')}.example.test` });
      expect(res.hostMatch).toBe(false);
      expect(res.platformName).toBe('DocuStamp');
    });
  });

  describe('outgoing mail', () => {
    it('uses the tenant sender name and drops the Powered by line', async () => {
      const owner = await makeUser('brandmail');
      const tenant = await makeTenant(owner, {
        EmailSenderName: 'Acme Agreements',
        HidePoweredBy: true,
        EmailFooter: 'Acme Inc., Springfield',
      });
      const extUser = await makeExtUser(owner, tenant, 'contracts_Admin');
      const contact = await makeContact('Signer One', tenant);
      const doc = await makeDocument({ owner, extUser, contacts: [contact] });

      const mailbox = [];
      setReminderMailTransport(async params => {
        mailbox.push(params);
        return { status: 'success' };
      });

      const outcome = await sendReminderForDoc({ doc, by: owner.id });
      expect(outcome.sent.length).toBe(1);
      expect(mailbox.length).toBe(1);
      expect(mailbox[0].from).toBe('Acme Agreements');
      expect(mailbox[0].html).toContain('Acme Inc., Springfield');
      expect(mailbox[0].html).not.toContain('file a complaint');
    });

    it('keeps the Powered by line when the tenant has not hidden it', async () => {
      const owner = await makeUser('brandmailkeep');
      const tenant = await makeTenant(owner);
      const extUser = await makeExtUser(owner, tenant, 'contracts_Admin');
      const contact = await makeContact('Signer Two', tenant);
      const doc = await makeDocument({ owner, extUser, contacts: [contact] });

      const mailbox = [];
      setReminderMailTransport(async params => {
        mailbox.push(params);
        return { status: 'success' };
      });

      await sendReminderForDoc({ doc, by: owner.id });
      expect(mailbox.length).toBe(1);
      // No tenant sender name: the owner's company, never their bare address.
      expect(mailbox[0].from).toBe('Acme Inc');
      // No APP_COMPLAINTS_EMAIL in the test env: the plain attribution line.
      expect(mailbox[0].html).toContain('Sent via DocuStamp.');
    });
  });
});
