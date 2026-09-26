/**
 * Coverage for the security hardening applied to `sendmailv3`, `fileupload`,
 * `generatecertificate`, `getcontact`, `usersignup`/`addadmin` and the five
 * `afterFind` triggers.
 *
 * Every call goes over raw HTTP so we control exactly which credentials are
 * present, which is the whole point of these tests: the guest signing flows
 * arrive with no session at all, and the web app also sends its session under
 * the non-standard `sessionToken` header spelling.
 */
import axios from 'axios';
import { serverAppId } from '../Utils.js';
import {
  checkRateLimit,
  resetRateLimits,
  RATE_LIMIT_CODE,
} from '../cloud/parsefunction/authGuard.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { uniqueEmail } from './support/env.js';

// MASTER_KEY and PUBLIC_URL are set in spec/support/env.js, before index.js is
// imported; setting them here (at spec module scope) was both too late for this
// file's own imports and a leak into every other spec file in the run.

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.1',
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

/** The lowercase header spelling the web app also sends; Parse Server itself ignores it. */
const legacySession = token => ({ sessionToken: token });
const properSession = token => ({ 'X-Parse-Session-Token': token });

/**
 * The in-process SDK does not hand back a session token here, so the token
 * comes from a real REST login, which is also how both frontends get theirs.
 */
async function loginToken(email, password) {
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    {
      headers: {
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
      },
    }
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
  user.__specSessionToken = await loginToken(email, password);
  return user;
}

async function makeExtUser(user, tenantId) {
  const ext = new Parse.Object('contracts_Users');
  ext.set('UserId', pointer('_User', user.id));
  ext.set('Email', user.get('email'));
  ext.set('Name', user.get('name'));
  ext.set('UserRole', 'contracts_User');
  if (tenantId) ext.set('TenantId', pointer('partners_Tenant', tenantId));
  return await ext.save(null, { useMasterKey: true });
}

async function makeContact(owner, email, name = 'Signer') {
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', name);
  contact.set('Email', email);
  contact.set('CreatedBy', pointer('_User', owner.id));
  contact.set('UserId', pointer('_User', owner.id));
  contact.set('IsDeleted', false);
  return await contact.save(null, { useMasterKey: true });
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

describe('security hardening', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let ownerSession;
  let ownerExt;
  let stranger;
  let strangerSession;
  let signerContact;
  let signerEmail;

  beforeAll(async () => {
    owner = await makeUser(uniqueEmail('owner.hardening'));
    ownerSession = owner.__specSessionToken;
    ownerExt = await makeExtUser(owner);
    stranger = await makeUser(uniqueEmail('stranger.hardening'));
    strangerSession = stranger.__specSessionToken;
    signerEmail = uniqueEmail('signer.hardening');
    signerContact = await makeContact(owner, signerEmail);
  }, 60000);

  beforeEach(() => resetRateLimits());

  /* ----------------------------------------------------------------- */
  describe('rate limiter', () => {
    it('throws once the window is full and recovers after a reset', () => {
      for (let i = 0; i < 3; i++) checkRateLimit('spec', 'k', 3);
      let thrown;
      try {
        checkRateLimit('spec', 'k', 3);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe(RATE_LIMIT_CODE);
      resetRateLimits();
      expect(() => checkRateLimit('spec', 'k', 3)).not.toThrow();
    });
  });

  /* ----------------------------------------------------------------- */
  describe('sendmailv3', () => {
    // `sendmailv3` now throws when the message is not accepted, and the test
    // server has no mail provider, so an accepted send is stubbed here: these
    // specs are about who may send, not about delivery (see Mail.spec.js).
    beforeEach(() => setMailTransport(async () => ({ status: 'success' })));
    afterAll(() => setMailTransport(null));

    const body = extra => ({
      recipient: signerEmail,
      subject: 'Please sign',
      from: 'Owner',
      html: '<p>hi</p>',
      ...extra,
    });

    it('refuses an anonymous call with no document or sender context', async () => {
      const res = await callFn('sendmailv3', body());
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });

    it('refuses a malformed recipient address', async () => {
      const res = await callFn(
        'sendmailv3',
        body({ recipient: 'not-an-email' }),
        legacySession(ownerSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('refuses more recipients than the cap', async () => {
      const many = Array.from({ length: 30 }, (_, i) => uniqueEmail(`bulk${i}`)).join(',');
      const res = await callFn(
        'sendmailv3',
        body({ recipient: many }),
        legacySession(ownerSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('refuses an anonymous call to someone who is not a contact of the sender', async () => {
      const res = await callFn(
        'sendmailv3',
        body({ recipient: uniqueEmail('outsider'), extUserId: ownerExt.id })
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('allows the anonymous next-signer mail to a real contact of the sender', async () => {
      // Preserves §6.8 step 9: a guest on a non-OTP document has no session.
      const res = await callFn('sendmailv3', body({ extUserId: ownerExt.id }));
      expect(res.ok).toBe(true);
      expect(res.result.status).toBe('success');
    });

    it('accepts the lowercase session-token header spelling', async () => {
      const res = await callFn('sendmailv3', body(), legacySession(ownerSession));
      expect(res.ok).toBe(true);
    });

    it('accepts the standard session-token header', async () => {
      const res = await callFn('sendmailv3', body(), properSession(ownerSession));
      expect(res.ok).toBe(true);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('fileupload', () => {
    it('refuses a url that is not a file on this server', async () => {
      const res = await callFn('fileupload', { url: 'https://evil.example.com/secret.pdf' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('refuses a non-file path on this server', async () => {
      const res = await callFn('fileupload', { url: `${TEST_SERVER}/classes/contracts_Document` });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('refuses a file belonging to a different app id', async () => {
      const res = await callFn('fileupload', {
        url: `${TEST_SERVER}/files/someotherapp/doc.pdf`,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('still signs a real local file for a guest with no session', async () => {
      const res = await callFn('fileupload', { url: localFileUrl('guest-widget.png') });
      expect(res.ok).toBe(true);
      expect(res.result.url).toContain('?token=');
      expect(res.result.url.split('?')[0]).toBe(localFileUrl('guest-widget.png'));
    });

    it('drops a caller supplied token instead of signing it in', async () => {
      const res = await callFn('fileupload', {
        url: `${localFileUrl('guest-widget.png')}?token=whatever`,
      });
      expect(res.ok).toBe(true);
      expect(res.result.url.split('?')[0]).toBe(localFileUrl('guest-widget.png'));
    });
  });

  /* ----------------------------------------------------------------- */
  describe('generatecertificate', () => {
    let completedWithCert;
    let completedWithoutCert;
    let openDoc;

    beforeAll(async () => {
      const base = () => {
        const doc = new Parse.Object('contracts_Document');
        doc.set('Name', 'Certificate spec');
        doc.set('URL', localFileUrl('cert-spec.pdf'));
        doc.set('CreatedBy', pointer('_User', owner.id));
        doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
        doc.set('Signers', [pointer('contracts_Contactbook', signerContact.id)]);
        return doc;
      };
      const a = base();
      a.set('IsCompleted', true);
      a.set('CertificateUrl', localFileUrl('cert-done.pdf'));
      completedWithCert = await a.save(null, { useMasterKey: true });

      const b = base();
      b.set('IsCompleted', true);
      completedWithoutCert = await b.save(null, { useMasterKey: true });

      const c = base();
      openDoc = await c.save(null, { useMasterKey: true });
    }, 60000);

    it('returns an existing certificate to the public done page with no session', async () => {
      const res = await callFn('generatecertificate', { docId: completedWithCert.id });
      expect(res.ok).toBe(true);
      expect(res.result.CertificateUrl).toContain('cert-done.pdf');
    });

    it('reports no certificate for a document that is not completed', async () => {
      const res = await callFn('generatecertificate', { docId: openDoc.id });
      expect(res.ok).toBe(true);
      expect(res.result.CertificateUrl).toBe('');
    });

    it('refuses to generate for an anonymous caller', async () => {
      const res = await callFn('generatecertificate', { docId: completedWithoutCert.id });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });

    it('refuses to generate for someone who is not on the document', async () => {
      const res = await callFn(
        'generatecertificate',
        { docId: completedWithoutCert.id },
        properSession(strangerSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('getcontact', () => {
    let orphanContact;
    let signedDoc;

    beforeAll(async () => {
      orphanContact = await makeContact(owner, uniqueEmail('orphan.hardening'), 'Orphan');
      const doc = new Parse.Object('contracts_Document');
      doc.set('Name', 'Contact spec');
      doc.set('URL', localFileUrl('contact-spec.pdf'));
      doc.set('CreatedBy', pointer('_User', owner.id));
      doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      doc.set('Signers', [pointer('contracts_Contactbook', signerContact.id)]);
      doc.set('Placeholders', [
        { Id: 1, email: signerContact.get('Email'), signerObjId: signerContact.id },
      ]);
      signedDoc = await doc.save(null, { useMasterKey: true });
    }, 60000);

    it('serves the guest signer with no session, as the signing page needs', async () => {
      const res = await callFn('getcontact', {
        contactId: signerContact.id,
        docId: signedDoc.id,
      });
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(signerContact.id);
      expect(res.result.Email).toBe(signerContact.get('Email'));
    });

    it('narrows the anonymous answer to signing fields only', async () => {
      const res = await callFn('getcontact', {
        contactId: signerContact.id,
        docId: signedDoc.id,
      });
      expect(res.result.CreatedBy).toBeUndefined();
      expect(res.result.TenantId).toBeUndefined();
      expect(res.result.ACL).toBeUndefined();
    });

    it('refuses an anonymous call that names no document', async () => {
      // Without a docId the only question left is "is this contact a signer
      // anywhere", which is true for nearly every contact, so an anonymous
      // caller could walk objectIds through the contact book.
      const res = await callFn('getcontact', { contactId: signerContact.id });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    });

    it('hides a contact that is not a signer on the named document', async () => {
      const res = await callFn('getcontact', {
        contactId: orphanContact.id,
        docId: signedDoc.id,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    });

    it('gives the owner the full row', async () => {
      const res = await callFn(
        'getcontact',
        { contactId: orphanContact.id },
        properSession(ownerSession)
      );
      expect(res.ok).toBe(true);
      expect(res.result.objectId).toBe(orphanContact.id);
      expect(res.result.CreatedBy).toBeDefined();
    });
  });

  /* ----------------------------------------------------------------- */
  describe('usersignup and addadmin', () => {
    it('signs up a brand new user and returns a session token', async () => {
      const res = await callFn('usersignup', {
        userDetails: {
          name: 'Fresh Signup',
          email: uniqueEmail('fresh.signup'),
          password: 'Str0ng!pass',
          role: 'contracts_User',
          company: 'Acme',
          jobTitle: 'Tester',
        },
      });
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User sign up');
      expect(res.result.sessionToken).toBeDefined();
    });

    it('never mints a session for an existing account without the password', async () => {
      const res = await callFn('usersignup', {
        userDetails: {
          name: 'Impostor',
          email: owner.get('email'),
          role: 'contracts_User',
          company: 'Acme',
          jobTitle: 'Tester',
        },
      });
      expect(res.ok).toBe(true);
      expect(res.result.sessionToken).toBeUndefined();
      expect(res.result.message).toMatch(/already exist/i);
    });

    it('never mints a session for an existing account with the wrong password', async () => {
      const res = await callFn('usersignup', {
        userDetails: {
          name: 'Impostor',
          email: owner.get('email'),
          password: 'not-the-password',
          role: 'contracts_User',
          company: 'Acme',
          jobTitle: 'Tester',
        },
      });
      expect(res.ok).toBe(true);
      expect(res.result.sessionToken).toBeUndefined();
      expect(res.result.message).toMatch(/already exist/i);
    });

    it('addadmin refuses an existing account without proof of ownership', async () => {
      const res = await callFn('addadmin', {
        userDetails: {
          name: 'Impostor Admin',
          email: stranger.get('email'),
          role: 'contracts_Admin',
          company: 'Acme',
          jobTitle: 'Boss',
        },
      });
      expect(res.ok).toBe(true);
      expect(res.result.sessionToken).toBeUndefined();
      expect(res.result.message).toMatch(/already exist/i);
    });

    it('addadmin bootstraps when the caller already holds that account session', async () => {
      // This is the old first-admin page: it creates the `_User` itself and
      // then calls `addadmin`, and now sends the password along with it.
      const bootstrap = await makeUser(uniqueEmail('bootstrap.admin'), 'Str0ng!pass');
      const res = await callFn(
        'addadmin',
        {
          userDetails: {
            name: 'Bootstrap Admin',
            email: bootstrap.get('email'),
            password: 'Str0ng!pass',
            role: 'contracts_Admin',
            company: 'Acme',
            jobTitle: 'Boss',
          },
        },
        properSession(bootstrap.__specSessionToken)
      );
      expect(res.ok).toBe(true);
      expect(res.result.message).toBe('User sign up');
      expect(res.result.sessionToken).toBeDefined();
    }, 60000);
  });

  /* ----------------------------------------------------------------- */
  describe('afterFind triggers sign every object', () => {
    let docs;

    beforeAll(async () => {
      docs = [];
      for (let i = 0; i < 3; i++) {
        const doc = new Parse.Object('contracts_Document');
        doc.set('Name', `List spec ${i}`);
        doc.set('Type', 'listspec');
        doc.set('URL', localFileUrl(`list-spec-${i}.pdf`));
        doc.set('CreatedBy', pointer('_User', owner.id));
        doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
        docs.push(await doc.save(null, { useMasterKey: true }));
      }
    }, 60000);

    it('signs the url on every document of a list query', async () => {
      const query = new Parse.Query('contracts_Document');
      query.equalTo('Type', 'listspec');
      const found = await query.find({ useMasterKey: true });
      expect(found.length).toBe(3);
      for (const doc of found) {
        expect(doc.get('URL')).toContain('?token=');
      }
    });

    it('keeps single-object behaviour identical', async () => {
      const query = new Parse.Query('contracts_Document');
      query.equalTo('objectId', docs[0].id);
      const found = await query.find({ useMasterKey: true });
      expect(found.length).toBe(1);
      expect(found[0].get('URL')).toContain('?token=');
    });

    it('signs profile pictures on every user of a list query', async () => {
      const target = await new Parse.Query(Parse.User).get(owner.id, { useMasterKey: true });
      target.set('ProfilePic', localFileUrl('avatar.png'));
      await target.save(null, { useMasterKey: true });

      // Scoped to this file's own two fixtures rather than every _User row in
      // the shared database, which coupled the assertion to whatever other spec
      // files had signed up.
      const query = new Parse.Query(Parse.User);
      query.containedIn('objectId', [owner.id, stranger.id]);
      const found = await query.find({ useMasterKey: true });
      expect(found.length).toBe(2);
      const signed = found.find(u => u.id === owner.id);
      expect(signed.get('ProfilePic')).toContain('?token=');
    });

    it('leaves objects without urls untouched and never throws', async () => {
      // contracts_Contactbook has no url-bearing column, so the afterFind
      // trigger must hand every field back exactly as stored. Asserting only
      // that rows came back checked neither half of the claim.
      const query = new Parse.Query('contracts_Contactbook');
      query.equalTo('objectId', signerContact.id);
      const found = await query.find({ useMasterKey: true });
      expect(found.length).toBe(1);
      const contact = found[0];
      expect(contact.get('Email')).toBe(signerEmail);
      expect(contact.get('Name')).toBe(signerContact.get('Name'));
      expect(contact.get('IsDeleted')).toBe(false);
      expect(contact.get('CreatedBy')?.id).toBe(owner.id);
      // Nothing was rewritten into a signed url on a class that has none.
      expect(JSON.stringify(contact.toJSON())).not.toContain('?token=');
    });
  });
});
