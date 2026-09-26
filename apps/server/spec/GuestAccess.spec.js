/**
 * Coverage for the guest-signing access model: `getDocument`, `getcontact`,
 * `triggerevent`, `declinedoc`, `linkcontacttodoc`, `getsignedurl` and the new
 * `getsigninglinks`.
 *
 * All of these used to trust whatever the caller typed. A docId travels in every
 * signing link and `getDocument` used to hand out every contactId, so "knows a
 * docId" was effectively public knowledge. Every call below therefore goes over
 * raw HTTP with exactly the credentials a guest would really have: none, a
 * signing-link token, or a session.
 */
import axios from 'axios';
import { serverAppId } from '../Utils.js';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.7',
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

/** The header spelling the frontends use; Parse Server itself ignores it. */
const legacySession = token => ({ sessionToken: token });

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
  user.__specSessionToken = await loginToken(email, password);
  return user;
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

describe('guest access', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let ownerSession;
  let ownerExt;
  let tenant;
  let stranger;
  let strangerSession;
  let signerUser;
  let signerContact;
  let otherContact;

  const UNBOUND_EMAIL = 'unbound.guest@example.com';

  async function makeDocument(extra = {}) {
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', 'Guest access spec');
    doc.set('URL', localFileUrl('guest-access.pdf'));
    doc.set('SignedUrl', localFileUrl('guest-access.pdf'));
    doc.set('CreatedBy', pointer('_User', owner.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
    doc.set('Signers', [pointer('contracts_Contactbook', signerContact.id)]);
    doc.set('Placeholders', [
      {
        Id: 1,
        Role: 'Role 1',
        signerObjId: signerContact.id,
        signerPtr: pointer('contracts_Contactbook', signerContact.id),
        email: signerContact.get('Email'),
        placeHolder: [{ pageNumber: 1, pos: [] }],
      },
      {
        Id: 2,
        Role: 'Role 2',
        email: UNBOUND_EMAIL,
        placeHolder: [{ pageNumber: 1, pos: [] }],
      },
    ]);
    doc.set('DocSentAt', new Date());
    const acl = new Parse.ACL();
    acl.setReadAccess(owner.id, true);
    acl.setWriteAccess(owner.id, true);
    doc.setACL(acl);
    for (const [key, value] of Object.entries(extra)) doc.set(key, value);
    return await doc.save(null, { useMasterKey: true });
  }

  function tokenFor(docId, contactId) {
    return mintSigningToken({ docId, contactId, expiresAt: Date.now() + 60000 });
  }

  beforeAll(async () => {
    owner = await makeUser('owner.guest@example.com');
    ownerSession = owner.__specSessionToken;
    stranger = await makeUser('stranger.guest@example.com');
    strangerSession = stranger.__specSessionToken;
    signerUser = await makeUser('signer.guest@example.com');

    const tenantObj = new Parse.Object('partners_Tenant');
    tenantObj.set('TenantName', 'Guest Access Ltd');
    tenantObj.set('FileAdapters', { provider: 'do', secret: 'super-secret' });
    tenantObj.set('PfxFile', { base64: 'private-pfx-bytes', password: 'pfx-secret' });
    tenantObj.set('CreatedBy', pointer('_User', owner.id));
    tenant = await tenantObj.save(null, { useMasterKey: true });

    const ext = new Parse.Object('contracts_Users');
    ext.set('UserId', pointer('_User', owner.id));
    ext.set('Email', owner.get('email'));
    ext.set('Name', 'Guest Owner');
    ext.set('UserRole', 'contracts_User');
    ext.set('TenantId', pointer('partners_Tenant', tenant.id));
    ownerExt = await ext.save(null, { useMasterKey: true });

    const contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'Guest Signer');
    contact.set('Email', signerUser.get('email'));
    contact.set('CreatedBy', pointer('_User', owner.id));
    contact.set('UserId', pointer('_User', signerUser.id));
    contact.set('IsDeleted', false);
    signerContact = await contact.save(null, { useMasterKey: true });

    const other = new Parse.Object('contracts_Contactbook');
    other.set('Name', 'Someone Else');
    other.set('Email', 'someone.else.guest@example.com');
    other.set('CreatedBy', pointer('_User', owner.id));
    other.set('UserId', pointer('_User', stranger.id));
    other.set('IsDeleted', false);
    otherContact = await other.save(null, { useMasterKey: true });
  }, 120000);

  beforeEach(() => resetRateLimits());

  /* ----------------------------------------------------------------- */
  describe('getDocument', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('refuses an anonymous caller who only knows the docId', async () => {
      const res = await callFn('getDocument', { docId: doc.id });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('opens the document for a valid signing token', async () => {
      const res = await callFn('getDocument', {
        docId: doc.id,
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);
      expect(res.result?.objectId).toBe(doc.id);
      expect(res.result?.Signers?.[0]?.Email).toBe(signerUser.get('email'));
    });

    it('never leaks credentials or tenant secrets to a signer', async () => {
      const res = await callFn('getDocument', {
        docId: doc.id,
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);
      const body = JSON.stringify(res.result);
      expect(body).not.toContain('authData');
      expect(body).not.toContain('sessionToken');
      expect(body).not.toContain('super-secret');
      expect(body).not.toContain('pfx-secret');
      expect(res.result?.ExtUserPtr?.TenantId?.TenantName).toBe('Guest Access Ltd');
      expect(res.result?.ExtUserPtr?.TenantId?.FileAdapters).toBeUndefined();
      expect(res.result?.ExtUserPtr?.UserId).toBeUndefined();
      expect(Object.keys(res.result?.CreatedBy || {}).sort()).toEqual([
        'email',
        'name',
        'objectId',
      ]);
    });

    it('refuses a token minted for a contact who is not on this document', async () => {
      const res = await callFn('getDocument', {
        docId: doc.id,
        signingToken: tokenFor(doc.id, otherContact.id),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses a token minted for another document', async () => {
      const res = await callFn('getDocument', {
        docId: doc.id,
        signingToken: tokenFor('someotherdoc', signerContact.id),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses a stranger with a session', async () => {
      const res = await callFn('getDocument', { docId: doc.id }, legacySession(strangerSession));
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('gives the owner the fuller row, still without credentials', async () => {
      const res = await callFn('getDocument', { docId: doc.id }, legacySession(ownerSession));
      expect(res.ok).toBe(true);
      expect(res.result?.ExtUserPtr?.UserId?.objectId).toBe(owner.id);
      const body = JSON.stringify(res.result);
      expect(body).not.toContain('authData');
      expect(body).not.toContain('super-secret');
    });
  });

  /* ----------------------------------------------------------------- */
  describe('getcontact', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('accepts a signing token as proof for the anonymous path', async () => {
      const res = await callFn('getcontact', {
        contactId: signerContact.id,
        docId: doc.id,
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);
      expect(res.result?.Email).toBe(signerUser.get('email'));
    });
  });

  /* ----------------------------------------------------------------- */
  describe('triggerevent', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
      const update = new Parse.Object('contracts_Document');
      update.id = doc.id;
      update.set('AuditTrail', [
        {
          UserPtr: pointer('contracts_Contactbook', signerContact.id),
          Activity: 'Signed',
          SignedOn: new Date().toISOString(),
          ipAddress: '203.0.113.9',
        },
      ]);
      await update.save(null, { useMasterKey: true });
    }, 60000);

    it('refuses an audit write for a contact who is not on the document', async () => {
      // Documents created before the token cutover keep the legacy
      // `docId + contactId` grace, so this is the check that still bites: the
      // contact has to belong to the document either way.
      const res = await callFn('triggerevent', {
        event: 'viewed',
        contactId: otherContact.id,
        body: { objectId: doc.id },
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses a token holder writing another signer slot', async () => {
      const res = await callFn('triggerevent', {
        event: 'viewed',
        contactId: otherContact.id,
        body: { objectId: doc.id },
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('never downgrades a Signed entry to Viewed', async () => {
      const res = await callFn('triggerevent', {
        event: 'viewed',
        contactId: signerContact.id,
        body: { objectId: doc.id },
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);

      const fresh = await new Parse.Query('contracts_Document').get(doc.id, {
        useMasterKey: true,
      });
      const trail = fresh.get('AuditTrail');
      expect(trail.length).toBe(1);
      expect(trail[0].Activity).toBe('Signed');
    });
  });

  /* ----------------------------------------------------------------- */
  describe('declinedoc', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('refuses an anonymous decline', async () => {
      const res = await callFn('declinedoc', {
        docId: doc.id,
        reason: 'nope',
        userId: stranger.id,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('declines for a token holder and ignores the client-supplied userId', async () => {
      const res = await callFn('declinedoc', {
        docId: doc.id,
        reason: 'not my contract',
        // The old signature let the caller pin the decline on anyone.
        userId: stranger.id,
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);

      const fresh = await new Parse.Query('contracts_Document').get(doc.id, {
        useMasterKey: true,
      });
      expect(fresh.get('IsDeclined')).toBe(true);
      expect(fresh.get('DeclineReason')).toBe('not my contract');
      expect(fresh.get('DeclineBy')?.id).toBe(signerUser.id);
      expect(fresh.get('DeclineBy')?.id).not.toBe(stranger.id);
      expect(fresh.get('DeclineByContact')?.id).toBe(signerContact.id);
    });

    it('refuses to decline a document twice', async () => {
      const res = await callFn('declinedoc', {
        docId: doc.id,
        reason: 'again',
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(false);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('getsignedurl', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('signs a url that is stored on the document', async () => {
      const res = await callFn('getsignedurl', {
        docId: doc.id,
        url: localFileUrl('guest-access.pdf'),
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(true);
      expect(typeof res.result).toBe('string');
      expect(res.result).toContain('token=');
    });

    it('refuses a url that is not on the document', async () => {
      const res = await callFn('getsignedurl', {
        docId: doc.id,
        url: localFileUrl('someone-elses-contract.pdf'),
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses an anonymous caller with no document at all', async () => {
      const res = await callFn('getsignedurl', { url: localFileUrl('guest-access.pdf') });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('getsigninglinks', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('refuses an anonymous caller', async () => {
      const res = await callFn('getsigninglinks', { docId: doc.id });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });

    it('refuses a signed-in stranger', async () => {
      const res = await callFn(
        'getsigninglinks',
        { docId: doc.id },
        legacySession(strangerSession)
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('returns a tokenised link per recipient for the owner', async () => {
      const res = await callFn(
        'getsigninglinks',
        { docId: doc.id },
        { ...legacySession(ownerSession), public_url: 'https://sign.example.test' }
      );
      expect(res.ok).toBe(true);
      const link = (res.result?.links || []).find(x => x.contactId === signerContact.id);
      expect(link).toBeDefined();
      expect(link.email).toBe(signerUser.get('email'));
      expect(typeof link.signingToken).toBe('string');
      expect(link.signingToken.length).toBeGreaterThan(10);
      const encoded = link.url.split('/login/')[1];
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      expect(decoded.split('/').length).toBe(4);
      expect(decoded.endsWith(link.signingToken)).toBe(true);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('linkcontacttodoc', () => {
    let doc;
    beforeAll(async () => {
      doc = await makeDocument();
    }, 60000);

    it('refuses an anonymous caller binding an unbound placeholder', async () => {
      const res = await callFn('linkcontacttodoc', {
        docId: doc.id,
        email: UNBOUND_EMAIL,
        name: 'Unbound Guest',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('refuses a token holder binding somebody else placeholder', async () => {
      const res = await callFn('linkcontacttodoc', {
        docId: doc.id,
        email: UNBOUND_EMAIL,
        name: 'Unbound Guest',
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    });

    it('lets the owner bind the placeholder', async () => {
      const res = await callFn(
        'linkcontacttodoc',
        { docId: doc.id, email: UNBOUND_EMAIL, name: 'Unbound Guest' },
        legacySession(ownerSession)
      );
      expect(res.ok).toBe(true);
      expect(typeof res.result?.contactId).toBe('string');

      const fresh = await new Parse.Query('contracts_Document').get(doc.id, {
        useMasterKey: true,
      });
      const bound = fresh.get('Placeholders').find(p => p.email === UNBOUND_EMAIL);
      expect(bound.signerObjId).toBe(res.result.contactId);
    });
  });
});
