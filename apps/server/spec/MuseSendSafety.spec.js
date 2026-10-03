/**
 * Send safety on the MCP tools, the rules an assistant host's review checks:
 * a send is never tucked inside a routine edit, a retried call does not make a
 * second document or mail the signers twice, and a draft that changed after the
 * user saw it is not sent.
 */
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { resetIdempotency, resetSendsInFlight } from '../cloud/api/shared.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const PDF_URL = `${BASE}/files/test/muse-send-safety.pdf`;
const http = axios.create({ validateStatus: () => true });

async function makeLeasePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Residential Lease Agreement', { x: 72, y: 720, size: 12, font });
  page.drawText('Tenant signature: ______________________', { x: 72, y: 600, size: 12, font });
  page.drawText('Landlord signature: ______________________', { x: 72, y: 500, size: 12, font });
  return new Uint8Array(await pdf.save());
}

/** The AI's answer for the lease: two roles, one signature box each, no emails. */
function fakeAi() {
  return {
    messages: {
      create: async () => ({
        model: 'fake-claude',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'propose_signing_setup',
            input: {
              title: 'Residential Lease Agreement',
              summary: 'A lease. Both sign.',
              document_type: 'lease',
              language: 'en',
              roles: [
                { key: 'tenant', label: 'Tenant', name: '', email: '', is_sender: false },
                { key: 'landlord', label: 'Landlord', name: '', email: '', is_sender: false },
              ],
              fields: [
                { role: 'tenant', type: 'signature', label: 'Tenant signature', page: 1, placement: 'absolute', x: 220, y: 180, required: true },
                { role: 'landlord', type: 'signature', label: 'Landlord signature', page: 1, placement: 'absolute', x: 220, y: 280, required: true },
              ],
              signing_order_matters: false,
              warnings: [],
            },
          },
        ],
      }),
    },
  };
}

describe('MCP send safety', () => {
  Parse.User.enableUnsafeCurrentUser();

  let user;
  let token;
  let mails;
  let pdfBytes;
  let rpcId = 0;

  beforeAll(async () => {
    const email = uniqueEmail('muse.send');
    const signup = new Parse.User();
    signup.set('username', email);
    signup.set('password', 'pa55word!');
    signup.set('email', email);
    await signup.signUp();
    user = await Parse.User.logIn(email, 'pa55word!');
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Acme');
    tenant.set('UserId', user.toPointer());
    await tenant.save(null, { useMasterKey: true });
    const extUser = new Parse.Object('contracts_Users');
    extUser.set('Name', 'Owner Person');
    extUser.set('Email', email);
    extUser.set('Company', 'Acme Inc');
    extUser.set('UserId', user.toPointer());
    extUser.set('TenantId', tenant.toPointer());
    extUser.set('UserRole', 'contracts_Admin');
    await extUser.save(null, { useMasterKey: true });

    pdfBytes = await makeLeasePdf();
    spyOn(axios, 'get').and.callFake(async url => {
      if (String(url).startsWith(PDF_URL)) return { data: pdfBytes.buffer.slice(0), status: 200 };
      throw new Error(`unexpected axios.get ${url}`);
    });
    mails = [];
    setRequestMailTransport(async params => {
      mails.push(params);
      return { status: 'success' };
    });
    setAiClientForTests(fakeAi());
    token = (await Parse.Cloud.run('generateapitoken', {}, { sessionToken: user.getSessionToken() })).token;
  });

  beforeEach(() => {
    resetRateLimits();
    resetIdempotency();
    resetSendsInFlight();
  });

  afterAll(() => {
    setRequestMailTransport(null);
    setAiClientForTests(null);
  });

  async function rpc(method, params) {
    rpcId += 1;
    const res = await http.post(
      `${BASE}/mcp`,
      { jsonrpc: '2.0', id: rpcId, method, params },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      }
    );
    expect(res.status).toBe(200, JSON.stringify(res.data));
    expect(res.data.error).toBeUndefined(JSON.stringify(res.data.error));
    return res.data.result;
  }

  /** `{ body }` on success, `{ error }` with the tool's error text otherwise. */
  async function tool(name, args) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) return { error: result.content[0].text };
    return { body: JSON.parse(result.content[0].text) };
  }

  async function documentCount() {
    return await new Parse.Query('contracts_Document')
      .equalTo('CreatedBy', user.toPointer())
      .count({ useMasterKey: true });
  }

  const people = n => [
    { name: 'Tina Tenant', email: `tenant.${n}@example.test`, role: 'Tenant' },
    { name: 'Larry Landlord', email: `landlord.${n}@example.test`, role: 'Landlord' },
  ];
  const draftInput = (n, extra = {}) => ({
    name: `Lease ${n}`,
    url: PDF_URL,
    recipients: people(n),
    fields: [
      { recipient: 'Tenant', type: 'signature', page: 1, x: 220, y: 180 },
      { recipient: 'Landlord', type: 'signature', page: 1, x: 220, y: 280 },
    ],
    ...extra,
  });

  let templateId;
  async function template() {
    if (templateId) return templateId;
    const tpl = await tool('create_template', {
      name: 'Muse lease template',
      url: PDF_URL,
      roles: ['Tenant', 'Landlord'],
      fields: [
        { recipient: 'Tenant', type: 'signature', page: 1, x: 220, y: 180 },
        { recipient: 'Landlord', type: 'signature', page: 1, x: 220, y: 280 },
      ],
    });
    expect(tpl.error).toBeUndefined(tpl.error);
    templateId = tpl.body.objectId;
    return templateId;
  }

  describe('labels', () => {
    it('marks the webhook tools as outreach and keeps the draft tools routine', async () => {
      const tools = (await rpc('tools/list', {})).tools;
      const byName = Object.fromEntries(tools.map(t => [t.name, t]));
      for (const name of ['register_webhook', 'test_webhook', 'send_document', 'quick_send', 'decline_document']) {
        expect(byName[name].annotations).toEqual(
          jasmine.objectContaining({ readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
          name
        );
      }
      for (const name of ['create_document', 'create_document_from_template']) {
        expect(byName[name].annotations.destructiveHint).toBeFalse(name);
        expect(byName[name].description).toContain('Nothing is emailed');
        expect(byName[name].inputSchema.properties.send.description).toContain('Not accepted');
      }
      expect(byName.send_document.inputSchema.properties.revision).toBeDefined();
      expect(byName.quick_send.inputSchema.properties.allowDuplicate).toBeDefined();
    });
  });

  describe('create tools only make drafts', () => {
    it('create_document refuses send and signForMe and creates nothing', async () => {
      const before = await documentCount();
      const mailed = mails.length;
      const sent = await tool('create_document', draftInput('refuse.send', { send: true }));
      expect(sent.error).toContain('create_document only creates drafts');
      expect(sent.error).toContain('send_document');
      const signed = await tool('create_document', draftInput('refuse.sign', { signForMe: true }));
      expect(signed.error).toContain('create_document only creates drafts');
      expect(await documentCount()).toBe(before);
      expect(mails.length).toBe(mailed);

      const draft = await tool('create_document', draftInput('plain', { send: false }));
      expect(draft.error).toBeUndefined(draft.error);
      expect(draft.body.status).toBe('draft');
      expect(draft.body.mail).toBeNull();
      expect(mails.length).toBe(mailed);
    });

    it('create_document_from_template refuses send and signForMe and creates nothing', async () => {
      const id = await template();
      const before = await documentCount();
      const mailed = mails.length;
      for (const flag of [{ send: true }, { signForMe: true }]) {
        const res = await tool('create_document_from_template', {
          templateId: id,
          recipients: people('tpl.refuse'),
          ...flag,
        });
        expect(res.error).toContain('create_document_from_template only creates drafts');
      }
      expect(await documentCount()).toBe(before);
      expect(mails.length).toBe(mailed);
    });
  });

  describe('requestId', () => {
    it('replays create_document, in memory and after a restart', async () => {
      const before = await documentCount();
      const input = draftInput('rid.create', { requestId: 'req-create-1' });
      const first = await tool('create_document', input);
      expect(first.error).toBeUndefined(first.error);
      expect(first.body.idempotentReplay).toBeUndefined();
      const again = await tool('create_document', input);
      expect(again.body.objectId).toBe(first.body.objectId);
      expect(again.body.idempotentReplay).toBeTrue();
      // The in-memory record is gone (a restart): the key stored on the row answers.
      resetIdempotency();
      const afterRestart = await tool('create_document', input);
      expect(afterRestart.body.objectId).toBe(first.body.objectId);
      expect(afterRestart.body.idempotentReplay).toBeTrue();
      expect(await documentCount()).toBe(before + 1);
    });

    it('replays create_document_from_template', async () => {
      const id = await template();
      const before = await documentCount();
      const input = { templateId: id, recipients: people('rid.tpl'), requestId: 'req-tpl-1' };
      const first = await tool('create_document_from_template', input);
      expect(first.error).toBeUndefined(first.error);
      const again = await tool('create_document_from_template', input);
      expect(again.body.objectId).toBe(first.body.objectId);
      expect(again.body.idempotentReplay).toBeTrue();
      resetIdempotency();
      const afterRestart = await tool('create_document_from_template', input);
      expect(afterRestart.body.objectId).toBe(first.body.objectId);
      expect(await documentCount()).toBe(before + 1);
    });

    it('replays quick_send without mailing the signers again', async () => {
      const before = await documentCount();
      const mailed = mails.length;
      const input = { url: PDF_URL, recipients: people('rid.quick'), requestId: 'req-quick-1' };
      const first = await tool('quick_send', input);
      expect(first.error).toBeUndefined(first.error);
      expect(first.body.document.status).toBe('in_progress');
      expect(mails.length).toBe(mailed + 2);
      const again = await tool('quick_send', input);
      expect(again.body.document.objectId).toBe(first.body.document.objectId);
      expect(again.body.idempotentReplay).toBeTrue();
      resetIdempotency();
      resetSendsInFlight();
      const afterRestart = await tool('quick_send', input);
      expect(afterRestart.body.document.objectId).toBe(first.body.document.objectId);
      expect(afterRestart.body.idempotentReplay).toBeTrue();
      expect(mails.length).toBe(mailed + 2);
      expect(await documentCount()).toBe(before + 1);
    });

    it('lets the follow-up call with the recipients filled in run under the same requestId', async () => {
      const mailed = mails.length;
      const asks = await tool('quick_send', { url: PDF_URL, requestId: 'req-quick-2' });
      expect(asks.error).toBeUndefined(asks.error);
      expect(asks.body.document).toBeNull();
      expect(asks.body.needsRecipients.length).toBe(2);
      const sent = await tool('quick_send', {
        url: PDF_URL,
        requestId: 'req-quick-2',
        recipients: people('rid.followup'),
        proposal: asks.body.proposal,
      });
      expect(sent.error).toBeUndefined(sent.error);
      expect(sent.body.document.status).toBe('in_progress');
      expect(mails.length).toBe(mailed + 2);
    });
  });

  describe('quick_send duplicate guard', () => {
    it('sends an identical quick_send once, and a second copy only with allowDuplicate', async () => {
      const before = await documentCount();
      const mailed = mails.length;
      const input = { url: PDF_URL, recipients: people('dup') };
      const first = await tool('quick_send', input);
      expect(first.error).toBeUndefined(first.error);
      expect(first.body.document.status).toBe('in_progress');
      expect(mails.length).toBe(mailed + 2);

      // The same PDF to the same people, in another order and with another title.
      const again = await tool('quick_send', {
        ...input,
        name: 'Another title',
        recipients: [...input.recipients].reverse(),
      });
      expect(again.error).toBeUndefined(again.error);
      expect(again.body.duplicate).toBeTrue();
      expect(again.body.sent).toBeFalse();
      expect(again.body.document.objectId).toBe(first.body.document.objectId);
      expect(again.body.message).toContain('Nothing was sent again');
      expect(again.body.message).toContain('allowDuplicate');
      expect(mails.length).toBe(mailed + 2);
      expect(await documentCount()).toBe(before + 1);

      const second = await tool('quick_send', { ...input, allowDuplicate: true });
      expect(second.error).toBeUndefined(second.error);
      expect(second.body.duplicate).toBeUndefined();
      expect(second.body.document.objectId).not.toBe(first.body.document.objectId);
      expect(mails.length).toBe(mailed + 4);
    });

    it('lets two identical calls racing each other send once', async () => {
      const mailed = mails.length;
      const input = { url: PDF_URL, recipients: people('race') };
      const [a, b] = await Promise.all([tool('quick_send', input), tool('quick_send', input)]);
      expect(a.error).toBeUndefined(a.error);
      expect(b.error).toBeUndefined(b.error);
      expect([a.body.duplicate === true, b.body.duplicate === true].filter(Boolean).length).toBe(1);
      expect(a.body.document.objectId).toBe(b.body.document.objectId);
      expect(mails.length).toBe(mailed + 2);
    });

    it('does not count a voided copy, a draft, or other people', async () => {
      const input = { url: PDF_URL, recipients: people('void') };
      const first = await tool('quick_send', input);
      expect(first.error).toBeUndefined(first.error);
      const voided = await tool('void_document', { documentId: first.body.document.objectId, reason: 'Wrong copy' });
      expect(voided.error).toBeUndefined(voided.error);
      const resent = await tool('quick_send', input);
      expect(resent.body.duplicate).toBeUndefined();
      expect(resent.body.document.objectId).not.toBe(first.body.document.objectId);

      const draft = await tool('quick_send', { url: PDF_URL, recipients: people('dry'), dryRun: true });
      expect(draft.body.document.status).toBe('draft');
      const afterDraft = await tool('quick_send', { url: PDF_URL, recipients: people('dry') });
      expect(afterDraft.body.duplicate).toBeUndefined();
      expect(afterDraft.body.document.status).toBe('in_progress');

      const others = await tool('quick_send', { url: PDF_URL, recipients: people('void.others') });
      expect(others.body.duplicate).toBeUndefined();
    });
  });

  describe('draft revision', () => {
    it('is stable across reads, changes on an edit, and gates send_document', async () => {
      const draft = await tool('create_document', draftInput('revision'));
      expect(draft.error).toBeUndefined(draft.error);
      const documentId = draft.body.objectId;

      const one = await tool('get_draft', { documentId });
      const two = await tool('get_draft', { documentId });
      expect(one.body.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(two.body.revision).toBe(one.body.revision);
      const reviewed = await tool('review_draft', { documentId });
      expect(reviewed.body.revision).toBe(one.body.revision);

      const edited = await tool('update_draft', { documentId, name: 'Lease revision (edited)' });
      expect(edited.error).toBeUndefined(edited.error);
      const after = await tool('get_draft', { documentId });
      expect(after.body.revision).not.toBe(one.body.revision);

      const mailed = mails.length;
      const stale = await tool('send_document', { documentId, revision: one.body.revision });
      expect(stale.error).toContain('changed after it was shown');
      expect(stale.error).toContain(after.body.revision);
      expect((await tool('get_draft', { documentId })).body.status).toBe('draft');
      expect(mails.length).toBe(mailed);

      const sent = await tool('send_document', { documentId, revision: after.body.revision });
      expect(sent.error).toBeUndefined(sent.error);
      expect(sent.body.status).toBe('in_progress');
      expect(mails.length).toBe(mailed + 2);
    });

    it('checks the revision on the REST send route too', async () => {
      const draft = await tool('create_document', draftInput('revision.rest'));
      const documentId = draft.body.objectId;
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const stale = await http.post(
        `${BASE}/v1/documents/${documentId}/send`,
        { revision: '0000000000000000' },
        { headers }
      );
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(stale.data.error).toContain('changed after it was shown');
      const { revision } = (await tool('get_draft', { documentId })).body;
      const ok = await http.post(`${BASE}/v1/documents/${documentId}/send`, { revision }, { headers });
      expect(ok.status).toBe(200, JSON.stringify(ok.data));
    });
  });
});
