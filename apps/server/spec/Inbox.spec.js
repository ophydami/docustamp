/**
 * Documents sent TO the caller (cloud/lib/inbox.js) and the participant page
 * preview (cloud/lib/preview.js `renderParticipantPreview`): the buckets, the
 * "is it my turn" rule on sequential documents, the participant check, and that
 * nothing another signer owns (an address, a link, the owner's note) leaks.
 */
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ensureContact } from '../cloud/lib/contacts.js';
import { loadCaller } from '../cloud/lib/context.js';
import { getParticipantDocument, listInbox } from '../cloud/lib/inbox.js';
import { renderPagePreview, renderParticipantPreview } from '../cloud/lib/preview.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const PUBLIC = 'https://sign.example.test';
const PDF_URL = `${BASE}/files/inbox-spec-${Date.now()}.pdf`;
const OWNER_NOTE = 'Private note from the owner';

async function makeAccount(prefix, name, company) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', company);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', name);
  extUser.set('Email', email);
  extUser.set('Company', company);
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  const caller = await loadCaller(user, { publicUrl: PUBLIC });
  return { user, extUser, email, caller };
}

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Purchase agreement, page ${n}`, { x: 72, y: 740, size: 12, font });
  }
  return new Uint8Array(await pdf.save());
}

function contactPointer(contact) {
  return { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contact.objectId };
}

function widget(key, type, x, y, width, height, options = {}) {
  return {
    key,
    type,
    xPosition: x,
    yPosition: y,
    Width: width,
    Height: height,
    options: { name: `${type}-${key}`, status: 'required', fontSize: 12, ...options },
  };
}

/** Bob's seat: a signature, a hinted text box, an optional checkbox and a date. */
function bobWidgets(prefix) {
  return [
    widget(`${prefix}-sig`, 'signature', 72, 600, 150, 40),
    widget(`${prefix}-acct`, 'text input', 72, 560, 150, 19, { hint: 'Account number' }),
    widget(`${prefix}-opts`, 'checkbox', 72, 500, 15, 40, {
      status: 'optional',
      values: ['Paper copy', 'Email copy'],
      defaultValue: [],
      layout: 'vertical',
    }),
    widget(`${prefix}-date`, 'date', 300, 560, 100, 20, {
      validation: { type: 'date-format', format: 'MM/dd/yyyy' },
    }),
  ];
}

function seatGroup(contact, role, color, pos, id) {
  return {
    Id: id,
    Role: role,
    blockColor: color,
    signerObjId: contact.objectId,
    signerPtr: contactPointer(contact),
    email: contact.email,
    placeHolder: [{ pageNumber: 1, pos }],
  };
}

describe('Inbox: documents sent to the caller', () => {
  let alice; // the sender
  let bob; // the recipient, with a real account
  let carol; // a stranger
  let daveEmail;
  let bobContact;
  let daveContact;
  let aliceSelf;
  let pdfBytes;
  let seq = 0;

  beforeAll(async () => {
    alice = await makeAccount('inbox.alice', 'Alice Owner', 'Acme Inc');
    bob = await makeAccount('inbox.bob', 'Bob Recipient', 'Bob Co');
    carol = await makeAccount('inbox.carol', 'Carol Stranger', 'Carol Co');
    daveEmail = uniqueEmail('inbox.dave', 'example.test');
    // Alice's address book. Bob's contact resolves to Bob's own account
    // (shadowUserFor finds the existing username), Dave gets a shadow account.
    bobContact = await ensureContact(alice.caller, { name: 'Bob Recipient', email: bob.email });
    daveContact = await ensureContact(alice.caller, { name: 'Dave Cosigner', email: daveEmail });
    aliceSelf = await ensureContact(alice.caller, { name: 'Alice Owner', email: alice.email });

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
  });

  /**
   * A document Alice sends. `seats` is [{contact, role, color, pos}] in signing
   * order; a prefill box is always added.
   */
  async function makeDoc({ name, seats, sendInOrder = false, sent = true, extra = {} }) {
    seq += 1;
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', name || `Inbox doc ${seq}`);
    doc.set('Note', OWNER_NOTE);
    doc.set('URL', PDF_URL);
    if (sent) {
      doc.set('SignedUrl', PDF_URL);
      doc.set('DocSentAt', new Date());
      doc.set('SentToOthers', true);
    }
    doc.set('SendinOrder', sendInOrder);
    doc.set('CreatedBy', alice.user.toPointer());
    doc.set('ExtUserPtr', alice.extUser.toPointer());
    doc.set(
      'Signers',
      seats.map(s => contactPointer(s.contact))
    );
    doc.set('Placeholders', [
      ...seats.map((s, i) => seatGroup(s.contact, s.role, s.color, s.pos, 1000 + i)),
      {
        Id: 999,
        Role: 'prefill',
        blockColor: '#94a3b8',
        placeHolder: [
          {
            pageNumber: 1,
            pos: [
              widget(`pre-${seq}`, 'text', 72, 680, 200, 19, { defaultValue: 'Prefilled by Acme' }),
            ],
          },
        ],
      },
    ]);
    for (const [k, v] of Object.entries(extra)) doc.set(k, v);
    await doc.save(null, { useMasterKey: true });
    return doc;
  }

  function bobSeat(prefix = `b${seq + 1}`) {
    return { contact: bobContact, role: 'Buyer', color: '#93a3db', pos: bobWidgets(prefix) };
  }

  function daveSeat() {
    return {
      contact: daveContact,
      role: 'Seller',
      color: '#e5a3a3',
      pos: [widget(`d${seq + 1}-sig`, 'signature', 350, 600, 150, 40)],
    };
  }

  async function patch(doc, fields) {
    const update = new Parse.Object('contracts_Document');
    update.id = doc.id;
    for (const [k, v] of Object.entries(fields)) update.set(k, v);
    await update.save(null, { useMasterKey: true });
  }

  function signedEntry(contact) {
    return {
      UserPtr: contactPointer(contact),
      Activity: 'Signed',
      SignedOn: new Date().toISOString(),
      SignedUrl: PDF_URL,
    };
  }

  async function ids(caller, status) {
    const { documents } = await listInbox(caller, { status });
    return documents.map(d => d.id);
  }

  async function itemFor(caller, status, docId) {
    const { documents } = await listInbox(caller, { status });
    return documents.find(d => d.id === docId);
  }

  /** Only the sender's address may appear; no signing links, no owner note. */
  function expectNoLeaks(value) {
    const text = JSON.stringify(value);
    const addresses = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) || []).map(a =>
      a.toLowerCase()
    );
    for (const address of addresses) expect(address).toBe(alice.email);
    expect(text).not.toContain(daveEmail);
    expect(text).not.toContain(bob.email);
    expect(text).not.toContain(OWNER_NOTE);
    expect(text).not.toMatch(/signingToken|signingUrl|signingLinks|nextSignerUrl|\/login\//);
  }

  async function expectNotFound(promise) {
    let error;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error?.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    expect(error?.message).toBe('Document not found.');
  }

  it('binds the recipient contact to their own account', async () => {
    const row = await new Parse.Query('contracts_Contactbook').get(bobContact.objectId, {
      useMasterKey: true,
    });
    expect(row.get('UserId').id).toBe(bob.user.id);
  });

  it('lists a document sent to the caller under needs_you, with the sender and names only', async () => {
    const doc = await makeDoc({ name: 'Purchase agreement', seats: [bobSeat(), daveSeat()] });
    const item = await itemFor(bob.caller, 'needs_you', doc.id);
    expect(item).toBeDefined();
    expect(item.title).toBe('Purchase agreement');
    expect(item.status).toBe('in_progress');
    expect(item.myStatus).toBe('needs_you');
    expect(item.myRole).toBe('Buyer');
    expect(item.sender).toEqual({ name: 'Alice Owner', company: 'Acme Inc', email: alice.email });
    expect(item.sentAt).toMatch(/^\d{4}-/);
    expect(item.expiresAt).toMatch(/^\d{4}-/);
    expect(item.signers).toEqual([
      { name: 'Bob Recipient', role: 'Buyer', status: 'pending' },
      { name: 'Dave Cosigner', role: 'Seller', status: 'pending' },
    ]);
    // The default bucket is needs_you.
    expect(await ids(bob.caller)).toContain(doc.id);
    expect(await ids(bob.caller, 'waiting')).not.toContain(doc.id);
    expectNoLeaks(await listInbox(bob.caller, { status: 'all' }));
  });

  it('gives a participant their seat, their own fields and a short-lived file link', async () => {
    const doc = await makeDoc({ seats: [bobSeat('pv'), daveSeat()] });
    const view = await getParticipantDocument(bob.caller, doc.id);
    expect(view.id).toBe(doc.id);
    expect(view.role).toBe('signer');
    expect(view.status).toBe('in_progress');
    expect(view.myStatus).toBe('needs_you');
    expect(view.sender.email).toBe(alice.email);
    expect(view.mySeat).toEqual({ contactId: bobContact.objectId, role: 'Buyer' });
    expect(view.pageCount).toBe(2);
    expect(view.myFields.map(f => f.key)).toEqual(['pv-sig', 'pv-acct', 'pv-opts', 'pv-date']);
    const byKey = Object.fromEntries(view.myFields.map(f => [f.key, f]));
    expect(byKey['pv-sig']).toEqual({
      key: 'pv-sig',
      type: 'signature',
      label: 'Signature',
      required: true,
      page: 1,
    });
    expect(byKey['pv-acct'].label).toBe('Account number');
    expect(byKey['pv-opts'].options).toEqual(['Paper copy', 'Email copy']);
    expect(byKey['pv-opts'].required).toBeFalse();
    expect(byKey['pv-date'].dateFormat).toBe('MM/dd/yyyy');
    expect(view.urls.app).toBe(`${PUBLIC}/inbox`);
    expect(view.urls.file.startsWith(`${PDF_URL}?token=`)).toBeTrue();
    expectNoLeaks(view);
  });

  it('waits on a sequential document until the earlier signer has signed', async () => {
    const doc = await makeDoc({ seats: [daveSeat(), bobSeat()], sendInOrder: true });
    expect(await ids(bob.caller, 'needs_you')).not.toContain(doc.id);
    const waiting = await itemFor(bob.caller, 'waiting', doc.id);
    expect(waiting?.myStatus).toBe('waiting');
    expect((await getParticipantDocument(bob.caller, doc.id)).myStatus).toBe('waiting');

    await patch(doc, { AuditTrail: [signedEntry(daveContact)] });
    const turn = await itemFor(bob.caller, 'needs_you', doc.id);
    expect(turn?.myStatus).toBe('needs_you');
    expect(turn.signers.map(s => s.status)).toEqual(['signed', 'pending']);
    expect(await ids(bob.caller, 'waiting')).not.toContain(doc.id);

    await patch(doc, {
      AuditTrail: [signedEntry(daveContact), signedEntry(bobContact)],
      IsCompleted: true,
    });
    expect(await ids(bob.caller, 'needs_you')).not.toContain(doc.id);
    expect(await ids(bob.caller, 'waiting')).not.toContain(doc.id);
    const done = await itemFor(bob.caller, 'completed', doc.id);
    expect(done?.status).toBe('completed');
    expect(done?.myStatus).toBe('signed');
  });

  it('moves a document to waiting once the caller has signed and others still owe', async () => {
    const doc = await makeDoc({ seats: [bobSeat(), daveSeat()] });
    await patch(doc, { AuditTrail: [signedEntry(bobContact)] });
    expect(await ids(bob.caller, 'needs_you')).not.toContain(doc.id);
    const item = await itemFor(bob.caller, 'waiting', doc.id);
    expect(item?.myStatus).toBe('signed');
    expect(item.signers.map(s => s.status)).toEqual(['signed', 'pending']);
    expect((await getParticipantDocument(bob.caller, doc.id)).myStatus).toBe('signed');
  });

  it('keeps drafts and archived documents out, and files expired and declined ones under all', async () => {
    const draft = await makeDoc({ seats: [bobSeat()], sent: false });
    const archived = await makeDoc({ seats: [bobSeat()], extra: { IsArchive: true } });
    const expired = await makeDoc({ seats: [bobSeat(), daveSeat()] });
    await patch(expired, { ExpiryDate: new Date(Date.now() - 24 * 3600 * 1000) });
    const declined = await makeDoc({ seats: [bobSeat(), daveSeat()] });
    await patch(declined, {
      IsDeclined: true,
      DeclineReason: 'Wrong price',
      DeclineByContact: contactPointer(daveContact),
      AuditTrail: [
        {
          UserPtr: contactPointer(daveContact),
          Activity: 'Declined',
          DeclinedOn: new Date().toISOString(),
        },
      ],
    });

    const all = await listInbox(bob.caller, { status: 'all' });
    const allIds = all.documents.map(d => d.id);
    expect(allIds).not.toContain(draft.id);
    expect(allIds).not.toContain(archived.id);
    await expectNotFound(getParticipantDocument(bob.caller, draft.id));
    await expectNotFound(getParticipantDocument(bob.caller, archived.id));

    const exp = all.documents.find(d => d.id === expired.id);
    expect(exp?.status).toBe('expired');
    expect(exp?.myStatus).toBe('waiting');
    const dec = all.documents.find(d => d.id === declined.id);
    expect(dec?.status).toBe('declined');
    expect(dec?.myStatus).toBe('declined');
    expect(dec.signers).toEqual([
      { name: 'Bob Recipient', role: 'Buyer', status: 'pending' },
      { name: 'Dave Cosigner', role: 'Seller', status: 'declined' },
    ]);
    const buckets = await Promise.all(
      ['needs_you', 'waiting', 'completed'].map(status => ids(bob.caller, status))
    );
    for (const bucket of buckets) {
      expect(bucket).not.toContain(expired.id);
      expect(bucket).not.toContain(declined.id);
    }
    expectNoLeaks(all);
  });

  it('shows the owner their own document only when they are also a signer', async () => {
    const onlyOthers = await makeDoc({ seats: [daveSeat()] });
    const withMe = await makeDoc({
      seats: [
        {
          contact: aliceSelf,
          role: 'Landlord',
          color: '#a3dba3',
          pos: [widget(`a${seq + 1}-sig`, 'signature', 72, 300, 150, 40)],
        },
        daveSeat(),
      ],
    });
    const all = await ids(alice.caller, 'all');
    expect(all).not.toContain(onlyOthers.id);
    expect(await ids(alice.caller, 'needs_you')).toContain(withMe.id);
    // The owner reads a document they only sent through get_document, not here.
    await expectNotFound(getParticipantDocument(alice.caller, onlyOthers.id));
  });

  it('shows a stranger nothing and refuses them the document and its pages', async () => {
    const doc = await makeDoc({ seats: [bobSeat(), daveSeat()] });
    const lists = await Promise.all(
      ['needs_you', 'waiting', 'completed', 'all'].map(status =>
        listInbox(carol.caller, { status })
      )
    );
    for (const list of lists) expect(list.documents).toEqual([]);
    await expectNotFound(getParticipantDocument(carol.caller, doc.id));
    await expectNotFound(renderParticipantPreview(carol.caller, doc.id, { page: 1 }));
    await expectNotFound(getParticipantDocument(bob.caller, 'doesnotexist'));
  });

  it('refuses an unknown status', async () => {
    let error;
    try {
      await listInbox(bob.caller, { status: 'pending' });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe(Parse.Error.VALIDATION_ERROR);
  });

  it("previews a page for a participant in signer mode, drawing only the caller's own fields", async () => {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const doc = await makeDoc({ seats: [bobSeat('img'), daveSeat()] });

    const out = await renderParticipantPreview(bob.caller, doc.id, { page: 1, scale: 1 });
    expect(out.mode).toBe('signer');
    expect(out.page).toBe(1);
    expect(out.pageCount).toBe(2);
    expect(out.png.subarray(1, 4).toString()).toBe('PNG');
    expect(out.fields.map(f => f.key).sort()).toEqual([
      'img-acct',
      'img-date',
      'img-opts',
      'img-sig',
    ]);
    expect(out.fields.every(f => f.recipient === 'Buyer')).toBeTrue();
    expectNoLeaks(out.fields);

    const sample = async (png, x, y) => {
      const img = await loadImage(png);
      const cnv = createCanvas(img.width, img.height);
      const ctx = cnv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return d[0] + d[1] + d[2];
    };
    // Bob's signature box is tinted; Dave's is not drawn at all.
    expect(await sample(out.png, 147, 620)).toBeLessThan(765);
    expect(await sample(out.png, 425, 620)).toBe(765);

    // The owner's own signer-mode preview still draws every signer's box.
    const owner = await renderPagePreview(alice.caller, doc.id, {
      page: 1,
      scale: 1,
      mode: 'signer',
    });
    expect(await sample(owner.png, 425, 620)).toBeLessThan(765);
    expect(owner.fields.map(f => f.key)).toContain(`d${seq}-sig`);
    // And the owner path still refuses a participant.
    let error;
    try {
      await renderPagePreview(bob.caller, doc.id, { page: 1 });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe(Parse.Error.OPERATION_FORBIDDEN);

    // Once Bob has signed, his values are in the PDF, so his boxes are not drawn.
    await patch(doc, { AuditTrail: [signedEntry(bobContact)] });
    const after = await renderParticipantPreview(bob.caller, doc.id, { page: 1, scale: 1 });
    expect(await sample(after.png, 147, 620)).toBe(765);
  });
});
