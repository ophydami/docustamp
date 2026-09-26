/**
 * Coverage for the `batchdocuments` cloud function (cloud/parsefunction/createBatchDocs.js).
 *
 * The function talks to the Parse `/batch` endpoint through the shared axios
 * instance, using the hard-coded production server URL, so `axios.post` is spied
 * on and /batch calls are replayed against the test server (rewriting the `/app`
 * mount to `/test`).
 *
 * The request mail no longer loops back over HTTP to `sendmailv3`: it is rendered
 * and sent in process by `cloud/lib/requestMail.js`, so mail is captured at that
 * module's transport seam instead.
 */
import axios from 'axios';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';

// `DocumentAfterFind` signs a single document's URL on the way out, which needs a
// master key and a local /files/ URL. The test server runs with masterKey 'test'.
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
// The test server is started with a javascript key (spec/utils/test-runner.js), so
// every raw HTTP call has to carry it. The production config sets no client keys.
const JS_KEY = 'test';
const PUBLIC_URL = 'http://localhost:3000';

// A separate instance, so the spy on the default instance does not intercept it.
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

describe('batchdocuments (createBatchDocs)', () => {
  Parse.User.enableUnsafeCurrentUser();

  let sessionToken;
  let userId;
  let extUser;
  let contacts = [];
  let mailCalls = [];
  let mailResult = { status: 'success' };
  let batchCalls = 0;

  async function callBatchDocuments(documents, headers = {}, params = {}) {
    const res = await http.post(
      `${TEST_SERVER}/functions/batchdocuments`,
      { Documents: JSON.stringify(documents), ...params },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Parse-Application-Id': APP_ID,
          'X-Parse-Javascript-Key': JS_KEY,
          'X-Parse-Session-Token': sessionToken,
          sessiontoken: sessionToken,
          public_url: PUBLIC_URL,
          'x-real-ip': '127.0.0.1',
          ...headers,
        },
      }
    );
    return res.data.result;
  }

  function documentFor(contact, name, extra = {}) {
    return {
      Name: name,
      URL: `${TEST_SERVER}/files/test/bulk-send-spec.pdf`,
      Note: 'Please sign',
      Description: 'Bulk send spec',
      CreatedBy: pointer('_User', userId),
      SendinOrder: false,
      SendInOrderStrict: false,
      TimeToCompleteDays: 15,
      RemindOnceInEvery: 5,
      AutomaticReminders: false,
      IsEnableOTP: false,
      ExtUserPtr: {
        className: 'contracts_Users',
        objectId: extUser.id,
        Name: extUser.get('Name'),
        Email: extUser.get('Email'),
        Company: 'Acme',
      },
      Signers: [
        {
          objectId: contact.id,
          Name: contact.get('Name'),
          Email: contact.get('Email'),
        },
      ],
      Placeholders: [
        {
          Id: 12345678,
          Role: 'Role 1',
          blockColor: '#0f6e56',
          signerObjId: contact.id,
          signerPtr: { objectId: contact.id, Email: contact.get('Email') },
          email: contact.get('Email'),
          placeHolder: [],
        },
      ],
      ...extra,
    };
  }

  beforeAll(async () => {
    const suffix = Date.now();
    const username = `bulkowner${suffix}@example.com`;
    const password = 'bulk-send-spec';
    const user = new Parse.User();
    user.set('username', username);
    user.set('email', username);
    user.set('password', password);
    await user.signUp();
    userId = user.id;
    // Sign-up through the server-side SDK does not hand back a session, so log in
    // over REST to get the token the cloud function authenticates with.
    const login = await http.post(
      `${TEST_SERVER}/login`,
      { username, password },
      {
        headers: {
          'X-Parse-Application-Id': APP_ID,
          'X-Parse-Javascript-Key': JS_KEY,
          'X-Parse-Revocable-Session': '1',
        },
      }
    );
    sessionToken = login.data.sessionToken;

    extUser = new Parse.Object('contracts_Users');
    extUser.set('Name', 'Bulk Owner');
    extUser.set('Email', `bulkowner${suffix}@example.com`);
    extUser.set('UserId', pointer('_User', userId));
    extUser.set('UserRole', 'contracts_Admin');
    await extUser.save(null, { useMasterKey: true });

    contacts = await Promise.all(
      ['one', 'two', 'three'].map(label => {
        const contact = new Parse.Object('contracts_Contactbook');
        contact.set('Name', `Signer ${label}`);
        contact.set('Email', `signer-${label}-${suffix}@example.com`);
        contact.set('UserId', pointer('_User', userId));
        contact.set('CreatedBy', pointer('_User', userId));
        contact.set('IsDeleted', false);
        return contact.save(null, { useMasterKey: true });
      })
    );

    // `allowClientClassCreation` is false, and /batch runs with a session token, so
    // the class has to exist before the function is called.
    const seed = new Parse.Object('contracts_Document');
    seed.set('Name', 'class seed');
    await seed.save(null, { useMasterKey: true });
    await seed.destroy({ useMasterKey: true });
  }, 60000);

  afterAll(() => setRequestMailTransport(null));

  beforeEach(() => {
    mailCalls = [];
    mailResult = { status: 'success' };
    batchCalls = 0;
    setRequestMailTransport(async params => {
      mailCalls.push(params);
      return mailResult;
    });
    spyOn(axios, 'post').and.callFake(async (url, body, config) => {
      if (url === 'batch') {
        batchCalls += 1;
        const requests = body.requests.map(r => ({
          ...r,
          path: r.path.replace(/^\/app\//, '/test/'),
        }));
        // The function signs the call with the production app id and no client key;
        // the test server runs under a different app id and a javascript key.
        return http.post(
          `${TEST_SERVER}/batch`,
          { requests },
          {
            headers: {
              ...config.headers,
              'X-Parse-Application-Id': APP_ID,
              'X-Parse-Javascript-Key': JS_KEY,
            },
          }
        );
      }
      throw new Error(`unexpected axios.post to ${url}`);
    });
  });

  async function documentsNamed(name) {
    const query = new Parse.Query('contracts_Document');
    query.equalTo('Name', name);
    return query.find({ useMasterKey: true });
  }

  it('creates one document per request and mails each one', async () => {
    const name = `bulk-all-${Date.now()}`;
    const documents = contacts.map(c => documentFor(c, name));

    const result = await callBatchDocuments(documents);

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results.length).toBe(3);
    expect(result.results.map(r => r.index)).toEqual([0, 1, 2]);
    result.results.forEach(row => {
      expect(typeof row.objectId).toBe('string');
      expect(row.objectId.length).toBeGreaterThan(0);
      expect(row.error).toBeUndefined();
    });

    const saved = await documentsNamed(name);
    expect(saved.length).toBe(3);
    expect(saved.map(d => d.id).sort()).toEqual(result.results.map(r => r.objectId).sort());
    // One /batch call is enough for three rows, and each created row gets one mail.
    expect(batchCalls).toBe(1);
    expect(mailCalls.length).toBe(3);
    expect(mailCalls.map(m => m.recipient).sort()).toEqual(
      contacts.map(c => c.get('Email')).sort()
    );
  }, 60000);

  it('reports a bad row as failed without aborting the others', async () => {
    const name = `bulk-partial-${Date.now()}`;
    const documents = [
      documentFor(contacts[0], name),
      // The recipients are read while the row is mapped, so this row fails on its
      // own. `CreatedBy` no longer works for this: it is taken from the caller.
      { ...documentFor(contacts[1], name), Placeholders: undefined },
      documentFor(contacts[2], name),
    ];

    const result = await callBatchDocuments(documents);

    expect(result.total).toBe(3);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0].objectId).toBeDefined();
    expect(result.results[2].objectId).toBeDefined();
    expect(result.results[1].objectId).toBeUndefined();
    expect(result.results[1].index).toBe(1);
    expect(typeof result.results[1].error).toBe('string');

    const saved = await documentsNamed(name);
    expect(saved.length).toBe(2);
    expect(mailCalls.length).toBe(2);
  }, 60000);

  it('sets BulkSendToken on the bulksend path only', async () => {
    const bulkName = `bulk-token-${Date.now()}`;
    const bulk = await callBatchDocuments([documentFor(contacts[0], bulkName)], {
      type: 'bulksend',
    });
    expect(bulk.created).toBe(1);

    const bulkDocs = await documentsNamed(bulkName);
    expect(bulkDocs.length).toBe(1);
    const token = bulkDocs[0].get('BulkSendToken');
    expect(typeof token).toBe('string');
    expect(token.length).toBe(10);

    const quickName = `quick-token-${Date.now()}`;
    const quick = await callBatchDocuments([documentFor(contacts[1], quickName)], {
      type: 'quicksend',
    });
    expect(quick.created).toBe(1);

    const quickDocs = await documentsNamed(quickName);
    expect(quickDocs.length).toBe(1);
    expect(quickDocs[0].get('BulkSendToken')).toBeUndefined();
  }, 60000);

  it('keeps the prefill values and drops the roles this row does not bind', async () => {
    const name = `bulk-prefill-${Date.now()}`;
    const row = documentFor(contacts[0], name);
    row.Placeholders = [
      {
        Id: 1,
        Role: 'prefill',
        signerObjId: '',
        signerPtr: {},
        email: '',
        placeHolder: [
          { pageNumber: 1, pos: [{ key: 9, type: 'textbox', options: { response: '42' } }] },
        ],
      },
      row.Placeholders[0],
      // A second role the bulk row does not bind. Kept, it made the document
      // uncompletable: completion counts every non-prefill placeholder.
      { Id: 3, Role: 'Role 2', signerObjId: '', signerPtr: {}, email: '', placeHolder: [] },
    ];

    const result = await callBatchDocuments([row]);
    expect(result.created).toBe(1);

    const saved = await documentsNamed(name);
    expect(saved.length).toBe(1);
    const placeholders = JSON.parse(JSON.stringify(saved[0].get('Placeholders')));
    expect(placeholders.length).toBe(2);
    expect(placeholders.map(p => p.Role)).toEqual(['prefill', 'Role 1']);
    // The value the sender filled in before sending survived.
    expect(placeholders[0].placeHolder[0].pos[0].options.response).toBe('42');
    expect(placeholders.some(p => p.Role === 'Role 2')).toBe(false);
  }, 60000);

  it('does not create the run twice when the caller retries the same batchId', async () => {
    const name = `bulk-idempotent-${Date.now()}`;
    const batchId = `spec${Date.now()}`;
    const documents = [documentFor(contacts[0], name), documentFor(contacts[1], name)];

    const first = await callBatchDocuments(documents, {}, { batchId });
    expect(first.created).toBe(2);
    expect(first.batchId).toBe(batchId);
    expect(batchCalls).toBe(1);

    const again = await callBatchDocuments(documents, {}, { batchId });
    expect(again.created).toBe(2);
    // Nothing new was inserted; the answer is the documents that already exist.
    expect(batchCalls).toBe(1);
    expect(again.results.map(r => r.objectId).sort()).toEqual(
      first.results.map(r => r.objectId).sort()
    );

    const saved = await documentsNamed(name);
    expect(saved.length).toBe(2);
  }, 60000);

  it('recovers the documents a failed /batch transport call had already committed', async () => {
    const name = `bulk-transport-${Date.now()}`;
    const documents = [documentFor(contacts[0], name)];
    // Commit the writes, then fail the call: exactly the socket-reset / proxy-502
    // shape that used to be reported as "the document was not created", leaving a
    // live signing link nobody was told about and inviting a duplicate retry.
    axios.post.and.callFake(async (url, body, config) => {
      if (url !== 'batch') throw new Error(`unexpected axios.post to ${url}`);
      batchCalls += 1;
      const requests = body.requests.map(r => ({
        ...r,
        path: r.path.replace(/^\/app\//, '/test/'),
      }));
      await http.post(
        `${TEST_SERVER}/batch`,
        { requests },
        {
          headers: {
            ...config.headers,
            'X-Parse-Application-Id': APP_ID,
            'X-Parse-Javascript-Key': JS_KEY,
          },
        }
      );
      throw new Error('socket hang up');
    });

    const result = await callBatchDocuments(documents);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
    const saved = await documentsNamed(name);
    expect(saved.length).toBe(1);
    expect(result.results[0].objectId).toBe(saved[0].id);
  }, 60000);

  it('rejects a caller without a session', async () => {
    let failed = false;
    try {
      await http.post(
        `${TEST_SERVER}/functions/batchdocuments`,
        { Documents: JSON.stringify([]) },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Parse-Application-Id': APP_ID,
            'X-Parse-Javascript-Key': JS_KEY,
          },
        }
      );
    } catch (err) {
      failed = true;
      expect(err.response.data.error).toContain('not authenticated');
    }
    expect(failed).toBe(true);
  }, 60000);
});
