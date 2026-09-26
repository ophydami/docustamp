/**
 * Coverage for the API-token auth, the REST API v1, the stateless MCP endpoint and
 * the AI document preparation (with a fake Claude client).
 */
import axios from 'axios';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { looksLikeToken, resolveApiToken } from '../cloud/lib/apiTokens.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { setLifecycleMailTransport } from '../cloud/lib/lifecycle.js';
import { setWebhookTransport, signPayload } from '../cloud/lib/webhooks.js';
import { runChainOnComplete } from '../cloud/lib/chain.js';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { analyzePdf } from '../cloud/ai/analyze.js';
import { extractLayout, layoutTranscript } from '../cloud/ai/pdfLayout.js';
import {
  resetTenantBrandingCache,
  resolveTenantBranding,
} from '../cloud/parsefunction/tenantBranding.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { resetIdempotency } from '../cloud/api/shared.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
process.env.PUBLIC_URL = 'https://sign.example.test';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true });

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
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

async function makeTenant(user) {
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  return await tenant.save(null, { useMasterKey: true });
}

async function makeExtUser(user, tenant) {
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', user.get('email'));
  extUser.set('Company', 'Acme Inc');
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  return await extUser.save(null, { useMasterKey: true });
}

/** A landscape-rotated page (/Rotate 90), to check the layout transform. */
async function makeRotatedPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature: ______________________', { x: 72, y: 700, size: 12, font });
  page.setRotation(degrees(90));
  return new Uint8Array(await pdf.save());
}

/** A page whose CropBox starts 100 pt above the MediaBox origin. */
async function makeCroppedPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature: ______________________', { x: 72, y: 700, size: 12, font });
  page.setCropBox(0, 100, 612, 692);
  return new Uint8Array(await pdf.save());
}

/** Three A4 pages, for the "default fields go on the last page" check. */
async function makeThreePagePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Page ${n}`, { x: 72, y: 700, size: 12, font });
  }
  return new Uint8Array(await pdf.save());
}

/** A one-page lease with printed signature lines. */
async function makeLeasePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const draw = (text, y) => page.drawText(text, { x: 72, y, size: 12, font });
  draw('Residential Lease Agreement', 720);
  draw('This lease is between the Landlord and the Tenant.', 690);
  draw('Tenant name: ______________________', 640);
  draw('Tenant signature: ______________________', 600);
  draw('Date: ______________', 560);
  draw('Landlord signature: ______________________', 500);
  return new Uint8Array(await pdf.save());
}

/** Labels followed by DRAWN rules (vector lines / thin rectangles), the HTML-to-PDF idiom. */
async function makeRuledPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Acme initials:', { x: 72, y: 700, size: 9, font });
  page.drawLine({ start: { x: 150, y: 697 }, end: { x: 260, y: 697 }, thickness: 0.8 });
  page.drawText('Customer signature:', { x: 72, y: 650, size: 10, font });
  page.drawRectangle({ x: 170, y: 646, width: 200, height: 0.7 });
  page.drawText('Date:', { x: 400, y: 650, size: 10, font });
  page.drawLine({ start: { x: 430, y: 647 }, end: { x: 540, y: 647 }, thickness: 1 });
  page.drawText('Elected', { x: 72, y: 600, size: 10, font });
  page.drawText('Declined', { x: 230, y: 600, size: 10, font });
  return new Uint8Array(await pdf.save());
}

function fakeAi(proposalForLayout) {
  return {
    messages: {
      create: async request => {
        fakeAi.calls += 1;
        fakeAi.lastRequest = request;
        const transcript = request.messages[0].content.find(b => b.type === 'text').text;
        const layout = await extractLayout(fakeAi.lastPdf);
        const input = proposalForLayout(layout, transcript);
        return {
          model: 'fake-claude',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'tu_1', name: 'propose_signing_setup', input }],
        };
      },
    },
  };
}
fakeAi.calls = 0;

/** A fake client that answers with whatever the test hands it (or throws). */
function fakeAiRaw(answer) {
  return {
    messages: {
      create: async () => {
        fakeAi.calls += 1;
        if (typeof answer === 'function') return answer();
        return answer;
      },
    },
  };
}

function lineIdFor(layout, needle) {
  for (const page of layout.pages) {
    const line = page.lines.find(l => l.text.toLowerCase().includes(needle.toLowerCase()));
    if (line) return line.id;
  }
  throw new Error(`no line containing ${needle}`);
}

function leaseProposal(withEmails) {
  return layout => ({
    title: 'Residential Lease Agreement',
    summary: 'A lease between a landlord and a tenant. Both sign.',
    document_type: 'lease',
    language: 'en',
    roles: [
      {
        key: 'tenant',
        label: 'Tenant',
        name: '',
        email: withEmails ? 'tenant@example.test' : '',
        is_sender: false,
      },
      {
        key: 'landlord',
        label: 'Landlord',
        name: '',
        email: withEmails ? 'landlord@example.test' : '',
        is_sender: false,
      },
    ],
    fields: [
      {
        role: 'tenant',
        type: 'name',
        label: 'Tenant name',
        page: 1,
        anchor_line: lineIdFor(layout, 'Tenant name'),
        placement: 'on_blank',
        required: true,
      },
      {
        role: 'tenant',
        type: 'signature',
        label: 'Tenant signature',
        page: 1,
        anchor_line: lineIdFor(layout, 'Tenant signature'),
        placement: 'on_blank',
        required: true,
      },
      {
        role: 'tenant',
        type: 'date',
        label: 'Date',
        page: 1,
        anchor_line: lineIdFor(layout, 'Date:'),
        placement: 'on_blank',
        required: true,
      },
      {
        role: 'landlord',
        type: 'signature',
        label: 'Landlord signature',
        page: 1,
        anchor_line: lineIdFor(layout, 'Landlord signature'),
        placement: 'on_blank',
        required: true,
      },
      {
        role: 'ghost',
        type: 'initials',
        label: 'nobody',
        page: 1,
        placement: 'absolute',
        x: 10,
        y: 10,
        required: true,
      },
    ],
    signing_order_matters: true,
    warnings: [],
  });
}

describe('API tokens, REST v1, MCP and AI preparation', () => {
  Parse.User.enableUnsafeCurrentUser();

  let user;
  let token;
  let pdfBytes;
  let threePageBytes;
  let ruledBytes;
  let mails;
  const PDF_URL = `${BASE}/files/test/lease-spec.pdf`;
  const THREE_PAGE_URL = `${BASE}/files/test/threepage.pdf`;
  const RULED_URL = `${BASE}/files/test/ruled.pdf`;

  beforeAll(async () => {
    user = await makeUser('owner');
    const tenant = await makeTenant(user);
    await makeExtUser(user, tenant);
    pdfBytes = await makeLeasePdf();
    threePageBytes = await makeThreePagePdf();
    ruledBytes = await makeRuledPdf();
    fakeAi.lastPdf = pdfBytes;
    mails = [];
    setRequestMailTransport(async params => {
      mails.push(params);
      return { status: 'success' };
    });
    // Stored-file downloads go through axios.get; serve the spec PDF for our URL.
    // Uploads (parseUploadFile) POST to the Parse files endpoint over axios; the
    // test server has no reachable files endpoint here, so the spy stores the
    // bytes and hands back a url on our own origin that the GET spy serves.
    const fakeFiles = new Map();
    spyOn(axios, 'post').and.callFake(async (url, data) => {
      const u = String(url);
      const m = u.match(/\/files\/([^/?]+)$/);
      if (!m) throw new Error(`unexpected axios.post ${url}`);
      const stored = `${BASE}/files/test/${m[1]}`;
      fakeFiles.set(stored, Buffer.from(data));
      return { status: 201, data: { url: stored, name: m[1] } };
    });
    spyOn(axios, 'get').and.callFake(async url => {
      const u = String(url);
      const bare = u.split('?')[0];
      if (fakeFiles.has(bare)) return { data: fakeFiles.get(bare).buffer.slice(fakeFiles.get(bare).byteOffset, fakeFiles.get(bare).byteOffset + fakeFiles.get(bare).byteLength), status: 200 };
      if (u.startsWith(PDF_URL)) return { data: pdfBytes.buffer.slice(0), status: 200 };
      if (u.includes('threepage')) return { data: threePageBytes.buffer.slice(0), status: 200 };
      if (u.includes('ruled')) return { data: ruledBytes.buffer.slice(0), status: 200 };
      throw new Error(`unexpected axios.get ${url}`);
    });
    const res = await Parse.Cloud.run(
      'generateapitoken',
      {},
      { sessionToken: user.getSessionToken() }
    );
    token = res.token;
  });

  // Every authenticated call here lands in the same per-IP bucket, and this file
  // runs well inside one window, so without this the counters only ever go up
  // and the next spec added anywhere fails with "Too many requests" instead of
  // a real assertion. The AI budget (10/min/user) is in the same store.
  beforeEach(() => {
    resetRateLimits();
    resetIdempotency();
    fakeAi.calls = 0;
  });

  afterAll(() => {
    setRequestMailTransport(null);
    setAiClientForTests(null);
  });

  const authed = (extra = {}) => ({
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      public_url: 'https://sign.example.test',
      ...extra,
    },
  });

  async function rpc(method, params, id = 1, headers = {}) {
    return await http.post(
      `${BASE}/mcp`,
      { jsonrpc: '2.0', id, method, params },
      authed({ Accept: 'application/json, text/event-stream', ...headers })
    );
  }

  function rpcResult(res) {
    expect(res.status).toBe(200, JSON.stringify(res.data));
    expect(res.data.error).toBeUndefined(JSON.stringify(res.data.error));
    return res.data.result;
  }

  function toolJson(result) {
    expect(result.isError).toBeFalsy(JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }

  it('issues, describes, resolves and revokes a personal token', async () => {
    expect(looksLikeToken(token)).toBeTrue();
    const info = await Parse.Cloud.run('getapitoken', {}, { sessionToken: user.getSessionToken() });
    expect(info.token.prefix).toBe(token.slice(0, 11));
    const resolved = await resolveApiToken(token);
    expect(resolved.user.id).toBe(user.id);
    expect(await resolveApiToken('os_' + 'x'.repeat(40))).toBeNull();
    expect(await resolveApiToken('nonsense')).toBeNull();

    const other = await makeUser('temp');
    await makeExtUser(other, await makeTenant(other));
    const t2 = await Parse.Cloud.run(
      'generateapitoken',
      {},
      { sessionToken: other.getSessionToken() }
    );
    expect((await resolveApiToken(t2.token)).user.id).toBe(other.id);
    await Parse.Cloud.run('revokeapitoken', {}, { sessionToken: other.getSessionToken() });
    expect(await resolveApiToken(t2.token)).toBeNull();
    await Parse.User.logIn(user.get('email'), 'pa55word!');
  });

  it('rejects REST and MCP calls without a valid token', async () => {
    const me = await http.get(`${BASE}/v1/me`);
    expect(me.status).toBe(401);
    const bad = await http.get(`${BASE}/v1/me`, {
      headers: { Authorization: 'Bearer os_' + 'y'.repeat(40) },
    });
    expect(bad.status).toBe(401);
    const mcp = await http.post(`${BASE}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers['www-authenticate']).toContain('Bearer');
  });

  it('creates, sends, lists and links a document over REST', async () => {
    const me = await http.get(`${BASE}/v1/me`, authed());
    expect(me.status).toBe(200);
    expect(me.data.email).toBe(user.get('email'));

    const created = await http.post(
      `${BASE}/v1/documents`,
      {
        name: 'Lease via API',
        url: PDF_URL,
        recipients: [
          { name: 'Tina Tenant', email: 'tina@example.test', role: 'Tenant' },
          { name: 'Larry Landlord', email: 'larry@example.test' },
        ],
        note: 'Please sign by Friday',
      },
      authed()
    );
    expect(created.status).toBe(200, JSON.stringify(created.data));
    expect(created.data.status).toBe('draft');
    expect(created.data.signers.map(s => s.email)).toEqual([
      'tina@example.test',
      'larry@example.test',
    ]);
    expect(created.data.signers[0].role).toBe('Tenant');
    expect(created.data.signers[1].role).toBe('Role 2');
    // default layout: signature + date per signer
    expect(created.data.fieldCount).toBe(4);
    expect(mails.length).toBe(0);

    // Placeholders and Signers must stay index-parallel (§6.2).
    const raw = await new Parse.Query('contracts_Document').get(created.data.objectId, {
      useMasterKey: true,
    });
    expect(raw.get('Signers').length).toBe(2);
    expect(raw.get('Placeholders')[0].signerObjId).toBe(raw.get('Signers')[0].id);
    expect(raw.get('Placeholders')[0].placeHolder[0].pos[0].type).toBe('signature');
    expect(raw.get('Placeholders')[0].placeHolder[0].pos[0].options.status).toBe('required');
    expect(raw.get('ExpiryDate')).toBeDefined();
    expect(raw.get('SignedUrl')).toBeUndefined();

    const sent = await http.post(
      `${BASE}/v1/documents/${created.data.objectId}/send`,
      {},
      authed()
    );
    expect(sent.status).toBe(200, JSON.stringify(sent.data));
    expect(sent.data.status).toBe('in_progress');
    expect(sent.data.mail.sent.sort()).toEqual(['larry@example.test', 'tina@example.test']);
    expect(mails.length).toBe(2);
    expect(mails[0].subject).toContain('Lease via API');
    // index.js rewrites public_url to the request host, so only the path is stable here.
    expect(mails[0].html).toContain('/login/');
    expect(sent.data.signers[0].signingUrl).toContain('/login/');

    const again = await http.post(
      `${BASE}/v1/documents/${created.data.objectId}/send`,
      {},
      authed()
    );
    expect(again.status).toBe(400);
    expect(again.data.error).toContain('already sent');

    const list = await http.get(`${BASE}/v1/documents?status=in_progress`, authed());
    expect(list.status).toBe(200);
    expect(list.data.documents.some(d => d.objectId === created.data.objectId)).toBeTrue();
    const drafts = await http.get(`${BASE}/v1/documents?status=draft`, authed());
    expect(drafts.data.documents.some(d => d.objectId === created.data.objectId)).toBeFalse();

    const links = await http.get(
      `${BASE}/v1/documents/${created.data.objectId}/signing-links`,
      authed()
    );
    expect(links.data.links.length).toBe(2);

    const one = await http.get(`${BASE}/v1/documents/${created.data.objectId}`, authed());
    expect(one.data.urls.original).toContain('lease-spec.pdf');

    const contacts = await http.get(`${BASE}/v1/contacts?search=tina`, authed());
    expect(contacts.data.contacts.some(c => c.email === 'tina@example.test')).toBeTrue();
  });

  it('forbids touching another user’s document', async () => {
    const other = await makeUser('intruder');
    await makeExtUser(other, await makeTenant(other));
    const t2 = await Parse.Cloud.run(
      'generateapitoken',
      {},
      { sessionToken: other.getSessionToken() }
    );
    const mine = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Private', url: PDF_URL, recipients: [{ email: 'p@example.test' }] },
      authed()
    );
    const res = await http.get(`${BASE}/v1/documents/${mine.data.objectId}`, {
      headers: { Authorization: `Bearer ${t2.token}` },
    });
    expect(res.status).toBe(403);
    await Parse.User.logIn(user.get('email'), 'pa55word!');
  });

  it('serves MCP initialize, tools/list and tool calls statelessly', async () => {
    const init = rpcResult(
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'spec', version: '1' },
      })
    );
    expect(init.serverInfo.name).toBe('docustamp');
    // No session header: the endpoint is stateless.
    const list = await rpc('tools/list', {}, 2);
    expect(list.headers['mcp-session-id']).toBeUndefined();
    const names = rpcResult(list).tools.map(t => t.name);
    for (const n of [
      'whoami',
      'get_branding',
      'update_branding',
      'get_audit_trail',
      'verify_document',
      'void_document',
      'replace_signer',
      'resend_to',
      'extend_expiry',
      'wait_for',
      'merge_documents',
      'create_upload',
      'complete_upload',
      'register_webhook',
      'list_webhooks',
      'test_webhook',
      'delete_webhook',
      'create_template',
      'save_as_template',
      'delete_template',
      'update_contact',
      'delete_contact',
      'list_folders',
      'create_folder',
      'preview_page',
      'find_text',
      'detect_fields',
      'place_field_at_text',
      'upload_document',
      'analyze_document',
      'create_document',
      'quick_send',
      'send_document',
      'list_documents',
      'get_document',
      'send_reminder',
      'list_contacts',
      'list_templates',
    ]) {
      expect(names).toContain(n);
    }
    const who = toolJson(rpcResult(await rpc('tools/call', { name: 'whoami', arguments: {} }, 3)));
    expect(who.email).toBe(user.get('email'));

    const created = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          {
            name: 'create_document',
            arguments: {
              name: 'Lease via MCP',
              url: PDF_URL,
              recipients: [{ name: 'Mia', email: 'mia@example.test' }],
              fields: [
                { recipient: 0, type: 'signature', page: 1, x: 100, y: 600 },
                {
                  recipient: 'mia@example.test',
                  type: 'date',
                  page: 1,
                  x: 100,
                  y: 670,
                  label: 'Date signed',
                },
              ],
              send: true,
            },
          },
          4
        )
      )
    );
    expect(created.status).toBe('in_progress');
    expect(created.fieldCount).toBe(2);
    expect(created.mail.sent).toEqual(['mia@example.test']);

    const got = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          { name: 'get_document', arguments: { documentId: created.objectId } },
          5
        )
      )
    );
    expect(got.signers[0].status).toBe('pending');

    const bad = rpcResult(
      await rpc('tools/call', { name: 'get_document', arguments: { documentId: 'nope' } }, 6)
    );
    expect(bad.isError).toBeTrue();
    expect(bad.content[0].text).toContain('not found');
  });

  it('extracts a coordinate-annotated layout from the PDF', async () => {
    const layout = await extractLayout(pdfBytes);
    expect(layout.pageCount).toBe(1);
    expect(layout.pages[0].width).toBe(612);
    const sig = layout.pages[0].lines.find(l => l.text.startsWith('Tenant signature'));
    expect(sig).toBeDefined();
    expect(sig.blank).not.toBeNull();
    expect(sig.blank.x).toBeGreaterThan(72);
    expect(sig.y).toBeGreaterThan(150);
    expect(sig.y).toBeLessThan(220);
    expect(layoutTranscript(layout)).toContain(`${sig.id} [x=`);
  });

  it('turns the AI proposal into placed fields and placeholders', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    const proposal = await analyzePdf({ bytes: pdfBytes, instructions: 'test' });
    expect(proposal.title).toBe('Residential Lease Agreement');
    expect(proposal.roles.map(r => r.role)).toEqual(['Tenant', 'Landlord']);
    // The field for an unknown role is dropped and reported.
    expect(proposal.fields.length).toBe(4);
    expect(proposal.warnings.some(w => /could not be placed/.test(w))).toBeTrue();
    const layout = await extractLayout(pdfBytes);
    const sigLine = layout.pages[0].lines.find(l => l.text.startsWith('Tenant signature'));
    const sig = proposal.fields.find(f => f.type === 'signature' && f.role === 'Tenant');
    expect(sig.page).toBe(1);
    expect(sig.x).toBe(sigLine.blank.x);
    expect(sig.width).toBeLessThanOrEqual(sigLine.blank.w + 0.01);
    // Bottom of the box rests near the baseline of the printed line.
    expect(Math.abs(sig.y + sig.height - (sigLine.y + sigLine.h))).toBeLessThan(3);
    expect(proposal.placeholders.length).toBe(2);
    expect(proposal.placeholders[0].Role).toBe('Tenant');
    expect(proposal.placeholders[0].signerObjId).toBe('');
    const pos = proposal.placeholders[0].placeHolder[0].pos;
    expect(pos.map(p => p.type).sort()).toEqual(['date', 'name', 'signature']);
    expect(pos.every(p => typeof p.key === 'number' && p.options?.name)).toBeTrue();
  });

  it('aipreparedocument reports missing recipients, then creates the document', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    const first = await Parse.Cloud.run(
      'aipreparedocument',
      { url: PDF_URL, instructions: 'prepare' },
      { sessionToken: user.getSessionToken() }
    );
    expect(first.document).toBeNull();
    expect(first.needsRecipients.map(r => r.role)).toEqual(['Tenant', 'Landlord']);

    const second = await Parse.Cloud.run(
      'aipreparedocument',
      {
        url: PDF_URL,
        recipients: [
          { name: 'Tina', email: 'tina2@example.test' },
          { name: 'Larry', email: 'larry2@example.test' },
        ],
        send: false,
      },
      { sessionToken: user.getSessionToken() }
    );
    expect(second.needsRecipients).toEqual([]);
    expect(second.document.status).toBe('draft');
    expect(second.document.name).toBe('Residential Lease Agreement');
    expect(second.document.signers.map(s => s.email)).toEqual([
      'tina2@example.test',
      'larry2@example.test',
    ]);
    expect(second.document.fieldCount).toBe(4);
    expect(second.document.sendInOrder).toBeTrue();
  });

  it('quick_send asks before mailing an address it only read out of the document', async () => {
    setAiClientForTests(fakeAi(leaseProposal(true)));
    const before = mails.length;
    // The PDF is untrusted input, so an email the model found in it is a
    // suggestion, never a signer: nothing is created and nothing is mailed.
    const asked = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          { name: 'quick_send', arguments: { url: PDF_URL, instructions: 'send it' } },
          7
        )
      )
    );
    expect(asked.document).toBeNull();
    expect(asked.needsRecipients.map(r => r.suggestedEmail)).toEqual([
      'tenant@example.test',
      'landlord@example.test',
    ]);
    expect(asked.needsRecipients[0].source).toBe('document');
    expect(mails.length).toBe(before);
    // The full proposal comes back, so the confirming call can hand it straight
    // back instead of paying for a second analysis.
    expect(asked.proposal.placeholders.length).toBe(2);
    expect(fakeAi.calls).toBe(1);

    const result = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          {
            name: 'quick_send',
            arguments: { url: PDF_URL, acceptExtractedRecipients: true, proposal: asked.proposal },
          },
          8
        )
      )
    );
    expect(fakeAi.calls).toBe(1);
    expect(result.document.status).toBe('in_progress');
    expect(result.document.signers.map(s => s.email)).toEqual([
      'tenant@example.test',
      'landlord@example.test',
    ]);
    // Signing order mattered, so only the first signer is mailed.
    expect(result.document.mail.sent).toEqual(['tenant@example.test']);
    expect(mails.length).toBe(before + 1);
    expect(result.proposal.fieldCount).toBe(4);
  });

  it('quick_send binds the recipients the caller gave, and refuses more than there are roles', async () => {
    setAiClientForTests(fakeAi(leaseProposal(true)));
    const before = mails.length;
    const result = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          {
            name: 'quick_send',
            arguments: {
              url: PDF_URL,
              dryRun: true,
              recipients: [
                { name: 'Given Tenant', email: 'given-tenant@example.test' },
                { name: 'Given Landlord', email: 'given-landlord@example.test' },
              ],
            },
          },
          9
        )
      )
    );
    expect(result.document.status).toBe('draft');
    expect(result.document.signers.map(s => s.email)).toEqual([
      'given-tenant@example.test',
      'given-landlord@example.test',
    ]);
    expect(mails.length).toBe(before);

    const tooMany = rpcResult(
      await rpc(
        'tools/call',
        {
          name: 'quick_send',
          arguments: {
            url: PDF_URL,
            dryRun: true,
            recipients: [
              { email: 'a@example.test' },
              { email: 'b@example.test' },
              { email: 'c@example.test' },
            ],
          },
        },
        10
      )
    );
    expect(tooMany.isError).toBeTrue();
    expect(tooMany.content[0].text).toContain('only has 2 signer role');
  });
  it('edits, reviews, versions, restores, duplicates and deletes drafts', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const created = await call(
      'create_document',
      {
        name: 'Draft to edit',
        url: PDF_URL,
        recipients: [
          { name: 'Tina Tenant', email: 'tina-d@example.test', role: 'Tenant' },
          { name: 'Larry', email: 'larry-d@example.test', role: 'Landlord' },
        ],
      },
      20
    );
    const id = created.objectId;
    expect(created.fieldCount).toBe(4);

    const draft = await call('get_draft', { documentId: id, pages: true }, 21);
    expect(draft.editable).toBeTrue();
    expect(draft.recipients.length).toBe(2);
    expect(draft.recipients[0].fields.length).toBe(2);
    expect(draft.recipients[0].fields[0].key).toEqual(jasmine.any(Number));
    expect(draft.pages[0].width).toBe(612);
    expect(draft.versions).toBe(0);
    expect(draft.urls.editor).toContain(`/editor/${id}`);

    // Rename, change settings and recipients: Tina keeps her fields, Larry is replaced by Mona.
    const updated = await call(
      'update_draft',
      {
        documentId: id,
        name: 'Lease v2',
        note: 'Sign by Friday',
        settings: { expiryDays: 30, sendInOrder: true },
        message: { subject: 'Please sign {{document_title}}' },
        recipients: [
          { email: 'tina-d@example.test', role: 'Tenant' },
          { name: 'Mona', email: 'mona-d@example.test', role: 'Manager' },
        ],
      },
      22
    );
    expect(updated.changed).toEqual(['name', 'note', 'settings', 'message', 'recipients']);
    expect(updated.droppedFields).toBe(2);
    expect(updated.name).toBe('Lease v2');
    expect(updated.settings.expiryDays).toBe(30);
    expect(updated.settings.sendInOrder).toBeTrue();
    expect(updated.message.subject).toContain('{{document_title}}');
    expect(updated.recipients.map(r => r.email)).toEqual([
      'tina-d@example.test',
      'mona-d@example.test',
    ]);
    expect(updated.recipients[0].fields.length).toBe(2);
    expect(updated.recipients[1].fields.length).toBe(0);
    expect(updated.versions).toBe(1);

    // Signers stay parallel to Placeholders (§6.2).
    let raw = JSON.parse(
      JSON.stringify(await new Parse.Query('contracts_Document').get(id, { useMasterKey: true }))
    );
    expect(raw.Signers.length).toBe(2);
    expect(raw.Placeholders[1].signerObjId).toBe(raw.Signers[1].objectId);
    expect(raw.Placeholders[1].Role).toBe('Manager');

    // Review: Mona has nothing to sign yet; append fields for her, a prefill box and a checkbox.
    let review = await call('review_draft', { documentId: id }, 23);
    expect(review.readyToSend).toBeTrue();
    expect(
      review.warnings.some(w => w.code === 'recipient_without_fields' && w.recipient === 'Manager')
    ).toBeTrue();

    const appended = await call(
      'set_draft_fields',
      {
        documentId: id,
        mode: 'append',
        fields: [
          { recipient: 'Manager', type: 'signature', page: 1, x: 300, y: 600 },
          {
            recipient: 'prefill',
            type: 'text input',
            page: 1,
            x: 72,
            y: 100,
            label: 'Rent',
            defaultValue: '$1,200',
          },
          { recipient: 0, type: 'checkbox', page: 1, x: 72, y: 700, values: ['Pets', 'No pets'] },
        ],
      },
      24
    );
    expect(appended.fieldCount).toBe(5);
    expect(appended.prefillFields.length).toBe(1);
    expect(appended.prefillFields[0].defaultValue).toBe('$1,200');
    const checkbox = appended.recipients[0].fields.find(f => f.type === 'checkbox');
    expect(checkbox.values).toEqual(['Pets', 'No pets']);

    // Move Tina's signature, then hand the checkbox to Mona.
    const sig = appended.recipients[0].fields.find(f => f.type === 'signature');
    const moved = await call(
      'update_draft_field',
      {
        documentId: id,
        field: sig.key,
        changes: { x: 50, y: 650, width: 200, label: 'Tenant signs here' },
      },
      25
    );
    expect(moved.field.x).toBe(50);
    expect(moved.field.width).toBe(200);
    expect(moved.field.label).toBe('Tenant signs here');
    expect(moved.field.key).toBe(sig.key);
    const handed = await call(
      'update_draft_field',
      {
        documentId: id,
        field: checkbox.key,
        changes: { recipient: 'mona-d@example.test', required: false },
      },
      26
    );
    expect(handed.field.recipient).toBe('Manager');
    expect(handed.field.required).toBeFalse();
    expect(handed.recipients[1].fields.length).toBe(2);

    // An off-page field is caught by review, then removed by key.
    await call(
      'set_draft_fields',
      {
        documentId: id,
        mode: 'append',
        fields: [{ recipient: 'Tenant', type: 'date', page: 1, x: 600, y: 780 }],
      },
      27
    );
    review = await call('review_draft', { documentId: id }, 28);
    expect(review.readyToSend).toBeFalse();
    const offPage = review.errors.find(e => e.code === 'field_outside_page');
    expect(offPage).toBeDefined();
    const removed = await call('remove_draft_fields', { documentId: id, keys: [offPage.key] }, 29);
    expect(removed.removed).toBe(1);
    review = await call('review_draft', { documentId: id }, 30);
    expect(review.readyToSend).toBeTrue();

    // History: every change stored the state it replaced.
    const versions = await call('list_draft_versions', { documentId: id }, 31);
    expect(versions.versions.length).toBe(6);
    expect(versions.versions[0].version).toBe(6);
    expect(versions.versions[5].name).toBe('Draft to edit');
    const v1 = await call('get_draft_version', { documentId: id, version: 1 }, 32);
    expect(v1.state.name).toBe('Draft to edit');
    expect(v1.state.recipients.map(r => r.email)).toEqual([
      'tina-d@example.test',
      'larry-d@example.test',
    ]);

    // Undo brings the removed field back; undoing again redoes.
    const undone = await call('undo_draft_change', { documentId: id }, 33);
    expect(undone.restored.version).toBe(6);
    expect(undone.fieldCount).toBe(6);
    const redone = await call('undo_draft_change', { documentId: id }, 34);
    expect(redone.fieldCount).toBe(5);

    // A named checkpoint, then all the way back to version 1.
    const checkpoint = await call(
      'save_draft_version',
      { documentId: id, label: 'before rollback' },
      35
    );
    expect(checkpoint.label).toBe('before rollback');
    const restored = await call('restore_draft_version', { documentId: id, version: 1 }, 36);
    expect(restored.name).toBe('Draft to edit');
    expect(restored.recipients.map(r => r.email)).toEqual([
      'tina-d@example.test',
      'larry-d@example.test',
    ]);
    expect(restored.fieldCount).toBe(4);
    expect(restored.note).toBeUndefined();
    raw = JSON.parse(
      JSON.stringify(await new Parse.Query('contracts_Document').get(id, { useMasterKey: true }))
    );
    expect(raw.Signers.length).toBe(2);
    expect(raw.Signers[1].objectId).toBe(raw.Placeholders[1].signerObjId);
    expect(raw.Note).toBeUndefined();

    // REST mirrors.
    const patched = await http.patch(
      `${BASE}/v1/documents/${id}`,
      { name: 'Lease via PATCH' },
      authed()
    );
    expect(patched.status).toBe(200, JSON.stringify(patched.data));
    expect(patched.data.name).toBe('Lease via PATCH');
    const restDraft = await http.get(`${BASE}/v1/documents/${id}/draft`, authed());
    expect(restDraft.data.recipients.length).toBe(2);
    const restReview = await http.get(`${BASE}/v1/documents/${id}/review`, authed());
    expect(restReview.data.readyToSend).toBeTrue();
    const restVersions = await http.get(`${BASE}/v1/documents/${id}/versions`, authed());
    expect(restVersions.data.versions[0].reason).toBe('update name');
    const put = await http.put(
      `${BASE}/v1/documents/${id}/fields`,
      { fields: [{ recipient: 0, type: 'signature', page: 1, x: 72, y: 600 }] },
      authed()
    );
    expect(put.status).toBe(200, JSON.stringify(put.data));
    expect(put.data.fieldCount).toBe(1);
    const del = await http.delete(`${BASE}/v1/documents/${id}/fields`, {
      ...authed(),
      data: { all: true },
    });
    expect(del.data.removed).toBe(1);
    const undo = await http.post(`${BASE}/v1/documents/${id}/undo`, {}, authed());
    expect(undo.data.fieldCount).toBe(1);

    // The history class is not readable through the Parse REST API.
    const leak = await http.get(`${BASE}/test/classes/contracts_DocumentVersion`, {
      headers: { 'X-Parse-Application-Id': 'test' },
    });
    expect(leak.status).toBe(403, JSON.stringify(leak.data));

    // Duplicate, delete the copy, find it in the bin, restore it.
    const copy = await call('duplicate_document', { documentId: id, name: 'Lease copy' }, 37);
    expect(copy.copiedFrom).toBe(id);
    expect(copy.name).toBe('Lease copy');
    expect(copy.fieldCount).toBe(1);
    expect(copy.recipients.map(r => r.email)).toEqual([
      'tina-d@example.test',
      'larry-d@example.test',
    ]);
    const deleted = await call('delete_draft', { documentId: copy.objectId }, 38);
    expect(deleted.deleted).toBeTrue();
    const gone = rpcResult(
      await rpc('tools/call', { name: 'get_draft', arguments: { documentId: copy.objectId } }, 39)
    );
    expect(gone.isError).toBeTrue();
    const bin = await call('restore_deleted_document', {}, 40);
    expect(bin.deleted.some(d => d.objectId === copy.objectId)).toBeTrue();
    const back = await call('restore_deleted_document', { documentId: copy.objectId }, 41);
    expect(back.status).toBe('draft');

    // Once sent, the document is read-only here.
    await call('send_document', { documentId: id }, 42);
    const locked = rpcResult(
      await rpc(
        'tools/call',
        { name: 'update_draft', arguments: { documentId: id, name: 'nope' } },
        43
      )
    );
    expect(locked.isError).toBeTrue();
    expect(locked.content[0].text).toContain('no longer be edited');
    const stillReadable = await call('get_draft', { documentId: id }, 44);
    expect(stillReadable.editable).toBeFalse();
    const history = await call('list_draft_versions', { documentId: id }, 45);
    expect(history.versions.length).toBeGreaterThan(6);
  });

  it('ai_layout_draft lays a draft out again and binds the roles to its recipients', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const created = await call(
      'create_document',
      {
        name: 'AI relayout',
        url: PDF_URL,
        recipients: [
          { name: 'Tina', email: 'tina-ai@example.test' },
          { name: 'Larry', email: 'larry-ai@example.test' },
        ],
      },
      50
    );
    const result = await call(
      'ai_layout_draft',
      { documentId: created.objectId, instructions: 'place everything' },
      51
    );
    expect(result.applied).toBeTrue();
    expect(result.proposal.fieldCount).toBe(4);
    expect(result.fieldCount).toBe(4);
    expect(result.recipients.map(r => r.role)).toEqual(['Tenant', 'Landlord']);
    expect(result.recipients[0].email).toBe('tina-ai@example.test');
    expect(result.recipients[0].fields.map(f => f.type).sort()).toEqual([
      'date',
      'name',
      'signature',
    ]);
    expect(result.sendInOrder).toBeTrue();
    expect(result.versions).toBe(1);

    // One recipient for two roles: nothing changes, the missing role is reported.
    const solo = await call(
      'create_document',
      { name: 'AI solo', url: PDF_URL, recipients: [{ email: 'solo-ai@example.test' }] },
      52
    );
    const blocked = await call('ai_layout_draft', { documentId: solo.objectId }, 53);
    expect(blocked.applied).toBeFalse();
    expect(blocked.needsRecipients.map(r => r.role)).toEqual(['Landlord']);
    expect(blocked.objectId).toBe(solo.objectId);
    expect(blocked.versions).toBe(0);

    // Append mode keeps the default fields and adds the AI ones.
    const both = await call(
      'ai_layout_draft',
      {
        documentId: solo.objectId,
        mode: 'append',
        recipients: [{ email: 'solo-ai@example.test' }, { email: 'second-ai@example.test' }],
      },
      55
    );
    expect(both.applied).toBeTrue();
    expect(both.recipients.map(r => r.email)).toEqual([
      'solo-ai@example.test',
      'second-ai@example.test',
    ]);
    expect(both.recipients[0].fields.length).toBe(5);
    expect(both.recipients[1].fields.length).toBe(1);
  });

  it('reads rotated and cropped pages in the same top-left system', async () => {
    const rotated = await extractLayout(await makeRotatedPdf());
    expect(rotated.pages[0].rotation).toBe(90);
    // /Rotate 90 swaps the rendered page box.
    expect(rotated.pages[0].width).toBe(792);
    expect(rotated.pages[0].height).toBe(612);
    for (const line of rotated.pages[0].lines) {
      expect(line.x).toBeGreaterThanOrEqual(0);
      expect(line.y).toBeGreaterThanOrEqual(0);
      expect(line.x + line.w).toBeLessThanOrEqual(rotated.pages[0].width + 1);
      expect(line.y + line.h).toBeLessThanOrEqual(rotated.pages[0].height + 1);
    }

    const cropped = await extractLayout(await makeCroppedPdf());
    // CropBox height 692 plus its 100 pt offset: the same total the editor uses.
    expect(cropped.pages[0].width).toBe(612);
    expect(cropped.pages[0].height).toBe(792);
    const line = cropped.pages[0].lines.find(l => l.text.startsWith('Signature'));
    expect(line).toBeDefined();
    expect(line.y).toBeGreaterThan(0);
    expect(line.y + line.h).toBeLessThanOrEqual(cropped.pages[0].height);
  });

  it('keeps a large but usable proposal instead of throwing it away', async () => {
    setAiClientForTests(
      fakeAi(layout => ({
        title: 'T'.repeat(400),
        summary: 'S'.repeat(3000),
        document_type: 'lease',
        language: 'en',
        roles: [{ key: 'tenant', label: 'Tenant', name: '', email: '', is_sender: false }],
        fields: [
          {
            role: 'tenant',
            type: 'signature',
            label: 'L'.repeat(200),
            page: 1,
            anchor_line: lineIdFor(layout, 'Tenant signature'),
            placement: 'on_blank',
            required: true,
          },
          // An invented type, and a page the PDF does not have: both dropped.
          {
            role: 'tenant',
            type: 'fingerprint',
            label: 'nope',
            page: 1,
            placement: 'absolute',
            x: 10,
            y: 10,
            required: true,
          },
          {
            role: 'tenant',
            type: 'date',
            label: 'late',
            page: 9,
            placement: 'absolute',
            x: 10,
            y: 10,
            required: true,
          },
        ],
        signing_order_matters: false,
        warnings: [],
      }))
    );
    const proposal = await analyzePdf({ bytes: pdfBytes });
    expect(proposal.title.length).toBe(250);
    expect(proposal.summary.length).toBe(1200);
    expect(proposal.fields.length).toBe(1);
    expect(proposal.fields[0].label.length).toBe(80);
    expect(proposal.warnings.some(w => /2 suggested field/.test(w))).toBeTrue();
    expect(proposal.warnings.some(w => /field type this server does not know/.test(w))).toBeTrue();
  });

  it('gives a declared "sender" role its own fields and adds a signature it can see', async () => {
    setAiClientForTests(
      fakeAi(layout => ({
        title: 'Mutual NDA',
        summary: 'Both parties sign.',
        document_type: 'nda',
        language: 'en',
        roles: [
          { key: 'sender', label: 'Discloser', name: '', email: '', is_sender: false },
          { key: 'tenant', label: 'Tenant', name: '', email: '', is_sender: false },
        ],
        fields: [
          {
            role: 'sender',
            type: 'name',
            label: 'Discloser name',
            page: 1,
            anchor_line: lineIdFor(layout, 'Tenant name'),
            placement: 'on_blank',
            required: true,
          },
          {
            role: 'tenant',
            type: 'signature',
            label: 'Tenant signature',
            page: 1,
            anchor_line: lineIdFor(layout, 'Tenant signature'),
            placement: 'on_blank',
            required: true,
          },
        ],
        signing_order_matters: false,
        warnings: [],
      }))
    );
    const proposal = await analyzePdf({ bytes: pdfBytes });
    // The "sender" key is a declared role here, so its field stays with it.
    const discloser = proposal.roles.find(r => r.role === 'Discloser');
    expect(discloser.fieldCount).toBe(2);
    expect(
      proposal.fields
        .filter(f => f.role === 'Discloser')
        .map(f => f.type)
        .sort()
    ).toEqual(['name', 'signature']);
    // The auto-added signature is in fields[] too, so the preview and the
    // created document cannot disagree.
    expect(proposal.fields.length).toBe(3);
    expect(proposal.roles.reduce((n, r) => n + r.fieldCount, 0)).toBe(proposal.fields.length);
    expect(
      proposal.warnings.some(w => /No signature line was found for "Discloser"/.test(w))
    ).toBeTrue();
    const auto = proposal.fields.find(f => f.role === 'Discloser' && f.type === 'signature');
    expect(auto.page).toBe(1);
    expect(auto.x).toBeGreaterThanOrEqual(40);
  });

  it('reports malformed, refused and failing AI answers without leaking the provider text', async () => {
    const failing = async () => {
      let err = null;
      await analyzePdf({ bytes: pdfBytes }).catch(e => (err = e));
      expect(err).not.toBeNull();
      return err;
    };

    setAiClientForTests(
      fakeAiRaw({
        model: 'fake',
        stop_reason: 'tool_use',
        usage: {},
        content: [
          {
            type: 'tool_use',
            name: 'propose_signing_setup',
            input: { title: 'x', summary: 'y', fields: [] },
          },
        ],
      })
    );
    expect((await failing()).message).toContain('malformed');

    setAiClientForTests(
      fakeAiRaw({ model: 'fake', stop_reason: 'refusal', usage: {}, content: [] })
    );
    expect((await failing()).message).toContain('declined to analyse');

    setAiClientForTests(
      fakeAiRaw({
        model: 'fake',
        stop_reason: 'end_turn',
        usage: {},
        content: [{ type: 'text', text: 'hello' }],
      })
    );
    expect((await failing()).message).toContain('did not return a proposal');

    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude';
    setAiClientForTests(
      fakeAiRaw(() => {
        const err = new Error(
          `AccessDeniedException: no identity-based policy allows bedrock:InvokeModel on ${arn}`
        );
        err.status = 403;
        throw err;
      })
    );
    const denied = await failing();
    expect(denied.message).not.toContain('arn:aws');
    expect(denied.message).not.toContain('123456789012');
    expect(denied.message).toContain('credentials');

    setAiClientForTests(
      fakeAiRaw(() => {
        const err = new Error('ThrottlingException: Too many requests, please wait');
        err.status = 429;
        throw err;
      })
    );
    expect((await failing()).message).toContain('busy');
  });

  it('explains an unreadable PDF in the user’s terms instead of quoting pdf.js', async () => {
    const broken = new Uint8Array(Buffer.from('this is not a PDF at all'));
    let thrown = null;
    await analyzePdf({ bytes: broken }).catch(err => (thrown = err));
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(Parse.Error.VALIDATION_ERROR);
    expect(thrown.message).toMatch(/could not be read|password protected/);
  });

  it('refuses a fields payload that is not an array, and reminders on documents that cannot take one', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    const created = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Guard rails', url: PDF_URL, recipients: [{ email: 'guard@example.test' }] },
      authed()
    );
    const id = created.data.objectId;
    expect(created.data.fieldCount).toBe(2);

    const wiped = await http.put(`${BASE}/v1/documents/${id}/fields`, { field: [] }, authed());
    expect(wiped.status).toBe(400, JSON.stringify(wiped.data));
    expect(wiped.data.error).toContain('array');
    const still = await http.get(`${BASE}/v1/documents/${id}/draft`, authed());
    expect(still.data.fieldCount).toBe(2);

    const empty = await http.put(`${BASE}/v1/documents/${id}/fields`, { fields: [] }, authed());
    expect(empty.status).toBe(200, JSON.stringify(empty.data));
    expect(empty.data.fieldCount).toBe(0);
    await http.post(`${BASE}/v1/documents/${id}/undo`, {}, authed());

    // Not sent yet.
    const early = await http.post(`${BASE}/v1/documents/${id}/remind`, {}, authed());
    expect(early.status).toBe(400, JSON.stringify(early.data));
    expect(early.data.error).toContain('not been sent');

    await http.post(`${BASE}/v1/documents/${id}/send`, {}, authed());
    const raw = await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });
    raw.set('IsDeclined', true);
    await raw.save(null, { useMasterKey: true });
    const declined = await http.post(`${BASE}/v1/documents/${id}/remind`, {}, authed());
    expect(declined.status).toBe(400, JSON.stringify(declined.data));
    expect(declined.data.error).toContain('declined');
    // The MCP twin says the same thing.
    const viaMcp = rpcResult(
      await rpc('tools/call', { name: 'send_reminder', arguments: { documentId: id } }, 60)
    );
    expect(viaMcp.isError).toBeTrue();
    expect(viaMcp.content[0].text).toContain('declined');

    raw.set('IsDeclined', false);
    raw.set('IsCompleted', true);
    await raw.save(null, { useMasterKey: true });
    const completed = await http.post(`${BASE}/v1/documents/${id}/remind`, {}, authed());
    expect(completed.status).toBe(400);
    expect(completed.data.error).toContain('completed');

    raw.set('IsCompleted', false);
    raw.set('IsArchive', true);
    await raw.save(null, { useMasterKey: true });
    const archived = await http.post(`${BASE}/v1/documents/${id}/remind`, {}, authed());
    expect(archived.status).toBe(404, JSON.stringify(archived.data));
  });

  it('puts the default fields on the real last page and replays an Idempotency-Key', async () => {
    // No fields and no pageCount: the PDF itself has to answer where the
    // signature goes, or a three-page A4 document gets Letter boxes on page 1.
    const created = await http.post(
      `${BASE}/v1/documents`,
      {
        name: 'Default layout',
        url: THREE_PAGE_URL,
        recipients: [{ email: 'layout@example.test' }],
        // Not a documented key: it must not reach the library (§G2-24).
        templateId: 'not-a-template',
      },
      authed()
    );
    expect(created.status).toBe(200, JSON.stringify(created.data));
    const draft = await http.get(
      `${BASE}/v1/documents/${created.data.objectId}/draft?pages=true`,
      authed()
    );
    expect(draft.data.pages.length).toBe(3);
    for (const f of draft.data.recipients[0].fields) {
      expect(f.page).toBe(3);
      expect(f.x + f.width).toBeLessThanOrEqual(595);
    }
    const rawDoc = await new Parse.Query('contracts_Document').get(created.data.objectId, {
      useMasterKey: true,
    });
    expect(rawDoc.get('TemplateId')).toBeUndefined();

    const key = `spec-${Date.now()}`;
    const first = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Only once', url: PDF_URL, recipients: [{ email: 'once@example.test' }] },
      authed({ 'Idempotency-Key': key })
    );
    const second = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Only once', url: PDF_URL, recipients: [{ email: 'once@example.test' }] },
      authed({ 'Idempotency-Key': key })
    );
    expect(first.status).toBe(200, JSON.stringify(first.data));
    expect(second.data.objectId).toBe(first.data.objectId);
    const other = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Only once', url: PDF_URL, recipients: [{ email: 'once@example.test' }] },
      authed({ 'Idempotency-Key': `${key}-2` })
    );
    expect(other.data.objectId).not.toBe(first.data.objectId);
  });

  it('spends the AI budget once per account whatever the entry point', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    let limited = null;
    for (let i = 0; i < 12; i++) {
      const res = await http.post(`${BASE}/v1/documents/analyze`, { url: PDF_URL }, authed());
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited.data.error).toContain('Too many requests');
    // The MCP twin shares the same budget.
    const viaMcp = rpcResult(
      await rpc('tools/call', { name: 'analyze_document', arguments: { url: PDF_URL } }, 70)
    );
    expect(viaMcp.isError).toBeTrue();
    expect(viaMcp.content[0].text).toContain('Too many requests');
  });

  it('refuses every mutating REST and MCP route for another account’s document', async () => {
    setAiClientForTests(fakeAi(leaseProposal(false)));
    const mine = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Not yours', url: PDF_URL, recipients: [{ email: 'owner-only@example.test' }] },
      authed()
    );
    expect(mine.status).toBe(200, JSON.stringify(mine.data));
    const id = mine.data.objectId;
    const draft = await http.get(`${BASE}/v1/documents/${id}/draft`, authed());
    const fieldKey = draft.data.recipients[0].fields[0].key;

    const other = await makeUser('outsider');
    await makeExtUser(other, await makeTenant(other));
    const t2 = (
      await Parse.Cloud.run('generateapitoken', {}, { sessionToken: other.getSessionToken() })
    ).token;
    await Parse.User.logIn(user.get('email'), 'pa55word!');
    const theirs = {
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
    };

    const calls = [
      ['get', `/v1/documents/${id}`],
      ['get', `/v1/documents/${id}/draft`],
      ['get', `/v1/documents/${id}/review`],
      ['get', `/v1/documents/${id}/versions`],
      ['get', `/v1/documents/${id}/signing-links`],
      ['patch', `/v1/documents/${id}`, { name: 'stolen' }],
      ['put', `/v1/documents/${id}/fields`, { fields: [] }],
      ['post', `/v1/documents/${id}/fields`, { fields: [] }],
      ['patch', `/v1/documents/${id}/fields/${fieldKey}`, { x: 1 }],
      ['delete', `/v1/documents/${id}/fields/${fieldKey}`],
      ['post', `/v1/documents/${id}/send`, {}],
      ['post', `/v1/documents/${id}/remind`, {}],
      ['post', `/v1/documents/${id}/duplicate`, {}],
      ['post', `/v1/documents/${id}/versions`, {}],
      ['post', `/v1/documents/${id}/undo`, {}],
      ['post', `/v1/documents/${id}/ai-layout`, {}],
      ['delete', `/v1/documents/${id}`],
      ['post', `/v1/documents/${id}/restore`, {}],
    ];
    for (const [method, path, body] of calls) {
      const res =
        method === 'get' || method === 'delete'
          ? await http[method](`${BASE}${path}`, theirs)
          : await http[method](`${BASE}${path}`, body || {}, theirs);
      expect([403, 404]).toContain(
        res.status,
        `${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.data)}`
      );
      expect(JSON.stringify(res.data)).not.toContain('Not yours');
    }

    const theirRpc = async (name, args, id2) =>
      await http.post(
        `${BASE}/mcp`,
        { jsonrpc: '2.0', id: id2, method: 'tools/call', params: { name, arguments: args } },
        {
          headers: { Authorization: `Bearer ${t2}`, Accept: 'application/json, text/event-stream' },
        }
      );
    const tools = [
      ['get_document', { documentId: id }],
      ['get_draft', { documentId: id }],
      ['update_draft', { documentId: id, name: 'stolen' }],
      ['set_draft_fields', { documentId: id, fields: [] }],
      ['remove_draft_fields', { documentId: id, all: true }],
      ['send_document', { documentId: id }],
      ['send_reminder', { documentId: id }],
      ['duplicate_document', { documentId: id }],
      ['delete_draft', { documentId: id }],
      ['ai_layout_draft', { documentId: id }],
      ['restore_deleted_document', { documentId: id }],
      ['get_signing_links', { documentId: id }],
    ];
    let n = 100;
    for (const [name, args] of tools) {
      const res = rpcResult(await theirRpc(name, args, n++));
      expect(res.isError).toBeTrue(`${name} was not refused: ${JSON.stringify(res)}`);
      expect(res.content[0].text).not.toContain('Not yours');
    }

    // Still untouched for its owner.
    const after = await http.get(`${BASE}/v1/documents/${id}/draft`, authed());
    expect(after.data.name).toBe('Not yours');
    expect(after.data.status).toBe('draft');
    await Parse.User.logIn(user.get('email'), 'pa55word!');
  });

  it('duplicates a signed document without carrying a signer’s values over', async () => {
    const created = await http.post(
      `${BASE}/v1/documents`,
      { name: 'Signed original', url: PDF_URL, recipients: [{ email: 'signed@example.test' }] },
      authed()
    );
    const id = created.data.objectId;
    const raw = await new Parse.Query('contracts_Document').get(id, { useMasterKey: true });
    const placeholders = JSON.parse(JSON.stringify(raw.get('Placeholders')));
    placeholders[0].SignUrl = 'https://sign.example.test/login/abc';
    for (const p of placeholders[0].placeHolder) {
      for (const w of p.pos) {
        w.options = { ...(w.options || {}), response: 'data:image/png;base64,AAAA' };
      }
    }
    raw.set('Placeholders', placeholders);
    raw.set('IsCompleted', true);
    raw.set('SignedUrl', 'https://sign.example.test/files/signed.pdf');
    raw.set('DocSentAt', new Date());
    await raw.save(null, { useMasterKey: true });

    const copy = await http.post(
      `${BASE}/v1/documents/${id}/duplicate`,
      { name: 'Fresh copy' },
      authed()
    );
    expect(copy.status).toBe(200, JSON.stringify(copy.data));
    expect(copy.data.status).toBe('draft');
    const copyRaw = await new Parse.Query('contracts_Document').get(copy.data.objectId, {
      useMasterKey: true,
    });
    const copied = JSON.stringify(copyRaw.get('Placeholders'));
    expect(copied).not.toContain('response');
    // resetPlaceholdersForCopy strips SIGNED_STATE_KEYS from the group as well as
    // the widgets, so the copy carries no signer's link either.
    expect(copied).not.toContain('SignUrl');
    expect(copyRaw.get('SignedUrl')).toBeUndefined();
    expect(copyRaw.get('DocSentAt')).toBeUndefined();
    expect(copyRaw.get('IsCompleted')).toBeFalsy();
    // The keys are fresh, so editing the copy cannot touch the original.
    const originalKeys = placeholders[0].placeHolder.flatMap(p => p.pos.map(w => w.key));
    const copyKeys = JSON.parse(JSON.stringify(copyRaw.get('Placeholders')))[0].placeHolder.flatMap(
      p => p.pos.map(w => w.key)
    );
    expect(copyKeys.some(k => originalKeys.includes(k))).toBeFalse();
  });

  it('needs a session for aistatus and pages contacts and templates with skip', async () => {
    const anonymous = await http.post(
      `${BASE}/test/functions/aistatus`,
      {},
      { headers: { 'X-Parse-Application-Id': 'test', 'Content-Type': 'application/json' } }
    );
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(anonymous.data)).not.toContain('region');

    const asUser = await Parse.Cloud.run('aistatus', {}, { sessionToken: user.getSessionToken() });
    expect(typeof asUser.enabled).toBe('boolean');
    expect(asUser.model).toBeDefined();

    const first = toolJson(
      rpcResult(await rpc('tools/call', { name: 'list_contacts', arguments: { limit: 1 } }, 80))
    );
    const skipped = toolJson(
      rpcResult(
        await rpc('tools/call', { name: 'list_contacts', arguments: { limit: 1, skip: 1 } }, 81)
      )
    );
    expect(first.length).toBe(1);
    if (skipped.length) expect(skipped[0].email).not.toBe(first[0].email);
    const templates = toolJson(
      rpcResult(
        await rpc('tools/call', { name: 'list_templates', arguments: { limit: 5, skip: 0 } }, 82)
      )
    );
    expect(Array.isArray(templates)).toBeTrue();
  });

  it('returns the audit trail, lint warnings, and verifies a copy against the stored hash', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const created = await call(
      'create_document',
      {
        name: 'Audit spec',
        url: PDF_URL,
        recipients: [{ name: 'Ada', email: 'ada.audit@example.test', role: 'Tenant' }],
        fields: [
          { recipient: 0, type: 'signature', page: 1, x: 50, y: 600, width: 150, height: 40 },
          { recipient: 0, type: 'text input', page: 1, x: 50, y: 500, width: 150, height: 20, required: false },
          { recipient: 'prefill', type: 'checkbox', page: 1, x: 50, y: 450, width: 12, height: 12, values: ['Yes'], required: true },
        ],
      },
      100
    );
    const docId = created.objectId;

    // The new lint rules.
    const review = await call('review_draft', { documentId: docId }, 101);
    const codes = review.warnings.map(w => w.code);
    expect(codes).toContain('signature_without_date');
    expect(codes).toContain('optional_text_field');
    expect(codes).toContain('prefill_required_empty');

    // A trail as the signing path leaves it: a Parse-encoded SignedOn and a Viewed entry.
    const contactId = created.signers[0].contactId;
    const docObj = new Parse.Object('contracts_Document');
    docObj.id = docId;
    const signedAt = new Date('2026-08-22T06:09:40.859Z');
    docObj.set('AuditTrail', [
      {
        UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId },
        Activity: 'Viewed',
        ipAddress: '10.0.0.9',
        ViewedOn: '2026-08-22T06:09:00.000Z',
      },
      {
        UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId },
        Activity: 'Signed',
        ipAddress: '10.0.0.9',
        SignedOn: signedAt,
      },
    ]);
    docObj.set('IsCompleted', true);
    docObj.set('DocSentAt', new Date('2026-08-22T06:00:00.000Z'));
    const copy = Buffer.from('%PDF-1.4 signed copy bytes');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(copy).digest('hex');
    docObj.set('DocumentHash', hash);
    await docObj.save(null, { useMasterKey: true });

    const trail = await call('get_audit_trail', { documentId: docId }, 102);
    expect(trail.status).toBe('completed');
    expect(trail.entries.map(e => e.activity)).toEqual(['Viewed', 'Signed']);
    expect(trail.entries[1].at).toBe('2026-08-22T06:09:40.859Z');
    expect(trail.entries[1].who.email).toBe('ada.audit@example.test');
    expect(trail.entries[1].ip).toBe('10.0.0.9');
    expect(trail.lifecycle.sentAt).toBe('2026-08-22T06:00:00.000Z');
    expect(trail.certificate.documentHash).toBe(hash);
    expect(trail.certificate.signers[0].email).toBe('ada.audit@example.test');
    expect(trail.certificate.signers[0].signedAt).toBe('2026-08-22T06:09:40.859Z');
    expect(trail.certificate.signers[0].viewedAt).toBe('2026-08-22T06:09:00.000Z');
    expect(Array.isArray(trail.versions)).toBeTrue();

    const ok = await call(
      'verify_document',
      { documentId: docId, fileBase64: copy.toString('base64') },
      103
    );
    expect(ok.verdict).toBe('authentic');
    expect(ok.matches).toBeTrue();
    const tampered = await call(
      'verify_document',
      { documentId: docId, fileBase64: Buffer.from('%PDF-1.4 other bytes').toString('base64') },
      104
    );
    expect(tampered.verdict).toBe('different');
    const lookup = await call('verify_document', { fileBase64: copy.toString('base64') }, 105);
    expect(lookup.verdict).toBe('authentic');
    expect(lookup.documents[0].objectId).toBe(docId);
    const unknown = await call(
      'verify_document',
      { fileBase64: Buffer.from('%PDF-1.4 nobody').toString('base64') },
      106
    );
    expect(unknown.verdict).toBe('unknown');
  }, 60000);

  it('finds text, detects printed fields, places a field at a phrase and previews the page', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const created = await call(
      'create_document',
      {
        name: 'Anchor spec',
        url: PDF_URL,
        recipients: [
          { name: 'Ada', email: 'ada.anchor@example.test', role: 'Tenant' },
          { name: 'Lou', email: 'lou.anchor@example.test', role: 'Landlord' },
        ],
        fields: [
          { recipient: 'prefill', type: 'checkbox', page: 1, x: 72, y: 400, width: 15, height: 19, values: ['Furnished', 'Pets allowed'], defaultValue: ['Pets allowed'] },
        ],
      },
      110
    );
    const docId = created.objectId;

    const found = await call('find_text', { documentId: docId, query: 'tenant signature' }, 111);
    expect(found.matches.length).toBe(1);
    const m = found.matches[0];
    expect(m.page).toBe(1);
    expect(m.lineText).toContain('Tenant signature:');
    expect(m.match.x).toBeGreaterThanOrEqual(72 - 1);
    expect(m.blanks.length).toBeGreaterThan(0);
    expect(m.blanks[0].x).toBeGreaterThan(m.match.end - 5);

    const detected = await call('detect_fields', { documentId: docId }, 112);
    const byType = Object.fromEntries(detected.candidates.map(c => [c.label, c.type]));
    expect(byType['Tenant name']).toBe('name');
    expect(byType['Tenant signature']).toBe('signature');
    expect(byType['Date']).toBe('date');
    expect(byType['Landlord signature']).toBe('signature');
    for (const c of detected.candidates) {
      expect(c.x).toBeGreaterThan(72);
      expect(c.width).toBeGreaterThan(40);
      expect(c.y).toBeGreaterThan(0);
      expect(c.y + c.height).toBeLessThanOrEqual(792);
    }

    const placed = await call(
      'place_field_at_text',
      { documentId: docId, anchor: 'Landlord signature:', recipient: 'Landlord', type: 'signature' },
      113
    );
    expect(placed.placed.field.type).toBe('signature');
    expect(placed.placed.derived.width).toContain('blank');
    const landlord = placed.recipients.find(r => r.role === 'Landlord');
    expect(landlord.fields.length).toBe(1);
    expect(landlord.fields[0].type).toBe('signature');
    // The field sits on the "Landlord signature" line (drawn at pdf y=500 -> ~280 from the top).
    expect(landlord.fields[0].y).toBeGreaterThan(220);
    expect(landlord.fields[0].y).toBeLessThan(300);

    const toNext = await call(
      'place_field_at_text',
      { documentId: docId, anchor: 'is between the', widthToNextAnchor: 'Tenant', recipient: 0, type: 'text input', useBlank: false },
      114
    );
    expect(toNext.placed.derived.width).toContain('up to');
    expect(toNext.placed.field.width).toBeGreaterThanOrEqual(40);

    const missing = rpcResult(
      await rpc('tools/call', { name: 'place_field_at_text', arguments: { documentId: docId, anchor: 'no such phrase anywhere' } }, 115)
    );
    expect(missing.isError).toBeTrue();

    // Page preview: an image part plus the field list.
    const preview = rpcResult(
      await rpc('tools/call', { name: 'preview_page', arguments: { documentId: docId, page: 1, scale: 1 } }, 116)
    );
    expect(preview.isError).toBeFalsy(JSON.stringify(preview).slice(0, 300));
    expect(preview.content[0].type).toBe('image');
    expect(preview.content[0].mimeType).toBe('image/png');
    const png = Buffer.from(preview.content[0].data, 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const meta = JSON.parse(preview.content[1].text);
    expect(meta.page).toBe(1);
    expect(meta.pageCount).toBe(1);
    expect(meta.width).toBe(612);
    expect(meta.fields.length).toBe(3);
    expect(meta.fields.some(f => f.type === 'checkbox' && f.recipient === 'prefill')).toBeTrue();
    const signerView = rpcResult(
      await rpc('tools/call', { name: 'preview_page', arguments: { documentId: docId, mode: 'signer' } }, 117)
    );
    expect(signerView.content[0].type).toBe('image');
    const badPage = rpcResult(
      await rpc('tools/call', { name: 'preview_page', arguments: { documentId: docId, page: 9 } }, 118)
    );
    expect(badPage.isError).toBeTrue();
  }, 90000);

  it('runs the post-send lifecycle: resend to one signer, replace a signer, extend, wait, void', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const systemMails = [];
    setLifecycleMailTransport(async params => {
      systemMails.push(params);
      return { status: 'success' };
    });
    try {
      const created = await call(
        'create_document',
        {
          name: 'Lifecycle spec',
          url: PDF_URL,
          recipients: [
            { name: 'Ada', email: 'ada.life@example.test', role: 'Tenant' },
            { name: 'Lou', email: 'lou.life@example.test', role: 'Landlord' },
          ],
          settings: { sendInOrder: true, expiryDays: 10 },
        },
        120
      );
      const docId = created.objectId;
      mails.length = 0;
      const sent = await call('send_document', { documentId: docId }, 121);
      expect(sent.status).toBe('in_progress');
      // Secret material is opt-in.
      expect(sent.mail.signingLinks).toBeUndefined();
      expect(sent.signers.every(s => s.signingUrl === undefined)).toBeTrue();
      expect(mails.length).toBe(1);
      expect(mails[0].recipient).toBe('ada.life@example.test');

      const got = await call('get_document', { documentId: docId }, 122);
      expect(got.signers.every(s => s.signingUrl === undefined)).toBeTrue();
      const withLinks = await call('get_document', { documentId: docId, includeLinks: true }, 123);
      expect(withLinks.signers[0].signingUrl).toContain('/login/');

      const resent = await call('resend_to', { documentId: docId, signer: 'ada.life@example.test' }, 124);
      expect(resent.mail.sent).toEqual(['ada.life@example.test']);
      expect(resent.mail.signingLinks).toBeUndefined();
      expect(mails.length).toBe(2);
      const notTurn = rpcResult(
        await rpc('tools/call', { name: 'resend_to', arguments: { documentId: docId, signer: 'Landlord' } }, 125)
      );
      expect(notTurn.isError).toBeTrue();
      expect(notTurn.content[0].text).toContain('turn');

      const replaced = await call(
        'replace_signer',
        { documentId: docId, signer: 'Landlord', email: 'CFO.life@example.test', name: 'Cleo' },
        126
      );
      expect(replaced.replaced.previous.email).toBe('lou.life@example.test');
      expect(replaced.replaced.now.email).toBe('cfo.life@example.test');
      expect(replaced.signers.map(s => s.email)).toEqual(['ada.life@example.test', 'cfo.life@example.test']);
      expect(replaced.signers[1].contactId).toBe(replaced.replaced.now.contactId);
      // Not their turn: no mail yet.
      expect(replaced.mail.skipped).toContain('turn');
      expect(mails.length).toBe(2);

      const extended = await call('extend_expiry', { documentId: docId, days: 40 }, 127);
      expect(new Date(extended.expiresAt).getTime()).toBeGreaterThan(Date.now() + 39 * 86400000);
      expect(extended.previousExpiresAt).toBeTruthy();
      expect(new Date(extended.expiresAt).getTime()).toBeGreaterThan(new Date(extended.previousExpiresAt).getTime());

      const waited = await call('wait_for', { documentId: docId, status: ['completed'], timeoutSec: 1 }, 128);
      expect(waited.reached).toBeFalse();
      expect(waited.timedOut).toBeTrue();
      expect(waited.status).toBe('in_progress');

      const voided = await call('void_document', { documentId: docId, reason: 'Wrong counterparty' }, 129);
      expect(voided.voided).toBeTrue();
      expect(voided.status).toBe('voided');
      expect(voided.signers.every(x => x.status === 'voided')).toBeTrue();
      expect(voided.declineReason).toBe('Wrong counterparty');
      expect(voided.notified.sort()).toEqual(['ada.life@example.test', 'cfo.life@example.test']);
      expect(systemMails.length).toBe(2);
      expect(systemMails[0].subject).toContain('withdrawn');
      const after = await call('get_document', { documentId: docId }, 130);
      expect(after.voided).toBeTrue();
      const trail = await call('get_audit_trail', { documentId: docId }, 131);
      expect(trail.entries.some(e => e.activity === 'Voided' && e.who.kind === 'sender')).toBeTrue();
      const again = rpcResult(
        await rpc('tools/call', { name: 'resend_to', arguments: { documentId: docId, signer: 'ada.life@example.test' } }, 132)
      );
      expect(again.isError).toBeTrue();
      const voidDraft = rpcResult(
        await rpc('tools/call', { name: 'void_document', arguments: { documentId: created.objectId } }, 133)
      );
      expect(voidDraft.isError).toBeTrue();
    } finally {
      setLifecycleMailTransport(null);
    }
  }, 90000);

  it('creates templates, updates and deletes contacts, lists and creates folders', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));

    const tpl = await call(
      'create_template',
      {
        name: 'MSA template',
        url: PDF_URL,
        roles: ['Customer', 'Provider'],
        fields: [
          { recipient: 'Customer', type: 'signature', page: 1, x: 72, y: 180, width: 150, height: 50 },
          { recipient: 1, type: 'signature', page: 1, x: 72, y: 290, width: 150, height: 50 },
          { recipient: 'prefill', type: 'text input', page: 1, x: 150, y: 140, width: 150, height: 19 },
        ],
        settings: { sendInOrder: true, expiryDays: 30 },
        message: { subject: 'Please sign {{document_title}}', body: 'Hello {{receiver_name}}' },
      },
      140
    );
    expect(tpl.objectId).toBeTruthy();
    expect(tpl.roles.map(r => r.role)).toEqual(['Customer', 'Provider']);
    expect(tpl.roles.map(r => r.fields)).toEqual([1, 1]);
    expect(tpl.fieldCount).toBe(3);
    expect(tpl.sendInOrder).toBeTrue();
    const listed = await call('list_templates', { search: 'MSA template' }, 141);
    expect(listed.some(t => t.objectId === tpl.objectId)).toBeTrue();
    const fromTpl = await call(
      'create_document_from_template',
      {
        templateId: tpl.objectId,
        recipients: [
          { email: 'cust.tpl@example.test', role: 'Customer' },
          { email: 'prov.tpl@example.test', role: 'Provider' },
        ],
      },
      142
    );
    expect(fromTpl.signers.map(s => s.role)).toEqual(['Customer', 'Provider']);
    expect(fromTpl.fieldCount).toBe(3);
    expect(fromTpl.sendInOrder).toBeTrue();

    const saved = await call('save_as_template', { documentId: fromTpl.objectId, name: 'MSA copy' }, 143);
    expect(saved.name).toBe('MSA copy');
    expect(saved.roles.length).toBe(2);
    expect(saved.sourceDocumentId).toBe(fromTpl.objectId);

    const contact = await call('add_contact', { name: 'Temp Contact', email: 'temp.contact@example.test' }, 144);
    const updated = await call(
      'update_contact',
      { contactId: contact.objectId, name: 'Temp Renamed', company: 'Acme', phone: '+4712345678' },
      145
    );
    expect(updated.name).toBe('Temp Renamed');
    expect(updated.company).toBe('Acme');
    expect(updated.email).toBe('temp.contact@example.test');
    const moved = await call('update_contact', { contactId: contact.objectId, email: 'Temp.Moved@example.test' }, 146);
    expect(moved.email).toBe('temp.moved@example.test');
    const deleted = await call('delete_contact', { contactId: contact.objectId }, 147);
    expect(deleted.deleted).toBeTrue();
    const gone = await call('list_contacts', { search: 'temp.moved' }, 148);
    expect(gone.some(c => c.objectId === contact.objectId)).toBeFalse();
    const notMine = rpcResult(await rpc('tools/call', { name: 'delete_contact', arguments: { contactId: 'nope' } }, 149));
    expect(notMine.isError).toBeTrue();

    const folder = await call('create_folder', { name: 'Clients' }, 150);
    expect(folder.created).toBeTrue();
    const sameAgain = await call('create_folder', { name: 'Clients' }, 151);
    expect(sameAgain.objectId).toBe(folder.objectId);
    expect(sameAgain.created).toBeFalse();
    const child = await call('create_folder', { name: 'DAN CARE', parentId: folder.objectId }, 152);
    expect(child.parentId).toBe(folder.objectId);
    await call('update_draft', { documentId: fromTpl.objectId, folderId: child.objectId }, 153);
    const folders = await call('list_folders', {}, 154);
    const childRow = folders.folders.find(f => f.objectId === child.objectId);
    expect(childRow.documents).toBe(1);
    const onlyChildren = await call('list_folders', { parentId: folder.objectId }, 155);
    expect(onlyChildren.folders.map(f => f.objectId)).toEqual([child.objectId]);
  }, 90000);

  it('registers webhooks and delivers signed events; merges envelopes; per-document date settings; upload handshake', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const deliveries = [];
    setWebhookTransport(async (url, body, headers) => {
      deliveries.push({ url, body, headers });
      return { status: url.includes('fail') ? 500 : 200 };
    });
    // The url check resolves the host; example.test does not resolve here.
    const previousAllow = process.env.ALLOW_PRIVATE_FETCH;
    process.env.ALLOW_PRIVATE_FETCH = 'true';
    try {
      const hook = await call(
        'register_webhook',
        { url: 'https://hooks.example.test/docustamp', events: ['sent', 'voided', 'completed'], description: 'spec' },
        160
      );
      expect(hook.webhookId).toBeTruthy();
      expect(hook.secret).toBeTruthy();
      expect(hook.events).toEqual(['sent', 'voided', 'completed']);
      const bad = rpcResult(
        await rpc('tools/call', { name: 'register_webhook', arguments: { url: 'http://127.0.0.1/x' } }, 161)
      );
      expect(bad.isError).toBeTrue();
      const badEvent = rpcResult(
        await rpc('tools/call', { name: 'register_webhook', arguments: { url: 'https://hooks.example.test/y', events: ['nope'] } }, 162)
      );
      expect(badEvent.isError).toBeTrue();

      const listed = await call('list_webhooks', {}, 163);
      expect(listed.webhooks.some(w => w.webhookId === hook.webhookId && w.secret === undefined)).toBeTrue();
      const withSecrets = await call('list_webhooks', { showSecrets: true }, 164);
      expect(withSecrets.webhooks.find(w => w.webhookId === hook.webhookId).secret).toBe(hook.secret);

      const ping = await call('test_webhook', { webhookId: hook.webhookId }, 165);
      expect(ping.ok).toBeTrue();
      expect(ping.status).toBe(200);
      const pingDelivery = deliveries.pop();
      expect(pingDelivery.headers['X-DocuStamp-Event']).toBe('ping');
      expect(pingDelivery.headers['X-DocuStamp-Signature']).toBe(signPayload(hook.secret, pingDelivery.body));
      expect(pingDelivery.headers['X-OpenSign-Event']).toBe('ping');
      expect(pingDelivery.headers['X-OpenSign-Signature']).toBe(signPayload(hook.secret, pingDelivery.body));

      // A real event: sending a document.
      const created = await call(
        'create_document',
        {
          name: 'Webhook spec',
          url: PDF_URL,
          recipients: [{ name: 'Ada', email: 'ada.hook@example.test', role: 'Tenant' }],
          settings: { dateFormat: 'DD/MM/YYYY', timezone: 'Europe/Oslo', is12HourTime: false },
        },
        166
      );
      const draft = await call('get_draft', { documentId: created.objectId }, 167);
      expect(draft.settings.dateFormat).toBe('DD/MM/YYYY');
      expect(draft.settings.timezone).toBe('Europe/Oslo');
      const badZone = rpcResult(
        await rpc('tools/call', { name: 'update_draft', arguments: { documentId: created.objectId, settings: { timezone: 'Mars/Olympus' } } }, 168)
      );
      expect(badZone.isError).toBeTrue();
      const badFormat = rpcResult(
        await rpc('tools/call', { name: 'update_draft', arguments: { documentId: created.objectId, settings: { dateFormat: 'YYYY' } } }, 169)
      );
      expect(badFormat.isError).toBeTrue();

      deliveries.length = 0;
      await call('send_document', { documentId: created.objectId }, 170);
      // Delivery is fire-and-forget: give it a moment.
      for (let i = 0; i < 40 && !deliveries.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(deliveries.length).toBe(1);
      const sent = JSON.parse(deliveries[0].body);
      expect(sent.event).toBe('sent');
      expect(sent.document.objectId).toBe(created.objectId);
      expect(sent.document.status).toBe('in_progress');
      expect(sent.document.signers[0].signingUrl).toBeUndefined();
      expect(deliveries[0].headers['X-OpenSign-Signature']).toBe(signPayload(hook.secret, deliveries[0].body));
      expect(deliveries[0].headers['X-OpenSign-Delivery']).toBe(sent.id);

      deliveries.length = 0;
      await call('void_document', { documentId: created.objectId, notifySigners: false }, 171);
      for (let i = 0; i < 40 && !deliveries.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(deliveries.length).toBe(1);
      expect(JSON.parse(deliveries[0].body).event).toBe('voided');

      // A failing endpoint is retried and the failure is recorded, nothing throws.
      const failing = await call('register_webhook', { url: 'https://hooks.example.test/fail', events: ['*'] }, 172);
      const failPing = await call('test_webhook', { webhookId: failing.webhookId }, 173);
      expect(failPing.ok).toBeFalse();
      expect(failPing.status).toBe(500);
      const afterFail = (await call('list_webhooks', {}, 174)).webhooks.find(w => w.webhookId === failing.webhookId);
      expect(afterFail.failures).toBe(1);
      expect(afterFail.lastStatus).toBe(500);
      await call('delete_webhook', { webhookId: failing.webhookId }, 175);
      await call('delete_webhook', { webhookId: hook.webhookId }, 176);
      expect((await call('list_webhooks', {}, 177)).webhooks.length).toBe(0);

      // Envelopes: two files become one document, with page offsets.
      const merged = await call('merge_documents', { files: [{ url: PDF_URL, fileName: 'msa.pdf' }, { url: THREE_PAGE_URL, fileName: 'baa.pdf' }] }, 178);
      expect(merged.pageCount).toBe(4);
      expect(merged.parts.map(p => p.firstPage)).toEqual([1, 2]);
      expect(merged.parts[1].pageCount).toBe(3);
      const envelope = await call(
        'create_document',
        {
          name: 'Envelope spec',
          url: PDF_URL,
          attachments: [{ url: THREE_PAGE_URL, fileName: 'baa.pdf' }],
          recipients: [{ email: 'env.hook@example.test', role: 'Customer' }],
          fields: [{ recipient: 0, type: 'signature', page: 4, x: 50, y: 600, width: 150, height: 40 }],
        },
        179
      );
      expect(envelope.envelope.pageCount).toBe(4);
      expect(envelope.envelope.parts[1].firstPage).toBe(2);
      const review = await call('review_draft', { documentId: envelope.objectId }, 180);
      expect(review.errors.some(e => e.code === 'field_off_document')).toBeFalse();
      expect(review.summary.pages).toBe(4);

      // Uploads: the test server stores on disk, so the handshake says so.
      const upload = await call('create_upload', { fileName: 'big.pdf', size: 700000 }, 181);
      expect(upload.mode).toBe('direct');
      const unknown = rpcResult(await rpc('tools/call', { name: 'complete_upload', arguments: { uploadId: 'uploads/x.pdf.deadbeef' } }, 182));
      expect(unknown.isError).toBeTrue();
    } finally {
      setWebhookTransport(null);
      if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
      else process.env.ALLOW_PRIVATE_FETCH = previousAllow;
    }
  }, 120000);

  it('chains: configures, inherits and clears a chain, and sends the follow-up on completion', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const callError = async (name, args, id) => {
      const result = rpcResult(await rpc('tools/call', { name, arguments: args }, id));
      expect(result.isError).toBeTrue(JSON.stringify(result));
      return result.content[0].text;
    };

    // The follow-up template (one role, so the completed document's single
    // signer carries over).
    const followUp = await call(
      'create_template',
      { name: 'Onboarding form', url: PDF_URL, roles: ['New hire'], fields: [{ recipient: 0, type: 'signature', page: 1, x: 72, y: 600, width: 150, height: 40 }] },
      400
    );

    // Config validation: unknown template, wrong recipient count.
    expect(await callError('create_document', { name: 'Bad chain', url: PDF_URL, recipients: [{ email: 'chain.a@example.test' }], chain: { templateId: 'nope' } }, 401)).toContain('Template not found');
    expect(
      await callError(
        'create_document',
        { name: 'Bad chain 2', url: PDF_URL, recipients: [{ email: 'chain.a@example.test' }], chain: { templateId: followUp.objectId, recipients: [{ email: 'x@example.test' }, { email: 'y@example.test' }] } },
        402
      )
    ).toContain('1 role(s)');

    // Set on create, visible everywhere, editable, removable.
    const docA = await call(
      'create_document',
      { name: 'Chained NDA', url: PDF_URL, recipients: [{ name: 'Ada', email: 'chain.ada@example.test', role: 'Signer' }], chain: { templateId: followUp.objectId, name: 'Welcome pack' } },
      403
    );
    expect(docA.chain).toEqual({ templateId: followUp.objectId, templateName: 'Onboarding form', name: 'Welcome pack' });
    expect((await call('get_document', { documentId: docA.objectId }, 404)).chain.templateId).toBe(followUp.objectId);
    expect((await call('get_draft', { documentId: docA.objectId }, 405)).chain.templateId).toBe(followUp.objectId);
    const cleared = await call('update_draft', { documentId: docA.objectId, chain: null }, 406);
    expect(cleared.chain).toBeUndefined();
    expect(cleared.changed).toContain('chain');
    const reset = await call('update_draft', { documentId: docA.objectId, chain: { templateId: followUp.objectId, name: 'Welcome pack' } }, 407);
    expect(reset.chain.templateId).toBe(followUp.objectId);

    // A template carrying a chain hands it to documents created from it; an
    // explicit chain: null wins.
    const carrier = await call(
      'create_template',
      { name: 'NDA with follow-up', url: PDF_URL, roles: ['Signer'], chain: { templateId: followUp.objectId } },
      408
    );
    expect(carrier.chain.templateId).toBe(followUp.objectId);
    const inherited = await call(
      'create_document_from_template',
      { templateId: carrier.objectId, recipients: [{ email: 'chain.bob@example.test' }] },
      409
    );
    expect(inherited.chain.templateId).toBe(followUp.objectId);
    const optedOut = await call(
      'create_document_from_template',
      { templateId: carrier.objectId, recipients: [{ email: 'chain.cyn@example.test' }], chain: null },
      410
    );
    expect(optedOut.chain).toBeUndefined();

    // Completion fires the chain: the follow-up is created from the template,
    // sent to the completed document's signer, back-linked, and the outcome is
    // recorded on A and emitted as the `chained` event.
    const deliveries = [];
    setWebhookTransport(async (url, body, headers) => {
      deliveries.push({ url, body, headers });
      return { status: 200 };
    });
    const previousAllow = process.env.ALLOW_PRIVATE_FETCH;
    process.env.ALLOW_PRIVATE_FETCH = 'true';
    try {
      const hook = await call('register_webhook', { url: 'https://hooks.example.test/chain', events: ['chained'] }, 411);
      await call('send_document', { documentId: docA.objectId }, 412);
      mails.length = 0;
      const row = await new Parse.Query('contracts_Document')
        .include(['Signers', 'ExtUserPtr', 'CreatedBy'])
        .get(docA.objectId, { useMasterKey: true });
      const docJson = { ...JSON.parse(JSON.stringify(row)), IsCompleted: true };
      const result = await runChainOnComplete(docJson);
      expect(result.status).toBe('sent', result.error);
      expect(result.documentId).toBeTruthy();

      const docB = await call('get_document', { documentId: result.documentId }, 413);
      expect(docB.status).toBe('in_progress');
      expect(docB.name).toBe('Welcome pack');
      expect(docB.templateId).toBe(followUp.objectId);
      expect(docB.chainedFrom).toBe(docA.objectId);
      expect(docB.signers.map(s => s.email)).toEqual(['chain.ada@example.test']);
      expect(mails.length).toBe(1);

      const after = await call('get_document', { documentId: docA.objectId }, 414);
      expect(after.chainResult.status).toBe('sent');
      expect(after.chainResult.documentId).toBe(result.documentId);

      for (let i = 0; i < 40 && deliveries.length < 2 && !deliveries.some(d => JSON.parse(d.body).event === 'chained'); i++) await new Promise(r => setTimeout(r, 50));
      const chained = deliveries.map(d => JSON.parse(d.body)).find(p => p.event === 'chained');
      expect(chained).toBeTruthy(JSON.stringify(deliveries.map(d => JSON.parse(d.body).event)));
      expect(chained.document.objectId).toBe(docA.objectId);
      expect(chained.chain.status).toBe('sent');
      expect(chained.chain.documentId).toBe(result.documentId);

      // set_chain: a draft goes through the versioned draft edit, a sent
      // document is stamped directly, a completed one is refused.
      const draftSet = await call('set_chain', { documentId: optedOut.objectId, chain: { templateId: carrier.objectId } }, 418);
      expect(draftSet.chain.templateId).toBe(carrier.objectId);
      const midFlight = await call('set_chain', { documentId: docA.objectId, chain: { templateId: carrier.objectId } }, 419);
      expect(midFlight.chain.templateId).toBe(carrier.objectId);
      expect(midFlight.status).toBe('in_progress');
      const removed = await call('set_chain', { documentId: docA.objectId }, 420);
      expect(removed.chain).toBeUndefined();
      const done = new Parse.Object('contracts_Document');
      done.id = docA.objectId;
      done.set('IsCompleted', true);
      await done.save(null, { useMasterKey: true });
      expect(await callError('set_chain', { documentId: docA.objectId, chain: { templateId: carrier.objectId } }, 421)).toContain('completed');

      // A chain whose template has since been deleted fails softly: the failure
      // is recorded, nothing throws, nothing is sent.
      await call('delete_template', { templateId: followUp.objectId }, 415);
      const inheritedRow = await new Parse.Query('contracts_Document')
        .include(['Signers', 'ExtUserPtr', 'CreatedBy'])
        .get(inherited.objectId, { useMasterKey: true });
      mails.length = 0;
      const failed = await runChainOnComplete({ ...JSON.parse(JSON.stringify(inheritedRow)), IsCompleted: true });
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('Template not found');
      expect(mails.length).toBe(0);
      expect((await call('get_document', { documentId: inherited.objectId }, 416)).chainResult.status).toBe('failed');

      await call('delete_webhook', { webhookId: hook.webhookId }, 417);
    } finally {
      setWebhookTransport(null);
      if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
      else process.env.ALLOW_PRIVATE_FETCH = previousAllow;
    }
  }, 120000);

  it('fixes: canonical checkbox defaults, drawn rules, anchored sizing, hideLabel, signer preview, keepOriginal, delete_template, envelope', async () => {
    const call = async (name, args, id) =>
      toolJson(rpcResult(await rpc('tools/call', { name, arguments: args }, id)));
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');

    // 1. Checkbox defaultValue: labels or indexes in, labels out, indexes stored.
    const created = await call(
      'create_document',
      {
        name: 'Checkbox spec',
        url: RULED_URL,
        recipients: [{ name: 'Ada', email: 'ada.cb@example.test', role: 'Customer' }],
        fields: [
          { recipient: 'prefill', type: 'checkbox', page: 1, x: 60, y: 185, width: 15, height: 19, values: ['Elected', 'Declined'], defaultValue: ['Elected'] },
          { recipient: 'prefill', type: 'checkbox', page: 1, x: 60, y: 230, width: 15, height: 19, values: ['A', 'B', 'C'], defaultValue: [2] },
          { recipient: 'prefill', type: 'radio button', page: 1, x: 300, y: 185, width: 5, height: 10, values: ['Monthly', 'Yearly'], defaultValue: 1 },
        ],
      },
      200
    );
    const docId = created.objectId;
    const draft = await call('get_draft', { documentId: docId }, 201);
    const [cb1, cb2, radio] = draft.prefillFields;
    expect(cb1.defaultValue).toEqual(['Elected']);
    expect(cb2.defaultValue).toEqual(['C']);
    expect(radio.defaultValue).toBe('Yearly');
    // Stored form is what the legacy signer and the stamping code read: indexes for checkbox, label for radio.
    const rowObj = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    const prefillGroup = rowObj.get('Placeholders').find(g => g.Role === 'prefill');
    const stored = prefillGroup.placeHolder[0].pos;
    expect(stored.find(w => w.key === cb1.key).options.defaultValue).toEqual([0]);
    expect(stored.find(w => w.key === cb2.key).options.defaultValue).toEqual([2]);
    expect(stored.find(w => w.key === radio.key).options.defaultValue).toBe('Yearly');
    const badDefault = rpcResult(
      await rpc('tools/call', { name: 'update_draft_field', arguments: { documentId: docId, field: cb1.key, changes: { defaultValue: ['Nope'] } } }, 202)
    );
    expect(badDefault.isError).toBeTrue();
    const byIndex = await call('update_draft_field', { documentId: docId, field: cb1.key, changes: { defaultValue: [1], hideLabel: true } }, 203);
    const cb1b = byIndex.prefillFields.find(f => f.key === cb1.key);
    expect(cb1b.defaultValue).toEqual(['Declined']);
    expect(cb1b.hideLabel).toBeTrue();

    // The tick is really drawn: signer-mode preview has dark pixels inside the
    // second option's box (the one ticked) and none inside the first.
    const preview = rpcResult(await rpc('tools/call', { name: 'preview_page', arguments: { documentId: docId, mode: 'signer', scale: 2 } }, 204));
    const img = await loadImage(Buffer.from(preview.content[0].data, 'base64'));
    const cnv = createCanvas(img.width, img.height);
    const ctx = cnv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const darkIn = (x, y, w, h) => {
      const d = ctx.getImageData(Math.round(x * 2), Math.round(y * 2), Math.round(w * 2), Math.round(h * 2)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) n++;
      return n;
    };
    // Boxes: fontSize 12 -> boxSize 11 at (x, y+2) and (x, y+2+17.5); inset to skip the border.
    const firstBox = darkIn(60 + 3, 185 + 2 + 3, 5, 5);
    const secondBox = darkIn(60 + 3, 185 + 2 + 17.5 + 3, 5, 5);
    expect(firstBox).toBe(0);
    expect(secondBox).toBeGreaterThan(0);
    // An unfilled signer field is drawn as a box in signer mode (not nothing).
    const withSig = await call('place_field_at_text', { documentId: docId, anchor: 'Customer signature:', recipient: 0, type: 'signature' }, 205);
    expect(withSig.placed.derived.width).toContain('blank');
    const preview2 = rpcResult(await rpc('tools/call', { name: 'preview_page', arguments: { documentId: docId, mode: 'signer', scale: 2 } }, 206));
    const img2 = await loadImage(Buffer.from(preview2.content[0].data, 'base64'));
    ctx.drawImage(img2, 0, 0);
    const sigField = withSig.recipients[0].fields[0];
    const edge = ctx.getImageData(Math.round(sigField.x * 2), Math.round((sigField.y + sigField.height / 2) * 2), 2, 2).data;
    expect(edge[0] + edge[1] + edge[2]).toBeLessThan(740); // not pure white: the box edge is there

    // 3. Drawn rules are found, 2. anchored sizing follows the line, narrow gaps error.
    const found = await call('find_text', { documentId: docId, query: 'Acme initials' }, 207);
    expect(found.matches[0].blanks.length).toBe(1);
    expect(found.matches[0].blanks[0].x).toBeGreaterThanOrEqual(149);
    const detected = await call('detect_fields', { documentId: docId }, 208);
    const labels = Object.fromEntries(detected.candidates.map(c => [c.label, c]));
    expect(labels['Acme initials'].type).toBe('initials');
    expect(labels['Acme initials'].height).toBeLessThanOrEqual(24);
    expect(labels['Customer signature'].type).toBe('signature');
    expect(labels['Date'].type).toBe('date');
    const initials = await call('place_field_at_text', { documentId: docId, anchor: 'Acme initials:', recipient: 0, type: 'initials' }, 209);
    const placedInitials = initials.placed.field;
    expect(placedInitials.height).toBeLessThanOrEqual(24);
    expect(placedInitials.width).toBe(110);
    // Sits on the 9 pt line (y 83..92 from the top), not over the text above.
    expect(placedInitials.y).toBeGreaterThan(70);
    expect(placedInitials.y + placedInitials.height).toBeLessThan(100);
    expect(initials.placed.derived.height).toContain('line');
    const wide = rpcResult(
      await rpc('tools/call', { name: 'place_field_at_text', arguments: { documentId: docId, anchor: 'Elected', widthToNextAnchor: 'Declined', recipient: 0, type: 'text input', useBlank: false } }, 210)
    );
    expect(wide.isError).toBeFalsy(JSON.stringify(wide).slice(0, 200));
    const tooNarrow = rpcResult(
      await rpc('tools/call', { name: 'place_field_at_text', arguments: { documentId: docId, anchor: 'Acme', widthToNextAnchor: 'initials', recipient: 0, type: 'text input', useBlank: false } }, 211)
    );
    expect(tooNarrow.isError).toBeTrue();
    expect(tooNarrow.content[0].text).toContain('pt between');
    // 4. A single tick box placed over a printed label hides its label by default.
    const tick = await call('place_field_at_text', { documentId: docId, anchor: 'Elected', recipient: 'prefill', type: 'checkbox', values: ['Elected'], defaultValue: ['Elected'], useBlank: false, width: 12, height: 12 }, 212);
    expect(tick.placed.field.hideLabel).toBeTrue();
    const tickField = tick.prefillFields.find(f => f.x === tick.placed.field.x && f.type === 'checkbox');
    expect(tickField.hideLabel).toBeTrue();
    expect(tickField.defaultValue).toEqual(['Elected']);

    // 6. keepOriginal keeps the bytes (and verify by url then agrees with verify by bytes).
    const signedCopy = Buffer.from('%PDF-1.4 signed copy bytes for keepOriginal');
    const kept = await call('upload_document', { fileBase64: signedCopy.toString('base64'), fileName: 'copy.pdf', keepOriginal: true }, 213);
    expect(kept.flattened).toBeFalse();
    const docObj = new Parse.Object('contracts_Document');
    docObj.id = docId;
    const { createHash } = await import('node:crypto');
    docObj.set('IsCompleted', true);
    docObj.set('DocumentHash', createHash('sha256').update(signedCopy).digest('hex'));
    await docObj.save(null, { useMasterKey: true });
    const byUrl = await call('verify_document', { documentId: docId, url: kept.url }, 214);
    expect(byUrl.verdict).toBe('authentic');

    // 7. delete_template; 8. envelope persisted.
    const tpl = await call('create_template', { name: 'To delete', url: PDF_URL, roles: ['A'] }, 215);
    const del = await call('delete_template', { templateId: tpl.objectId }, 216);
    expect(del.deleted).toBeTrue();
    expect((await call('list_templates', { search: 'To delete' }, 217)).some(t => t.objectId === tpl.objectId)).toBeFalse();
    const notMine = rpcResult(await rpc('tools/call', { name: 'delete_template', arguments: { templateId: 'nope' } }, 218));
    expect(notMine.isError).toBeTrue();
    const env = await call('create_document', { name: 'Envelope persisted', url: PDF_URL, attachments: [{ url: THREE_PAGE_URL }], recipients: [{ email: 'env2@example.test' }] }, 219);
    expect(env.envelope.parts.length).toBe(2);
    const envDraft = await call('get_draft', { documentId: env.objectId }, 220);
    expect(envDraft.envelope.parts[1].firstPage).toBe(2);
    expect(envDraft.envelope.pageCount).toBe(4);
    const envDoc = await call('get_document', { documentId: env.objectId }, 221);
    expect(envDoc.envelope.parts.length).toBe(2);

    // 9. list_documents knows the voided bucket.
    const voidedList = await call('list_documents', { status: 'voided', limit: 5 }, 222);
    expect(Array.isArray(voidedList)).toBeTrue();
  }, 120000);

  it('reads and changes the workspace email branding over MCP', async () => {
    const before = toolJson(
      rpcResult(await rpc('tools/call', { name: 'get_branding', arguments: {} }, 90))
    );
    expect(before.workspaceName).toBe('Acme');
    expect(before.senderName).toBe('');
    // No workspace sender name: requests go out as the sender's company.
    expect(before.effectiveSenderName).toBe('Acme Inc');
    expect(before.canEdit).toBeTrue();
    expect(before.templateVariables).toContain('signing_url');

    const after = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          {
            name: 'update_branding',
            arguments: {
              senderName: 'Acme Agreements',
              replyTo: 'Legal@Acme.test',
              footer: 'Acme Inc, Oslo',
              hidePoweredBy: true,
              requestSubject: 'Please sign {{document_title}}',
            },
          },
          91
        )
      )
    );
    expect(after.senderName).toBe('Acme Agreements');
    expect(after.effectiveSenderName).toBe('Acme Agreements');
    expect(after.replyTo).toBe('legal@acme.test');
    expect(after.footer).toBe('Acme Inc, Oslo');
    expect(after.hidePoweredBy).toBeTrue();
    expect(after.requestSubject).toBe('Please sign {{document_title}}');
    expect(after.requestBody).toBe('');
    expect(after.changed).toBe(5);
    // A subject without a body is not applied; the tool says so.
    expect(after.warnings.join(' ')).toContain('requestSubject and requestBody');

    // The mail path sees the new branding straight away.
    resetTenantBrandingCache();
    const ext = await new Parse.Query('contracts_Users')
      .equalTo('UserId', user.toPointer())
      .first({ useMasterKey: true });
    const branding = await resolveTenantBranding({ extUserId: ext.id });
    expect(branding.senderName).toBe('Acme Agreements');
    expect(branding.hidePoweredBy).toBeTrue();

    // null clears; "" clears too; validation errors come back as tool errors.
    const cleared = toolJson(
      rpcResult(
        await rpc(
          'tools/call',
          {
            name: 'update_branding',
            arguments: { senderName: null, footer: '', hidePoweredBy: false, requestSubject: null },
          },
          92
        )
      )
    );
    expect(cleared.senderName).toBe('');
    expect(cleared.footer).toBe('');
    expect(cleared.hidePoweredBy).toBeFalse();
    expect(cleared.requestSubject).toBe('');
    expect(cleared.warnings).toBeUndefined();

    const bad = rpcResult(
      await rpc('tools/call', { name: 'update_branding', arguments: { replyTo: 'not-an-email' } }, 93)
    );
    expect(bad.isError).toBeTrue();
    expect(bad.content[0].text).toContain('Reply-to');
    const empty = rpcResult(await rpc('tools/call', { name: 'update_branding', arguments: {} }, 94));
    expect(empty.isError).toBeTrue();

    // A plain member can read the branding but not change it.
    const member = await makeUser('member');
    const memberExt = new Parse.Object('contracts_Users');
    memberExt.set('Name', 'Member Person');
    memberExt.set('Email', member.get('email'));
    memberExt.set('UserId', member.toPointer());
    memberExt.set('TenantId', before.tenantId ? { __type: 'Pointer', className: 'partners_Tenant', objectId: before.tenantId } : null);
    memberExt.set('UserRole', 'contracts_User');
    await memberExt.save(null, { useMasterKey: true });
    const memberToken = (
      await Parse.Cloud.run('generateapitoken', {}, { sessionToken: member.getSessionToken() })
    ).token;
    const asMember = async (name, args, id) =>
      await http.post(
        `${BASE}/mcp`,
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        {
          headers: {
            Authorization: `Bearer ${memberToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        }
      );
    const memberView = toolJson(rpcResult(await asMember('get_branding', {}, 95)));
    expect(memberView.canEdit).toBeFalse();
    expect(memberView.workspaceName).toBe('Acme');
    const refused = rpcResult(await asMember('update_branding', { footer: 'nope' }, 96));
    expect(refused.isError).toBeTrue();
    await Parse.User.logIn(user.get('email'), 'pa55word!');
  });
});
