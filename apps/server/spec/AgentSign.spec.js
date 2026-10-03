/**
 * An AI agent signing for its own user (cloud/lib/agentSign.js) through the
 * same `signPdf` code a person uses (cloud/parsefunction/pdf/PDF.js), called as
 * master with an `agent` record and the file it stamped.
 *
 * Like spec/SignPdf.spec.js this needs the internal proxy on 8080 (PDF.js
 * uploads and writes through `cloudServerUrl`) and a pkcs#12 from openssl for
 * the seal on the last signature; without either the signing cases are
 * pending.
 */
import axios from 'axios';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { formatInTimeZone } from 'date-fns-tz';
import {
  agentSignDocument,
  findAgentSeat,
  isOwnDocument,
  prepareAgentSignature,
  setAgentSignMailTransport,
} from '../cloud/lib/agentSign.js';
import { VERIFY_EMAIL_HINT } from '../cloud/lib/agentIdentity.js';
import { loadCaller } from '../cloud/lib/context.js';
import { fetchPdfBytes } from '../cloud/lib/files.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import PDF, { isBaseChangedError } from '../cloud/parsefunction/pdf/PDF.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const MASTER_KEY = 'test';
const INTERNAL_PORT = 8080;
const INTERNAL_PREFIX = '/app';
const PUBLIC_URL = 'https://sign.example.test';
const ZONE = 'America/New_York';

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Reverse proxy for `cloudServerUrl` (see spec/SignPdf.spec.js). */
function startInternalProxy() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const suffix = req.url.startsWith(INTERNAL_PREFIX)
          ? req.url.slice(INTERNAL_PREFIX.length)
          : req.url;
        try {
          const upstream = await fetch(`${TEST_SERVER}${suffix}`, {
            method: req.method,
            headers: {
              'content-type': req.headers['content-type'] || 'application/json',
              'X-Parse-Application-Id': APP_ID,
              'X-Parse-Master-Key': MASTER_KEY,
            },
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') || 'application/json',
          });
          res.end(body);
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
      });
    });
    server.on('error', () => resolve(null));
    server.listen(INTERNAL_PORT, () => resolve(server));
  });
}

/** A self-signed pkcs#12, base64, or null without openssl. */
function makePfxBase64() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docustamp-agent-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const p12 = path.join(dir, 'k.p12');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2'].concat([
        '-nodes',
        '-subj',
        '/CN=DocuStamp Agent Spec',
      ]),
      { stdio: 'ignore' }
    );
    execFileSync(
      'openssl',
      [
        'pkcs12',
        '-export',
        '-out',
        p12,
        '-inkey',
        key,
        '-in',
        cert,
        '-passout',
        'pass:specpass',
      ].concat(['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']),
      { stdio: 'ignore' }
    );
    return fs.readFileSync(p12).toString('base64');
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function pdfWith(text) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 72, y: 740, size: 14, font });
  return await pdf.save();
}

/** Store a pdf the way an upload would and hand back its stored url. */
async function storePdf(text) {
  const bytes = await pdfWith(text);
  const file = new Parse.File('base.pdf', { base64: Buffer.from(bytes).toString('base64') });
  await file.save({ useMasterKey: true });
  return file.url().split('?')[0];
}

let pdfjsLib;
async function pdfText(bytes) {
  pdfjsLib = pdfjsLib || (await import('pdfjs-dist/legacy/build/pdf.mjs'));
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
    .promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n); // eslint-disable-line no-await-in-loop
    const content = await page.getTextContent(); // eslint-disable-line no-await-in-loop
    out.push(...content.items.map(i => i.str));
  }
  return out.join('\n');
}

/** An account: _User, tenant and profile, as signup leaves them. */
async function makeAccount(prefix, name, { verified = true, company = '', jobTitle = '' } = {}) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  user.set('name', name);
  await user.signUp();
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', `${name} Co`);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const ext = new Parse.Object('contracts_Users');
  ext.set('Name', name);
  ext.set('Email', email);
  ext.set('Company', company);
  ext.set('JobTitle', jobTitle);
  ext.set('Timezone', ZONE);
  ext.set('UserId', user.toPointer());
  ext.set('TenantId', tenant.toPointer());
  ext.set('UserRole', 'contracts_Admin');
  await ext.save(null, { useMasterKey: true });
  if (verified) {
    user.set('emailVerified', true);
    await user.save(null, { useMasterKey: true });
  }
  return { user, ext, email, name };
}

/** The caller an OAuth app gets for `account`, read fresh like every request. */
async function callerFor(account) {
  const user = await new Parse.Query(Parse.User).get(account.user.id, { useMasterKey: true });
  const caller = await loadCaller(user, { publicUrl: PUBLIC_URL });
  caller.oauth = {
    clientId: 'client-chatgpt',
    clientName: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    signingEnabledAt: new Date('2026-10-01T12:00:00Z'),
  };
  caller.ip = '10.1.2.3';
  return caller;
}

/** `owner`'s contact for `person`, bound to the person's own account. */
async function contactOf(owner, person) {
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', person.name);
  contact.set('Email', person.email);
  contact.set('CreatedBy', owner.user.toPointer());
  contact.set('UserId', person.user.toPointer());
  contact.set('IsDeleted', false);
  return await contact.save(null, { useMasterKey: true });
}

let keySeq = 1000;
function widget(type, x, y, options = {}, extra = {}) {
  keySeq += 1;
  return {
    key: keySeq,
    type,
    xPosition: x,
    yPosition: y,
    scale: 1,
    options: { name: `${type}-${keySeq}`, status: 'required', ...options },
    ...extra,
  };
}

const sig = () => widget('signature', 72, 600, {}, { Width: 150, Height: 60 });

/**
 * A sent document. `seats` is `[{contact, widgets, role}]` in signing order;
 * `extra` lands in a follow-up update (the afterSave recomputes some fields on
 * insert).
 */
async function makeDoc(owner, seats, extra = {}) {
  const url = extra.URL || (await storePdf('Agent signing agreement'));
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', `Lease ${keySeq}`);
  doc.set('URL', url);
  doc.set('CreatedBy', owner.user.toPointer());
  doc.set('ExtUserPtr', owner.ext.toPointer());
  doc.set('IsSendMail', false);
  doc.set(
    'Signers',
    seats.map(s => pointer('contracts_Contactbook', s.contact.id))
  );
  doc.set(
    'Placeholders',
    seats.map((s, i) => ({
      Id: i + 1,
      Role: s.role || `Role ${i + 1}`,
      signerObjId: s.contact.id,
      signerPtr: pointer('contracts_Contactbook', s.contact.id),
      email: s.contact.get('Email'),
      placeHolder: [{ pageNumber: 1, pos: s.widgets }],
    }))
  );
  await doc.save(null, { useMasterKey: true });
  const update = new Parse.Object('contracts_Document');
  update.id = doc.id;
  update.set('SignedUrl', url);
  update.set('DocSentAt', new Date());
  update.set('DateFormat', 'MM/DD/YYYY');
  for (const [k, v] of Object.entries(extra)) if (k !== 'URL') update.set(k, v);
  await update.save(null, { useMasterKey: true });
  return doc;
}

async function reload(docId) {
  return JSON.parse(
    JSON.stringify(await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true }))
  );
}

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

describe('agent signing (lib/agentSign.js)', () => {
  Parse.User.enableUnsafeCurrentUser();

  let proxy;
  let pfxBase64;
  let owner;
  let tenantPerson;
  let stranger;
  let requestMails;
  let ownerMails;

  function requirements() {
    if (!proxy) return 'port 8080 is not free, so the internal server url cannot be stubbed';
    if (!pfxBase64) return 'openssl is not available to build a test pkcs#12';
    return '';
  }

  beforeAll(async () => {
    proxy = await startInternalProxy();
    pfxBase64 = makePfxBase64();
    process.env.PFX_BASE64 = pfxBase64 || '';
    process.env.PASS_PHRASE = pfxBase64 ? 'specpass' : '';
    owner = await makeAccount('agent.owner', 'Olivia Owner', {
      company: 'Owner Holdings',
      jobTitle: 'Landlord',
    });
    tenantPerson = await makeAccount('agent.tenant', 'Terry Tenant');
    stranger = await makeAccount('agent.stranger', 'Sam Stranger');
    setRequestMailTransport(async params => {
      requestMails.push(params);
      return { status: 'success' };
    });
    setAgentSignMailTransport(async params => {
      ownerMails.push(params);
      return { status: 'success' };
    });
  }, 120000);

  afterAll(async () => {
    setRequestMailTransport(null);
    setAgentSignMailTransport(null);
    if (proxy) await new Promise(resolve => proxy.close(resolve));
  });

  beforeEach(() => {
    resetRateLimits();
    requestMails = [];
    ownerMails = [];
  });

  /** Owner first, tenant second; the owner seat has one of most field types. */
  async function leaseFor(extra = {}, { ownerFirst = true } = {}) {
    const ownerContact = await contactOf(owner, owner);
    const tenantContact = await contactOf(owner, tenantPerson);
    const ownerWidgets = [
      sig(),
      widget('initials', 300, 600, {}, { Width: 50, Height: 50 }),
      widget('name', 72, 100),
      widget('email', 72, 125, { validation: { type: 'email', pattern: '' } }),
      widget('company', 72, 150),
      widget('date', 72, 175, { validation: { type: 'date-format', format: 'MM/dd/yyyy' } }),
      widget('text input', 72, 200, { hint: 'Monthly rent' }),
      widget('checkbox', 72, 230, { values: ['Pets allowed'], status: 'optional' }),
      widget('radio button', 72, 260, { values: ['Monthly', 'Yearly'] }),
      widget('stamp', 300, 400, { status: 'optional' }),
    ];
    const ownerSeat = { contact: ownerContact, widgets: ownerWidgets, role: 'Landlord' };
    const tenantSeat = { contact: tenantContact, widgets: [sig()], role: 'Tenant' };
    const doc = await makeDoc(
      owner,
      ownerFirst ? [ownerSeat, tenantSeat] : [tenantSeat, ownerSeat],
      extra
    );
    const keys = Object.fromEntries(ownerWidgets.map(w => [w.type, String(w.key)]));
    return { doc, ownerContact, tenantContact, keys };
  }

  describe('the seat', () => {
    it('is the contact bound to the caller and carrying their address', async () => {
      const { doc, ownerContact } = await leaseFor();
      const json = await reload(doc.id);
      // `reload` does not include Signers; the lookup needs the contacts.
      json.Signers = [
        { objectId: ownerContact.id, Email: owner.email, UserId: pointer('_User', owner.user.id) },
      ];
      const caller = await callerFor(owner);
      expect(findAgentSeat(json, caller).contactId).toBe(ownerContact.id);
      expect(isOwnDocument(json, caller)).toBe(true);
      // Same account, other address: not the seat.
      expect(findAgentSeat(json, { ...caller, email: 'someone@example.test' })).toBeNull();
      // Same address, other account: not the seat either.
      expect(findAgentSeat(json, { ...caller, userId: stranger.user.id })).toBeNull();
    });
  });

  describe('prepareAgentSignature', () => {
    it('lists every value it would fill and what is missing, and writes nothing', async () => {
      const { doc, keys, ownerContact } = await leaseFor();
      const caller = await callerFor(owner);
      const before = await reload(doc.id);
      const out = await prepareAgentSignature(caller, doc.id, { fields: {} });
      expect(out.seat).toEqual({ contactId: ownerContact.id, role: 'Landlord' });
      const byType = Object.fromEntries(out.values.map(v => [v.type, v]));
      expect(byType.signature.value).toBe('Olivia Owner');
      expect(byType.initials.value).toBe('OO');
      expect(byType.name.value).toBe('Olivia Owner');
      expect(byType.email.value).toBe(owner.email.toLowerCase());
      expect(byType.company.value).toBe('Owner Holdings');
      expect(byType.date.value).toBe(formatInTimeZone(new Date(), ZONE, 'MM/dd/yyyy'));
      expect(byType.checkbox.value).toEqual([]);
      expect(byType.stamp.value).toBeNull();
      expect(byType.signature.page).toBe(1);
      // Reading order: page, then top to bottom, then left to right.
      expect(out.values.map(v => v.type)).toEqual([
        'name',
        'email',
        'company',
        'date',
        'checkbox',
        'stamp',
        'signature',
        'initials',
      ]);
      expect(out.missing.map(m => [String(m.key), m.reason])).toEqual([
        [keys['text input'], 'A value is required.'],
        [keys['radio button'], 'A value is required.'],
      ]);
      expect(out.missing[0].label).toBe('Monthly rent');
      const after = await reload(doc.id);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.AuditTrail).toBeUndefined();
    });

    it('checks the values the agent gives', async () => {
      const { doc, keys } = await leaseFor();
      const caller = await callerFor(owner);
      const out = await prepareAgentSignature(caller, doc.id, {
        fields: {
          [keys['text input']]: '1500',
          [keys['radio button']]: 'weekly',
          [keys.checkbox]: ['Pets allowed', 'Smoking'],
          [keys.name]: 'Somebody Else',
          [keys.stamp]: 'data:image/png;base64,AAAA',
        },
      });
      const reasons = Object.fromEntries(out.missing.map(m => [m.type, m.reason]));
      expect(reasons['radio button']).toBe('Choose one of: "Monthly", "Yearly".');
      expect(reasons.checkbox).toContain('"Smoking" is not an option');
      expect(reasons.name).toContain('comes from your DocuStamp profile');
      expect(reasons.stamp).toContain('cannot add an image');
      expect(reasons['text input']).toBeUndefined();

      const err = await refusal(
        prepareAgentSignature(caller, doc.id, { fields: { 99999999: 'x' } })
      );
      expect(err.message).toBe('Field "99999999" is not one of your fields on this document.');
    });
  });

  describe('agentSignDocument', () => {
    it('signs the owner seat, records the agent, mails the next signer and the owner', async () => {
      const why = requirements();
      if (why) return pending(why);
      const { doc, keys, ownerContact } = await leaseFor({ SendinOrder: true });
      const caller = await callerFor(owner);
      const before = await reload(doc.id);

      const res = await agentSignDocument(caller, doc.id, {
        fields: {
          [keys['text input']]: '1500',
          [keys['radio button']]: 'yearly',
          [keys.checkbox]: true,
        },
      });

      expect(res).toEqual({
        status: 'signed',
        documentId: doc.id,
        completed: false,
        signer: {
          name: 'Olivia Owner',
          email: owner.email.toLowerCase(),
          contactId: ownerContact.id,
        },
        nextSigner: { name: 'Terry Tenant', email: tenantPerson.email.toLowerCase() },
        // Olivia had no saved signature: the typed one is hers from now on
        // (spec/AgentSavedSignature.spec.js covers the rest).
        signatureSaved: true,
      });
      // Never a link or a token.
      expect(JSON.stringify(res)).not.toMatch(/login|token|nextSignerUrl/i);

      const after = await reload(doc.id);
      expect(after.SignedUrl).not.toBe(before.SignedUrl);
      expect(after.IsCompleted).toBe(false);
      expect(after.AuditTrail.length).toBe(1);
      const entry = after.AuditTrail[0];
      expect(entry.UserPtr.objectId).toBe(ownerContact.id);
      expect(entry.Activity).toBe('Signed');
      expect(entry.ipAddress).toBe('10.1.2.3');
      expect(entry.Method).toBe('agent');
      expect(entry.Agent).toEqual({
        kind: 'oauth',
        clientId: 'client-chatgpt',
        name: 'ChatGPT',
        host: 'chatgpt.com',
      });
      expect(entry.OnBehalfOf).toEqual({
        name: 'Olivia Owner',
        email: owner.email.toLowerCase(),
        userId: owner.user.id,
      });
      expect(entry.AllowedBy.via).toBe('own_document');
      expect(entry.AllowedBy.name).toBe('Olivia Owner');
      expect(entry.AllowedBy.email).toBe(owner.email.toLowerCase());
      expect(new Date(entry.AllowedBy.at.iso || entry.AllowedBy.at).getTime()).toBeGreaterThan(
        Date.now() - 5 * 60 * 1000
      );
      expect(
        new Date(
          entry.AllowedBy.signingEnabledAt.iso || entry.AllowedBy.signingEnabledAt
        ).toISOString()
      ).toBe('2026-10-01T12:00:00.000Z');
      expect(entry.Signature).toContain('/files/');

      // What the stamped file says.
      const text = await pdfText(await fetchPdfBytes(after.SignedUrl));
      expect(text).toContain('Agent signing agreement');
      expect(text).toContain('Signed via ChatGPT for Olivia Owner');
      expect(text).toContain('Olivia Owner');
      expect(text).toContain('Owner Holdings');
      expect(text).toContain('1500');
      expect(text).toContain(formatInTimeZone(new Date(), ZONE, 'MM/dd/yyyy'));

      // The tenant is next on a sequential document and gets the request mail.
      expect(requestMails.map(m => m.recipient)).toEqual([tenantPerson.email.toLowerCase()]);
      expect(requestMails[0].html).toContain('/login/');
      // The owner hears about it, with a way back to the document.
      expect(ownerMails.length).toBe(1);
      expect(ownerMails[0].recipient).toBe(owner.email.toLowerCase());
      expect(ownerMails[0].subject).toBe(`ChatGPT signed "${after.Name}" for you`);
      expect(ownerMails[0].html).toContain(`${PUBLIC_URL}/documents/${doc.id}`);
      expect(ownerMails[0].html).toContain('Review or void');
      expect(ownerMails[0].html).toContain('Terry Tenant');
      expect(ownerMails[0].html).toContain('We saved this as your signature.');

      // Signing twice is refused like any second submit.
      const again = await refusal(
        agentSignDocument(caller, doc.id, {
          fields: { [keys['text input']]: '1500', [keys['radio button']]: 'Yearly' },
        })
      );
      expect(again.message).toBe('You have already signed this document.');
    }, 90000);

    it('completes the document when the agent signs last', async () => {
      const why = requirements();
      if (why) return pending(why);
      const ownerContact = await contactOf(owner, owner);
      const tenantContact = await contactOf(owner, tenantPerson);
      const doc = await makeDoc(owner, [
        { contact: tenantContact, widgets: [sig()] },
        { contact: ownerContact, widgets: [sig(), widget('name', 72, 100)] },
      ]);
      // The tenant signed already.
      const update = new Parse.Object('contracts_Document');
      update.id = doc.id;
      update.set('AuditTrail', [
        {
          UserPtr: pointer('contracts_Contactbook', tenantContact.id),
          Activity: 'Signed',
          SignedOn: new Date(),
        },
      ]);
      await update.save(null, { useMasterKey: true });

      const res = await agentSignDocument(await callerFor(owner), doc.id);
      expect(res.completed).toBe(true);
      expect(res.nextSigner).toBeNull();
      const after = await reload(doc.id);
      expect(after.IsCompleted).toBe(true);
      expect(after.DocumentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(after.CertificateUrl).toContain('/files/');
      expect(after.AuditTrail.find(e => e.UserPtr.objectId === ownerContact.id).Method).toBe(
        'agent'
      );
      expect(requestMails.length).toBe(0);
      expect(ownerMails.length).toBe(1);
      expect(ownerMails[0].html).toContain('the document is complete');
      // Saved by the first signature above, so nothing new to say.
      expect(res.signatureSaved).toBe(false);
      expect(ownerMails[0].html).not.toContain('We saved this as your signature');
    }, 90000);

    it('refuses an account whose address is not verified', async () => {
      const unverified = await makeAccount('agent.unverified', 'Una Verified', { verified: false });
      const contact = await contactOf(unverified, unverified);
      const doc = await makeDoc(unverified, [{ contact, widgets: [sig()] }]);
      const err = await refusal(agentSignDocument(await callerFor(unverified), doc.id));
      expect(err.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(err.message).toBe(VERIFY_EMAIL_HINT);
      expect((await reload(doc.id)).AuditTrail).toBeUndefined();
    });

    it('refuses a document where the caller has no seat', async () => {
      const tenantContact = await contactOf(owner, tenantPerson);
      const doc = await makeDoc(owner, [{ contact: tenantContact, widgets: [sig()] }]);
      // The owner is not a signer on it.
      const mine = await refusal(agentSignDocument(await callerFor(owner), doc.id));
      expect(mine.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(mine.message).toContain('not a signer on this document');
      // A stranger cannot even tell it exists.
      const theirs = await refusal(agentSignDocument(await callerFor(stranger), doc.id));
      expect(theirs.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
      expect(theirs.message).toBe('Document not found.');
      // A contact with the stranger's address but bound to another account is
      // not the stranger's seat.
      const lookalike = new Parse.Object('contracts_Contactbook');
      lookalike.set('Name', 'Sam Stranger');
      lookalike.set('Email', stranger.email);
      lookalike.set('CreatedBy', owner.user.toPointer());
      lookalike.set('UserId', tenantPerson.user.toPointer());
      lookalike.set('IsDeleted', false);
      await lookalike.save(null, { useMasterKey: true });
      const other = await makeDoc(owner, [{ contact: lookalike, widgets: [sig()] }]);
      const notSeat = await refusal(agentSignDocument(await callerFor(stranger), other.id));
      expect(notSeat.message).toBe('Document not found.');
    });

    it('refuses to sign out of turn on a sequential document', async () => {
      const { doc, keys } = await leaseFor({ SendinOrder: true }, { ownerFirst: false });
      const err = await refusal(
        agentSignDocument(await callerFor(owner), doc.id, {
          fields: { [keys['text input']]: '1500', [keys['radio button']]: 'Monthly' },
        })
      );
      expect(err.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(err.message).toBe(
        'It is not your turn yet: this document is signed in order and is waiting on Terry Tenant.'
      );
      expect((await reload(doc.id)).AuditTrail).toBeUndefined();
    });

    it('refuses with one message listing every missing value', async () => {
      const { doc, keys } = await leaseFor();
      const err = await refusal(agentSignDocument(await callerFor(owner), doc.id));
      expect(err.code).toBe(Parse.Error.VALIDATION_ERROR);
      expect(err.message).toContain(
        `Monthly rent (field ${keys['text input']}): A value is required.`
      );
      expect(err.message).toContain(
        `Radio button (field ${keys['radio button']}): A value is required.`
      );
      expect((await reload(doc.id)).AuditTrail).toBeUndefined();
    });

    it('refuses a required stamp, which an agent cannot add', async () => {
      const contact = await contactOf(owner, owner);
      const doc = await makeDoc(owner, [{ contact, widgets: [sig(), widget('stamp', 300, 400)] }]);
      const err = await refusal(agentSignDocument(await callerFor(owner), doc.id));
      expect(err.message).toContain('cannot add');
      expect((await reload(doc.id)).AuditTrail).toBeUndefined();
    });

    it('refuses a draft and a document with no signers', async () => {
      const contact = await contactOf(owner, owner);
      const draft = new Parse.Object('contracts_Document');
      draft.set('Name', 'Draft');
      draft.set('URL', await storePdf('Draft'));
      draft.set('CreatedBy', owner.user.toPointer());
      draft.set('ExtUserPtr', owner.ext.toPointer());
      draft.set('Signers', [pointer('contracts_Contactbook', contact.id)]);
      draft.set('Placeholders', [
        { Id: 1, signerObjId: contact.id, placeHolder: [{ pageNumber: 1, pos: [sig()] }] },
      ]);
      await draft.save(null, { useMasterKey: true });
      const caller = await callerFor(owner);
      expect((await refusal(agentSignDocument(caller, draft.id))).message).toContain(
        'has not been sent yet'
      );

      const selfSign = new Parse.Object('contracts_Document');
      selfSign.set('Name', 'Self');
      selfSign.set('URL', await storePdf('Self'));
      selfSign.set('CreatedBy', owner.user.toPointer());
      selfSign.set('ExtUserPtr', owner.ext.toPointer());
      await selfSign.save(null, { useMasterKey: true });
      expect((await refusal(agentSignDocument(caller, selfSign.id))).message).toContain(
        'has no signers'
      );
    });

    it("needs an approval on someone else's document, and then signs without the owner notice", async () => {
      const why = requirements();
      if (why) return pending(why);
      // The tenant's own document, sent to the owner: the owner is a guest here.
      const ownerAsGuest = await contactOf(tenantPerson, owner);
      const tenantSelf = await contactOf(tenantPerson, tenantPerson);
      const doc = await makeDoc(tenantPerson, [
        { contact: ownerAsGuest, widgets: [sig()] },
        { contact: tenantSelf, widgets: [sig()] },
      ]);
      const caller = await callerFor(owner);
      const none = await refusal(agentSignDocument(caller, doc.id));
      expect(none.message).toContain('you have to approve the signature first');
      const pretend = await refusal(
        agentSignDocument(caller, doc.id, { allowedBy: { via: 'own_document' } })
      );
      expect(pretend.message).toBe('Only documents you created are signed without your approval.');

      const res = await agentSignDocument(caller, doc.id, {
        allowedBy: { via: 'web', approvalId: 'appr123' },
      });
      expect(res.status).toBe('signed');
      // Another sender's co-signer: a name, not an address.
      expect(res.nextSigner).toEqual({ name: 'Terry Tenant', email: '' });
      expect(ownerMails.length).toBe(0);
      const entry = (await reload(doc.id)).AuditTrail[0];
      expect(entry.AllowedBy.via).toBe('web');
      expect(entry.AllowedBy.approvalId).toBe('appr123');
    }, 90000);

    it('stamps the new file again when another signature lands in between', async () => {
      const why = requirements();
      if (why) return pending(why);
      const { doc, keys } = await leaseFor();
      const coSigned = await storePdf('Co-signer stamp');
      const caller = await callerFor(owner);
      // The first download of the base file is the moment another signer's
      // signature lands: the document now points at a newer file.
      const realGet = axios.get.bind(axios);
      let fileReads = 0;
      spyOn(axios, 'get').and.callFake(async (url, opts) => {
        if (String(url).includes('/files/') && String(url).includes('base.pdf')) {
          fileReads += 1;
          if (fileReads === 1) {
            const moved = new Parse.Object('contracts_Document');
            moved.id = doc.id;
            moved.set('SignedUrl', coSigned);
            await moved.save(null, { useMasterKey: true });
          }
        }
        return await realGet(url, opts);
      });

      const res = await agentSignDocument(caller, doc.id, {
        fields: { [keys['text input']]: '1750', [keys['radio button']]: 'Monthly' },
      });
      expect(res.status).toBe('signed');
      expect(fileReads).toBe(2);
      const after = await reload(doc.id);
      const text = await pdfText(await fetchPdfBytes(after.SignedUrl));
      // Built on the newer file, so the co-signer's stamp survived.
      expect(text).toContain('Co-signer stamp');
      expect(text).toContain('1750');
      expect(text).not.toContain('Agent signing agreement');
    }, 90000);
  });

  describe('signPdf with an agent record', () => {
    it('refuses a stale base with the retryable error', async () => {
      const why = requirements();
      if (why) return pending(why);
      const { doc, ownerContact } = await leaseFor();
      const err = await refusal(
        PDF({
          master: true,
          params: {
            docId: doc.id,
            userId: ownerContact.id,
            pdfFile: Buffer.from(await pdfWith('x')).toString('base64'),
            baseUrl: `${TEST_SERVER}/files/${APP_ID}/somewhere-else.pdf`,
            agent: { Method: 'agent' },
          },
          headers: { 'x-real-ip': '', public_url: PUBLIC_URL },
        })
      );
      expect(isBaseChangedError(err)).toBe(true);
      const after = await reload(doc.id);
      expect(after.AuditTrail).toBeUndefined();
      // Not a fault worth recording on the document.
      expect(after.DebugginLog).toBeUndefined();
    }, 60000);

    it('ignores agent and baseUrl sent by a client', async () => {
      const why = requirements();
      if (why) return pending(why);
      const { doc, tenantContact } = await leaseFor();
      const token = mintSigningToken({
        docId: doc.id,
        contactId: tenantContact.id,
        expiresAt: Date.now() + 60000,
      });
      const res = await axios.post(
        `${TEST_SERVER}/functions/signPdf`,
        {
          docId: doc.id,
          userId: tenantContact.id,
          signingToken: token,
          pdfFile: Buffer.from(await pdfWith('By hand')).toString('base64'),
          agent: { Method: 'agent', Agent: { name: 'Forged' } },
          baseUrl: 'https://elsewhere.example.test/file.pdf',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Parse-Application-Id': APP_ID,
            'X-Parse-Javascript-Key': 'test',
            public_url: PUBLIC_URL,
          },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(200, JSON.stringify(res.data));
      expect(res.data.result.status).toBe('success');
      const entry = (await reload(doc.id)).AuditTrail[0];
      expect(entry.UserPtr.objectId).toBe(tenantContact.id);
      expect(entry.Method).toBeUndefined();
      expect(entry.Agent).toBeUndefined();
    }, 60000);
  });
});
