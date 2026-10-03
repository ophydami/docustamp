/**
 * Declining a document someone else sent the user, as their agent
 * (`decline_document`, cloud/lib/decline.js), over real MCP calls with an API
 * token and an OAuth connection; and the web's `declinedoc`, which shares the
 * decline itself (parsefunction/declinedocument.js `applyDecline`).
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { VERIFY_EMAIL_HINT } from '../cloud/lib/agentIdentity.js';
import { ensureContact } from '../cloud/lib/contacts.js';
import { loadCaller } from '../cloud/lib/context.js';
import { declineForUser } from '../cloud/lib/decline.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import { mcpResourceUrl } from '../cloud/lib/oauth.js';
import { registerWebhook, setWebhookTransport } from '../cloud/lib/webhooks.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const PDF_URL = `${BASE}/files/decline-spec-${Date.now()}.pdf`;
const APP_REDIRECT = 'https://muse.example.test/oauth/callback';
const HOOK_URL = 'https://hooks.example.test/decline-owner';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function makeAccount(prefix, name, { verified = false } = {}) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  // A fresh login: the next sign-up replaces the current user, and its session
  // with it, so the sign-up session is not one to keep.
  const signedIn = await Parse.User.logIn(email, 'pa55word!');
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', `${name} Co`);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', name);
  extUser.set('Email', email);
  extUser.set('Company', `${name} Co`);
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  if (verified) {
    const row = new Parse.User();
    row.id = user.id;
    row.set('emailVerified', true);
    await row.save(null, { useMasterKey: true });
  }
  return { user: signedIn, extUser, email, name, sessionToken: signedIn.getSessionToken() };
}

/** A caller as the library sees it, read fresh so `emailVerified` is current. */
async function callerFor(account) {
  const user = await new Parse.Query(Parse.User).get(account.user.id, { useMasterKey: true });
  return await loadCaller(user, { publicUrl: BASE });
}

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('Services agreement', { x: 72, y: 740, size: 12, font });
  return new Uint8Array(await pdf.save());
}

function contactPointer(contact) {
  return { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contact.objectId };
}

function seatGroup(contact, role, id) {
  return {
    Id: id,
    Role: role,
    blockColor: '#93a3db',
    signerObjId: contact.objectId,
    signerPtr: contactPointer(contact),
    email: contact.email,
    placeHolder: [
      {
        pageNumber: 1,
        pos: [
          {
            key: `sig-${id}-${crypto.randomUUID().slice(0, 8)}`,
            type: 'signature',
            xPosition: 72,
            yPosition: 600,
            Width: 150,
            Height: 40,
            options: { name: 'signature', status: 'required' },
          },
        ],
      },
    ],
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe("Declining as the user's agent", () => {
  Parse.User.enableUnsafeCurrentUser();

  let alice; // the sender
  let bob; // a recipient with a verified account
  let carol; // a recipient whose email is not verified
  let dave; // verified, on nobody's document
  let bobContact;
  let carolContact;
  let aliceSelf;
  let bobToken;
  let clientId;
  let pdfBytes;
  let previousAllow;
  const mailbox = [];
  const deliveries = [];
  let seq = 0;

  beforeAll(async () => {
    previousAllow = process.env.ALLOW_PRIVATE_FETCH;
    process.env.ALLOW_PRIVATE_FETCH = 'true';
    alice = await makeAccount('decline.alice', 'Alice Sender', { verified: true });
    bob = await makeAccount('decline.bob', 'Bob Recipient', { verified: true });
    carol = await makeAccount('decline.carol', 'Carol Unverified');
    dave = await makeAccount('decline.dave', 'Dave Stranger', { verified: true });
    const aliceCaller = await callerFor(alice);
    bobContact = await ensureContact(aliceCaller, { name: 'Bob Recipient', email: bob.email });
    carolContact = await ensureContact(aliceCaller, {
      name: 'Carol Unverified',
      email: carol.email,
    });
    aliceSelf = await ensureContact(aliceCaller, { name: 'Alice Sender', email: alice.email });

    pdfBytes = await makePdf();
    const realGet = axios.get.bind(axios);
    spyOn(axios, 'get').and.callFake(async (url, config) => {
      if (String(url).startsWith(PDF_URL)) {
        return {
          status: 200,
          data: pdfBytes.buffer.slice(
            pdfBytes.byteOffset,
            pdfBytes.byteOffset + pdfBytes.byteLength
          ),
        };
      }
      return await realGet(url, config);
    });

    setMailTransport(async params => {
      mailbox.push(params);
      return { status: 'success' };
    });
    setWebhookTransport(async (url, body) => {
      deliveries.push({ url, payload: JSON.parse(body) });
      return { status: 200 };
    });
    await registerWebhook(aliceCaller, { url: HOOK_URL, events: ['declined'] });

    resetRateLimits();
    bobToken = (await Parse.Cloud.run('generateapitoken', {}, { sessionToken: bob.sessionToken }))
      .token;
    const reg = await http.post(`${BASE}/oauth/register`, {
      client_name: 'Muse Test',
      redirect_uris: [APP_REDIRECT],
    });
    expect(reg.status).toBe(201, JSON.stringify(reg.data));
    clientId = reg.data.client_id;
  }, 120000);

  afterAll(() => {
    setMailTransport(null);
    setWebhookTransport(null);
    if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
    else process.env.ALLOW_PRIVATE_FETCH = previousAllow;
  });

  beforeEach(() => {
    resetRateLimits();
    mailbox.length = 0;
    deliveries.length = 0;
  });

  /** A document Alice sent, with Bob (or `seats`) to sign. */
  async function makeDoc({ seats, sent = true, extra = {} } = {}) {
    seq += 1;
    const list = seats || [{ contact: bobContact, role: 'Client' }];
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', `Decline doc ${seq}`);
    doc.set('URL', PDF_URL);
    if (sent) {
      doc.set('SignedUrl', PDF_URL);
      doc.set('DocSentAt', new Date());
      doc.set('SentToOthers', true);
    }
    doc.set('CreatedBy', alice.user.toPointer());
    doc.set('ExtUserPtr', alice.extUser.toPointer());
    doc.set(
      'Signers',
      list.map(s => contactPointer(s.contact))
    );
    doc.set(
      'Placeholders',
      list.map((s, i) => seatGroup(s.contact, s.role, 1000 + i))
    );
    const { ExpiryDate, ...rest } = extra;
    for (const [k, v] of Object.entries(rest)) doc.set(k, v);
    await doc.save(null, { useMasterKey: true });
    if (ExpiryDate) {
      // A new document gets its expiry from its settings on create
      // (DocumentBeforesave), so a past date is written afterwards.
      const update = new Parse.Object('contracts_Document');
      update.id = doc.id;
      update.set('ExpiryDate', ExpiryDate);
      await update.save(null, { useMasterKey: true });
    }
    return doc;
  }

  async function fresh(doc) {
    return await new Parse.Query('contracts_Document').get(doc.id, { useMasterKey: true });
  }

  async function mcp(token, method, params = {}) {
    return await http.post(
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
  }

  /** Call a tool; `{error}` with the text when it failed, else the parsed JSON. */
  async function tool(token, name, args) {
    const res = await mcp(token, 'tools/call', { name, arguments: args });
    expect(res.status).toBe(200, JSON.stringify(res.data));
    const result = res.data.result;
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) return { error: text };
    return { body: JSON.parse(text) };
  }

  /** An OAuth access token for `account`, with the given scope. */
  async function connect(account, scope) {
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: APP_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-1',
      resource: mcpResourceUrl(),
    });
    if (scope) params.set('scope', scope);
    const res = await http.get(`${BASE}/oauth/authorize?${params}`);
    expect(res.status).toBe(302, JSON.stringify(res.data));
    const requestId = new URL(res.headers.location).searchParams.get('request');
    const { redirectUrl } = await Parse.Cloud.run(
      'oauthdecide',
      { requestId, approve: true },
      { sessionToken: account.sessionToken }
    );
    const code = new URL(redirectUrl).searchParams.get('code');
    const token = await http.post(
      `${BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
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

  async function declinedDeliveries(docId) {
    for (let i = 0; i < 60; i++) {
      const hits = deliveries.filter(
        d => d.payload.event === 'declined' && d.payload.document?.objectId === docId
      );
      if (hits.length) return hits;
      await sleep(50);
    }
    return deliveries.filter(d => d.payload.document?.objectId === docId);
  }

  /** The contact's audit entry. The SDK hands pointers in an array back as objects. */
  function entryFor(doc, contact) {
    return (doc.get('AuditTrail') || []).find(
      e => (e?.UserPtr?.id || e?.UserPtr?.objectId) === contact.objectId
    );
  }

  it('is a sensitive tool that a read-only connection does not get', async () => {
    const res = await mcp(bobToken, 'tools/list');
    const listed = res.data.result.tools.find(t => t.name === 'decline_document');
    expect(listed).toBeDefined();
    expect(listed.annotations).toEqual(
      jasmine.objectContaining({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    );

    const readOnly = await connect(bob, 'documents:read');
    const names = (await mcp(readOnly, 'tools/list')).data.result.tools.map(t => t.name);
    expect(names).toContain('list_inbox');
    expect(names).not.toContain('decline_document');
  });

  it("declines the user's own part over an API token and tells the sender", async () => {
    const doc = await makeDoc();
    const { body, error } = await tool(bobToken, 'decline_document', {
      documentId: doc.id,
      reason: 'The fee is wrong.',
    });
    expect(error).toBeUndefined();
    expect(body.status).toBe('declined');
    expect(body.documentId).toBe(doc.id);
    expect(body.senderNotified).toBe(true);
    expect(body.document?.status).toBe('declined');

    const row = await fresh(doc);
    expect(row.get('IsDeclined')).toBe(true);
    expect(row.get('DeclineReason')).toBe('The fee is wrong.');
    expect(row.get('DeclineBy')?.id).toBe(bob.user.id);
    expect(row.get('DeclineByContact')?.id).toBe(bobContact.objectId);

    const entry = entryFor(row, bobContact);
    expect(entry.Activity).toBe('Declined');
    expect(entry.Method).toBe('agent');
    expect(entry.Agent).toEqual(jasmine.objectContaining({ kind: 'api_token', name: 'AI agent' }));
    expect(entry.OnBehalfOf).toEqual(
      jasmine.objectContaining({ name: 'Bob Recipient', email: bob.email, userId: bob.user.id })
    );
    expect(entry.AllowedBy?.via).toBe('connection');

    const mail = mailbox.find(m => String(m.recipient).toLowerCase() === alice.email);
    expect(mail).toBeDefined();
    expect(mail.subject).toContain('has been declined by Bob Recipient');
    expect(mail.html).toContain('The fee is wrong.');
    expect(mail.html).toContain('Declined on their behalf by their AI agent.');

    const hooks = await declinedDeliveries(doc.id);
    expect(hooks.length).toBe(1);
    expect(hooks[0].url).toBe(HOOK_URL);
    expect(hooks[0].payload.reason).toBe('The fee is wrong.');
    expect(hooks[0].payload.signer).toEqual(
      jasmine.objectContaining({ email: bob.email, contactId: bobContact.objectId })
    );
  });

  it('declines over an OAuth connection and names the app', async () => {
    const doc = await makeDoc();
    const token = await connect(bob);
    const { body, error } = await tool(token, 'decline_document', {
      documentId: doc.id,
      reason: 'Not this year.',
    });
    expect(error).toBeUndefined();
    expect(body.status).toBe('declined');

    const entry = entryFor(await fresh(doc), bobContact);
    expect(entry.Method).toBe('agent');
    expect(entry.Agent).toEqual(
      jasmine.objectContaining({ kind: 'oauth', name: 'Muse Test', host: 'muse.example.test' })
    );
    const mail = mailbox.find(m => String(m.recipient).toLowerCase() === alice.email);
    expect(mail.html).toContain('by their AI agent, Muse Test (muse.example.test).');
  });

  it('refuses the sender, who voids instead', async () => {
    const doc = await makeDoc({
      seats: [
        { contact: aliceSelf, role: 'Provider' },
        { contact: bobContact, role: 'Client' },
      ],
    });
    await expectAsync(
      declineForUser(await callerFor(alice), doc.id, { reason: 'changed my mind' })
    ).toBeRejectedWith(
      jasmine.objectContaining({
        message: 'You sent this document; use void_document to cancel it.',
      })
    );
    expect((await fresh(doc)).get('IsDeclined')).not.toBe(true);
  });

  it('refuses a part that is already signed', async () => {
    const doc = await makeDoc({
      seats: [
        { contact: bobContact, role: 'Client' },
        { contact: carolContact, role: 'Witness' },
      ],
      extra: {
        AuditTrail: [
          {
            UserPtr: contactPointer(bobContact),
            Activity: 'Signed',
            SignedOn: new Date().toISOString(),
            SignedUrl: PDF_URL,
          },
        ],
      },
    });
    const { error } = await tool(bobToken, 'decline_document', {
      documentId: doc.id,
      reason: 'too late',
    });
    expect(error).toContain('You have already signed this document');
    expect((await fresh(doc)).get('IsDeclined')).not.toBe(true);
  });

  it('refuses a document that is completed, declined, voided or expired', async () => {
    const cases = [
      [{ IsCompleted: true }, 'already completed'],
      [{ IsDeclined: true, DeclineReason: 'earlier' }, 'already been declined'],
      [{ IsDeclined: true, IsVoided: true }, 'The sender voided this document'],
      [{ ExpiryDate: new Date(Date.now() - 86400000) }, 'has expired'],
    ];
    for (const [extra, message] of cases) {
      const doc = await makeDoc({ extra });
      const { error } = await tool(bobToken, 'decline_document', {
        documentId: doc.id,
        reason: 'no',
      });
      expect(error).toContain(message);
      const row = await fresh(doc);
      expect(row.get('DeclineReason') || '').not.toBe('no');
    }
    expect(mailbox.length).toBe(0);
  });

  it('needs a verified email', async () => {
    const doc = await makeDoc({ seats: [{ contact: carolContact, role: 'Client' }] });
    await expectAsync(
      declineForUser(await callerFor(carol), doc.id, { reason: 'no thanks' })
    ).toBeRejectedWith(jasmine.objectContaining({ message: VERIFY_EMAIL_HINT }));
    expect((await fresh(doc)).get('IsDeclined')).not.toBe(true);
  });

  it("does not find a stranger's document or an unsent one", async () => {
    const doc = await makeDoc();
    await expectAsync(
      declineForUser(await callerFor(dave), doc.id, { reason: 'no' })
    ).toBeRejectedWith(jasmine.objectContaining({ message: 'Document not found.' }));
    const draft = await makeDoc({ sent: false });
    await expectAsync(
      declineForUser(await callerFor(bob), draft.id, { reason: 'no' })
    ).toBeRejectedWith(jasmine.objectContaining({ message: 'Document not found.' }));
    await expectAsync(
      declineForUser(await callerFor(bob), 'nosuchdoc12', { reason: 'no' })
    ).toBeRejectedWith(jasmine.objectContaining({ message: 'Document not found.' }));
    expect((await fresh(doc)).get('IsDeclined')).not.toBe(true);
    expect((await fresh(draft)).get('IsDeclined')).not.toBe(true);
  });

  it('needs a reason', async () => {
    const doc = await makeDoc();
    await expectAsync(
      declineForUser(await callerFor(bob), doc.id, { reason: '   ' })
    ).toBeRejectedWith(jasmine.objectContaining({ code: Parse.Error.VALIDATION_ERROR }));
    const { error } = await tool(bobToken, 'decline_document', { documentId: doc.id, reason: '' });
    expect(error).toBeDefined();
    expect((await fresh(doc)).get('IsDeclined')).not.toBe(true);
  });

  it('leaves the web decline as it was: a person, no agent on the record', async () => {
    const doc = await makeDoc();
    const res = await Parse.Cloud.run(
      'declinedoc',
      { docId: doc.id, reason: 'Wrong address.', contactId: bobContact.objectId },
      { sessionToken: bob.sessionToken }
    );
    expect(res).toEqual(
      jasmine.objectContaining({
        declined: true,
        notified: true,
        recorded: true,
        message: 'document declined',
      })
    );
    const row = await fresh(doc);
    expect(row.get('IsDeclined')).toBe(true);
    expect(row.get('DeclineBy')?.id).toBe(bob.user.id);
    const entry = entryFor(row, bobContact);
    expect(entry.Activity).toBe('Declined');
    expect(entry.Method).toBeUndefined();
    const mail = mailbox.find(m => String(m.recipient).toLowerCase() === alice.email);
    expect(mail.html).not.toContain('AI agent');
    expect((await declinedDeliveries(doc.id)).length).toBe(1);

    await expectAsync(
      Parse.Cloud.run(
        'declinedoc',
        { docId: doc.id, reason: 'again', contactId: bobContact.objectId },
        { sessionToken: bob.sessionToken }
      )
    ).toBeRejectedWith(
      jasmine.objectContaining({ message: 'Document has already been declined.' })
    );
  });
});
