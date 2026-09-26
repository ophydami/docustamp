/**
 * Coverage for the file-url rules in `cloud/lib/files.js`:
 *
 *   assertFetchableUrl   what the server is allowed to GET (SSRF guard),
 *   resolveFileUrl       what gets signed or presigned (only our own urls),
 *   assertStoredFileUrl  what may be written onto a document,
 *
 * plus the ownership `createdocumentfromapp` now derives from the session
 * instead of from the payload.
 */
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import { serverAppId } from '../Utils.js';
import {
  assertFetchableUrl,
  assertStoredFileUrl,
  isStoredFileUrl,
  resolveFileUrl,
  storedFileUrl,
} from '../cloud/lib/files.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create({ validateStatus: () => true });

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
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

async function makeExtUser(user) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'File Person');
  extUser.set('Email', user.get('email'));
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  return await extUser.save(null, { useMasterKey: true });
}

function callerFor(user, extUser) {
  return { userId: user.id, tenantId: extUser.get('TenantId')?.id || '' };
}

async function makePdfBytes() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText('Hello');
  return new Uint8Array(await pdf.save());
}

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': APP_ID,
      'X-Parse-Javascript-Key': JS_KEY,
      'x-real-ip': '10.0.0.7',
      ...headers,
    },
  });
  if (res.status === 200 && res.data?.result !== undefined) {
    return { ok: true, result: res.data.result };
  }
  return { ok: false, code: res.data?.code, error: res.data?.error };
}

describe('file url handling', () => {
  Parse.User.enableUnsafeCurrentUser();

  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_FETCH;
  });

  /* ----------------------------------------------------------------- */
  describe('assertFetchableUrl', () => {
    const refused = [
      ['loopback by address', 'http://127.0.0.1:9/secret.pdf'],
      ['a private range', 'http://10.1.2.3/secret.pdf'],
      ['another private range', 'http://192.168.0.5/secret.pdf'],
      ['the link local metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['CGNAT space', 'http://100.100.100.200/secret.pdf'],
      ['IPv6 loopback', 'http://[::1]:9/secret.pdf'],
      ['a hostname that resolves to loopback', 'http://localhost:9/secret.pdf'],
      ['the cloud metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ];

    for (const [label, url] of refused) {
      it(`refuses ${label}`, async () => {
        await expectAsync(assertFetchableUrl(url)).toBeRejectedWithError(/could not be fetched/);
      });
    }

    it('gives every network refusal the same message, so it is not an oracle', async () => {
      const messages = [];
      for (const [, url] of refused) {
        await assertFetchableUrl(url).catch(err => messages.push(err.message));
      }
      expect(new Set(messages).size).toBe(1);
      expect(messages.length).toBe(refused.length);
    });

    it('refuses anything that is not http(s)', async () => {
      for (const url of ['file:///etc/passwd', 'ftp://example.test/x.pdf', 'not a url', '']) {
        await expectAsync(assertFetchableUrl(url)).toBeRejectedWithError(/http\(s\)/);
      }
    });

    it('allows our own storage origin even though it is loopback', async () => {
      await expectAsync(assertFetchableUrl(localFileUrl('own.pdf'))).toBeResolved();
    });

    it('allows a private host only when ALLOW_PRIVATE_FETCH is set', async () => {
      process.env.ALLOW_PRIVATE_FETCH = 'true';
      await expectAsync(assertFetchableUrl('http://127.0.0.1:9/secret.pdf')).toBeResolved();
    });
  });

  /* ----------------------------------------------------------------- */
  describe('resolveFileUrl', () => {
    it('signs a local file of ours', async () => {
      const signed = await resolveFileUrl(localFileUrl('mine.pdf'));
      expect(signed.split('?')[0]).toBe(localFileUrl('mine.pdf'));
      expect(signed).toContain('token=');
    });

    it('drops a caller supplied token instead of signing it in', async () => {
      const signed = await resolveFileUrl(`${localFileUrl('mine.pdf')}?token=whatever`);
      expect(signed.split('?')[0]).toBe(localFileUrl('mine.pdf'));
      expect(signed).not.toContain('token=whatever');
    });

    it('refuses a foreign host and never mints a JWT for it', async () => {
      let error;
      await resolveFileUrl('https://evil.example.test/files/secret.pdf').catch(e => (error = e));
      expect(error).toBeDefined();
      expect(error.message).toBe('The file could not be fetched.');
    });

    it('returns a fetchable foreign url untouched', async () => {
      process.env.ALLOW_PRIVATE_FETCH = 'true';
      const url = 'https://files.example.test/files/report.pdf';
      expect(await resolveFileUrl(url)).toBe(url);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('assertStoredFileUrl', () => {
    let user;
    let extUser;
    let caller;

    beforeAll(async () => {
      user = await makeUser('fileowner');
      extUser = await makeExtUser(user);
      caller = callerFor(user, extUser);
    }, 60000);

    it('recognises our own stored urls', () => {
      expect(isStoredFileUrl(localFileUrl('a.pdf'))).toBeTrue();
      expect(storedFileUrl(`${localFileUrl('a.pdf')}?token=x`)).toBe(localFileUrl('a.pdf'));
      expect(isStoredFileUrl('https://files.example.test/a.pdf')).toBeFalse();
      expect(isStoredFileUrl('http://localhost:30001/test/classes/contracts_Document')).toBeFalse();
    });

    it('accepts our local shape and strips the query string', async () => {
      const url = await assertStoredFileUrl(`${localFileUrl('stored.pdf')}?token=abc`, caller);
      expect(url).toBe(localFileUrl('stored.pdf'));
    });

    it('requires a url at all', async () => {
      await expectAsync(assertStoredFileUrl('', caller)).toBeRejectedWithError(/url is required/);
      await expectAsync(assertStoredFileUrl('javascript:alert(1)', caller)).toBeRejectedWithError(
        /http\(s\)/
      );
    });

    it('downloads and re-uploads an external url so no third party serves the bytes', async () => {
      process.env.ALLOW_PRIVATE_FETCH = 'true';
      const pdfBytes = await makePdfBytes();
      const copy = localFileUrl('abcdefghijkl_lease.pdf');
      spyOn(axios, 'get').and.callFake(async () => ({
        data: pdfBytes.buffer.slice(0),
        status: 200,
      }));
      const post = spyOn(axios, 'post').and.callFake(async () => ({
        data: { name: 'abcdefghijkl_lease.pdf', url: copy },
      }));

      const stored = await assertStoredFileUrl('https://files.example.test/lease.pdf', caller);
      expect(stored).toBe(copy);
      expect(axios.get).toHaveBeenCalled();
      expect(post).toHaveBeenCalled();
      expect(String(post.calls.mostRecent().args[0])).toContain('/files/');
    });

    it('refuses a stored url another account is already using', async () => {
      const other = await makeUser('filestranger');
      const otherExt = await makeExtUser(other);
      const url = localFileUrl('theirs.pdf');
      const doc = new Parse.Object('contracts_Document');
      doc.set('Name', 'Theirs');
      doc.set('URL', url);
      doc.set('CreatedBy', other.toPointer());
      doc.set('ExtUserPtr', otherExt.toPointer());
      await doc.save(null, { useMasterKey: true });
      await Parse.User.logIn(user.get('email'), 'pa55word!');

      let error;
      await assertStoredFileUrl(url, caller).catch(e => (error = e));
      expect(error).toBeDefined();
      expect(error.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      // The owner may of course keep using it.
      expect(await assertStoredFileUrl(url, callerFor(other, otherExt))).toBe(url);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('createdocumentfromapp', () => {
    let owner;
    let ownerExt;
    let stranger;
    let strangerExt;

    beforeAll(async () => {
      owner = await makeUser('appowner');
      ownerExt = await makeExtUser(owner);
      stranger = await makeUser('appstranger');
      strangerExt = await makeExtUser(stranger);
      await Parse.User.logIn(owner.get('email'), 'pa55word!');
    }, 60000);

    it('files the document under the session, ignoring the payload pointers', async () => {
      const res = await callFn(
        'createdocumentfromapp',
        {
          document: {
            Name: 'Ownership test',
            URL: localFileUrl('app-created.pdf'),
            CreatedBy: { __type: 'Pointer', className: '_User', objectId: stranger.id },
            ExtUserPtr: {
              __type: 'Pointer',
              className: 'contracts_Users',
              objectId: strangerExt.id,
            },
          },
        },
        { 'X-Parse-Session-Token': owner.getSessionToken() }
      );
      expect(res.ok).toBeTrue();
      const saved = await new Parse.Query('contracts_Document').get(res.result.objectId, {
        useMasterKey: true,
      });
      expect(saved.get('CreatedBy').id).toBe(owner.id);
      expect(saved.get('ExtUserPtr').id).toBe(ownerExt.id);
      // The afterFind trigger hands back a signed url, so compare the bare one.
      expect(saved.get('URL').split('?')[0]).toBe(localFileUrl('app-created.pdf'));
    });

    it('refuses a url that is not a file of ours without copying it blindly', async () => {
      const res = await callFn(
        'createdocumentfromapp',
        { document: { Name: 'External', URL: 'http://169.254.169.254/latest/meta-data/' } },
        { 'X-Parse-Session-Token': owner.getSessionToken() }
      );
      expect(res.ok).toBeFalse();
      expect(res.error).toContain('could not be fetched');
    });

    it('needs a session', async () => {
      const res = await callFn('createdocumentfromapp', {
        document: { Name: 'Anon', URL: localFileUrl('anon.pdf') },
      });
      expect(res.ok).toBeFalse();
      expect(res.code).toBe(Parse.Error.INVALID_SESSION_TOKEN);
    });
  });
  /* ----------------------------------------------------------------- */
  describe('getsignedurl across accounts', () => {
    let owner;
    let ownerExt;
    let stranger;
    let doc;

    beforeAll(async () => {
      owner = await makeUser('urlowner');
      ownerExt = await makeExtUser(owner);
      stranger = await makeUser('urlstranger');
      await makeExtUser(stranger);
      doc = new Parse.Object('contracts_Document');
      doc.set('Name', 'Signed url scope');
      doc.set('URL', localFileUrl('scoped-doc.pdf'));
      doc.set('CreatedBy', owner.toPointer());
      doc.set('ExtUserPtr', ownerExt.toPointer());
      await doc.save(null, { useMasterKey: true });
    }, 60000);

    it('signs the owner own document url', async () => {
      const res = await callFn(
        'getsignedurl',
        { docId: doc.id, url: localFileUrl('scoped-doc.pdf') },
        { 'X-Parse-Session-Token': owner.getSessionToken() }
      );
      expect(res.ok).toBeTrue();
      expect(String(res.result)).toContain('token=');
    });

    it('refuses another account holding only the document id', async () => {
      // A docId travels in every signing link, so knowing one must not be
      // enough to mint a read link to the file behind it.
      const res = await callFn(
        'getsignedurl',
        { docId: doc.id, url: localFileUrl('scoped-doc.pdf') },
        { 'X-Parse-Session-Token': stranger.getSessionToken() }
      );
      expect(res.ok).toBeFalse();
      expect([Parse.Error.OPERATION_FORBIDDEN, Parse.Error.OBJECT_NOT_FOUND]).toContain(res.code);
      expect(String(res.error || '')).not.toContain('Signed url scope');
    });

    it('refuses a signed-in caller asking for a file on a foreign host', async () => {
      const res = await callFn(
        'getsignedurl',
        { url: 'https://files.elsewhere.test/files/other.pdf' },
        { 'X-Parse-Session-Token': stranger.getSessionToken() }
      );
      // A `/files/` path on somebody else's host is refused outright rather
      // than signed: the token would otherwise say this server vouches for it.
      expect(res.ok).toBeFalse();
      expect(String(res.error || '')).toContain('stored on this server');
    });
  });
});
