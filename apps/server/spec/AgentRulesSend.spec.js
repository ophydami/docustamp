/**
 * The "only send to these domains" rule for an account's AI (lib/agentRules.js):
 * every path that mails a signer refuses an address outside the list when the
 * caller is a token (an app the user connected, or their API key), before
 * anything is created or mailed. The account holder's own address always
 * passes, a subdomain of an allowed domain passes, and a person in the web app
 * is never limited. A chain an AI set up is checked again when it fires.
 */
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { setAiClientForTests } from '../cloud/ai/client.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { resetIdempotency, resetSendsInFlight } from '../cloud/api/shared.js';
import { runChainOnComplete } from '../cloud/lib/chain.js';
import { loadCaller } from '../cloud/lib/context.js';
import { sendDocument } from '../cloud/lib/documents.js';
import { setDocumentChain } from '../cloud/lib/lifecycle.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const PDF_URL = `${BASE}/files/test/agent-rules-send.pdf`;
const http = axios.create({ validateStatus: () => true });

async function makePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Mutual Non-Disclosure Agreement', { x: 72, y: 720, size: 12, font });
  page.drawText('Signature: ______________________', { x: 72, y: 600, size: 12, font });
  return new Uint8Array(await pdf.save());
}

describe('Rules for your AI: sending domains', () => {
  Parse.User.enableUnsafeCurrentUser();

  let user;
  let ownEmail;
  let token;
  let mails;
  let pdfBytes;
  let aiCalls = 0;
  let aiEmail = '';
  let rpcId = 0;

  /** The AI's proposal: one signer role, with `aiEmail` read out of the PDF. */
  function fakeAi() {
    return {
      messages: {
        create: async () => {
          aiCalls += 1;
          return {
            model: 'fake-claude',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'propose_signing_setup',
                input: {
                  title: 'Mutual NDA',
                  summary: 'An NDA. One signer.',
                  document_type: 'nda',
                  language: 'en',
                  roles: [{ key: 'party', label: 'Party', name: 'Pat Party', email: aiEmail, is_sender: false }],
                  fields: [
                    { role: 'party', type: 'signature', label: 'Signature', page: 1, placement: 'absolute', x: 220, y: 180, required: true },
                  ],
                  signing_order_matters: false,
                  warnings: [],
                },
              },
            ],
          };
        },
      },
    };
  }

  beforeAll(async () => {
    ownEmail = uniqueEmail('rules.send');
    const signup = new Parse.User();
    signup.set('username', ownEmail);
    signup.set('password', 'pa55word!');
    signup.set('email', ownEmail);
    await signup.signUp();
    user = await Parse.User.logIn(ownEmail, 'pa55word!');
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Acme');
    tenant.set('UserId', user.toPointer());
    await tenant.save(null, { useMasterKey: true });
    const extUser = new Parse.Object('contracts_Users');
    extUser.set('Name', 'Owner Person');
    extUser.set('Email', ownEmail);
    extUser.set('Company', 'Acme Inc');
    extUser.set('UserId', user.toPointer());
    extUser.set('TenantId', tenant.toPointer());
    extUser.set('UserRole', 'contracts_Admin');
    await extUser.save(null, { useMasterKey: true });

    pdfBytes = await makePdf();
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

  beforeEach(async () => {
    resetRateLimits();
    resetIdempotency();
    resetSendsInFlight();
    aiEmail = '';
    await setSendOnlyTo(['acme.test']);
  });

  afterAll(async () => {
    await setSendOnlyTo([]);
    setRequestMailTransport(null);
    setAiClientForTests(null);
  });

  /** As the person, from the web app: the only way rules change. */
  async function setSendOnlyTo(domains) {
    return await Parse.Cloud.run(
      'setagentrules',
      { rules: { sendOnlyTo: domains } },
      { sessionToken: user.getSessionToken() }
    );
  }

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

  const draftInput = (email, extra = {}) => ({
    name: `NDA for ${email}`,
    url: PDF_URL,
    recipients: [{ name: 'Pat Party', email, role: 'Party' }],
    fields: [{ recipient: 'Party', type: 'signature', page: 1, x: 220, y: 180 }],
    ...extra,
  });

  async function sentTo(email) {
    const draft = await tool('create_document', draftInput(email));
    expect(draft.error).toBeUndefined(draft.error);
    const sent = await tool('send_document', { documentId: draft.body.objectId });
    expect(sent.error).toBeUndefined(sent.error);
    return draft.body.objectId;
  }

  let templateId;
  async function template() {
    if (templateId) return templateId;
    const tpl = await tool('create_template', {
      name: 'Rules follow-up',
      url: PDF_URL,
      roles: ['Party'],
      fields: [{ recipient: 'Party', type: 'signature', page: 1, x: 220, y: 180 }],
    });
    expect(tpl.error).toBeUndefined(tpl.error);
    templateId = tpl.body.objectId;
    return templateId;
  }

  async function completedJson(docId) {
    const row = await new Parse.Query('contracts_Document')
      .include(['Signers', 'ExtUserPtr', 'CreatedBy'])
      .get(docId, { useMasterKey: true });
    return { ...JSON.parse(JSON.stringify(row)), IsCompleted: true };
  }

  describe('quick_send', () => {
    it('refuses a named recipient outside the list before the AI reads anything', async () => {
      const before = await documentCount();
      const mailed = mails.length;
      const calls = aiCalls;
      const res = await tool('quick_send', {
        url: PDF_URL,
        recipients: [{ name: 'Pat Party', email: 'pat@other.test', role: 'Party' }],
      });
      expect(res.error).toContain('only let your AI send to: acme.test');
      expect(res.error).toContain('pat@other.test');
      expect(res.error).toContain('nothing was sent');
      expect(aiCalls).toBe(calls);
      expect(await documentCount()).toBe(before);
      expect(mails.length).toBe(mailed);
    });

    it('refuses an address read out of the PDF, and creates nothing', async () => {
      aiEmail = 'pat@other.test';
      const before = await documentCount();
      const mailed = mails.length;
      const res = await tool('quick_send', { url: PDF_URL, acceptExtractedRecipients: true });
      expect(res.error).toContain('pat@other.test');
      expect(await documentCount()).toBe(before);
      expect(mails.length).toBe(mailed);
    });

    it('sends to a subdomain of an allowed domain, and a dry run is never limited', async () => {
      const ok = await tool('quick_send', {
        url: PDF_URL,
        recipients: [{ name: 'Pat Party', email: 'pat@legal.acme.test', role: 'Party' }],
      });
      expect(ok.error).toBeUndefined(ok.error);
      expect(ok.body.document.status).toBe('in_progress');

      const draft = await tool('quick_send', {
        url: PDF_URL,
        dryRun: true,
        recipients: [{ name: 'Pat Party', email: 'pat@other.test', role: 'Party' }],
      });
      expect(draft.error).toBeUndefined(draft.error);
      expect(draft.body.document.status).toBe('draft');
    });

    it('always lets the account holder be a recipient', async () => {
      await setSendOnlyTo(['vendor.test']);
      const res = await tool('quick_send', {
        url: PDF_URL,
        recipients: [{ me: true, role: 'Party' }],
      });
      expect(res.error).toBeUndefined(res.error);
      expect(res.body.document.signers.map(s => s.email)).toEqual([ownEmail.toLowerCase()]);
    });
  });

  describe('send_document, resend_to, replace_signer and send_reminder', () => {
    it('creates a draft for anyone but refuses to send it outside the list', async () => {
      const draft = await tool('create_document', draftInput('pat@other.test'));
      expect(draft.error).toBeUndefined(draft.error);
      expect(draft.body.status).toBe('draft');
      const mailed = mails.length;
      const sent = await tool('send_document', { documentId: draft.body.objectId });
      expect(sent.error).toContain('pat@other.test');
      expect(mails.length).toBe(mailed);
      expect((await tool('get_document', { documentId: draft.body.objectId })).body.status).toBe('draft');

      await setSendOnlyTo(['acme.test', 'other.test']);
      const now = await tool('send_document', { documentId: draft.body.objectId });
      expect(now.error).toBeUndefined(now.error);
      expect(mails.length).toBe(mailed + 1);
    });

    it('checks a resend, resend_to and send_reminder against the rules of the moment', async () => {
      const docId = await sentTo('pat@acme.test');
      await setSendOnlyTo(['vendor.test']);
      const mailed = mails.length;

      const resend = await tool('send_document', { documentId: docId, resend: true });
      expect(resend.error).toContain('pat@acme.test');
      const one = await tool('resend_to', { documentId: docId, signer: 'pat@acme.test' });
      expect(one.error).toContain('pat@acme.test');
      const nudge = await tool('send_reminder', { documentId: docId });
      expect(nudge.error).toContain('pat@acme.test');
      expect(mails.length).toBe(mailed);

      await setSendOnlyTo(['acme.test']);
      const again = await tool('resend_to', { documentId: docId, signer: 'pat@acme.test' });
      expect(again.error).toBeUndefined(again.error);
      expect(mails.length).toBe(mailed + 1);
    });

    it('refuses to put an outside address on a sent document, even without mailing it', async () => {
      const docId = await sentTo('pat@acme.test');
      for (const notify of [true, false]) {
        const res = await tool('replace_signer', {
          documentId: docId,
          signer: 'pat@acme.test',
          email: 'sam@other.test',
          name: 'Sam Other',
          notify,
        });
        expect(res.error).toContain('sam@other.test');
      }
      const doc = await tool('get_document', { documentId: docId });
      expect(doc.body.signers.map(s => s.email)).toEqual(['pat@acme.test']);

      const ok = await tool('replace_signer', {
        documentId: docId,
        signer: 'pat@acme.test',
        email: 'sam@sales.acme.test',
        name: 'Sam Sales',
      });
      expect(ok.error).toBeUndefined(ok.error);
      expect(ok.body.replaced.now.email).toBe('sam@sales.acme.test');
    });

    it('refuses the same send over the REST API', async () => {
      const draft = await tool('create_document', draftInput('pat@other.test'));
      const res = await http.post(
        `${BASE}/v1/documents/${draft.body.objectId}/send`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(403, JSON.stringify(res.data));
      expect(res.data.error).toContain('pat@other.test');
    });

    it('never limits the person in the web app', async () => {
      const draft = await tool('create_document', draftInput('pat@other.test'));
      const person = await loadCaller(user);
      expect(person.viaToken).toBeUndefined();
      const mailed = mails.length;
      const sent = await sendDocument(person, draft.body.objectId);
      expect(sent.status).toBe('in_progress');
      expect(mails.length).toBe(mailed + 1);
    });

    it('does not limit an AI whose list is empty', async () => {
      await setSendOnlyTo([]);
      const docId = await sentTo('pat@anywhere.test');
      expect(docId).toBeTruthy();
    });
  });

  describe('chains', () => {
    it('refuses a chain naming an outside recipient, on create, update and set_chain', async () => {
      const id = await template();
      const before = await documentCount();
      const outside = { templateId: id, recipients: [{ name: 'Pat Party', email: 'pat@other.test' }] };

      const created = await tool('create_document', draftInput('pat@acme.test', { chain: outside }));
      expect(created.error).toContain('pat@other.test');
      expect(await documentCount()).toBe(before);

      const draft = await tool('create_document', draftInput('pat@acme.test'));
      const updated = await tool('update_draft', { documentId: draft.body.objectId, chain: outside });
      expect(updated.error).toContain('pat@other.test');

      const docId = await sentTo('pat@acme.test');
      const set = await tool('set_chain', { documentId: docId, chain: outside });
      expect(set.error).toContain('pat@other.test');
      expect((await tool('get_document', { documentId: docId })).body.chain).toBeUndefined();
    });

    it('blocks an AI chain that the rules no longer allow when it fires, and sends nothing', async () => {
      const id = await template();
      const docId = await sentTo('pat@acme.test');
      const set = await tool('set_chain', { documentId: docId, chain: { templateId: id, name: 'Follow-up' } });
      expect(set.error).toBeUndefined(set.error);
      const stored = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
      expect(stored.get('Chain').viaAgent).toBeTrue();

      await setSendOnlyTo(['vendor.test']);
      const before = await documentCount();
      const mailed = mails.length;
      const result = await runChainOnComplete(await completedJson(docId));
      expect(result.status).toBe('blocked');
      expect(result.error).toContain('pat@acme.test');
      expect(result.documentId).toBeUndefined();
      expect(await documentCount()).toBe(before);
      expect(mails.length).toBe(mailed);
      const after = await tool('get_document', { documentId: docId });
      expect(after.body.chainResult.status).toBe('blocked');

      // Allowed again: the same chain goes out.
      await setSendOnlyTo(['acme.test']);
      const sent = await runChainOnComplete(await completedJson(docId));
      expect(sent.status).toBe('sent', sent.error);
    });

    it('never limits a chain the person set up in the web app', async () => {
      const id = await template();
      const docId = await sentTo('pat@acme.test');
      const person = await loadCaller(user);
      await setDocumentChain(person, docId, { templateId: id, name: 'From the person' });
      const stored = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
      expect(stored.get('Chain').viaAgent).toBeUndefined();

      await setSendOnlyTo(['vendor.test']);
      const result = await runChainOnComplete(await completedJson(docId));
      expect(result.status).toBe('sent', result.error);
    });
  });
});
