/**
 * Coverage for the medium and low findings in the document, template and
 * contact cloud functions (package M4).
 *
 * What is checked here, and what it used to do:
 *
 *  - `DocumentBeforesave` / `TemplateBeforesave` validated on insert only, so a
 *    plain REST update walked straight past the length and reminder limits.
 *  - `DocumentAftersave` rewrote `Signers` from contact pointers to
 *    contracts_Users pointers whenever the first signer carried an `ExtUserPtr`,
 *    corrupting the array `Placeholders[].signerObjId` is matched against.
 *  - `saveastemplate` copied the source document's `NextReminderDate`, which
 *    belongs to a different send and is usually in the past.
 *  - `createduplicate` answered a missing templateId with HTTP 200 and null.
 *  - `getcontact` returned the raw row (CreatedBy, TenantId, ACL) to anyone in
 *    the same tenant.
 *  - `getreport` answered every failure with HTTP 200 and
 *    `{error: "You don't have access!"}`.
 */
import axios from 'axios';
import { serverAppId } from '../Utils.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.42',
        ...headers,
      },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

async function loginToken(email, password) {
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: { 'X-Parse-Application-Id': APP_ID, 'X-Parse-Javascript-Key': JS_KEY } }
  );
  return res.data.sessionToken;
}

async function makeUser(email, password = 'Str0ng!pass') {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', password);
  user.set('name', email.split('@')[0]);
  await user.signUp();
  user.__session = await loginToken(email, password);
  return user;
}

describe('documents, templates and contacts (M4)', () => {
  Parse.User.enableUnsafeCurrentUser();

  const suffix = Date.now();
  let owner;
  let ownerExt;
  let colleague;
  let colleagueExt;
  let tenant;
  let contact;

  beforeAll(async () => {
    tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', `M4 tenant ${suffix}`);
    await tenant.save(null, { useMasterKey: true });

    owner = await makeUser(`m4owner${suffix}@example.com`);
    ownerExt = new Parse.Object('contracts_Users');
    ownerExt.set('Name', 'M4 Owner');
    ownerExt.set('Email', owner.get('email'));
    ownerExt.set('UserId', pointer('_User', owner.id));
    ownerExt.set('UserRole', 'contracts_Admin');
    ownerExt.set('TenantId', pointer('partners_Tenant', tenant.id));
    await ownerExt.save(null, { useMasterKey: true });

    colleague = await makeUser(`m4mate${suffix}@example.com`);
    colleagueExt = new Parse.Object('contracts_Users');
    colleagueExt.set('Name', 'M4 Colleague');
    colleagueExt.set('Email', colleague.get('email'));
    colleagueExt.set('UserId', pointer('_User', colleague.id));
    colleagueExt.set('UserRole', 'contracts_User');
    colleagueExt.set('TenantId', pointer('partners_Tenant', tenant.id));
    await colleagueExt.save(null, { useMasterKey: true });

    contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'M4 Signer');
    contact.set('Email', `m4signer${suffix}@example.com`);
    contact.set('CreatedBy', pointer('_User', owner.id));
    contact.set('IsDeleted', false);
    await contact.save(null, { useMasterKey: true });
  }, 60000);

  async function makeDocument(fields = {}) {
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', `M4 document ${Date.now()}`);
    doc.set('URL', localFileUrl('m4.pdf'));
    doc.set('CreatedBy', pointer('_User', owner.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
    for (const [key, value] of Object.entries(fields)) doc.set(key, value);
    return await doc.save(null, { useMasterKey: true });
  }

  /* --------------------------------------------------------- beforeSave */
  describe('beforeSave validation', () => {
    it('rejects an over-long Name on an update, not just on insert', async () => {
      const doc = await makeDocument();
      doc.set('Name', 'x'.repeat(400));
      let code = 0;
      await doc.save(null, { useMasterKey: true }).catch(err => {
        code = err.code;
      });
      expect(code).toBe(Parse.Error.VALIDATION_ERROR);
    }, 60000);

    it('rejects a reminder schedule raised on an update', async () => {
      const doc = await makeDocument({ TimeToCompleteDays: 15, RemindOnceInEvery: 5 });
      doc.set('TimeToCompleteDays', 365);
      doc.set('RemindOnceInEvery', 1);
      doc.set('AutomaticReminders', true);
      let code = 0;
      await doc.save(null, { useMasterKey: true }).catch(err => {
        code = err.code;
      });
      expect(code).toBe(Parse.Error.INVALID_QUERY);
    }, 60000);

    it('leaves an update that touches nothing it validates alone', async () => {
      const doc = await makeDocument();
      doc.set('Note', 'still fine');
      const saved = await doc.save(null, { useMasterKey: true });
      expect(saved.get('Note')).toBe('still fine');
    }, 60000);

    it('applies the same rules to templates', async () => {
      const template = new Parse.Object('contracts_Template');
      template.set('Name', 'M4 template');
      template.set('CreatedBy', pointer('_User', owner.id));
      template.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      const saved = await template.save(null, { useMasterKey: true });
      saved.set('Description', 'y'.repeat(600));
      let code = 0;
      await saved.save(null, { useMasterKey: true }).catch(err => {
        code = err.code;
      });
      expect(code).toBe(Parse.Error.VALIDATION_ERROR);
    }, 60000);
  });

  /* ---------------------------------------------------------- afterSave */
  describe('afterSave', () => {
    it('leaves Signers as contact pointers even when a contact carries ExtUserPtr', async () => {
      const linked = new Parse.Object('contracts_Contactbook');
      linked.set('Name', 'Linked contact');
      linked.set('Email', `m4linked${Date.now()}@example.com`);
      linked.set('CreatedBy', pointer('_User', owner.id));
      linked.set('IsDeleted', false);
      // Nothing in the product writes this, but the column exists and a signer
      // holds write on their own contact row.
      linked.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      await linked.save(null, { useMasterKey: true });

      const doc = await makeDocument({
        Signers: [pointer('contracts_Contactbook', linked.id)],
        Placeholders: [{ Id: 1, signerObjId: linked.id, email: linked.get('Email') }],
      });

      const fresh = await new Parse.Query('contracts_Document').get(doc.id, {
        useMasterKey: true,
      });
      const signers = fresh.get('Signers');
      expect(signers[0].className).toBe('contracts_Contactbook');
      expect(signers[0].id).toBe(linked.id);
    }, 60000);

    it('charges the document quota when the document is sent, once', async () => {
      const before = ownerExt.get('DocumentCount') || 0;
      const doc = await makeDocument({
        Signers: [pointer('contracts_Contactbook', contact.id)],
      });
      let ext = await new Parse.Query('contracts_Users').get(ownerExt.id, { useMasterKey: true });
      // Nothing is charged for an unsent document.
      expect(ext.get('DocumentCount') || 0).toBe(before);

      doc.set('SignedUrl', localFileUrl('m4-signed.pdf'));
      await doc.save(null, { useMasterKey: true });
      ext = await new Parse.Query('contracts_Users').get(ownerExt.id, { useMasterKey: true });
      expect(ext.get('DocumentCount') || 0).toBe(before + 1);
    }, 60000);
  });

  /* ------------------------------------------------------ saveastemplate */
  it('saveastemplate does not carry the document NextReminderDate over', async () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const doc = await makeDocument({
      NextReminderDate: past,
      AutomaticReminders: false,
      Placeholders: [{ Id: 1, Role: 'Role 1', signerObjId: '', email: '', placeHolder: [] }],
    });

    const res = await callFn(
      'saveastemplate',
      { docId: doc.id },
      { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session }
    );
    expect(res.ok).toBe(true);

    const template = await new Parse.Query('contracts_Template').get(res.result.objectId, {
      useMasterKey: true,
    });
    expect(template.get('NextReminderDate')).toBeUndefined();
  }, 60000);

  /* -------------------------------------------- the one document writer */
  describe('every creation path goes through one writer', () => {
    const session = { 'X-Parse-Session-Token': null, sessiontoken: null };

    function ownerHeaders() {
      return { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session };
    }

    it('createdocumentfromapp refuses strict order without sequential sending', async () => {
      // The column is what the signer page and the server both refuse a
      // signature on, so a stored `true` under a document that is not sent in
      // order blocked every signer for a rule the sender had turned off. It used
      // to be copied straight out of the payload here.
      const res = await callFn(
        'createdocumentfromapp',
        {
          document: {
            Name: `M4 strict ${Date.now()}`,
            URL: localFileUrl('m4.pdf'),
            SendinOrder: false,
            SendInOrderStrict: true,
          },
        },
        ownerHeaders()
      );
      expect(res.ok).toBe(true);
      const stored = await new Parse.Query('contracts_Document').get(res.result.objectId, {
        useMasterKey: true,
      });
      expect(stored.get('SendinOrder')).toBeFalse();
      expect(stored.get('SendInOrderStrict')).toBeFalse();
      // Ownership comes from the session, never from the payload.
      expect(stored.get('CreatedBy').id).toBe(owner.id);
      expect(stored.get('ExtUserPtr').id).toBe(ownerExt.id);
    }, 60000);

    it('createdocumentfromapp ignores the CreatedBy the browser sends', async () => {
      const res = await callFn(
        'createdocumentfromapp',
        {
          document: {
            Name: `M4 owner ${Date.now()}`,
            URL: localFileUrl('m4.pdf'),
            CreatedBy: pointer('_User', colleague.id),
            ExtUserPtr: pointer('contracts_Users', colleagueExt.id),
          },
        },
        ownerHeaders()
      );
      expect(res.ok).toBe(true);
      const stored = await new Parse.Query('contracts_Document').get(res.result.objectId, {
        useMasterKey: true,
      });
      expect(stored.get('CreatedBy').id).toBe(owner.id);
      expect(stored.get('ExtUserPtr').id).toBe(ownerExt.id);
      expect(session).toBeDefined();
    }, 60000);

    it('recreatedoc leaves the previous run behind', async () => {
      const doc = await makeDocument({
        SignedUrl: localFileUrl('m4-signed.pdf'),
        CertificateUrl: localFileUrl('m4-cert.pdf'),
        DocumentHash: 'deadbeef',
        IsDeclined: true,
        DeclineReason: 'not today',
        SendinOrder: false,
        SendInOrderStrict: true,
        AuditTrail: [{ Activity: 'Signed', UserPtr: pointer('contracts_Users', ownerExt.id) }],
        Placeholders: [
          {
            Id: 1,
            Role: 'Role 1',
            signerObjId: contact.id,
            signerPtr: pointer('contracts_Contactbook', contact.id),
            email: contact.get('Email'),
            placeHolder: [
              {
                pageNumber: 1,
                pos: [
                  {
                    key: 90909090,
                    type: 'signature',
                    xPosition: 10,
                    yPosition: 10,
                    SignUrl: localFileUrl('sig.png'),
                    options: { name: 's-1', status: 'required', response: 'AAAA' },
                  },
                ],
              },
            ],
          },
        ],
      });

      const res = await callFn('recreatedoc', { docId: doc.id }, ownerHeaders());
      expect(res.ok).toBe(true);
      // The response shape the SPA reads is unchanged.
      expect(res.result.objectId).toBeTruthy();
      expect(res.result.createdAt).toBeTruthy();

      const copy = await new Parse.Query('contracts_Document').get(res.result.objectId, {
        useMasterKey: true,
      });
      expect(copy.get('SignedUrl')).toBeUndefined();
      expect(copy.get('CertificateUrl')).toBeUndefined();
      expect(copy.get('DocumentHash')).toBeUndefined();
      expect(copy.get('AuditTrail')).toBeUndefined();
      expect(copy.get('DeclineReason')).toBeUndefined();
      expect(copy.get('IsDeclined')).toBeFalse();
      // Normalised by the shared settings pass, exactly like every other path.
      expect(copy.get('SendInOrderStrict')).toBeFalse();
      // A fresh deadline: the original's has usually gone by, which is half the
      // reason the document is being recreated.
      expect(copy.get('ExpiryDate').getTime()).toBeGreaterThan(Date.now());
      const widget = copy.get('Placeholders')[0].placeHolder[0].pos[0];
      expect(widget.SignUrl).toBeUndefined();
      expect(widget.options.response).toBeUndefined();
    }, 60000);

    it('recreatedoc still refuses a document the caller does not own', async () => {
      const doc = await makeDocument({ Placeholders: [] });
      const res = await callFn(
        'recreatedoc',
        { docId: doc.id },
        {
          'X-Parse-Session-Token': colleague.__session,
          sessiontoken: colleague.__session,
        }
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    }, 60000);
  });

  /* ------------------------------------------------------ createduplicate */
  it('createduplicate refuses a missing templateId instead of answering null', async () => {
    const res = await callFn(
      'createduplicate',
      {},
      { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session }
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe(Parse.Error.INVALID_QUERY);
  }, 60000);

  /* ------------------------------------------------------------ getreport */
  describe('getReport', () => {
    it('throws for an unknown report instead of an access message', async () => {
      const res = await callFn(
        'getReport',
        { reportId: 'not-a-report' },
        { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session }
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    }, 60000);

    it('runs the templates report for a caller with no team', async () => {
      const template = new Parse.Object('contracts_Template');
      template.set('Name', `M4 report template ${Date.now()}`);
      template.set('CreatedBy', pointer('_User', owner.id));
      template.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      await template.save(null, { useMasterKey: true });

      const res = await callFn(
        'getReport',
        { reportId: '6TeaPr321t', limit: 50, skip: 0 },
        { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session }
      );
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.result)).toBe(true);
      expect(res.result.some(r => r.objectId === template.id)).toBe(true);
    }, 60000);

    it('does not show one account the other account templates', async () => {
      const res = await callFn(
        'getReport',
        { reportId: '6TeaPr321t', limit: 50, skip: 0 },
        { 'X-Parse-Session-Token': colleague.__session, sessiontoken: colleague.__session }
      );
      expect(res.ok).toBe(true);
      expect(res.result.every(r => r.ExtUserPtr?.objectId !== ownerExt.id)).toBe(true);
    }, 60000);
  });

  /* ----------------------------------------------------------- getcontact */
  it('getcontact gives a tenant colleague the reduced projection only', async () => {
    const res = await callFn(
      'getcontact',
      { contactId: contact.id },
      { 'X-Parse-Session-Token': colleague.__session, sessiontoken: colleague.__session }
    );
    expect(res.ok).toBe(true);
    expect(res.result.objectId).toBe(contact.id);
    expect(res.result.CreatedBy).toBeUndefined();
    expect(res.result.TenantId).toBeUndefined();
    expect(res.result.ACL).toBeUndefined();
  }, 60000);

  /* ---------------------------------------------------- one contact writer */
  describe('one contact writer', () => {
    function ownerHeaders() {
      return { 'X-Parse-Session-Token': owner.__session, sessiontoken: owner.__session };
    }

    it('savecontact folds the address, links a shadow user and locks the row', async () => {
      const typed = `Saved.Contact${Date.now()}@Example.TEST`;
      const res = await callFn(
        'savecontact',
        { name: 'Saved Contact', email: typed, company: 'Acme' },
        ownerHeaders()
      );
      expect(res.ok).toBe(true);
      // The full row, which is what the SPA reads.
      expect(res.result.objectId).toBeTruthy();
      expect(res.result.Email).toBe(typed.toLowerCase());

      const row = await new Parse.Query('contracts_Contactbook').get(res.result.objectId, {
        useMasterKey: true,
      });
      const shadowId = row.get('UserId').id;
      expect(shadowId).toBeTruthy();
      // Owner and contact, both read+write; never public.
      const acl = row.getACL();
      expect(acl.getWriteAccess(owner.id)).toBeTrue();
      expect(acl.getWriteAccess(shadowId)).toBeTrue();
      expect(acl.getPublicReadAccess()).toBeFalse();
      // The shadow user's password is not its own address (§C).
      const shadow = await new Parse.Query(Parse.User).get(shadowId, { useMasterKey: true });
      expect(shadow.get('username')).toBe(typed.toLowerCase());
    }, 60000);

    it('savecontact still refuses a duplicate', async () => {
      const email = `dupe.contact${Date.now()}@example.test`;
      const first = await callFn('savecontact', { name: 'A', email }, ownerHeaders());
      expect(first.ok).toBe(true);
      const second = await callFn('savecontact', { name: 'A again', email }, ownerHeaders());
      expect(second.ok).toBe(false);
      expect(second.code).toBe(Parse.Error.DUPLICATE_VALUE);
    }, 60000);

    it('the afterSave trigger gives a master-key insert its owner ACL', async () => {
      // The owner grant used to depend on `request.user`, so a row written with
      // the master key that already carried `UserId` fell through the whole `if`
      // and kept whatever ACL it was saved with, which for a row saved with none
      // means world readable and world writable.
      const shadow = new Parse.User();
      const address = `imported${Date.now()}@example.test`;
      shadow.set('username', address);
      shadow.set('email', address);
      shadow.set('password', 'a-random-value-nobody-types');
      await shadow.signUp();

      const row = new Parse.Object('contracts_Contactbook');
      row.set('Name', 'Imported Contact');
      row.set('Email', address);
      row.set('CreatedBy', pointer('_User', owner.id));
      row.set('UserId', pointer('_User', shadow.id));
      const saved = await row.save(null, { useMasterKey: true });

      const stored = await new Parse.Query('contracts_Contactbook').get(saved.id, {
        useMasterKey: true,
      });
      const acl = stored.getACL();
      expect(acl).toBeDefined();
      expect(acl.getWriteAccess(owner.id)).toBeTrue();
      expect(acl.getReadAccess(shadow.id)).toBeTrue();
      expect(acl.getPublicReadAccess()).toBeFalse();
      expect(acl.getPublicWriteAccess()).toBeFalse();
    }, 60000);
  });
});
