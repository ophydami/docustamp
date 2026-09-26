/**
 * Open tracking: every signing-page open is counted on the document row
 * (`OpenStats`) and logged as one `contracts_DocumentOpen` row, without
 * touching what the audit trail says about the signer's state.
 */
import axios from 'axios';
import { serverAppId } from '../Utils.js';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { loadCaller } from '../cloud/lib/context.js';
import { getAuditTrail } from '../cloud/lib/audit.js';
import { bumpOpenStats, openSummary, OPEN_CLASS } from '../cloud/lib/documentOpens.js';
import { uniqueEmail } from './support/env.js';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.7',
        'user-agent': 'SpecBrowser/1.0',
        ...headers,
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
  const res = await http.post(
    `${TEST_SERVER}/login`,
    { username: email, password },
    { headers: { 'X-Parse-Application-Id': APP_ID, 'X-Parse-Javascript-Key': JS_KEY } }
  );
  return res.data.sessionToken;
}

async function makeUser(email, password = 'Str0ng!pass') {
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('password', password);
  user.set('name', email.split('@')[0]);
  await user.signUp();
  user.__specSessionToken = await loginToken(email, password);
  return user;
}

function localFileUrl(name) {
  return `${TEST_SERVER}/files/${serverAppId}/${name}`;
}

describe('bumpOpenStats', () => {
  it('starts a signer at one and keeps the first open time', () => {
    const t1 = new Date('2026-09-01T10:00:00.000Z');
    const t2 = new Date('2026-09-02T10:00:00.000Z');
    const once = bumpOpenStats(undefined, 'c1', t1);
    expect(once.c1).toEqual({ count: 1, firstAt: t1.toISOString(), lastAt: t1.toISOString() });
    const twice = bumpOpenStats(once, 'c1', t2);
    expect(twice.c1).toEqual({ count: 2, firstAt: t1.toISOString(), lastAt: t2.toISOString() });
    // The input is not mutated.
    expect(once.c1.count).toBe(1);
  });

  it('keeps other signers untouched and survives junk', () => {
    const stats = bumpOpenStats({ c1: { count: 3 }, c2: 'junk' }, 'c2', new Date());
    expect(stats.c1).toEqual({ count: 3 });
    expect(stats.c2.count).toBe(1);
    expect(bumpOpenStats([], 'c1').c1.count).toBe(1);
  });
});

describe('openSummary', () => {
  it('names each signer from the document and orders by the latest open', () => {
    const d = {
      Signers: [
        { objectId: 'a', Name: 'Ann', Email: 'Ann@Example.com' },
        { objectId: 'b', Name: 'Bob', Email: 'bob@example.com' },
      ],
      Placeholders: [{ signerObjId: 'a', Role: 'Tenant' }],
      OpenStats: {
        a: { count: 2, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-01T11:00:00.000Z' },
        b: { count: 5, firstAt: '2026-09-01T09:00:00.000Z', lastAt: '2026-09-03T09:00:00.000Z' },
      },
    };
    const s = openSummary(d);
    expect(s.total).toBe(7);
    expect(s.bySigner.map(x => x.contactId)).toEqual(['b', 'a']);
    expect(s.bySigner[1]).toEqual(
      jasmine.objectContaining({ name: 'Ann', email: 'ann@example.com', role: 'Tenant', count: 2 })
    );
  });

  it('is empty when nothing was recorded', () => {
    expect(openSummary({})).toEqual({ total: 0, bySigner: [] });
  });
});

describe('document opens', () => {
  Parse.User.enableUnsafeCurrentUser();

  let owner;
  let ownerSession;
  let ownerExt;
  let stranger;
  let strangerSession;
  let signerUser;
  let signerContact;

  async function makeDocument(extra = {}) {
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', 'Open tracking spec');
    doc.set('URL', localFileUrl('opens.pdf'));
    doc.set('SignedUrl', localFileUrl('opens.pdf'));
    doc.set('CreatedBy', pointer('_User', owner.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
    doc.set('Signers', [pointer('contracts_Contactbook', signerContact.id)]);
    doc.set('Placeholders', [
      {
        Id: 1,
        Role: 'Signer',
        signerObjId: signerContact.id,
        signerPtr: pointer('contracts_Contactbook', signerContact.id),
        email: signerContact.get('Email'),
        placeHolder: [{ pageNumber: 1, pos: [] }],
      },
    ]);
    doc.set('DocSentAt', new Date());
    const acl = new Parse.ACL();
    acl.setReadAccess(owner.id, true);
    acl.setWriteAccess(owner.id, true);
    doc.setACL(acl);
    for (const [key, value] of Object.entries(extra)) doc.set(key, value);
    return await doc.save(null, { useMasterKey: true });
  }

  function tokenFor(docId, contactId) {
    return mintSigningToken({ docId, contactId, expiresAt: Date.now() + 60000 });
  }

  async function open(doc, times = 1) {
    let last;
    for (let i = 0; i < times; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential opens on purpose
      last = await callFn('triggerevent', {
        event: 'viewed',
        contactId: signerContact.id,
        body: { objectId: doc.id },
        signingToken: tokenFor(doc.id, signerContact.id),
      });
      expect(last.ok).toBe(true);
    }
    return last;
  }

  async function freshDoc(docId) {
    const row = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
    return row.toJSON();
  }

  async function openRows(docId) {
    const q = new Parse.Query(OPEN_CLASS);
    q.equalTo('Document', pointer('contracts_Document', docId));
    q.ascending('OpenedAt');
    return (await q.find({ useMasterKey: true })).map(r => r.toJSON());
  }

  beforeAll(async () => {
    owner = await makeUser(uniqueEmail('owner.opens'));
    ownerSession = owner.__specSessionToken;
    stranger = await makeUser(uniqueEmail('stranger.opens'));
    strangerSession = stranger.__specSessionToken;
    signerUser = await makeUser(uniqueEmail('signer.opens'));

    const ext = new Parse.Object('contracts_Users');
    ext.set('UserId', pointer('_User', owner.id));
    ext.set('Email', owner.get('email'));
    ext.set('Name', 'Opens Owner');
    ext.set('UserRole', 'contracts_User');
    ownerExt = await ext.save(null, { useMasterKey: true });

    const contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'Opens Signer');
    contact.set('Email', signerUser.get('email'));
    contact.set('CreatedBy', pointer('_User', owner.id));
    contact.set('UserId', pointer('_User', signerUser.id));
    contact.set('IsDeleted', false);
    signerContact = await contact.save(null, { useMasterKey: true });
  }, 120000);

  beforeEach(() => resetRateLimits());

  it('counts every open on the row and logs each one, with a single audit entry', async () => {
    const doc = await makeDocument();
    await open(doc, 3);

    const d = await freshDoc(doc.id);
    expect(d.OpenStats?.[signerContact.id]?.count).toBe(3);
    expect(Date.parse(d.OpenStats[signerContact.id].firstAt)).toBeLessThanOrEqual(
      Date.parse(d.OpenStats[signerContact.id].lastAt)
    );
    // The audit trail still holds one slot per signer.
    expect(d.AuditTrail.length).toBe(1);
    expect(d.AuditTrail[0].Activity).toBe('Viewed');

    const rows = await openRows(doc.id);
    expect(rows.length).toBe(3);
    expect(rows[0].ContactId).toBe(signerContact.id);
    expect(rows[0].Email).toBe(signerUser.get('email').toLowerCase());
    // index.js rewrites x-real-ip from the socket, so only "an address was kept" holds here.
    expect(typeof rows[0].IpAddress).toBe('string');
    expect(rows[0].IpAddress.length).toBeGreaterThan(0);
    expect(rows[0].UserAgent).toBe('SpecBrowser/1.0');
    expect(rows[0].Owner?.objectId).toBe(ownerExt.id);
  }, 60000);

  it('keeps counting after the signer has signed, without touching the Signed entry', async () => {
    const doc = await makeDocument({
      AuditTrail: [
        {
          UserPtr: pointer('contracts_Contactbook', signerContact.id),
          Activity: 'Signed',
          SignedOn: new Date().toISOString(),
          ipAddress: '203.0.113.9',
        },
      ],
    });
    await open(doc, 2);

    const d = await freshDoc(doc.id);
    expect(d.AuditTrail.length).toBe(1);
    expect(d.AuditTrail[0].Activity).toBe('Signed');
    expect(d.OpenStats?.[signerContact.id]?.count).toBe(2);
    expect((await openRows(doc.id)).length).toBe(2);
  }, 60000);

  it('lists the opens for the owner and refuses everyone else', async () => {
    const doc = await makeDocument();
    await open(doc, 2);

    const mine = await callFn(
      'getdocumentopens',
      { docId: doc.id },
      { sessionToken: ownerSession }
    );
    expect(mine.ok).toBe(true);
    expect(mine.result.total).toBe(2);
    expect(mine.result.bySigner.length).toBe(1);
    expect(mine.result.bySigner[0]).toEqual(
      jasmine.objectContaining({
        contactId: signerContact.id,
        name: 'Opens Signer',
        role: 'Signer',
        count: 2,
      })
    );
    expect(mine.result.opens.length).toBe(2);
    expect(mine.result.opens[0].ip).toBeTruthy();
    expect(mine.result.opens[0].userAgent).toBe('SpecBrowser/1.0');
    // Newest first.
    expect(Date.parse(mine.result.opens[0].at)).toBeGreaterThanOrEqual(
      Date.parse(mine.result.opens[1].at)
    );

    const theirs = await callFn(
      'getdocumentopens',
      { docId: doc.id },
      { sessionToken: strangerSession }
    );
    expect(theirs.ok).toBe(false);

    const nobody = await callFn('getdocumentopens', { docId: doc.id });
    expect(nobody.ok).toBe(false);
  }, 60000);

  it('never exposes the open log through the REST classes endpoint', async () => {
    const doc = await makeDocument();
    await open(doc, 1);
    let status;
    let count;
    try {
      const res = await http.get(`${TEST_SERVER}/classes/${OPEN_CLASS}`, {
        headers: {
          'X-Parse-Application-Id': APP_ID,
          'X-Parse-Javascript-Key': JS_KEY,
          'X-Parse-Session-Token': ownerSession,
        },
      });
      status = res.status;
      count = res.data?.results?.length ?? -1;
    } catch (err) {
      status = err?.response?.status || 0;
      count = -1;
    }
    // Either the class is closed (Parse answers 400/403 with code 119) or the
    // query answers with nothing.
    expect(status !== 200 || count === 0).toBe(true);
  }, 60000);

  it('reports the opens in the audit trail the API and MCP return', async () => {
    const doc = await makeDocument();
    await open(doc, 2);
    const caller = await loadCaller(owner);
    const trail = await getAuditTrail(caller, doc.id);
    expect(trail.opens.total).toBe(2);
    expect(trail.opens.bySigner[0].count).toBe(2);
    expect(trail.opens.recent.length).toBe(2);
    expect(trail.entries.length).toBe(1);
  }, 60000);
});
