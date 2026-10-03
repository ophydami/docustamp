/**
 * Deleting an account (cloud/routes/deleteAccount/deleteUser.js) also removes
 * what used to outlive it: the apps it connected (OAuth grants), its webhooks,
 * the draft history of its documents and the requests to sign tied to it. And
 * none of another account's rows go with it.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { listApprovals } from '../cloud/lib/approvals.js';
import { loadCaller } from '../cloud/lib/context.js';
import { ensureVersionSchema } from '../cloud/lib/drafts.js';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { registerWebhook } from '../cloud/lib/webhooks.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { deleteUser } from '../cloud/routes/deleteAccount/deleteUser.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const APP_REDIRECT = 'https://app.example.test/oauth/callback';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

describe('Account deletion cleanup', () => {
  Parse.User.enableUnsafeCurrentUser();

  let clientId;
  let previousAllow;

  /** An account with its own workspace; `memberships` > 1 adds more tenants. */
  async function makeAccount(prefix, { memberships = 1, role = 'contracts_Admin' } = {}) {
    const email = uniqueEmail(prefix, 'example.test');
    const user = new Parse.User();
    user.set('username', email);
    user.set('password', 'pa55word!');
    user.set('email', email);
    await user.signUp();
    const signedIn = await Parse.User.logIn(email, 'pa55word!');
    const extUsers = [];
    for (let i = 0; i < memberships; i++) {
      const tenant = new Parse.Object('partners_Tenant');
      tenant.set('TenantName', `${prefix} ${i}`);
      tenant.set('UserId', signedIn.toPointer());
      await tenant.save(null, { useMasterKey: true });
      const extUser = new Parse.Object('contracts_Users');
      extUser.set('Name', `${prefix} person`);
      extUser.set('Email', email);
      extUser.set('UserId', signedIn.toPointer());
      extUser.set('TenantId', tenant.toPointer());
      extUser.set('UserRole', role);
      await extUser.save(null, { useMasterKey: true });
      extUsers.push(extUser);
    }
    const caller = await loadCaller(signedIn, { publicUrl: BASE, extUser: extUsers[0] });
    return { user: signedIn, extUser: extUsers[0], extUsers, email, caller };
  }

  async function makeDoc(account) {
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', 'Cleanup doc');
    doc.set('URL', `${BASE}/files/cleanup.pdf`);
    doc.set('CreatedBy', account.user.toPointer());
    doc.set('ExtUserPtr', account.extUser.toPointer());
    await doc.save(null, { useMasterKey: true });
    return doc;
  }

  async function addVersion(doc, account) {
    await ensureVersionSchema();
    const row = new Parse.Object('contracts_DocumentVersion');
    row.set('Document', pointer('contracts_Document', doc.id));
    row.set('CreatedBy', account.user.toPointer());
    await row.save(null, { useMasterKey: true });
    return row;
  }

  /** A request to sign `doc`, made by `requester`'s agent. */
  async function addApproval(doc, requester) {
    await listApprovals(requester.caller); // creates the locked-down class
    const row = new Parse.Object('contracts_SignApproval');
    row.set('Document', pointer('contracts_Document', doc.id));
    row.set('User', requester.user.toPointer());
    row.set('ExtUserPtr', requester.extUser.toPointer());
    row.set('Status', 'pending');
    await row.save(null, { useMasterKey: true });
    return row;
  }

  async function connect(account) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: APP_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st',
      resource: mcpResourceUrl(),
    });
    const res = await http.get(`${BASE}/oauth/authorize?${params}`);
    expect(res.status).toBe(302, JSON.stringify(res.data));
    const requestId = new URL(res.headers.location).searchParams.get('request');
    const { redirectUrl } = await Parse.Cloud.run(
      'oauthdecide',
      { requestId, approve: true },
      { sessionToken: account.user.getSessionToken() }
    );
    const token = await http.post(
      `${BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(redirectUrl).searchParams.get('code'),
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: APP_REDIRECT,
        resource: mcpResourceUrl(),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    expect(token.status).toBe(200, JSON.stringify(token.data));
    return token.data.access_token;
  }

  async function mcpStatus(accessToken) {
    const res = await http.post(
      `${BASE}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          public_url: BASE,
        },
      }
    );
    return res.status;
  }

  async function count(className, field, value) {
    return await new Parse.Query(className).equalTo(field, value).count({ useMasterKey: true });
  }

  async function exists(row) {
    return Boolean(
      await new Parse.Query(row.className).equalTo('objectId', row.id).first({ useMasterKey: true })
    );
  }

  beforeAll(async () => {
    previousAllow = process.env.ALLOW_PRIVATE_FETCH;
    process.env.ALLOW_PRIVATE_FETCH = 'true';
    resetRateLimits();
    const reg = await http.post(`${BASE}/oauth/register`, {
      client_name: 'Cleanup App',
      redirect_uris: [APP_REDIRECT],
    });
    expect(reg.status).toBe(201, JSON.stringify(reg.data));
    clientId = reg.data.client_id;
  });

  afterAll(() => {
    if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
    else process.env.ALLOW_PRIVATE_FETCH = previousAllow;
  });

  beforeEach(() => resetRateLimits());

  it('removes connected apps, webhooks, draft history and approvals, and only those of the account', async () => {
    const leaving = await makeAccount('cleanup.leaving');
    const staying = await makeAccount('cleanup.staying');

    const leavingDoc = await makeDoc(leaving);
    const stayingDoc = await makeDoc(staying);
    const leavingVersion = await addVersion(leavingDoc, leaving);
    const stayingVersion = await addVersion(stayingDoc, staying);
    // Someone asked to sign the leaving account's document, and the leaving
    // account's agent asked to sign the staying account's document.
    const onLeavingDoc = await addApproval(leavingDoc, staying);
    const byLeaving = await addApproval(stayingDoc, leaving);
    const stayingOwn = await addApproval(stayingDoc, staying);

    await registerWebhook(leaving.caller, { url: 'https://hooks.example.test/leaving' });
    await registerWebhook(staying.caller, { url: 'https://hooks.example.test/staying' });
    const leavingToken = await connect(leaving);
    const stayingToken = await connect(staying);
    expect(await mcpStatus(leavingToken)).toBe(200);

    const result = await deleteUser(leaving.user.id);
    expect(result.code).toBe(200, result.message);
    expect(result.message).toContain('your connected apps and your webhooks');

    expect(await count('contracts_OAuthGrant', 'User', leaving.user.toPointer())).toBe(0);
    expect(await mcpStatus(leavingToken)).toBe(401);
    expect(await count('contracts_Webhook', 'CreatedBy', leaving.user.toPointer())).toBe(0);
    expect(await exists(leavingVersion)).toBe(false);
    expect(await exists(onLeavingDoc)).toBe(false);
    expect(await exists(byLeaving)).toBe(false);

    expect(await count('contracts_OAuthGrant', 'User', staying.user.toPointer())).toBe(1);
    expect(await mcpStatus(stayingToken)).toBe(200);
    expect(await count('contracts_Webhook', 'CreatedBy', staying.user.toPointer())).toBe(1);
    expect(await exists(stayingVersion)).toBe(true);
    expect(await exists(stayingOwn)).toBe(true);
    expect(await exists(stayingDoc)).toBe(true);
  });

  it('keeps the account-wide rows when the account still has another workspace', async () => {
    const shared = await makeAccount('cleanup.shared', { memberships: 2, role: 'contracts_User' });
    const otherOwner = await makeAccount('cleanup.other');
    const sharedDoc = await makeDoc(shared);
    const version = await addVersion(sharedDoc, shared);
    const otherDoc = await makeDoc(otherOwner);
    const request = await addApproval(otherDoc, shared);
    await registerWebhook(shared.caller, { url: 'https://hooks.example.test/shared' });
    await connect(shared);

    // An admin of the first workspace removes the member from it.
    const result = await deleteUser(
      shared.user.id,
      otherOwner.user.id,
      shared.extUsers[0].get('TenantId'),
      false,
      null
    );
    expect(result.code).toBe(409, result.message);

    // This workspace's rows are gone...
    expect(await exists(version)).toBe(false);
    expect(await exists(request)).toBe(false);
    // ...the login's own connections stay with the login.
    expect(await count('contracts_OAuthGrant', 'User', shared.user.toPointer())).toBe(1);
    expect(await count('contracts_Webhook', 'CreatedBy', shared.user.toPointer())).toBe(1);
  });
});
