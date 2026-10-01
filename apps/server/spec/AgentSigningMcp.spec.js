/**
 * Agents that sign, over real MCP calls with an OAuth connection: the
 * documents:sign scope and its switch (cloud/lib/oauth.js,
 * parsefunction/oauthFunctions.js), `sign_document`, and "sign for me and send"
 * (`signForMe` and `me` recipients, cloud/lib/documents.js sendDocument). The
 * signature itself is lib/agentSign.js; this file checks the surface around it.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { VERIFY_EMAIL_HINT } from '../cloud/lib/agentIdentity.js';
import { setAgentSignMailTransport } from '../cloud/lib/agentSign.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { resetIdempotency } from '../cloud/api/shared.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const PDF_URL = `${BASE}/files/test/agent-lease.pdf`;
const SIGN_OFF = "Signing is off for this app. Turn on 'Can sign for me' for ChatGPT";

async function makeAccount(prefix, { verified = false } = {}) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  const signedIn = await Parse.User.logIn(email, 'pa55word!');
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', signedIn.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', email);
  extUser.set('Company', 'Acme Inc');
  extUser.set('UserId', signedIn.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  if (verified) await setVerified(signedIn, true);
  return signedIn;
}

async function setVerified(user, value) {
  const row = new Parse.User();
  row.id = user.id;
  row.set('emailVerified', value);
  await row.save(null, { useMasterKey: true });
}

async function makePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Residential Lease Agreement', { x: 72, y: 720, size: 14, font });
  page.drawText('Landlord signature: ______________________', { x: 72, y: 300, size: 12, font });
  page.drawText('Tenant signature: ______________________', { x: 72, y: 200, size: 12, font });
  return new Uint8Array(await pdf.save());
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function startConnect(clientId, scope) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: mcpResourceUrl(),
  });
  if (scope) params.set('scope', scope);
  const res = await http.get(`${BASE}/oauth/authorize?${params}`);
  expect(res.status).toBe(302, JSON.stringify(res.data));
  return { requestId: new URL(res.headers.location).searchParams.get('request'), verifier };
}

async function finishConnect(clientId, as, { requestId, verifier }, decide = {}) {
  const { redirectUrl } = await Parse.Cloud.run(
    'oauthdecide',
    { requestId, approve: true, ...decide },
    { sessionToken: as.getSessionToken() }
  );
  const code = new URL(redirectUrl).searchParams.get('code');
  const res = await http.post(
    `${BASE}/oauth/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      resource: mcpResourceUrl(),
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  expect(res.status).toBe(200, JSON.stringify(res.data));
  return res.data;
}

async function mcp(accessToken, method, params = {}) {
  return await http.post(
    `${BASE}/mcp`,
    { jsonrpc: '2.0', id: 1, method, params },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        public_url: BASE,
      },
    }
  );
}

/** Call a tool; `{error}` with the text when it failed, else the parsed JSON. */
async function tool(accessToken, name, args) {
  const res = await mcp(accessToken, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200, JSON.stringify(res.data));
  const result = res.data.result;
  const text = result?.content?.[0]?.text || '';
  if (result?.isError) return { error: text, raw: text };
  return { body: JSON.parse(text), raw: text };
}

/** The two-role lease the fake model proposes; landlord first unless told otherwise. */
function leaseProposal({ landlordFirst = true, inOrder = true } = {}) {
  const landlord = { key: 'landlord', label: 'Landlord', name: '', email: '', is_sender: false };
  const tenant = { key: 'tenant', label: 'Tenant', name: '', email: '', is_sender: false };
  const box = (role, y) => ({
    role,
    type: 'signature',
    label: `${role} signature`,
    page: 1,
    placement: 'absolute',
    x: 250,
    y,
    width: 150,
    height: 40,
    required: true,
  });
  return {
    title: 'Residential Lease Agreement',
    summary: 'A lease between a landlord and a tenant. Both sign.',
    document_type: 'lease',
    language: 'en',
    roles: landlordFirst ? [landlord, tenant] : [tenant, landlord],
    fields: [box('landlord', 470), box('tenant', 570)],
    signing_order_matters: inOrder,
    warnings: [],
  };
}

describe('Agents that sign over MCP', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let unverified;
  let clientId;
  let pdfBytes;
  let requestMails;
  let ownerNotices;
  let proposal;
  let aiRequests;
  let tenantSeq = 0;

  const nextTenant = () => {
    tenantSeq += 1;
    return uniqueEmail(`tina.tenant.${tenantSeq}`, 'example.test');
  };
  const mailedTo = () => requestMails.map(m => String(m.recipient).toLowerCase());

  /** A connection for `as`, with the "Can sign for me" box ticked or not. */
  async function connect(as = owner, { scope, allowSigning } = {}) {
    const started = await startConnect(clientId, scope);
    return await finishConnect(clientId, as, started, allowSigning ? { allowSigning: true } : {});
  }

  async function grantsOf(as) {
    return (await Parse.Cloud.run('listoauthgrants', {}, { sessionToken: as.getSessionToken() }))
      .grants;
  }

  async function auditOf(docId) {
    const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    return doc.get('AuditTrail') || [];
  }

  beforeAll(async () => {
    // signPdf reads a keystore even for a signature that does not complete.
    process.env.PFX_BASE64 = process.env.PFX_BASE64 || '';
    owner = await makeAccount('agent.mcp.owner', { verified: true });
    unverified = await makeAccount('agent.mcp.unverified');
    resetRateLimits();
    const reg = await http.post(`${BASE}/oauth/register`, {
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_REDIRECT],
    });
    expect(reg.status).toBe(201, JSON.stringify(reg.data));
    clientId = reg.data.client_id;

    pdfBytes = await makePdf();
    // Stored files: the spec PDF at PDF_URL, and whatever the server uploads
    // (signed copies, signature images) is kept and served back.
    const files = new Map();
    spyOn(axios, 'post').and.callFake(async (url, data) => {
      const m = String(url).match(/\/files\/([^/?]+)$/);
      if (!m) throw new Error(`unexpected axios.post ${url}`);
      const stored = `${BASE}/files/test/${Date.now()}_${m[1]}`;
      files.set(stored, Buffer.from(data));
      return { status: 201, data: { url: stored, name: m[1] } };
    });
    spyOn(axios, 'get').and.callFake(async url => {
      const bare = String(url).split('?')[0];
      const bytes = files.get(bare) || (bare === PDF_URL ? Buffer.from(pdfBytes) : null);
      if (!bytes) throw new Error(`unexpected axios.get ${url}`);
      return {
        status: 200,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
    setAiClientForTests({
      messages: {
        create: async request => {
          aiRequests.push(request);
          return {
            model: 'fake-claude',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'propose_signing_setup', input: proposal },
            ],
          };
        },
      },
    });
  }, 120000);

  beforeEach(() => {
    resetRateLimits();
    resetIdempotency();
    requestMails = [];
    ownerNotices = [];
    aiRequests = [];
    proposal = leaseProposal();
    setRequestMailTransport(async params => {
      requestMails.push(params);
      return { status: 'success' };
    });
    setAgentSignMailTransport(async params => {
      ownerNotices.push(params);
      return { status: 'success' };
    });
  });

  afterAll(() => {
    setRequestMailTransport(null);
    setAgentSignMailTransport(null);
    setAiClientForTests(null);
  });

  describe('the documents:sign scope', () => {
    it('is never granted because a client asked for it', async () => {
      const started = await startConnect(clientId, 'documents:read documents:write documents:sign');
      const info = await Parse.Cloud.run(
        'oauthrequest',
        { requestId: started.requestId },
        { sessionToken: owner.getSessionToken() }
      );
      expect(info.scopes).toEqual(['documents:read', 'documents:write']);
      expect(info.signRequested).toBeTrue();
      const tokens = await finishConnect(clientId, owner, started);
      expect(tokens.scope).toBe('documents:read documents:write');

      const plain = await connect(owner);
      expect(plain.scope).toBe('documents:read documents:write');
    });

    it('is granted by the "Can sign for me" box, only to a verified account', async () => {
      const ticked = await connect(owner, { allowSigning: true });
      expect(ticked.scope.split(' ')).toContain('documents:sign');
      const grant = (await grantsOf(owner)).find(g => g.canSign);
      expect(grant).toBeDefined();
      expect(grant.signingEnabledAt).toBeTruthy();

      const notVerified = await connect(unverified, { allowSigning: true });
      expect(notVerified.scope).toBe('documents:read documents:write');
    });

    it('is turned on and off with setoauthgrantsigning, which refuses an unverified account', async () => {
      await connect(owner);
      const session = { sessionToken: owner.getSessionToken() };
      const grant = (await grantsOf(owner)).find(g => !g.canSign);
      const on = await Parse.Cloud.run('setoauthgrantsigning', { id: grant.id, enabled: true }, session);
      expect(on).toEqual(
        jasmine.objectContaining({ id: grant.id, canSign: true, signingEnabledAt: jasmine.any(String) })
      );
      const off = await Parse.Cloud.run('setoauthgrantsigning', { id: grant.id, enabled: false }, session);
      expect(off).toEqual({ id: grant.id, canSign: false, signingEnabledAt: null });

      await connect(unverified);
      const theirs = (await grantsOf(unverified))[0];
      await expectAsync(
        Parse.Cloud.run(
          'setoauthgrantsigning',
          { id: theirs.id, enabled: true },
          { sessionToken: unverified.getSessionToken() }
        )
      ).toBeRejectedWith(jasmine.objectContaining({ message: VERIFY_EMAIL_HINT }));
      // Somebody else's connection is not found from this account.
      await expectAsync(
        Parse.Cloud.run('setoauthgrantsigning', { id: theirs.id, enabled: true }, session)
      ).toBeRejectedWith(jasmine.objectContaining({ code: Parse.Error.OBJECT_NOT_FOUND }));
    });
  });

  describe('sign_document', () => {
    /** A sent lease: the owner (me) as landlord, a tenant, one signature box each. */
    async function sentLease(accessToken) {
      const tenantEmail = nextTenant();
      const created = await tool(accessToken, 'create_document', {
        name: 'Lease to sign',
        url: PDF_URL,
        recipients: [
          { me: true, role: 'Landlord' },
          { email: tenantEmail, name: 'Tina Tenant', role: 'Tenant' },
        ],
        fields: [
          { recipient: 'Landlord', type: 'signature', page: 1, x: 250, y: 470 },
          { recipient: 'Tenant', type: 'signature', page: 1, x: 250, y: 570 },
        ],
        send: true,
      });
      expect(created.error).toBeUndefined();
      return { doc: created.body, tenantEmail };
    }

    it('says how to turn signing on when the app may not sign, then signs once it may', async () => {
      const { access_token: accessToken } = await connect(owner);
      const { doc } = await sentLease(accessToken);
      expect(doc.signers[0].email).toBe(owner.get('email'));
      expect(doc.signers[0].name).toBe('Owner Person');

      const refused = await tool(accessToken, 'sign_document', { documentId: doc.objectId });
      expect(refused.error).toContain(SIGN_OFF);
      expect(refused.error).toContain('Settings > API and MCP');

      // The switch applies to the next call, no reconnect.
      const grant = (await grantsOf(owner)).find(g => !g.canSign);
      await Parse.Cloud.run(
        'setoauthgrantsigning',
        { id: grant.id, enabled: true },
        { sessionToken: owner.getSessionToken() }
      );
      ownerNotices = [];
      requestMails = [];
      const signed = await tool(accessToken, 'sign_document', { documentId: doc.objectId });
      expect(signed.error).toBeUndefined();
      expect(signed.body.status).toBe('signed');
      expect(signed.body.completed).toBeFalse();
      expect(signed.body.document.signers.map(s => s.status)).toEqual(['signed', 'pending']);
      expect(signed.raw).not.toMatch(/signingUrl|signingToken|nextSignerUrl/);
      expect(ownerNotices.length).toBe(1);
      expect(ownerNotices[0].recipient).toBe(owner.get('email'));

      const entry = (await auditOf(doc.objectId)).find(a => a.Activity === 'Signed');
      expect(entry.Method).toBe('agent');
      expect(entry.Agent).toEqual(jasmine.objectContaining({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' }));
      expect(entry.AllowedBy.via).toBe('own_document');
      expect(entry.AllowedBy.signingEnabledAt).toBeTruthy();
    });

    it("does not find a document the user is not on (approvals: spec/Approvals.spec.js)", async () => {
      const { access_token: ownerToken } = await connect(owner, { allowSigning: true });
      const { doc } = await sentLease(ownerToken);
      const other = await makeAccount('agent.other', { verified: true });
      const { access_token: otherToken } = await connect(other, { allowSigning: true });
      const res = await tool(otherToken, 'sign_document', { documentId: doc.objectId });
      expect(res.error).toContain('Document not found.');
    });
  });

  describe('sign for me and send', () => {
    it('quick_send with me + signForMe signs the owner part and mails only the tenant', async () => {
      const { access_token: accessToken } = await connect(owner, { allowSigning: true });
      const tenantEmail = nextTenant();
      const res = await tool(accessToken, 'quick_send', {
        url: PDF_URL,
        recipients: [
          { me: true, role: 'Landlord' },
          { email: tenantEmail, name: 'Tina Tenant', role: 'Tenant' },
        ],
        signForMe: true,
      });
      expect(res.error).toBeUndefined();
      const doc = res.body.document;
      expect(doc.status).toBe('in_progress');
      expect(doc.signedForYou).toEqual(
        jasmine.objectContaining({ status: 'signed', completed: false })
      );
      expect(doc.signers.map(s => [s.email, s.status])).toEqual([
        [owner.get('email'), 'signed'],
        [tenantEmail, 'pending'],
      ]);
      expect(doc.warnings).toBeUndefined();
      // The owner gets a notice, not a request; the tenant gets exactly one request.
      expect(mailedTo()).toEqual([tenantEmail]);
      expect(ownerNotices.map(n => n.recipient)).toEqual([owner.get('email')]);
      expect(res.raw).not.toMatch(/signingUrl|signingToken|nextSignerUrl/);

      // No forced emailed code on a document a connected app sent.
      const row = await new Parse.Query('contracts_Document').get(doc.objectId, { useMasterKey: true });
      expect(row.get('IsEnableOTP')).not.toBeTrue();
      const entry = (await auditOf(doc.objectId)).find(a => a.Activity === 'Signed');
      expect(entry.Method).toBe('agent');
      expect(entry.OnBehalfOf.email).toBe(owner.get('email'));
      // The MCP request's own address (index.js sets x-real-ip from req.ip).
      expect(entry.ipAddress).toMatch(/\S/);

      // The model was told who the sender is.
      const prompt = aiRequests[0].messages[0].content.find(b => b.type === 'text').text;
      expect(prompt).toContain(`<${owner.get('email')}>`);
      expect(prompt).toContain('is_sender');
    });

    it('refuses signForMe up front when the owner is not first in the signing order', async () => {
      proposal = leaseProposal({ landlordFirst: false, inOrder: true });
      const { access_token: accessToken } = await connect(owner, { allowSigning: true });
      const tenantEmail = nextTenant();
      const res = await tool(accessToken, 'quick_send', {
        url: PDF_URL,
        recipients: [
          { email: tenantEmail, name: 'Tina Tenant', role: 'Tenant' },
          { me: true, role: 'Landlord' },
        ],
        signForMe: true,
      });
      expect(res.error).toContain('You are not first in the signing order');
      expect(res.error).toContain('call sign_document when it');
      expect(requestMails.length).toBe(0);
      expect(ownerNotices.length).toBe(0);
      const id = /documentId (\w+)/.exec(res.error)?.[1];
      const row = await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });
      expect(row.get('DocSentAt')).toBeUndefined();
    });

    it('refuses signForMe when the app may not sign, before anything is sent', async () => {
      const { access_token: accessToken } = await connect(owner);
      const res = await tool(accessToken, 'quick_send', {
        url: PDF_URL,
        recipients: [{ me: true, role: 'Landlord' }, { email: nextTenant(), role: 'Tenant' }],
        signForMe: true,
      });
      expect(res.error).toContain(SIGN_OFF);
      expect(requestMails.length).toBe(0);
    });

    it('refuses signForMe before sending when the agent cannot fill a required value', async () => {
      const { access_token: accessToken } = await connect(owner, { allowSigning: true });
      const tenantEmail = nextTenant();
      const res = await tool(accessToken, 'create_document', {
        name: 'Lease with a blank only the owner can fill',
        url: PDF_URL,
        recipients: [
          { me: true, role: 'Landlord' },
          { email: tenantEmail, name: 'Tina Tenant', role: 'Tenant' },
        ],
        fields: [
          { recipient: 'Landlord', type: 'signature', page: 1, x: 250, y: 470 },
          { recipient: 'Landlord', type: 'text input', page: 1, x: 250, y: 420, required: true },
          { recipient: 'Tenant', type: 'signature', page: 1, x: 250, y: 570 },
        ],
        send: true,
        signForMe: true,
      });
      expect(res.error).toContain('Your agent cannot sign your part, so nothing was sent');
      expect(res.error).toContain('A value is required');
      expect(requestMails.length).toBe(0);
      expect(ownerNotices.length).toBe(0);
      const id = /documentId (\w+)/.exec(res.error)?.[1];
      const row = await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });
      expect(row.get('DocSentAt')).toBeUndefined();
    });

    it('send_document with signForMe on a parallel document mails the others after signing', async () => {
      const { access_token: accessToken } = await connect(owner, { allowSigning: true });
      const tenantEmail = nextTenant();
      const draft = await tool(accessToken, 'create_document', {
        name: 'Parallel lease',
        url: PDF_URL,
        recipients: [
          { email: tenantEmail, name: 'Tina Tenant', role: 'Tenant' },
          { me: true, role: 'Landlord' },
        ],
        fields: [
          { recipient: 'Tenant', type: 'signature', page: 1, x: 250, y: 570 },
          { recipient: 'Landlord', type: 'signature', page: 1, x: 250, y: 470 },
        ],
      });
      expect(draft.error).toBeUndefined();
      const sent = await tool(accessToken, 'send_document', {
        documentId: draft.body.objectId,
        signForMe: true,
      });
      expect(sent.error).toBeUndefined();
      expect(sent.body.signedForYou.status).toBe('signed');
      expect(mailedTo()).toEqual([tenantEmail]);
      expect(sent.body.signers.map(s => s.status)).toEqual(['pending', 'signed']);
    });
  });
});
