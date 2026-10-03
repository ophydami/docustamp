/**
 * "Who is signing": the name a document prints for the party an agent signs
 * for, checked against the account (cloud/lib/signerName.js), and what each
 * path does with it:
 *  - the user's own document (sign_document, signForMe): a mismatch is refused,
 *    before anything is sent, until confirmNameMismatch, which is recorded;
 *  - a document someone else sent: never refused, the approval carries
 *    nameCheck, and approving records the confirmation;
 *  - the audit trail JSON and the certificate show a confirmed mismatch.
 * The reading itself is checked on real PDFs (pdf-lib in, pdf.js out).
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractLayout } from '../cloud/ai/pdfLayout.js';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { setAgentSignMailTransport } from '../cloud/lib/agentSign.js';
import { setApprovalMailTransport } from '../cloud/lib/approvals.js';
import { entryJson } from '../cloud/lib/audit.js';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import {
  checkSeatName,
  checkSignerName,
  cleanName,
  matchesAccount,
  nameMismatchMessage,
  nameMismatchRecord,
  printedNamesForSeat,
} from '../cloud/lib/signerName.js';
import GenerateCertificate, {
  agentCertificateRows,
  certificateBlocks,
} from '../cloud/parsefunction/pdf/GenerateCertificate.js';
import { resetIdempotency } from '../cloud/api/shared.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

const ACCOUNT = { name: 'Morgan Avery', company: 'Avery Labs LLC' };

/**
 * A one-page PDF with `lines` printed on it: `[text, x, top, size?]`, `top` in
 * points from the top of the page (the stored field system).
 */
async function pdfWith(lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [text, x, top, size = 11] of lines) {
    page.drawText(text, { x, y: 792 - top - size, size, font });
  }
  return new Uint8Array(await pdf.save());
}

async function layoutOf(lines) {
  return await extractLayout(await pdfWith(lines));
}

/** A seat as lib/agentSign.js findAgentSeat returns it: `fields` is `[type, x, top]`. */
function seat(role, fields, contactId = 'c1') {
  const placeholder = {
    Role: role,
    signerObjId: contactId,
    placeHolder: [
      {
        pageNumber: 1,
        pos: fields.map(([type, x, y], i) => ({
          key: `${contactId}-${i}`,
          type,
          xPosition: x,
          yPosition: y,
          Width: 150,
          Height: 40,
        })),
      },
    ],
  };
  return { contactId, placeholder };
}

function docOf(...seats) {
  return { Placeholders: seats.map(s => s.placeholder) };
}

async function check(lines, mine, ...others) {
  return checkSignerName(await layoutOf(lines), mine, docOf(mine, ...others), ACCOUNT);
}

const landlord = seat('Landlord', [['signature', 72, 470]]);
const tenant = seat('Tenant', [['signature', 320, 470]], 'c2');

describe('signer name check', () => {
  describe('reading the names a document prints for a party', () => {
    it('finds "Landlord: Jordan Ellis" and calls it a mismatch', async () => {
      const result = await check(
        [
          ['Residential Lease Agreement', 72, 60, 14],
          ['Landlord: Jordan Ellis', 72, 100],
          ['Tenant: Cameron Brooks', 72, 120],
        ],
        landlord,
        tenant
      );
      expect(result.status).toBe('mismatch');
      expect(result.expected).toBe('Morgan Avery');
      expect(result.role).toBe('Landlord');
      expect(result.printed).toEqual([
        {
          name: 'Jordan Ellis',
          page: 1,
          quote: 'Landlord: Jordan Ellis',
          source: 'role',
          matches: false,
        },
      ]);
    });

    it('finds "Jordan Ellis (Landlord)" and \'Acme Corp ("Buyer")\', each for its own party', async () => {
      const lines = [
        [
          'This lease is made between Jordan Ellis (Landlord) and Cameron Brooks (Tenant).',
          72,
          100,
          10,
        ],
      ];
      const forLandlord = await check(lines, landlord, tenant);
      expect(forLandlord.printed.map(p => p.name)).toEqual(['Jordan Ellis']);
      const forTenant = await check(lines, tenant, landlord);
      expect(forTenant.printed.map(p => p.name)).toEqual(['Cameron Brooks']);

      const buyer = seat('Buyer', [['signature', 72, 470]]);
      const sale = await check(
        [['Acme Corp ("Buyer") and Jordan Ellis, an individual ("Seller")', 72, 100, 10]],
        buyer
      );
      expect(sale.status).toBe('mismatch');
      expect(sale.printed.map(p => p.name)).toEqual(['Acme Corp']);
    });

    it('matches with a middle name, initials, accents or titles, and the account company', async () => {
      for (const printed of [
        'Landlord: Morgan James Avery',
        'Landlord: M. Avery',
        'Landlord: Dr. Mórgan Ávery',
        'Landlord: MORGAN AVERY',
        'Landlord: Avery Labs, LLC',
      ]) {
        // eslint-disable-next-line no-await-in-loop -- one small PDF each
        const result = await check([[printed, 72, 100]], landlord, tenant);
        expect(result.status).toBe('match', printed);
      }
    });

    it('ignores blanks and placeholders, and finds nothing on a page without names', async () => {
      const blanks = await check(
        [
          ['Landlord: ______________________', 72, 100],
          ['Landlord name: [Landlord Name]', 72, 120],
          ['Landlord: 10/03/2026', 72, 140],
          ['Landlord email: jordan@example.test', 72, 160],
          ['Landlord: shall keep the premises in good repair.', 72, 180],
          ['Landlord signature: ______________________', 72, 480],
          ['Name: Signature', 72, 515],
          ['Printed name: ________________', 72, 530],
          ['Date: ____________', 72, 545],
        ],
        landlord,
        tenant
      );
      expect(blanks).toEqual({
        status: 'unknown',
        expected: 'Morgan Avery',
        role: 'Landlord',
        printed: [],
      });

      const none = await check([['Residential Lease Agreement', 72, 60, 14]], landlord, tenant);
      expect(none.status).toBe('unknown');
    });

    it("reads labels by the seat's own fields, not the ones by the other party's", async () => {
      const lines = [
        ['Signature: ______________', 72, 500],
        ['Name: Jordan Ellis', 72, 520],
        ['Name: Cameron Brooks', 320, 520],
      ];
      const forLandlord = await check(lines, landlord, tenant);
      expect(forLandlord.printed).toEqual([
        jasmine.objectContaining({ name: 'Jordan Ellis', source: 'nearby', matches: false }),
      ]);
      const forTenant = await check(lines, tenant, landlord);
      expect(forTenant.printed.map(p => p.name)).toEqual(['Cameron Brooks']);

      // Stacked blocks: the landlord's printed name sits above the tenant's
      // line, but after a heading and a blank of its own.
      const upper = seat('Landlord', [['signature', 72, 400]]);
      const lower = seat('Tenant', [['signature', 72, 520]], 'c2');
      const stacked = [
        ['LANDLORD', 72, 380],
        ['Name: Jordan Ellis', 72, 445],
        ['Date: ______', 72, 465],
        ['TENANT', 72, 500],
        ['Name: Morgan Avery', 72, 565],
      ];
      const alone = checkSignerName(await layoutOf(stacked), lower, docOf(lower), ACCOUNT);
      expect(alone.status).toBe('match');
      expect(alone.printed.map(p => p.name)).toEqual(['Morgan Avery']);
      expect((await check(stacked, upper, lower)).printed.map(p => p.name)).toEqual([
        'Jordan Ellis',
      ]);
    });

    it('counts a company the account holder signs for by name as consistent', async () => {
      const result = await check(
        [
          ['Sereniq Inc. (Landlord)', 72, 100],
          ['By: Morgan Avery', 72, 515],
        ],
        landlord
      );
      expect(result.status).toBe('match');
      expect(result.printed.map(p => p.name)).toEqual(['Sereniq Inc.', 'Morgan Avery']);
    });

    it('is unknown with no text, an unreadable file, or no account name', async () => {
      const blank = await PDFDocument.create();
      blank.addPage([612, 792]);
      const scanned = await extractLayout(new Uint8Array(await blank.save()));
      expect(checkSignerName(scanned, landlord, docOf(landlord), ACCOUNT).status).toBe('unknown');
      expect(checkSignerName(null, landlord, docOf(landlord), ACCOUNT).status).toBe('unknown');

      const garbage = await checkSeatName({ URL: 'x' }, landlord, ACCOUNT, {
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      expect(garbage).toEqual({
        status: 'unknown',
        expected: 'Morgan Avery',
        role: 'Landlord',
        printed: [],
      });

      const layout = await layoutOf([['Landlord: Jordan Ellis', 72, 100]]);
      expect(checkSignerName(layout, landlord, docOf(landlord), { name: '' }).status).toBe(
        'unknown'
      );
      expect(printedNamesForSeat(layout, landlord, docOf(landlord)).length).toBe(1);
    });
  });

  describe('comparing names', () => {
    it('matches the same person and the account company, and nobody else', () => {
      expect(matchesAccount('Morgan Avery', ACCOUNT)).toBeTrue();
      expect(matchesAccount('Avery, Morgan', ACCOUNT)).toBeTrue();
      expect(matchesAccount('Ms. Morgan A. Avery', ACCOUNT)).toBeTrue();
      expect(matchesAccount('M Avery', ACCOUNT)).toBeTrue();
      expect(matchesAccount('Morgan Avery Jr.', ACCOUNT)).toBeTrue();
      expect(matchesAccount('Avery Labs, L.L.C.', ACCOUNT)).toBeTrue();
      expect(matchesAccount('Jordan Ellis', ACCOUNT)).toBeFalse();
      expect(matchesAccount('Jordan Avery', ACCOUNT)).toBeFalse();
      expect(matchesAccount('J. Avery', ACCOUNT)).toBeFalse();
      expect(matchesAccount('Avery Holdings LLC', ACCOUNT)).toBeFalse();
      expect(matchesAccount('Morgan Avery', { name: '', company: '' })).toBeFalse();
    });

    it('reads a value as a name only when it is one', () => {
      expect(cleanName('Jordan Ellis, residing at 12 Oak Street')).toBe('Jordan Ellis');
      expect(cleanName('Acme Holdings, LLC')).toBe('Acme Holdings, LLC');
      expect(cleanName('Jordan Ellis Title: CEO')).toBe('Jordan Ellis');
      expect(cleanName('/s/ Jordan Ellis')).toBe('Jordan Ellis');
      for (const value of [
        '',
        '______',
        '[Name]',
        '<name>',
        'Name',
        'Signature',
        'Printed Name',
        'Landlord',
        '10/03/2026',
        'Oct 3, 2026',
        'jordan@example.test',
        '12 Oak Street',
        'See Exhibit A',
        'shall pay the rent',
        'N/A',
      ]) {
        expect(cleanName(value)).toBeNull(value);
      }
    });

    it('explains a mismatch and records it', () => {
      const mismatch = {
        status: 'mismatch',
        expected: 'Morgan Avery',
        role: 'Landlord',
        printed: [
          { name: 'Jordan Ellis', matches: false },
          { name: 'Morgan Avery', matches: true },
        ],
      };
      expect(nameMismatchMessage(mismatch)).toBe(
        'This document names "Jordan Ellis" as the Landlord, but your agent signs as Morgan Avery. Fix the name in the document, or, if the user really signs for that party, ask them and call again with confirmNameMismatch: true.'
      );
      expect(nameMismatchMessage({ ...mismatch, role: '' })).toContain(
        'names "Jordan Ellis" next to your signature line'
      );
      expect(nameMismatchRecord(mismatch)).toEqual({
        printed: 'Jordan Ellis',
        expected: 'Morgan Avery',
        confirmed: true,
      });
      expect(nameMismatchRecord(mismatch, { via: 'web' }).via).toBe('web');
    });
  });

  describe('on the record', () => {
    const SIGNED_AT = '2026-10-03T15:00:00.000Z';
    const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });
    const sampleDoc = nameMismatch => ({
      objectId: 'docName1',
      Name: 'Residential Lease Agreement',
      ExtUserPtr: { objectId: 'ext1', Name: 'Morgan Avery', Email: 'morgan@example.test' },
      SenderName: 'Morgan Avery',
      SenderMail: 'morgan@example.test',
      DateFormat: 'MMM DD, YYYY',
      Timezone: 'UTC',
      DocSentAt: SIGNED_AT,
      completedAt: SIGNED_AT,
      Signers: [{ objectId: 'c1', Name: 'Morgan Avery', Email: 'morgan@example.test' }],
      Placeholders: [{ signerObjId: 'c1', Role: 'Landlord' }],
      AuditTrail: [
        {
          UserPtr: pointer('contracts_Contactbook', 'c1'),
          Activity: 'Signed',
          SignedOn: { __type: 'Date', iso: SIGNED_AT },
          ipAddress: '10.0.0.1',
          Method: 'agent',
          Agent: { kind: 'oauth', clientId: 'cid', name: 'Codex', host: 'chatgpt.com' },
          OnBehalfOf: { name: 'Morgan Avery', email: 'morgan@example.test', userId: 'u1' },
          AllowedBy: {
            via: 'own_document',
            name: 'Morgan Avery',
            email: 'morgan@example.test',
            at: { __type: 'Date', iso: SIGNED_AT },
            signingEnabledAt: null,
            ...(nameMismatch ? { nameMismatch } : {}),
          },
        },
      ],
    });
    const confirmed = { printed: 'Jordan Ellis', expected: 'Morgan Avery', confirmed: true };
    const opts = { DateFormat: 'MMM DD, YYYY', timezone: 'UTC', Is12Hr: true };

    it('adds a "Name on document" row to the agent block, and nothing without a mismatch', () => {
      const [block] = certificateBlocks(sampleDoc(confirmed));
      expect(block.AllowedBy.nameMismatch).toEqual(confirmed);
      expect(agentCertificateRows(block, opts)).toEqual([
        { label: 'Signed by', value: 'AI agent Codex (chatgpt.com) for Morgan Avery' },
        { label: 'Allowed by', value: 'Morgan Avery, own document' },
        {
          label: 'Name on document',
          value: 'Jordan Ellis (signed as Morgan Avery, confirmed by Morgan Avery)',
        },
      ]);
      const [plain] = certificateBlocks(sampleDoc(null));
      expect(Object.keys(plain.AllowedBy)).not.toContain('nameMismatch');
      expect(agentCertificateRows(plain, opts).length).toBe(2);
    });

    it('prints the row on the certificate and exposes it in the audit trail JSON', async () => {
      const bytes = await GenerateCertificate(sampleDoc(confirmed));
      const layout = await extractLayout(new Uint8Array(bytes));
      const text = layout.pages.flatMap(p => p.lines.map(l => l.text)).join('\n');
      expect(text).toContain('Name on document :');
      expect(text).toContain('Jordan Ellis (signed as Morgan Avery, confirmed by Morgan Avery)');

      const d = sampleDoc(confirmed);
      expect(entryJson(d.AuditTrail[0], d).allowedBy.nameMismatch).toEqual(confirmed);
      const without = sampleDoc(null);
      expect(Object.keys(entryJson(without.AuditTrail[0], without).allowedBy)).not.toContain(
        'nameMismatch'
      );
    });
  });
});

/* ------------------------------------------------------------------ over MCP */

let accountSeq = 0;

async function makeAccount(prefix, name) {
  accountSeq += 1;
  const email = uniqueEmail(`${prefix}.${accountSeq}`, 'example.test');
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
  extUser.set('Company', 'Avery Labs LLC');
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

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** An OAuth connection for `account` with "Can sign for me" ticked. */
async function connect(clientId, account) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
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
    { requestId, approve: true, allowSigning: true },
    account.session
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
  return res.data.access_token;
}

/** A tool call: `error` (its text) when it failed, else `body` (parsed JSON) and the whole result. */
async function call(token, name, args = {}) {
  const res = await http.post(
    `${BASE}/mcp`,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
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
  const result = res.data.result;
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

function leaseProposal() {
  const role = (key, label) => ({ key, label, name: '', email: '', is_sender: false });
  const box = (r, y) => ({
    role: r,
    type: 'signature',
    label: `${r} signature`,
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
    summary: 'A lease between a landlord and a tenant.',
    document_type: 'lease',
    language: 'en',
    roles: [role('landlord', 'Landlord'), role('tenant', 'Tenant')],
    fields: [box('landlord', 470), box('tenant', 570)],
    signing_order_matters: false,
    warnings: [],
  };
}

function reviewAnswer() {
  return {
    summary: 'A purchase agreement.',
    overall: 'standard',
    parties: [],
    keyTerms: [],
    flags: [],
    instructionsAimedAtAI: false,
  };
}

describe('signer name check over MCP', () => {
  Parse.User.enableUnsafeCurrentUser();

  const ELLIS_URL = `${BASE}/files/test/namecheck-lease-ellis.pdf`;
  const AVERY_URL = `${BASE}/files/test/namecheck-lease-avery.pdf`;
  const PURCHASE_URL = `${BASE}/files/test/namecheck-purchase.pdf`;

  let owner;
  let ownerToken;
  let bob;
  let bobToken;
  let sender;
  let senderToken;
  let requestMails;
  let ownerNotices;
  let approvalMails;
  let tenantSeq = 0;

  const nextTenant = () => {
    tenantSeq += 1;
    return uniqueEmail(`namecheck.tenant.${tenantSeq}`, 'example.test');
  };
  const mailedTo = () => requestMails.map(m => String(m.recipient).toLowerCase());

  async function signedEntry(docId) {
    const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    return (doc.get('AuditTrail') || []).find(a => a.Activity === 'Signed') || null;
  }

  async function storedDoc(docId) {
    const query = new Parse.Query('contracts_Document');
    query.include('Signers');
    query.include('ExtUserPtr');
    return JSON.parse(JSON.stringify(await query.get(docId, { useMasterKey: true })));
  }

  /** A sent lease with the owner (me) as Landlord, on the given PDF. */
  async function sentLease(url) {
    const created = await call(ownerToken, 'create_document', {
      name: 'Lease',
      url,
      recipients: [
        { me: true, role: 'Landlord' },
        { email: nextTenant(), name: 'Cameron Brooks', role: 'Tenant' },
      ],
      fields: [
        { recipient: 'Landlord', type: 'signature', page: 1, x: 250, y: 470 },
        { recipient: 'Tenant', type: 'signature', page: 1, x: 250, y: 570 },
      ],
      send: true,
    });
    expect(created.error).toBeUndefined(created.error);
    return created.body;
  }

  beforeAll(async () => {
    process.env.PFX_BASE64 = process.env.PFX_BASE64 || '';
    resetRateLimits();
    owner = await makeAccount('namecheck.owner', 'Morgan Avery');
    bob = await makeAccount('namecheck.bob', 'Bob Buyer');
    sender = await makeAccount('namecheck.sender', 'Sam Seller');
    ({ token: senderToken } = await Parse.Cloud.run('generateapitoken', {}, sender.session));
    const reg = await http.post(`${BASE}/oauth/register`, {
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_REDIRECT],
    });
    expect(reg.status).toBe(201, JSON.stringify(reg.data));
    ownerToken = await connect(reg.data.client_id, owner);
    bobToken = await connect(reg.data.client_id, bob);

    const lease = name => [
      ['Residential Lease Agreement', 72, 60, 14],
      [`Landlord: ${name}`, 72, 100],
      ['Tenant: Cameron Brooks', 72, 120],
      ['Landlord signature: ______________________', 72, 480],
      ['Tenant signature: ______________________', 72, 580],
    ];
    const files = new Map([
      [ELLIS_URL, Buffer.from(await pdfWith(lease('Jordan Ellis')))],
      [AVERY_URL, Buffer.from(await pdfWith(lease('Morgan Avery')))],
      [
        PURCHASE_URL,
        Buffer.from(
          await pdfWith([
            ['Purchase agreement', 72, 60, 14],
            ['Buyer: Cameron Brooks', 72, 100],
            ['Seller: Sam Seller', 72, 120],
          ])
        ),
      ],
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
        create: async request => {
          const tool = request.tool_choice?.name || request.tools?.[0]?.name;
          const input = tool === 'report_contract_review' ? reviewAnswer() : leaseProposal();
          return {
            model: 'fake-claude',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'tool_use', id: 'tu_1', name: tool, input }],
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
    approvalMails = [];
    setRequestMailTransport(async params => {
      requestMails.push(params);
      return { status: 'success' };
    });
    setAgentSignMailTransport(async params => {
      ownerNotices.push(params);
      return { status: 'success' };
    });
    setApprovalMailTransport(async params => {
      approvalMails.push(params);
      return { status: 'success' };
    });
  });

  afterAll(() => {
    setRequestMailTransport(null);
    setAgentSignMailTransport(null);
    setApprovalMailTransport(null);
    setAiClientForTests(null);
  });

  it('refuses sign_document on an own document that names someone else, then signs once confirmed', async () => {
    const doc = await sentLease(ELLIS_URL);
    ownerNotices = [];

    const refused = await call(ownerToken, 'sign_document', { documentId: doc.objectId });
    expect(refused.error).toContain(
      'This document names "Jordan Ellis" as the Landlord, but your agent signs as Morgan Avery.'
    );
    expect(refused.error).toContain('confirmNameMismatch: true');
    expect(await signedEntry(doc.objectId)).toBeNull();
    expect(ownerNotices.length).toBe(0);

    const signed = await call(ownerToken, 'sign_document', {
      documentId: doc.objectId,
      confirmNameMismatch: true,
    });
    expect(signed.error).toBeUndefined(signed.error);
    expect(signed.body.status).toBe('signed');

    const entry = await signedEntry(doc.objectId);
    expect(entry.Method).toBe('agent');
    expect(entry.AllowedBy.via).toBe('own_document');
    expect(entry.AllowedBy.nameMismatch).toEqual({
      printed: 'Jordan Ellis',
      expected: 'Morgan Avery',
      confirmed: true,
    });

    const trail = await call(ownerToken, 'get_audit_trail', { documentId: doc.objectId });
    const signedRow = trail.body.entries.find(e => e.activity === 'Signed');
    expect(signedRow.allowedBy.nameMismatch).toEqual(entry.AllowedBy.nameMismatch);

    const block = certificateBlocks(await storedDoc(doc.objectId)).find(b => b.Method === 'agent');
    expect(agentCertificateRows(block).at(-1)).toEqual({
      label: 'Name on document',
      value: 'Jordan Ellis (signed as Morgan Avery, confirmed by Morgan Avery)',
    });
  }, 90000);

  it("signs as before when the document prints the account holder's own name", async () => {
    const doc = await sentLease(AVERY_URL);
    const signed = await call(ownerToken, 'sign_document', { documentId: doc.objectId });
    expect(signed.error).toBeUndefined(signed.error);
    expect(signed.body.status).toBe('signed');
    const entry = await signedEntry(doc.objectId);
    expect(Object.keys(entry.AllowedBy)).not.toContain('nameMismatch');
    const block = certificateBlocks(await storedDoc(doc.objectId)).find(b => b.Method === 'agent');
    expect(agentCertificateRows(block).map(r => r.label)).toEqual(['Signed by', 'Allowed by']);
  }, 90000);

  it('refuses signForMe before anything is sent, and sends once confirmed', async () => {
    const tenantEmail = nextTenant();
    const res = await call(ownerToken, 'quick_send', {
      url: ELLIS_URL,
      recipients: [
        { me: true, role: 'Landlord' },
        { email: tenantEmail, name: 'Cameron Brooks', role: 'Tenant' },
      ],
      signForMe: true,
    });
    expect(res.error).toContain('This document names "Jordan Ellis" as the Landlord');
    expect(res.error).toContain('Nothing was sent.');
    expect(requestMails.length).toBe(0);
    expect(ownerNotices.length).toBe(0);
    const id = /documentId (\w+)/.exec(res.error)?.[1];
    const row = await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });
    expect(row.get('DocSentAt')).toBeUndefined();
    expect(row.get('SignedUrl')).toBeUndefined();

    const sent = await call(ownerToken, 'send_document', {
      documentId: id,
      signForMe: true,
      confirmNameMismatch: true,
    });
    expect(sent.error).toBeUndefined(sent.error);
    expect(sent.body.signedForYou.status).toBe('signed');
    expect(mailedTo()).toEqual([tenantEmail]);
    expect(ownerNotices.map(n => n.recipient)).toEqual([owner.email]);
    const entry = await signedEntry(id);
    expect(entry.AllowedBy.nameMismatch).toEqual({
      printed: 'Jordan Ellis',
      expected: 'Morgan Avery',
      confirmed: true,
    });
  }, 90000);

  it('asks for approval on a document someone else sent, with the mismatch on it, and records the approval', async () => {
    const created = await call(senderToken, 'create_document', {
      name: 'Purchase agreement',
      url: PURCHASE_URL,
      recipients: [
        { email: bob.email, name: bob.name, role: 'Buyer' },
        {
          email: uniqueEmail('namecheck.other', 'example.test'),
          name: 'Olive Other',
          role: 'Seller',
        },
      ],
      fields: [
        { recipient: 'Buyer', type: 'signature', page: 1, x: 72, y: 500 },
        { recipient: 'Seller', type: 'signature', page: 1, x: 320, y: 500 },
      ],
      send: true,
    });
    expect(created.error).toBeUndefined(created.error);
    const docId = created.body.objectId;

    const asked = await call(bobToken, 'sign_document', { documentId: docId });
    expect(asked.error).toBeUndefined(asked.error);
    expect(asked.body.status).toBe('awaiting_approval');
    expect(asked.body.message).toContain('this document names "Cameron Brooks" as the Buyer');
    const approval = asked.structuredContent.approval;
    expect(approval.nameCheck).toEqual({
      status: 'mismatch',
      expected: 'Bob Buyer',
      role: 'Buyer',
      printed: [
        jasmine.objectContaining({
          name: 'Cameron Brooks',
          page: 1,
          source: 'role',
          matches: false,
        }),
      ],
    });
    expect(approvalMails.length).toBe(1);
    expect(approvalMails[0].html).toContain('Check the name first');
    expect(approvalMails[0].html).toContain('Cameron Brooks');
    expect(await signedEntry(docId)).toBeNull();

    const web = await Parse.Cloud.run('getsignapproval', { id: approval.id }, bob.session);
    expect(web.nameCheck.status).toBe('mismatch');

    const decided = await Parse.Cloud.run(
      'decidesignapproval',
      { id: approval.id, decision: 'approve' },
      bob.session
    );
    expect(decided.status).toBe('signed', decided.error);
    const entry = await signedEntry(docId);
    expect(entry.AllowedBy).toEqual(
      jasmine.objectContaining({
        via: 'web',
        approvalId: approval.id,
        nameMismatch: {
          printed: 'Cameron Brooks',
          expected: 'Bob Buyer',
          confirmed: true,
          via: 'web',
        },
      })
    );
  }, 90000);
});
