/**
 * Approvals: an agent asking to sign a document someone else sent its user
 * (cloud/lib/approvals.js), over real MCP calls with OAuth connections, and the
 * web side (parsefunction/approvalFunctions.js). Also the participant reads
 * the agent uses first (list_inbox, get_document, preview_page, review_document)
 * and that they need a verified address.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { VERIFY_EMAIL_HINT } from '../cloud/lib/agentIdentity.js';
import { agentSignDocument, setAgentSignMailTransport } from '../cloud/lib/agentSign.js';
import { setApprovalMailTransport } from '../cloud/lib/approvals.js';
import { loadCaller } from '../cloud/lib/context.js';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { APP_RESOURCE_URI } from '../cloud/mcp/app.js';
import { resetIdempotency } from '../cloud/api/shared.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PDF_URL = `${BASE}/files/test/approvals-agreement.pdf`;
const MOVED_URL = `${BASE}/files/test/approvals-agreement-v2.pdf`;
const OWN_URL = `${BASE}/files/test/approvals-own.pdf`;
const NONCE_KEY = 'docustamp/approvalNonce';

let seq = 0;

async function makeAccount(prefix, name, { verified = true } = {}) {
  seq += 1;
  const email = uniqueEmail(`${prefix}.${seq}`, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  const signedIn = await Parse.User.logIn(email, 'pa55word!');
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', `${name} Co`);
  tenant.set('UserId', signedIn.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', name);
  extUser.set('Email', email);
  extUser.set('Company', `${name} Co`);
  extUser.set('UserId', signedIn.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  if (verified) await setVerified(signedIn, true);
  return { user: signedIn, email, name, session: { sessionToken: signedIn.getSessionToken() } };
}

async function setVerified(user, value) {
  const row = new Parse.User();
  row.id = user.id;
  row.set('emailVerified', value);
  await row.save(null, { useMasterKey: true });
}

async function makePdf(label) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(label, { x: 72, y: 720, size: 14, font });
  page.drawText('The buyer pays $5,000 on signing.', { x: 72, y: 690, size: 11, font });
  return new Uint8Array(await pdf.save());
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(name, redirect) {
  const res = await http.post(`${BASE}/oauth/register`, {
    client_name: name,
    redirect_uris: [redirect],
  });
  expect(res.status).toBe(201, JSON.stringify(res.data));
  return { clientId: res.data.client_id, redirect };
}

/** An OAuth connection for `account` through `client`, with "Can sign for me" ticked or not. */
async function connect(client, account, { allowSigning = true } = {}) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
    resource: mcpResourceUrl(),
  });
  const started = await http.get(`${BASE}/oauth/authorize?${params}`);
  expect(started.status).toBe(302, JSON.stringify(started.data));
  const requestId = new URL(started.headers.location).searchParams.get('request');
  const { redirectUrl } = await Parse.Cloud.run(
    'oauthdecide',
    { requestId, approve: true, ...(allowSigning ? { allowSigning: true } : {}) },
    account.session
  );
  const code = new URL(redirectUrl).searchParams.get('code');
  const res = await http.post(
    `${BASE}/oauth/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.clientId,
      redirect_uri: client.redirect,
      resource: mcpResourceUrl(),
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  expect(res.status).toBe(200, JSON.stringify(res.data));
  return res.data.access_token;
}

async function rpc(token, method, params = {}) {
  const res = await http.post(
    `${BASE}/mcp`,
    { jsonrpc: '2.0', id: 1, method, params },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        public_url: BASE,
      },
    }
  );
  expect(res.status).toBe(200, JSON.stringify(res.data));
  expect(res.data.error).toBeUndefined(JSON.stringify(res.data.error));
  return res.data.result;
}

/** A tool call's whole result, plus `error` (its text) when it failed and `body` (parsed JSON) when not. */
async function call(token, name, args = {}) {
  const result = await rpc(token, 'tools/call', { name, arguments: args });
  const text = result?.content?.find(p => p.type === 'text')?.text || '';
  if (result?.isError) return { ...result, error: text };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ...result, body, text };
}

function reviewAnswer() {
  return {
    summary: 'A purchase agreement. The buyer pays $5,000 on signing.',
    overall: 'review',
    parties: [{ name: 'Sam Seller', role: 'Seller' }],
    keyTerms: [
      { label: 'Price', value: '$5,000', quote: 'The buyer pays $5,000 on signing.', page: 1 },
    ],
    flags: [],
    instructionsAimedAtAI: false,
  };
}

describe('Approvals: agents signing documents sent to their user', () => {
  Parse.User.enableUnsafeCurrentUser();

  let sender;
  let senderToken;
  let bob;
  let chatgpt;
  let chatgpt2;
  let claude;
  let bobToken;
  let files;
  let requestMails;
  let approvalMails;
  let aiCalls;
  let otherSeq = 0;

  const nextOther = () => {
    otherSeq += 1;
    return uniqueEmail(`approvals.other.${otherSeq}`, 'example.test');
  };

  /**
   * A purchase agreement the sender sends to Bob (Buyer) and one more signer.
   * `extra` adds fields for Bob; `cosigner` replaces the other signer, and a
   * third signer (a witness) is added with it, so two signatures never complete
   * the document (completing needs a signing certificate the specs lack).
   */
  async function sendToBob({ to = bob, extra = [], cosigner, name = 'Purchase agreement' } = {}) {
    const other = cosigner || { email: nextOther(), name: 'Olive Other' };
    const witness = cosigner ? [{ email: nextOther(), name: 'Will Witness', role: 'Witness' }] : [];
    const created = await call(senderToken, 'create_document', {
      name,
      url: PDF_URL,
      recipients: [
        { email: to.email, name: to.name, role: 'Buyer' },
        { email: other.email, name: other.name, role: 'Seller' },
        ...witness,
      ],
      fields: [
        { recipient: 'Buyer', type: 'signature', page: 1, x: 72, y: 500 },
        ...extra.map(f => ({ recipient: 'Buyer', page: 1, ...f })),
        { recipient: 'Seller', type: 'signature', page: 1, x: 320, y: 500 },
        ...witness.map(() => ({ recipient: 'Witness', type: 'signature', page: 1, x: 320, y: 600 })),
      ],
      send: true,
    });
    expect(created.error).toBeUndefined(created.error);
    return created.body;
  }

  async function auditOf(docId) {
    const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    return doc.get('AuditTrail') || [];
  }

  async function signedEntries(docId) {
    return (await auditOf(docId)).filter(a => a.Activity === 'Signed');
  }

  async function askToSign(docId, token = bobToken, fields) {
    const res = await call(token, 'sign_document', { documentId: docId, ...(fields ? { fields } : {}) });
    expect(res.error).toBeUndefined(res.error);
    return res;
  }

  async function patchApproval(id, apply) {
    const row = new Parse.Object('contracts_SignApproval');
    row.id = id;
    apply(row);
    await row.save(null, { useMasterKey: true });
  }

  beforeAll(async () => {
    process.env.PFX_BASE64 = process.env.PFX_BASE64 || '';
    resetRateLimits();
    sender = await makeAccount('approvals.sender', 'Sam Seller');
    bob = await makeAccount('approvals.bob', 'Bob Buyer');
    ({ token: senderToken } = await Parse.Cloud.run('generateapitoken', {}, sender.session));
    chatgpt = await register('ChatGPT', CHATGPT_REDIRECT);
    chatgpt2 = await register('ChatGPT', CHATGPT_REDIRECT);
    claude = await register('Claude', CLAUDE_REDIRECT);
    bobToken = await connect(chatgpt, bob);

    const pdf = Buffer.from(await makePdf('Purchase agreement'));
    files = new Map([
      [PDF_URL, pdf],
      [MOVED_URL, Buffer.from(await makePdf('Purchase agreement, second version'))],
      [OWN_URL, Buffer.from(await makePdf('My own agreement'))],
    ]);
    spyOn(axios, 'post').and.callFake(async (url, data) => {
      const m = String(url).match(/\/files\/([^/?]+)$/);
      if (!m) throw new Error(`unexpected axios.post ${url}`);
      const stored = `${BASE}/files/test/${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${m[1]}`;
      files.set(stored, Buffer.from(data));
      return { status: 201, data: { url: stored, name: m[1] } };
    });
    spyOn(axios, 'get').and.callFake(async url => {
      const bytes = files.get(String(url).split('?')[0]);
      if (!bytes) throw new Error(`unexpected axios.get ${url}`);
      return {
        status: 200,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
    setAiClientForTests({
      messages: {
        create: async () => {
          aiCalls += 1;
          return {
            model: 'fake-claude',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'report_contract_review', input: reviewAnswer() },
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
    approvalMails = [];
    aiCalls = 0;
    setRequestMailTransport(async params => {
      requestMails.push(params);
      return { status: 'success' };
    });
    setApprovalMailTransport(async params => {
      approvalMails.push(params);
      return { status: 'success' };
    });
    setAgentSignMailTransport(async () => ({ status: 'success' }));
  });

  afterAll(() => {
    setRequestMailTransport(null);
    setApprovalMailTransport(null);
    setAgentSignMailTransport(null);
    setAiClientForTests(null);
  });

  describe('asking', () => {
    it('creates an approval, signs nothing, emails the user, and keeps the code in _meta only', async () => {
      const doc = await sendToBob();
      const res = await askToSign(doc.objectId);

      expect(res.structuredContent.view).toBe('approval');
      expect(res.structuredContent.chatApproval).toBeTrue();
      const approval = res.structuredContent.approval;
      expect(approval.status).toBe('pending');
      expect(approval.document).toEqual(
        jasmine.objectContaining({
          id: doc.objectId,
          title: 'Purchase agreement',
          senderName: 'Sam Seller',
          senderEmail: sender.email,
          pageCount: 1,
        })
      );
      expect(approval.agent).toEqual({ name: 'ChatGPT', host: 'chatgpt.com', kind: 'oauth' });
      expect(approval.values).toEqual([
        jasmine.objectContaining({ type: 'signature', value: 'Bob Buyer', page: 1 }),
      ]);
      expect(approval.review.summary).toContain('purchase agreement');
      expect(approval.review.disclaimer).toBe('This is not legal advice.');
      // The origin comes from PUBLIC_URL, which another spec file sets for the whole run.
      expect(res.structuredContent.appUrl).toMatch(new RegExp(`^https?://[^/]+/approvals/${approval.id}$`));

      // The code: in the result's _meta, nowhere the model reads.
      const nonce = res._meta?.[NONCE_KEY];
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(30);
      expect(JSON.stringify(res.structuredContent)).not.toContain(nonce);
      expect(JSON.stringify(res.content)).not.toContain(nonce);
      expect(res.body.status).toBe('awaiting_approval');
      expect(res.body.approvalId).toBe(approval.id);
      expect(res.body.message).toContain('Nothing is signed yet');
      expect(res.body.message).toContain('get_approval');
      const row = await new Parse.Query('contracts_SignApproval').get(approval.id, {
        useMasterKey: true,
      });
      expect(row.get('NonceHash')).toBe(crypto.createHash('sha256').update(nonce).digest('hex'));
      expect(JSON.stringify(row.toJSON())).not.toContain(nonce);
      // Master key only: a session cannot read the class.
      await expectAsync(
        new Parse.Query('contracts_SignApproval').get(approval.id, bob.session)
      ).toBeRejected();

      expect(await signedEntries(doc.objectId)).toEqual([]);
      expect(approvalMails.length).toBe(1);
      expect(approvalMails[0].recipient).toBe(bob.email);
      expect(approvalMails[0].subject).toBe('ChatGPT wants to sign "Purchase agreement" for you');
      expect(approvalMails[0].html).toContain(`/approvals/${approval.id}`);
      expect(approvalMails[0].html).toContain('Review and approve');
      expect(approvalMails[0].html).toContain('Nothing is signed until you approve');
      expect(approvalMails[0].html).toContain('Sam Seller');
    });

    it('renders the approval card from sign_document', async () => {
      const { tools } = await rpc(bobToken, 'tools/list');
      const byName = Object.fromEntries(tools.map(t => [t.name, t]));
      expect(byName.sign_document._meta.ui.resourceUri).toBe(APP_RESOURCE_URI);
      for (const name of ['app_approval', 'app_decide_approval']) {
        expect(byName[name]._meta.ui.visibility).toEqual(['app'], name);
      }
      for (const name of ['list_inbox', 'review_document', 'get_approval']) {
        expect(byName[name].annotations.readOnlyHint).toBeTrue();
      }
    });

    it('returns the same pending approval when asked again, with a new code', async () => {
      const doc = await sendToBob();
      const first = await askToSign(doc.objectId);
      const second = await askToSign(doc.objectId);
      expect(second.structuredContent.approval.id).toBe(first.structuredContent.approval.id);
      expect(second._meta[NONCE_KEY]).not.toBe(first._meta[NONCE_KEY]);
      expect(second.body.message).toContain('already open');
      expect(approvalMails.length).toBe(1);
      expect(aiCalls).toBe(1);

      // The first code was replaced.
      const stale = await call(bobToken, 'app_decide_approval', {
        approvalId: first.structuredContent.approval.id,
        nonce: first._meta[NONCE_KEY],
        decision: 'approve',
      });
      expect(stale.error).toContain('not valid');
      expect(await signedEntries(doc.objectId)).toEqual([]);
    });

    it('refuses up front what could not be signed, and stores the values it was given', async () => {
      const doc = await sendToBob({
        extra: [{ type: 'text input', x: 72, y: 450, label: 'Account number', required: true }],
      });
      const missing = await call(bobToken, 'sign_document', { documentId: doc.objectId });
      expect(missing.error).toContain('nothing was sent for approval');
      expect(missing.error).toContain('Account number');
      expect(approvalMails.length).toBe(0);

      const view = await call(bobToken, 'get_document', { documentId: doc.objectId });
      expect(view.body.role).toBe('signer');
      const key = view.body.myFields.find(f => f.type === 'text input').key;
      const asked = await askToSign(doc.objectId, bobToken, { [key]: '12345' });
      const values = asked.structuredContent.approval.values;
      expect(values.find(v => v.type === 'text input').value).toBe('12345');
    });

    it('gives a host that is not on the list no code, and refuses its decisions', async () => {
      const doc = await sendToBob();
      const claudeToken = await connect(claude, bob);
      const res = await askToSign(doc.objectId, claudeToken);
      expect(res.structuredContent.chatApproval).toBeFalse();
      expect(res._meta?.[NONCE_KEY]).toBeUndefined();
      expect(res.structuredContent.approval.agent.host).toBe('claude.ai');
      expect(res.body.message).toMatch(/https?:\/\/[^/\s]+\/approvals\//);
      const refused = await call(claudeToken, 'app_decide_approval', {
        approvalId: res.structuredContent.approval.id,
        nonce: 'x'.repeat(43),
        decision: 'approve',
      });
      expect(refused.error).toContain('not available in this app');
    });

    it('needs signing turned on for the app', async () => {
      const doc = await sendToBob();
      const readOnlySign = await connect(chatgpt, bob, { allowSigning: false });
      const res = await call(readOnlySign, 'sign_document', { documentId: doc.objectId });
      expect(res.error).toContain("Turn on 'Can sign for me'");
      expect(approvalMails.length).toBe(0);
    });
  });

  describe('deciding in the chat', () => {
    it('signs with the right code and records the chat approval and the agent', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;
      const nonce = asked._meta[NONCE_KEY];

      const decided = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce,
        decision: 'approve',
      });
      expect(decided.error).toBeUndefined(decided.error);
      expect(decided.structuredContent.approval).toEqual(
        jasmine.objectContaining({ id, status: 'signed', decidedVia: 'chat', error: null })
      );
      const entries = await signedEntries(doc.objectId);
      expect(entries.length).toBe(1);
      expect(entries[0].Method).toBe('agent');
      expect(entries[0].Agent).toEqual(
        jasmine.objectContaining({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' })
      );
      expect(entries[0].OnBehalfOf.email).toBe(bob.email);
      expect(entries[0].AllowedBy).toEqual(
        jasmine.objectContaining({ via: 'chat', approvalId: id, email: bob.email })
      );

      // Spent: the same code does nothing more.
      const again = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce,
        decision: 'approve',
      });
      expect(again.error).toContain('already decided');
      expect((await signedEntries(doc.objectId)).length).toBe(1);
    });

    it('refuses a wrong code, an expired code and another app\'s code', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;
      const nonce = asked._meta[NONCE_KEY];

      const wrong = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce: crypto.randomBytes(32).toString('base64url'),
        decision: 'approve',
      });
      expect(wrong.error).toContain('not valid');

      // Another ChatGPT connection (another client id) holding this code.
      const otherApp = await connect(chatgpt2, bob);
      const theirs = await call(otherApp, 'app_decide_approval', {
        approvalId: id,
        nonce,
        decision: 'approve',
      });
      expect(theirs.error).toContain('not valid');

      // Somebody else's connection cannot see it at all.
      const stranger = await makeAccount('approvals.stranger', 'Stan Stranger');
      const strangerToken = await connect(chatgpt, stranger);
      const notTheirs = await call(strangerToken, 'app_decide_approval', {
        approvalId: id,
        nonce,
        decision: 'approve',
      });
      expect(notTheirs.error).toContain('Approval not found');

      await patchApproval(id, row => row.set('NonceExpiresAt', new Date(Date.now() - 1000)));
      const expired = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce,
        decision: 'approve',
      });
      expect(expired.error).toContain('not valid');

      expect(await signedEntries(doc.objectId)).toEqual([]);
      const still = await call(bobToken, 'app_approval', { approvalId: id });
      expect(still.structuredContent.approval.status).toBe('pending');
    });
  });

  describe('deciding in DocuStamp', () => {
    it('lists, shows a page, and signs as the agent that asked, approved on the web', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;

      const { approvals } = await Parse.Cloud.run('listsignapprovals', {}, bob.session);
      expect(approvals.map(a => a.id)).toContain(id);
      const one = await Parse.Cloud.run('getsignapproval', { id }, bob.session);
      expect(one.status).toBe('pending');
      expect(JSON.stringify(one)).not.toMatch(/nonce/i);
      const page = await Parse.Cloud.run('getsignapprovalpage', { id, page: 1 }, bob.session);
      expect(page.image).toMatch(/^data:image\/png;base64,/);
      expect(page).toEqual(jasmine.objectContaining({ page: 1, pageCount: 1 }));
      await expectAsync(
        Parse.Cloud.run('getsignapproval', { id }, sender.session)
      ).toBeRejectedWith(jasmine.objectContaining({ code: Parse.Error.OBJECT_NOT_FOUND }));

      const decided = await Parse.Cloud.run(
        'decidesignapproval',
        { id, decision: 'approve' },
        bob.session
      );
      expect(decided).toEqual(
        jasmine.objectContaining({ id, status: 'signed', decidedVia: 'web', error: null })
      );
      const entries = await signedEntries(doc.objectId);
      expect(entries.length).toBe(1);
      // The agent that asked, not the web session.
      expect(entries[0].Agent).toEqual(
        jasmine.objectContaining({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' })
      );
      expect(entries[0].AllowedBy).toEqual(
        jasmine.objectContaining({ via: 'web', approvalId: id })
      );

      // The chat code is spent by a web decision.
      const late = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce: asked._meta[NONCE_KEY],
        decision: 'approve',
      });
      expect(late.error).toContain('already decided');
      const all = await Parse.Cloud.run('listsignapprovals', { status: 'all' }, bob.session);
      expect(all.approvals.find(a => a.id === id).status).toBe('signed');
      const pending = await Parse.Cloud.run('listsignapprovals', {}, bob.session);
      expect(pending.approvals.map(a => a.id)).not.toContain(id);
    });

    it('declines, and nothing is signed', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;
      const declined = await Parse.Cloud.run(
        'decidesignapproval',
        { id, decision: 'decline' },
        bob.session
      );
      expect(declined.status).toBe('declined');
      expect(declined.decidedVia).toBe('web');
      const chat = await call(bobToken, 'app_decide_approval', {
        approvalId: id,
        nonce: asked._meta[NONCE_KEY],
        decision: 'approve',
      });
      expect(chat.error).toContain('already decided');
      expect(await signedEntries(doc.objectId)).toEqual([]);
    });

    it('signs exactly once when the web and the chat approve at the same time', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;
      const [web, chat] = await Promise.allSettled([
        Parse.Cloud.run('decidesignapproval', { id, decision: 'approve' }, bob.session),
        call(bobToken, 'app_decide_approval', {
          approvalId: id,
          nonce: asked._meta[NONCE_KEY],
          decision: 'approve',
        }),
      ]);
      const webWon = web.status === 'fulfilled' && web.value.status === 'signed';
      const chatWon = chat.status === 'fulfilled' && !chat.value.error;
      expect([webWon, chatWon].filter(Boolean).length).toBe(1);
      expect((await signedEntries(doc.objectId)).length).toBe(1);
    });
  });

  describe('staying current', () => {
    it('survives a co-signer signing, and expires when the file changes', async () => {
      const carol = await makeAccount('approvals.carol', 'Carol Cosigner');
      const doc = await sendToBob({ cosigner: { email: carol.email, name: carol.name } });
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;

      // Carol signs (her own agent, approved on her side).
      const carolUser = await new Parse.Query(Parse.User).get(carol.user.id, { useMasterKey: true });
      const carolCaller = await loadCaller(carolUser, { publicUrl: BASE });
      await agentSignDocument(carolCaller, doc.objectId, { allowedBy: { via: 'web' } });
      expect((await signedEntries(doc.objectId)).length).toBe(1);
      const after = await call(bobToken, 'get_approval', { approvalId: id, waitSec: 0 });
      expect(after.body.approval.status).toBe('pending');
      expect(after.body.timedOut).toBeTrue();

      // A second request on another document, expired by a new file.
      const other = await sendToBob();
      const second = await askToSign(other.objectId);
      const moved = new Parse.Object('contracts_Document');
      moved.id = other.objectId;
      moved.set('URL', MOVED_URL);
      await moved.save(null, { useMasterKey: true });
      const gone = await call(bobToken, 'get_approval', {
        approvalId: second.structuredContent.approval.id,
        waitSec: 0,
      });
      expect(gone.body.approval.status).toBe('expired');
      expect(gone.body.approval.error).toContain('changed');

      // The first one still signs, on the copy Carol signed.
      const decided = await Parse.Cloud.run(
        'decidesignapproval',
        { id, decision: 'approve' },
        bob.session
      );
      expect(decided.status).toBe('signed', decided.error);
      expect((await signedEntries(doc.objectId)).length).toBe(2);
    });

    it('get_approval returns as soon as the user decides', async () => {
      const doc = await sendToBob();
      const asked = await askToSign(doc.objectId);
      const { id } = asked.structuredContent.approval;
      const started = Date.now();
      const waiting = call(bobToken, 'get_approval', { approvalId: id, waitSec: 30 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      await Parse.Cloud.run('decidesignapproval', { id, decision: 'approve' }, bob.session);
      const res = await waiting;
      expect(res.body.approval.status).toBe('signed');
      expect(res.body.decided).toBeTrue();
      expect(Date.now() - started).toBeLessThan(20000);
    }, 40000);
  });

  describe('reading documents sent to you', () => {
    it('needs a verified address for the inbox, the participant view, the preview and the review', async () => {
      const uma = await makeAccount('approvals.uma', 'Uma Unverified', { verified: false });
      const umaToken = await connect(chatgpt, uma, { allowSigning: false });
      const doc = await sendToBob({ to: uma });

      const inbox = await call(umaToken, 'list_inbox', {});
      expect(inbox.error).toContain(VERIFY_EMAIL_HINT);
      const view = await call(umaToken, 'get_document', { documentId: doc.objectId });
      expect(view.error).toContain(VERIFY_EMAIL_HINT);
      const preview = await call(umaToken, 'preview_page', { documentId: doc.objectId });
      expect(preview.error).toContain(VERIFY_EMAIL_HINT);
      const page = await call(umaToken, 'app_page', { documentId: doc.objectId });
      expect(page.error).toContain(VERIFY_EMAIL_HINT);
      const shown = await call(umaToken, 'show_document', { documentId: doc.objectId });
      expect(shown.error).toContain(VERIFY_EMAIL_HINT);
      const review = await call(umaToken, 'review_document', { documentId: doc.objectId });
      expect(review.error).toContain(VERIFY_EMAIL_HINT);
      expect(aiCalls).toBe(0);

      await setVerified(uma.user, true);
      const listed = await call(umaToken, 'list_inbox', {});
      expect(listed.body.documents.map(d => d.id)).toContain(doc.objectId);
      const seen = await call(umaToken, 'get_document', { documentId: doc.objectId });
      expect(seen.body).toEqual(
        jasmine.objectContaining({ id: doc.objectId, role: 'signer', myStatus: 'needs_you' })
      );
      // Other signers by name only: never their address.
      expect(seen.text).not.toMatch(/approvals\.other/);
      const card = await call(umaToken, 'show_document', { documentId: doc.objectId });
      expect(card.structuredContent.view).toBe('document');
      expect(card.structuredContent.document.role).toBe('signer');
      const image = await rpc(umaToken, 'tools/call', {
        name: 'preview_page',
        arguments: { documentId: doc.objectId },
      });
      expect(image.content[0].type).toBe('image');
      const reviewed = await call(umaToken, 'review_document', { documentId: doc.objectId });
      expect(reviewed.body.summary).toContain('purchase agreement');
    });

    it('still answers a stranger as before, and the owner unchanged', async () => {
      const doc = await sendToBob();
      const stranger = await makeAccount('approvals.nosy', 'Nora Nosy', { verified: false });
      const strangerToken = await connect(chatgpt, stranger, { allowSigning: false });
      const res = await call(strangerToken, 'get_document', { documentId: doc.objectId });
      expect(res.error).toContain('You do not own this document');
      await setVerified(stranger.user, true);
      const verified = await call(strangerToken, 'get_document', { documentId: doc.objectId });
      expect(verified.error).toContain('Document not found');

      const own = await call(senderToken, 'get_document', { documentId: doc.objectId });
      expect(own.body.objectId).toBe(doc.objectId);
      expect(own.body.signers.length).toBe(2);
    });
  });

  describe('own documents', () => {
    it('signs right away and shows the document with a "signed for you" banner', async () => {
      const created = await call(bobToken, 'create_document', {
        name: 'My own agreement',
        url: OWN_URL,
        recipients: [
          { me: true, role: 'Seller' },
          { email: nextOther(), name: 'Olive Other', role: 'Buyer' },
        ],
        fields: [
          { recipient: 'Seller', type: 'signature', page: 1, x: 72, y: 500 },
          { recipient: 'Buyer', type: 'signature', page: 1, x: 320, y: 500 },
        ],
        send: true,
      });
      expect(created.error).toBeUndefined(created.error);
      const res = await askToSign(created.body.objectId);
      expect(res.body.status).toBe('signed');
      expect(res._meta?.[NONCE_KEY]).toBeUndefined();
      expect(res.structuredContent.view).toBe('document');
      expect(res.structuredContent.document.objectId).toBe(created.body.objectId);
      expect(res.structuredContent.banner).toEqual({
        kind: 'signed_for_you',
        agent: { name: 'ChatGPT', host: 'chatgpt.com' },
      });
      expect(approvalMails.length).toBe(0);
    });
  });
});
