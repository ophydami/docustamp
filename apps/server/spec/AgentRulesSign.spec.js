/**
 * Signing by rules: sign_document on a document someone else sent the user
 * checks the rules the user set for their AI (lib/agentRules.js) first. When
 * the document fits them it is signed right away, the rule is recorded on the
 * audit trail and the certificate, and the user is mailed a notice; otherwise
 * it becomes an approval that says why (RuleCheck). get_rules reads the rules
 * and no tool changes them.
 *
 * The rules decision is driven through a test seam (setSignRulesCheckForTests)
 * so each outcome is exact; one case runs the real check end to end.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { agentSignDocument, setAgentSignMailTransport } from '../cloud/lib/agentSign.js';
import { setApprovalMailTransport } from '../cloud/lib/approvals.js';
import { loadCaller } from '../cloud/lib/context.js';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { setSignRulesCheckForTests, TOOL_ANNOTATIONS } from '../cloud/mcp/server.js';
import { resetIdempotency } from '../cloud/api/shared.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { agentCertificateRows } from '../cloud/parsefunction/pdf/GenerateCertificate.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const PDF_URL = `${BASE}/files/test/rules-nda.pdf`;
const BOB_OWN_URL = `${BASE}/files/test/rules-bob-own.pdf`;
const SENDER_OWN_URL = `${BASE}/files/test/rules-sender-own.pdf`;
const RULES_SET_AT = '2026-10-03T10:00:00.000Z';

let seq = 0;

async function makeAccount(prefix, name) {
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
  const row = new Parse.User();
  row.id = signedIn.id;
  row.set('emailVerified', true);
  await row.save(null, { useMasterKey: true });
  return { user: signedIn, email, name, session: { sessionToken: signedIn.getSessionToken() } };
}

async function makePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Mutual non-disclosure agreement', { x: 72, y: 720, size: 14, font });
  page.drawText('Each party keeps the other party\'s information confidential.', { x: 72, y: 690, size: 11, font });
  return new Uint8Array(await pdf.save());
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(name, redirect) {
  const res = await http.post(`${BASE}/oauth/register`, { client_name: name, redirect_uris: [redirect] });
  expect(res.status).toBe(201, JSON.stringify(res.data));
  return { clientId: res.data.client_id, redirect };
}

/** An OAuth connection for `account`; `choices` are the consent page's (allowSigning, readOnly). */
async function connect(client, account, choices = { allowSigning: true }) {
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
    { requestId, approve: true, ...choices },
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
    summary: 'A mutual NDA.',
    overall: 'review',
    parties: [{ name: 'Sam Sender', role: 'Discloser' }],
    keyTerms: [],
    flags: [],
    instructionsAimedAtAI: false,
  };
}

/** What checkSignRules answers, for the seam. */
function ruleAnswer(over = {}) {
  return {
    enabled: true,
    allowed: true,
    reasons: [],
    matched: { documentType: 'nda', valueUsd: null, limitUsd: 25000, senderDomain: 'example.test' },
    rulesUpdatedAt: RULES_SET_AT,
    summary: 'NDA, no money involved',
    review: null,
    rules: { updatedAt: RULES_SET_AT, updatedBy: { name: 'Bob Buyer', email: '' } },
    ...over,
  };
}

describe('Signing by rules', () => {
  Parse.User.enableUnsafeCurrentUser();

  let sender;
  let senderToken;
  let bob;
  let bobToken;
  let chatgpt;
  let files;
  let approvalMails;
  let notices;
  let aiCalls;
  let seamCalls;
  let otherSeq = 0;

  const nextOther = () => {
    otherSeq += 1;
    return uniqueEmail(`rules.other.${otherSeq}`, 'example.test');
  };

  /** An NDA the sender sends to Bob, with one more signer so Bob's signature never completes it. */
  async function sendToBob(name = 'Mutual NDA') {
    const created = await call(senderToken, 'create_document', {
      name,
      url: PDF_URL,
      recipients: [
        { email: bob.email, name: bob.name, role: 'Recipient' },
        { email: nextOther(), name: 'Olive Other', role: 'Discloser' },
      ],
      fields: [
        { recipient: 'Recipient', type: 'signature', page: 1, x: 72, y: 500 },
        { recipient: 'Discloser', type: 'signature', page: 1, x: 320, y: 500 },
      ],
    });
    expect(created.error).toBeUndefined(created.error);
    const sent = await call(senderToken, 'send_document', { documentId: created.body.objectId });
    expect(sent.error).toBeUndefined(sent.error);
    return sent.body;
  }

  async function auditOf(docId) {
    const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    return doc.get('AuditTrail') || [];
  }

  async function approvalsFor(docId) {
    const q = new Parse.Query('contracts_SignApproval');
    q.equalTo('Document', { __type: 'Pointer', className: 'contracts_Document', objectId: docId });
    return await q.find({ useMasterKey: true });
  }

  function useRules(answer) {
    setSignRulesCheckForTests(async (caller, doc, known) => {
      seamCalls.push({ docId: doc?.objectId, known });
      return typeof answer === 'function' ? answer(caller, doc, known) : answer;
    });
  }

  beforeAll(async () => {
    process.env.PFX_BASE64 = process.env.PFX_BASE64 || '';
    resetRateLimits();
    sender = await makeAccount('rules.sender', 'Sam Sender');
    bob = await makeAccount('rules.bob', 'Bob Buyer');
    ({ token: senderToken } = await Parse.Cloud.run('generateapitoken', {}, sender.session));
    chatgpt = await register('ChatGPT', CHATGPT_REDIRECT);
    bobToken = await connect(chatgpt, bob);

    const pdf = Buffer.from(await makePdf());
    files = new Map([
      [PDF_URL, pdf],
      [BOB_OWN_URL, pdf],
      [SENDER_OWN_URL, pdf],
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
      return { status: 200, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    });
    setAiClientForTests({
      messages: {
        create: async () => {
          aiCalls += 1;
          return {
            model: 'fake-claude',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'tool_use', id: 'tu_1', name: 'report_contract_review', input: reviewAnswer() }],
          };
        },
      },
    });
  }, 120000);

  beforeEach(() => {
    resetRateLimits();
    resetIdempotency();
    approvalMails = [];
    notices = [];
    aiCalls = 0;
    seamCalls = [];
    setRequestMailTransport(async () => ({ status: 'success' }));
    setApprovalMailTransport(async params => {
      approvalMails.push(params);
      return { status: 'success' };
    });
    setAgentSignMailTransport(async params => {
      notices.push(params);
      return { status: 'success' };
    });
  });

  afterEach(() => setSignRulesCheckForTests(null));

  afterAll(() => {
    setRequestMailTransport(null);
    setApprovalMailTransport(null);
    setAgentSignMailTransport(null);
    setAiClientForTests(null);
  });

  it('with the rules off, asks for approval as before and says the rules were off', async () => {
    const doc = await sendToBob();
    const res = await call(bobToken, 'sign_document', { documentId: doc.objectId });
    expect(res.error).toBeUndefined(res.error);
    expect(res.structuredContent.view).toBe('approval');
    const approval = res.structuredContent.approval;
    expect(approval.status).toBe('pending');
    expect(approval.ruleCheck).toEqual(jasmine.objectContaining({ enabled: false, allowed: false, reasons: [] }));
    expect(JSON.parse(res.text).status).toBe('awaiting_approval');
    expect((await auditOf(doc.objectId)).some(a => a.Activity === 'Signed')).toBeFalse();
    expect(approvalMails.length).toBe(1);
    expect(approvalMails[0].html).not.toContain('did not cover this one');
  });

  it('signs right away when the rules allow it, records the rule, and mails the user a notice', async () => {
    useRules(ruleAnswer());
    const doc = await sendToBob('NDA by rules');
    const res = await call(bobToken, 'sign_document', { documentId: doc.objectId });
    expect(res.error).toBeUndefined(res.error);
    expect(res.body.status).toBe('signed');
    expect(res.body.signedBy).toBe('rules');
    expect(res.body.rule).toBe('NDA, no money involved');
    expect(res.body.ruleCheck).toEqual(jasmine.objectContaining({ enabled: true, allowed: true }));
    expect(res.body.message).toContain('fits the rules the user set');
    expect(res.text).not.toMatch(/signingUrl|signingToken|nextSignerUrl/);
    expect(seamCalls.length).toBe(1);
    expect(seamCalls[0].known.nameCheck).toEqual(jasmine.objectContaining({ status: jasmine.any(String) }));

    // No approval was made.
    expect((await approvalsFor(doc.objectId)).length).toBe(0);
    expect(approvalMails.length).toBe(0);

    const entry = (await auditOf(doc.objectId)).find(a => a.Activity === 'Signed');
    expect(entry.Method).toBe('agent');
    expect(entry.AllowedBy.via).toBe('rules');
    expect(entry.AllowedBy.name).toBe('Bob Buyer');
    expect(entry.AllowedBy.rule).toEqual({
      summary: 'NDA, no money involved',
      documentType: 'nda',
      valueUsd: null,
      limitUsd: 25000,
    });

    // The certificate's row for it.
    const rows = agentCertificateRows(entry, { DateFormat: 'MMM DD, YYYY', timezone: 'UTC', Is12Hr: true });
    expect(rows[0].label).toBe('Signed by');
    expect(rows[1].label).toBe('Rule used');
    expect(rows[1].value).toMatch(/^NDA, no money involved \(rules set by Bob Buyer on .*2026\)$/);

    // get_audit_trail shows it too.
    const trail = await call(senderToken, 'get_audit_trail', { documentId: doc.objectId });
    expect(trail.error).toBeUndefined(trail.error);
    expect(JSON.stringify(trail.body)).toContain('"via":"rules"');

    // The user hears about it.
    expect(notices.length).toBe(1);
    expect(notices[0].recipient).toBe(bob.email);
    expect(notices[0].subject).toBe('ChatGPT signed "NDA by rules" for you under your rules');
    expect(notices[0].html).toContain('Rule used');
    expect(notices[0].html).toContain('NDA, no money involved');
    expect(notices[0].html).toContain('/inbox');
  });

  it('asks for approval with the reasons when the rules do not cover it, reusing the review', async () => {
    const review = { ...reviewAnswer(), overall: 'review', model: 'fake', reviewedAt: new Date().toISOString() };
    useRules(
      ruleAnswer({
        allowed: false,
        reasons: [
          { code: 'over_limit', text: "It's over your $25,000 limit ($48,000 on page 3)." },
          { code: 'auto_renewal', text: 'It renews automatically.' },
        ],
        summary: "Needs you: It's over your $25,000 limit ($48,000 on page 3).",
        review,
      })
    );
    const doc = await sendToBob('Vendor MSA');
    const res = await call(bobToken, 'sign_document', { documentId: doc.objectId });
    expect(res.error).toBeUndefined(res.error);
    const approval = res.structuredContent.approval;
    expect(approval.status).toBe('pending');
    expect(approval.ruleCheck.enabled).toBeTrue();
    expect(approval.ruleCheck.allowed).toBeFalse();
    expect(approval.ruleCheck.reasons.map(r => r.code)).toEqual(['over_limit', 'auto_renewal']);
    // The review the rules check ran rides on the approval; no second AI call.
    expect(approval.review.summary).toBe('A mutual NDA.');
    expect(aiCalls).toBe(0);
    expect(JSON.parse(res.text).message).toContain("did not cover this one, so it needs them. Tell them why: It's over your $25,000 limit");
    expect(approvalMails.length).toBe(1);
    expect(approvalMails[0].html).toContain('did not cover this one, so it needs you');
    expect(approvalMails[0].html).toContain('It renews automatically.');
    expect((await auditOf(doc.objectId)).some(a => a.Activity === 'Signed')).toBeFalse();

    // Asking again keeps one request and shows the current reasons.
    useRules(ruleAnswer({ allowed: false, reasons: [{ code: 'doc_type', text: "It's a lease." }], review }));
    const again = await call(bobToken, 'sign_document', { documentId: doc.objectId });
    expect(again.structuredContent.approval.id).toBe(approval.id);
    expect(again.structuredContent.approval.ruleCheck.reasons.map(r => r.code)).toEqual(['doc_type']);
  });

  it('still refuses an app without "Can sign for me", before any rules check', async () => {
    useRules(ruleAnswer());
    const noSign = await connect(chatgpt, bob, {});
    const doc = await sendToBob();
    const res = await call(noSign, 'sign_document', { documentId: doc.objectId });
    expect(res.error).toContain('Can sign for me');
    expect(seamCalls.length).toBe(0);
    expect((await auditOf(doc.objectId)).some(a => a.Activity === 'Signed')).toBeFalse();
  });

  it('leaves the user\'s own documents alone: signed as before, no rules check', async () => {
    useRules(ruleAnswer({ allowed: false, reasons: [{ code: 'doc_type', text: 'nope' }] }));
    const created = await call(bobToken, 'create_document', {
      name: 'My own NDA',
      url: BOB_OWN_URL,
      recipients: [
        { me: true, role: 'Recipient' },
        { email: nextOther(), name: 'Olive Other', role: 'Discloser' },
      ],
      fields: [
        { recipient: 'Recipient', type: 'signature', page: 1, x: 72, y: 500 },
        { recipient: 'Discloser', type: 'signature', page: 1, x: 320, y: 500 },
      ],
    });
    expect(created.error).toBeUndefined(created.error);
    const sent = await call(bobToken, 'send_document', { documentId: created.body.objectId });
    expect(sent.error).toBeUndefined(sent.error);
    const res = await call(bobToken, 'sign_document', { documentId: created.body.objectId });
    expect(res.error).toBeUndefined(res.error);
    expect(res.body.status).toBe('signed');
    expect(res.body.signedBy).toBeUndefined();
    expect(seamCalls.length).toBe(0);
    const entry = (await auditOf(created.body.objectId)).find(a => a.Activity === 'Signed');
    expect(entry.AllowedBy.via).toBe('own_document');
  });

  it('never signs by rules over a name that is not the user\'s, nor on their own document', async () => {
    const doc = await sendToBob('Mismatch NDA');
    // Read back from the database: the signed-in object predates emailVerified.
    const fresh = id => new Parse.Query(Parse.User).get(id, { useMasterKey: true });
    const bobCaller = await loadCaller(await fresh(bob.user.id), { publicUrl: BASE });
    bobCaller.viaToken = true;
    const rule = { summary: 'NDA, no money involved', documentType: 'nda', valueUsd: null, limitUsd: 0 };
    await expectAsync(
      agentSignDocument(bobCaller, doc.objectId, {
        allowedBy: { via: 'rules', rule },
        nameCheck: {
          status: 'mismatch',
          expected: 'Bob Buyer',
          role: 'Recipient',
          printed: [{ name: 'Cameron Brooks', matches: false }],
        },
      })
    ).toBeRejectedWithError(/Rules never sign over that/);
    expect((await auditOf(doc.objectId)).some(a => a.Activity === 'Signed')).toBeFalse();

    const senderCaller = await loadCaller(await fresh(sender.user.id), { publicUrl: BASE });
    const own = await call(senderToken, 'create_document', {
      name: 'Sender own',
      url: SENDER_OWN_URL,
      recipients: [{ me: true, role: 'Discloser' }, { email: nextOther(), name: 'X', role: 'Other' }],
      fields: [
        { recipient: 'Discloser', type: 'signature', page: 1, x: 72, y: 500 },
        { recipient: 'Other', type: 'signature', page: 1, x: 320, y: 500 },
      ],
    });
    await call(senderToken, 'send_document', { documentId: own.body.objectId });
    expect(own.error).toBeUndefined(own.error);
    await expectAsync(
      agentSignDocument(senderCaller, own.body.objectId, { allowedBy: { via: 'rules', rule } })
    ).toBeRejectedWithError(/Rules only cover documents someone else sent you/);
  });

  describe('get_rules', () => {
    it('is labelled read only and shows the rules without a way to change them', async () => {
      expect(TOOL_ANNOTATIONS.get_rules).toEqual(
        jasmine.objectContaining({ readOnlyHint: true, destructiveHint: false })
      );
      const listed = await rpc(bobToken, 'tools/list');
      const tool = listed.tools.find(t => t.name === 'get_rules');
      expect(tool).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBeTrue();
      expect(listed.tools.some(t => /set_rules|update_rules|change_rules/.test(t.name))).toBeFalse();

      const res = await call(bobToken, 'get_rules');
      expect(res.error).toBeUndefined(res.error);
      expect(res.body.canChange).toBeFalse();
      // The origin follows the server's configured public url, which other
      // specs in the same run change; the path is what matters here.
      expect(new URL(res.body.editUrl).pathname).toBe('/settings/rules');
      expect(res.body.rules.autoSign.enabled).toBeFalse();
      expect(res.body.rules.sendOnlyTo).toEqual([]);
      expect(Array.isArray(res.body.summary)).toBeTrue();
      expect(res.body.summary.length).toBeGreaterThan(0);
      expect(res.body.note).toContain('Only the user can change these rules');
    });

    it('is offered to a read-only connection, which cannot sign', async () => {
      const readOnly = await connect(chatgpt, bob, { readOnly: true });
      const listed = await rpc(readOnly, 'tools/list');
      const names = listed.tools.map(t => t.name);
      expect(names).toContain('get_rules');
      expect(names).not.toContain('sign_document');
      const res = await call(readOnly, 'get_rules');
      expect(res.error).toBeUndefined(res.error);
      expect(res.body.canChange).toBeFalse();
    });
  });

  describe('with the real rules check', () => {
    it('turns rules on from the web, and a document they do not cover becomes an approval with reasons, one AI call', async () => {
      // setagentrules is the web app's (Agent A, lib/agentRules.js).
      await Parse.Cloud.run(
        'setagentrules',
        { rules: { autoSign: { enabled: true, documentTypes: ['nda'], maxValueUsd: 0 } } },
        bob.session
      );
      try {
        const rules = await call(bobToken, 'get_rules');
        expect(rules.body.rules.autoSign.enabled).toBeTrue();
        expect(rules.body.rules.updatedAt).toBeTruthy();

        const doc = await sendToBob('Real rules NDA');
        const res = await call(bobToken, 'sign_document', { documentId: doc.objectId });
        expect(res.error).toBeUndefined(res.error);
        const approval = res.structuredContent.approval;
        expect(approval.status).toBe('pending');
        expect(approval.ruleCheck.enabled).toBeTrue();
        expect(approval.ruleCheck.allowed).toBeFalse();
        // The fake review rates it 'review', so the rules cannot sign it.
        expect(approval.ruleCheck.reasons.map(r => r.code)).toContain('not_standard');
        expect(approval.review).toBeTruthy();
        expect(aiCalls).toBe(1);
        expect((await auditOf(doc.objectId)).some(a => a.Activity === 'Signed')).toBeFalse();
      } finally {
        await Parse.Cloud.run('setagentrules', { rules: { autoSign: { enabled: false } } }, bob.session);
      }
    });

    it('cannot be changed through a token', async () => {
      const res = await http.post(
        `${BASE}/test/functions/setagentrules`,
        { rules: { autoSign: { enabled: true } } },
        {
          headers: {
            'X-Parse-Application-Id': Parse.applicationId,
            Authorization: `Bearer ${bobToken}`,
          },
        }
      );
      expect(res.status).not.toBe(200);
      const rules = await call(bobToken, 'get_rules');
      expect(rules.body.rules.autoSign.enabled).toBeFalse();
    });
  });
});
