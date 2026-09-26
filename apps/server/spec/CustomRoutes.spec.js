/**
 * Coverage for the two custom Express routes that sit next to the Parse mount:
 * `/decryptpdf` (anonymous file upload -> path traversal + password oracle) and
 * the tenant scoping of the account-deletion helpers.
 *
 * `spec/utils/test-runner.js` mounts the same express `app` that `index.js`
 * exports on port 30001, so the routes answer at the bare origin (the Parse API
 * itself lives under `/test`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { scopedDeletionQuery } from '../cloud/routes/deleteAccount/deleteFileUrl.js';

const ORIGIN = 'http://localhost:30001';
const PARSE_URL = `${ORIGIN}/test`;
const APP_ID = 'test';
const JS_KEY = 'test';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function loginToken(email, password) {
  const res = await fetch(`${PARSE_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': APP_ID,
      'X-Parse-Javascript-Key': JS_KEY,
    },
    body: JSON.stringify({ username: email, password }),
  });
  const json = await res.json();
  return json.sessionToken;
}

async function makeUser(email, password = 'Str0ng!pass') {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', password);
  user.set('name', email.split('@')[0]);
  await user.signUp();
  return await loginToken(email, password);
}

/** Everything under `dir`, relative, so a stray write shows up as a new entry. */
function listTree(dir) {
  const out = [];
  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(serverRoot, full));
    }
  };
  walk(dir);
  return out.sort();
}

function watchedTrees() {
  return [
    ...listTree(path.join(serverRoot, 'files')),
    ...listTree(path.join(serverRoot, 'exports')),
  ].sort();
}

/** A tiny but structurally real PDF, enough to clear the `%PDF-` magic gate. */
function pdfBytes() {
  return new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n'
  );
}

async function postDecrypt({ fileName, bytes, type, password = '', headers = {} }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), fileName);
  form.append('password', password);
  return await fetch(`${ORIGIN}/decryptpdf`, { method: 'POST', body: form, headers });
}

describe('custom routes', () => {
  describe('/decryptpdf', () => {
    let sessionToken;

    beforeAll(async () => {
      sessionToken = await makeUser('decrypt.caller@example.com');
    });

    beforeEach(() => resetRateLimits());

    it('refuses an anonymous caller', async () => {
      const res = await postDecrypt({
        fileName: 'secret.pdf',
        bytes: pdfBytes(),
        type: 'application/pdf',
        headers: { 'x-real-ip': '10.1.0.1' },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it('rejects a non-PDF payload from an authenticated caller', async () => {
      const res = await postDecrypt({
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('this is not a pdf at all'),
        type: 'text/plain',
        headers: { sessiontoken: sessionToken, 'x-real-ip': '10.1.0.2' },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/pdf/i);
    });

    it('accepts the `X-Parse-Session-Token` spelling as well', async () => {
      const res = await postDecrypt({
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('still not a pdf'),
        type: 'text/plain',
        headers: { 'X-Parse-Session-Token': sessionToken, 'x-real-ip': '10.1.0.3' },
      });
      // 400 (not 401) proves the session was accepted and the content rejected.
      expect(res.status).toBe(400);
    });

    it('never writes the upload to disk, whatever the filename claims', async () => {
      const before = watchedTrees();
      const res = await postDecrypt({
        fileName: '../files/files/pwned_contract.pdf',
        bytes: pdfBytes(),
        type: 'application/pdf',
        headers: { sessiontoken: sessionToken, 'x-real-ip': '10.1.0.4' },
      });
      // Whatever cpdf makes of the payload, it must not be a server error and
      // it must not have landed anywhere on disk.
      expect(res.status).toBeLessThan(500);
      const after = watchedTrees();
      expect(after).toEqual(before);
      const escaped = after.filter(entry => /pwned_contract/.test(entry));
      expect(escaped).toEqual([]);
    });

    it('rate limits a hammering IP', async () => {
      const ip = '10.1.0.5';
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) {
        const res = await postDecrypt({
          fileName: 'x.pdf',
          bytes: pdfBytes(),
          type: 'application/pdf',
          headers: { sessiontoken: sessionToken, 'x-real-ip': ip },
        });
        if (res.status === 429) limited = true;
        else await res.arrayBuffer();
      }
      expect(limited).toBe(true);
    });
  });

  /**
   * The deletion handler needs a whole admin/tenant fixture to drive end to
   * end, so the tenant boundary is tested where it is actually decided: the
   * exported query builder every deletion page runs through.
   */
  describe('account deletion scoping', () => {
    const extUserPtr = pointer('contracts_Users', 'membershipInTenantA');
    const otherUser = pointer('_User', 'sharedUser');
    const tenantPtr = pointer('partners_Tenant', 'tenantA');

    it('scopes documents by the authorized contracts_Users row, not the _User', () => {
      const where = scopedDeletionQuery('contracts_Document', { extUserPtr }).toJSON().where;
      expect(where.ExtUserPtr).toEqual(extUserPtr);
      expect(where.CreatedBy).toBeUndefined();
      expect(where.UserId).toBeUndefined();
    });

    it('pins the tenant when a class is keyed by a bare _User pointer', () => {
      const contacts = scopedDeletionQuery('contracts_Contactbook', {
        createdBy: otherUser,
        tenantPtr,
      }).toJSON().where;
      expect(contacts.CreatedBy).toEqual(otherUser);
      expect(contacts.TenantId).toEqual(tenantPtr);

      const dataFiles = scopedDeletionQuery('partners_DataFiles', {
        userId: otherUser,
        tenantPtr,
        tenantField: 'TenantPtr',
      }).toJSON().where;
      expect(dataFiles.UserId).toEqual(otherUser);
      expect(dataFiles.TenantPtr).toEqual(tenantPtr);
      expect(dataFiles.TenantId).toBeUndefined();
    });

    it('refuses to build a query with no owner constraint at all', () => {
      expect(() => scopedDeletionQuery('contracts_Document', { tenantPtr })).toThrowError(
        /unscoped/i
      );
      expect(() => scopedDeletionQuery('contracts_Document')).toThrowError(/unscoped/i);
    });

    it('pages at parse-server maxLimit so a second page is actually fetched', () => {
      expect(scopedDeletionQuery('contracts_Document', { extUserPtr }).toJSON().limit).toBe(500);
    });
  });
});
