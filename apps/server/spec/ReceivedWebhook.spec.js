/**
 * The `received` webhook (cloud/lib/webhooks.js `emitUserEvent`, fired from
 * cloud/lib/requestMail.js `announceReceived`): it goes to the RECIPIENT's own
 * webhooks when it becomes their turn to sign, from every path a request mail
 * leaves by: the server-side send (API, MCP, batch, agent handoff), the web
 * app's own first request mail through `sendmailv3`, and the browser's
 * `next_signer` handoff after a person signs.
 *
 * Deliveries are captured at the transport seam, as in spec/ApiMcpAi.spec.js.
 */
import axios from 'axios';
import { loadCaller } from '../cloud/lib/context.js';
import { loadDoc } from '../cloud/lib/documents.js';
import { setMailTransport } from '../cloud/lib/mailTransport.js';
import {
  deliverReceived,
  sendSignatureRequestMails,
  setRequestMailTransport,
  signingLinksFor,
} from '../cloud/lib/requestMail.js';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import {
  ensureWebhookSchema,
  registerWebhook,
  setWebhookTransport,
  signPayload,
  WEBHOOK_CLASS,
  WEBHOOK_EVENTS,
} from '../cloud/lib/webhooks.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const PUBLIC_URL = 'https://sign.example.test';
const PDF_URL = `${TEST_SERVER}/files/test/received-spec.pdf`;
const OWNER_NOTE = 'Private note from the owner';
const EXPIRES = new Date('2031-03-01T12:00:00.000Z');

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Calls a cloud function over HTTP and normalises the Parse error envelope. */
async function callFn(name, params = {}, sessionToken = '') {
  try {
    const res = await axios.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.7',
        public_url: PUBLIC_URL,
        ...(sessionToken ? { 'X-Parse-Session-Token': sessionToken } : {}),
      },
    });
    return { ok: true, result: res.data.result };
  } catch (err) {
    const data = err?.response?.data;
    if (!data) throw err;
    return { ok: false, code: data.code, error: data.error };
  }
}

async function loginToken(email, password) {
  const res = await axios.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: { 'X-Parse-Application-Id': APP_ID, 'X-Parse-Javascript-Key': JS_KEY } }
  );
  return res.data.sessionToken;
}

/** A signed-up person: `_User`, tenant and profile. `profile: false` leaves the profile out. */
async function makeAccount(prefix, name, { company = '', profile = true } = {}) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  user.set('name', name);
  await user.signUp();
  const sessionToken = await loginToken(email, 'pa55word!');
  if (!profile) return { user, email, name, sessionToken };
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', company || `${name} Co`);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const ext = new Parse.Object('contracts_Users');
  ext.set('Name', name);
  ext.set('Email', email);
  ext.set('Company', company);
  ext.set('UserId', user.toPointer());
  ext.set('TenantId', tenant.toPointer());
  ext.set('UserRole', 'contracts_Admin');
  await ext.save(null, { useMasterKey: true });
  return { user, ext, email, name, sessionToken };
}

/** `owner`'s address-book row for `person`, bound to the person's account. */
async function contactOf(owner, person, { email = person.email } = {}) {
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', person.name);
  contact.set('Email', email);
  contact.set('CreatedBy', owner.user.toPointer());
  contact.set('UserId', person.user.toPointer());
  contact.set('IsDeleted', false);
  return await contact.save(null, { useMasterKey: true });
}

let docSeq = 0;

/** A sent document with one seat per `[contact, role]`, in signing order. */
async function makeDoc(owner, seats, extra = {}) {
  docSeq += 1;
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', `Received spec ${docSeq}`);
  doc.set('Note', OWNER_NOTE);
  doc.set('URL', PDF_URL);
  doc.set('CreatedBy', owner.user.toPointer());
  doc.set('ExtUserPtr', owner.ext.toPointer());
  doc.set(
    'Signers',
    seats.map(([contact]) => pointer('contracts_Contactbook', contact.id))
  );
  doc.set(
    'Placeholders',
    seats.map(([contact, role], i) => ({
      Id: i + 1,
      Role: role,
      signerObjId: contact.id,
      signerPtr: pointer('contracts_Contactbook', contact.id),
      email: contact.get('Email'),
      placeHolder: [],
    }))
  );
  await doc.save(null, { useMasterKey: true });
  const update = new Parse.Object('contracts_Document');
  update.id = doc.id;
  update.set('SignedUrl', PDF_URL);
  update.set('SentToOthers', true);
  update.set('DocSentAt', new Date());
  update.set('ExpiryDate', EXPIRES);
  for (const [k, v] of Object.entries(extra)) update.set(k, v);
  await update.save(null, { useMasterKey: true });
  return doc;
}

async function docJson(docId) {
  return JSON.parse(JSON.stringify(await loadDoc(docId)));
}

/** Record `contact` as having signed, the way PDF.js leaves the audit trail. */
async function markSigned(doc, contact) {
  const update = new Parse.Object('contracts_Document');
  update.id = doc.id;
  update.set('AuditTrail', [
    {
      UserPtr: pointer('contracts_Contactbook', contact.id),
      Activity: 'Signed',
      SignedOn: new Date(),
      ipAddress: '10.0.0.7',
    },
  ]);
  await update.save(null, { useMasterKey: true });
}

describe('the received webhook', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let alice;
  let bob;
  let carol; // a `_User` with no DocuStamp profile: only ever mailed
  let stranger;
  let hooks;
  let deliveries;
  let requestMails;
  let systemMails;
  let previousAllow;

  /** `received` deliveries about one document, parsed. */
  function received(docId) {
    return deliveries.filter(d => d.payload.event === 'received' && d.payload.document?.id === docId);
  }

  /** Wait until `count` deliveries about `docId` arrived (fire and forget), then a beat more. */
  async function settleReceived(docId, count) {
    for (let i = 0; i < 80 && received(docId).length < count; i++) await sleep(50);
    await sleep(300);
    return received(docId);
  }

  /** Give a delivery that must not happen the time it would have taken. */
  async function settleNone(docId) {
    await sleep(700);
    return received(docId);
  }

  function urlOf(account) {
    return `https://hooks.example.test/${account.name.split(' ')[0].toLowerCase()}`;
  }

  beforeAll(async () => {
    previousAllow = process.env.ALLOW_PRIVATE_FETCH;
    process.env.ALLOW_PRIVATE_FETCH = 'true';
    owner = await makeAccount('received.owner', 'Olivia Owner', { company: 'Owner Holdings' });
    alice = await makeAccount('received.alice', 'Alice Adams');
    bob = await makeAccount('received.bob', 'Bob Brown');
    stranger = await makeAccount('received.stranger', 'Sam Stranger');
    carol = await makeAccount('received.carol', 'Carol Contact', { profile: false });
    setWebhookTransport(async (url, body, headers) => {
      deliveries.push({ url, body, headers, payload: JSON.parse(body) });
      return { status: 200 };
    });
    hooks = {};
    for (const account of [owner, alice, bob]) {
      const caller = await loadCaller(account.user, { publicUrl: PUBLIC_URL });
      // The owner listens to everything: it must still never hear `received`
      // for its own document unless it is the one being asked to sign.
      hooks[account.email] = await registerWebhook(caller, {
        url: urlOf(account),
        events: account === owner ? ['*'] : ['received'],
      });
    }
    // Carol cannot register one (no profile); a row written directly stands in
    // for one left over, so the account check is what keeps her out.
    await ensureWebhookSchema();
    const row = new Parse.Object(WEBHOOK_CLASS);
    row.set('Url', urlOf(carol));
    row.set('Secret', 'carol-secret');
    row.set('Events', ['*']);
    row.set('Active', true);
    row.set('CreatedBy', carol.user.toPointer());
    await row.save(null, { useMasterKey: true });
  }, 120000);

  afterAll(() => {
    setWebhookTransport(null);
    setRequestMailTransport(null);
    setMailTransport(null);
    if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
    else process.env.ALLOW_PRIVATE_FETCH = previousAllow;
  });

  beforeEach(() => {
    resetRateLimits();
    deliveries = [];
    requestMails = [];
    systemMails = [];
    setRequestMailTransport(async params => {
      requestMails.push(params);
      return { status: 'success' };
    });
    setMailTransport(async params => {
      systemMails.push(params);
      return { status: 'success' };
    });
  });

  it('is a webhook event a user can subscribe to', () => {
    expect(WEBHOOK_EVENTS).toContain('received');
  });

  it('reaches a recipient with an account at send, with a signed, recipient-safe payload', async () => {
    const aliceContact = await contactOf(owner, alice);
    const carolContact = await contactOf(owner, carol);
    const doc = await makeDoc(owner, [
      [aliceContact, 'Tenant'],
      [carolContact, 'Guarantor'],
    ]);
    const mail = await sendSignatureRequestMails({ doc: await docJson(doc.id), publicUrl: PUBLIC_URL });
    expect(mail.sent.sort()).toEqual([alice.email, carol.email].sort());

    const got = await settleReceived(doc.id, 1);
    // Carol was mailed too, but she has no DocuStamp account.
    expect(got.length).toBe(1);
    const [delivery] = got;
    expect(delivery.url).toBe(urlOf(alice));
    expect(delivery.headers['X-DocuStamp-Event']).toBe('received');
    expect(delivery.headers['X-DocuStamp-Delivery']).toBe(delivery.payload.id);
    expect(delivery.headers['X-DocuStamp-Signature']).toBe(
      signPayload(hooks[alice.email].secret, delivery.body)
    );
    expect(delivery.payload.document).toEqual({
      id: doc.id,
      title: doc.get('Name'),
      sender: { name: 'Olivia Owner', company: 'Owner Holdings', email: owner.email },
      sentAt: jasmine.any(String),
      expiresAt: EXPIRES.toISOString(),
      myRole: 'Tenant',
    });
    // No link, no token, no other signer's address, no note.
    expect(delivery.body).not.toContain('/login/');
    for (const l of mail.signingLinks) {
      expect(delivery.body).not.toContain(l.signingToken);
    }
    expect(delivery.body).not.toContain(carol.email);
    expect(delivery.body).not.toContain(OWNER_NOTE);
    expect(delivery.body).not.toMatch(/signingUrl|signingToken|signers/i);
    // Neither the owner's catch-all hook nor carol's row heard about it.
    expect(deliveries.some(d => d.url === urlOf(owner))).toBe(false);
    expect(deliveries.some(d => d.url === urlOf(carol))).toBe(false);
  }, 30000);

  it('on a document signed in order, reaches the second signer only after the first signs', async () => {
    const aliceContact = await contactOf(owner, alice);
    const bobContact = await contactOf(owner, bob);
    const doc = await makeDoc(
      owner,
      [
        [aliceContact, 'Buyer'],
        [bobContact, 'Seller'],
      ],
      { SendinOrder: true }
    );
    const mail = await sendSignatureRequestMails({ doc: await docJson(doc.id), publicUrl: PUBLIC_URL });
    expect(mail.sent).toEqual([alice.email]);
    let got = await settleReceived(doc.id, 1);
    expect(got.map(d => d.url)).toEqual([urlOf(alice)]);
    expect(got[0].payload.document.myRole).toBe('Buyer');

    // A mail to bob before it is his turn (a stray resend) is not his turn.
    deliveries.length = 0;
    await sendSignatureRequestMails({ doc: await docJson(doc.id), publicUrl: PUBLIC_URL, only: [bob.email] });
    expect(requestMails.map(m => m.recipient)).toEqual([alice.email, bob.email]);
    got = await settleNone(doc.id);
    expect(got.length).toBe(0);

    // Alice signs; the signing page hands over with the next_signer mail.
    await markSigned(doc, aliceContact);
    const handoff = await callFn('sendmailv3', {
      docId: doc.id,
      template: 'next_signer',
      recipient: bob.email,
      signingToken: mintSigningToken({ docId: doc.id, contactId: aliceContact.id }),
    });
    expect(handoff.ok).toBe(true);
    expect(systemMails.length).toBe(1);
    got = await settleReceived(doc.id, 1);
    expect(got.map(d => d.url)).toEqual([urlOf(bob)]);
    expect(got[0].payload.document.myRole).toBe('Seller');
    expect(got[0].headers['X-DocuStamp-Signature']).toBe(
      signPayload(hooks[bob.email].secret, got[0].body)
    );
    expect(got[0].body).not.toContain(alice.email);
  }, 30000);

  it('reaches the recipient of the request mail the web app composes, and only for a real link', async () => {
    const aliceContact = await contactOf(owner, alice);
    const doc = await makeDoc(owner, [[aliceContact, 'Client']]);
    const link = signingLinksFor(await docJson(doc.id), PUBLIC_URL).find(l => l.email === alice.email);
    const mailFor = html => ({
      recipient: alice.email,
      subject: 'Please sign',
      html,
      from: 'Olivia Owner',
      replyto: owner.email,
      extUserId: owner.ext.id,
    });

    // A made-up link (the token's signature tampered with) is not announced.
    const decoded = Buffer.from(link.url.split('/login/')[1], 'base64').toString('utf8');
    const forged = `${PUBLIC_URL}/login/${Buffer.from(`${decoded.slice(0, -4)}AAAA`).toString('base64')}`;
    expect((await callFn('sendmailv3', mailFor(`<a href="${forged}">Sign</a>`), owner.sessionToken)).ok).toBe(true);
    expect((await settleNone(doc.id)).length).toBe(0);

    // Someone who does not own the document cannot announce it with a real link.
    const strangerMail = { ...mailFor(`<a href="${link.url}">Sign</a>`), extUserId: stranger.ext.id };
    expect((await callFn('sendmailv3', strangerMail, stranger.sessionToken)).ok).toBe(true);
    expect((await settleNone(doc.id)).length).toBe(0);

    // The owner's own request mail, the button and the plain link both carrying it.
    const html = `<p>Hi</p><a href="${link.url}">Review and sign</a><p>${link.url}</p>`;
    expect((await callFn('sendmailv3', mailFor(html), owner.sessionToken)).ok).toBe(true);
    const got = await settleReceived(doc.id, 1);
    expect(got.length).toBe(1);
    expect(got[0].url).toBe(urlOf(alice));
    expect(got[0].payload.document.myRole).toBe('Client');
  }, 30000);

  it('never reaches the sender for their own document unless it is their turn to sign', async () => {
    const ownerContact = await contactOf(owner, owner);
    const bobContact = await contactOf(owner, bob);
    const later = await makeDoc(
      owner,
      [
        [bobContact, 'Signer'],
        [ownerContact, 'Countersigner'],
      ],
      { SendinOrder: true }
    );
    await sendSignatureRequestMails({ doc: await docJson(later.id), publicUrl: PUBLIC_URL });
    let got = await settleReceived(later.id, 1);
    expect(got.map(d => d.url)).toEqual([urlOf(bob)]);

    const first = await makeDoc(
      owner,
      [
        [ownerContact, 'Signer'],
        [bobContact, 'Countersigner'],
      ],
      { SendinOrder: true }
    );
    await sendSignatureRequestMails({ doc: await docJson(first.id), publicUrl: PUBLIC_URL });
    got = await settleReceived(first.id, 1);
    expect(got.map(d => d.url)).toEqual([urlOf(owner)]);
    expect(got[0].payload.document.sender.email).toBe(owner.email);
  }, 30000);

  it('skips a contact whose address is not the account it points at, and a finished document', async () => {
    // The address book row points at alice's account under another address.
    const misbound = await contactOf(owner, alice, { email: uniqueEmail('received.other', 'example.test') });
    const doc = await makeDoc(owner, [[misbound, 'Witness']]);
    const mail = await sendSignatureRequestMails({ doc: await docJson(doc.id), publicUrl: PUBLIC_URL });
    expect(mail.sent.length).toBe(1);
    expect((await settleNone(doc.id)).length).toBe(0);

    const aliceContact = await contactOf(owner, alice);
    const done = await makeDoc(owner, [[aliceContact, 'Client']], { IsCompleted: true });
    expect(await deliverReceived(done.id, [alice.email])).toEqual([]);
    const voided = await makeDoc(owner, [[aliceContact, 'Client']], { IsDeclined: true, IsVoided: true });
    expect(await deliverReceived(voided.id, [alice.email])).toEqual([]);
    expect(deliveries.length).toBe(0);
  }, 30000);
});
