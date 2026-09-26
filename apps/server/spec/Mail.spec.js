/**
 * Coverage for the mail path: the shared transport (cloud/lib/mailTransport.js),
 * `sendmailv3`'s failure reporting and its document authorisation, and the
 * in-process request mail `batchdocuments` now sends.
 *
 * Everything that would leave the process is stubbed at the transport seam, so
 * no spec here depends on SMTP, Mailgun or the loopback HTTP mail call the bulk
 * send used to make.
 */
import axios from 'axios';
import {
  resultFromMailgun,
  resultFromSmtpInfo,
  sendMail as transportSendMail,
  setMailTransport,
} from '../cloud/lib/mailTransport.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import sendSystemMail from '../cloud/parsefunction/sendSystemMail.js';
import { mintSigningToken } from '../cloud/lib/signingToken.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

const TEST_SERVER = 'http://localhost:30001/test';
const APP_ID = 'test';
const JS_KEY = 'test';
const PUBLIC_URL = 'http://localhost:3000';
const http = axios.create();

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Calls a cloud function and normalises the Parse error envelope. */
async function callFn(name, params = {}, headers = {}) {
  try {
    const res = await http.post(`${TEST_SERVER}/functions/${name}`, params, {
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Javascript-Key': JS_KEY,
        'x-real-ip': '10.0.0.9',
        public_url: PUBLIC_URL,
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

describe('mail path', () => {
  Parse.User.enableUnsafeCurrentUser();

  const password = 'Str0ng!pass';
  let owner;
  let ownerSession;
  let ownerExt;
  let contact;
  let mailbox;

  beforeAll(async () => {
    const suffix = Date.now();
    const email = `mailowner${suffix}@example.test`;
    owner = new Parse.User();
    owner.set('username', email);
    owner.set('email', email);
    owner.set('password', password);
    owner.set('name', 'Mail Owner');
    await owner.signUp();
    ownerSession = await loginToken(email, password);

    ownerExt = new Parse.Object('contracts_Users');
    ownerExt.set('UserId', pointer('_User', owner.id));
    ownerExt.set('Email', email);
    ownerExt.set('Name', 'Mail Owner');
    ownerExt.set('UserRole', 'contracts_Admin');
    await ownerExt.save(null, { useMasterKey: true });

    contact = new Parse.Object('contracts_Contactbook');
    contact.set('Name', 'Sam Signer');
    contact.set('Email', `sam${suffix}@example.test`);
    contact.set('CreatedBy', pointer('_User', owner.id));
    contact.set('UserId', pointer('_User', owner.id));
    contact.set('IsDeleted', false);
    await contact.save(null, { useMasterKey: true });
  }, 60000);

  beforeEach(() => {
    resetRateLimits();
    mailbox = [];
    setMailTransport(async params => {
      mailbox.push(params);
      return { status: 'success' };
    });
  });

  afterAll(() => {
    setMailTransport(null);
    setRequestMailTransport(null);
  });

  /** A sent document owned by `ownerExt` with `contact` as its only signer. */
  async function makeSentDoc(extra = {}) {
    const doc = new Parse.Object('contracts_Document');
    doc.set('Name', `mail-spec-${Date.now()}`);
    doc.set('Note', 'Please sign');
    doc.set('URL', `${TEST_SERVER}/files/test/mail-spec.pdf`);
    doc.set('CreatedBy', pointer('_User', owner.id));
    doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
    doc.set('Signers', [pointer('contracts_Contactbook', contact.id)]);
    doc.set('Placeholders', [
      {
        Id: 1,
        Role: 'Role 1',
        signerObjId: contact.id,
        signerPtr: { objectId: contact.id, Email: contact.get('Email') },
        email: contact.get('Email'),
        placeHolder: [],
      },
    ]);
    doc.set('SentToOthers', true);
    doc.set('DocSentAt', new Date());
    Object.entries(extra).forEach(([k, v]) => doc.set(k, v));
    return await doc.save(null, { useMasterKey: true });
  }

  /* --------------------------------------------------------------- */
  describe('transport', () => {
    it('reports an error when the smtp server rejects every recipient', () => {
      const res = resultFromSmtpInfo({ accepted: [], rejected: ['sam@example.test'] });
      expect(res.status).toBe('error');
      expect(res.reason).toContain('sam@example.test');
      // The old check was `if (!res.err)`, and nodemailer never sets `err`.
      expect(resultFromSmtpInfo({ accepted: [], rejected: [], err: undefined }).status).toBe(
        'success'
      );
    });

    it('accepts a message the smtp server took for at least one recipient', () => {
      const res = resultFromSmtpInfo({
        accepted: ['sam@example.test'],
        rejected: ['nope@example.test'],
        messageId: '<id@host>',
      });
      expect(res.status).toBe('success');
      expect(res.messageId).toBe('<id@host>');
    });

    it('reports an error when mailgun answers anything but 2xx', () => {
      const res = resultFromMailgun({ status: 500, message: 'Domain not allowed' });
      expect(res.status).toBe('error');
      expect(res.reason).toContain('Domain not allowed');
      // It used to fall off the end of the function and answer `undefined`.
      expect(resultFromMailgun(undefined).status).toBe('error');
      expect(resultFromMailgun({ status: 200, id: '<mg>' }).status).toBe('success');
    });

    it('never answers undefined, even with nothing configured', async () => {
      setMailTransport(null);
      const res = await transportSendMail({ recipient: 'sam@example.test', subject: 'x' });
      expect(res).toBeDefined();
      expect(res.status).toBe('error');
      expect(typeof res.reason).toBe('string');
    });

    it('carries cc, bcc and replyTo through sendSystemMail to the transport', async () => {
      const res = await sendSystemMail({
        params: {
          recipient: 'sam@example.test',
          cc: 'cc@example.test',
          bcc: ['bcc@example.test'],
          replyto: 'reply@example.test',
          subject: 'copies',
          html: '<p>hi</p>',
        },
      });
      expect(res.status).toBe('success');
      expect(mailbox.length).toBe(1);
      expect(mailbox[0].cc).toBe('cc@example.test');
      expect(mailbox[0].bcc).toEqual(['bcc@example.test']);
      expect(mailbox[0].replyto).toBe('reply@example.test');
    });

    it('strips a header injection out of the sender name on server originated mail', async () => {
      await sendSystemMail({
        params: {
          recipient: 'sam@example.test',
          from: 'Acme\r\nBcc: victim@example.test',
          subject: 'x',
          html: '<p>hi</p>',
        },
      });
      expect(mailbox[0].from).not.toContain('\n');
      expect(mailbox[0].from).not.toContain('\r');
    });
  });

  /* --------------------------------------------------------------- */
  describe('sendmailv3', () => {
    const body = extra => ({
      recipient: 'somebody@example.test',
      subject: 'Please sign',
      from: 'Owner',
      html: '<p>hi</p>',
      ...extra,
    });

    it('throws a Parse error when the message is not accepted', async () => {
      setMailTransport(async () => ({ status: 'error', reason: 'mailbox full' }));
      const res = await callFn('sendmailv3', body({ recipient: ownerExt.get('Email') }), {
        'X-Parse-Session-Token': ownerSession,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.SCRIPT_FAILED);
      expect(res.error).toContain('Mail could not be sent');
      expect(res.error).toContain('mailbox full');
    });

    it('refuses a sender name that would inject a mail header', async () => {
      const res = await callFn(
        'sendmailv3',
        body({ recipient: ownerExt.get('Email'), from: 'Acme\r\nBcc: victim@example.test' }),
        { 'X-Parse-Session-Token': ownerSession }
      );
      // `from` and `replyto` were the only mail params nothing validated.
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
      expect(mailbox.length).toBe(0);
    });

    it('refuses a reply-to that is not an address', async () => {
      const res = await callFn(
        'sendmailv3',
        body({ recipient: ownerExt.get('Email'), replyto: 'not an address' }),
        { 'X-Parse-Session-Token': ownerSession }
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.INVALID_QUERY);
    });

    it('ignores a caller supplied extUserId on the document branch', async () => {
      const doc = await makeSentDoc();
      const victim = new Parse.Object('contracts_Users');
      victim.set('Email', `victim${Date.now()}@example.test`);
      victim.set('Name', 'Victim Tenant');
      victim.set('UserRole', 'contracts_Admin');
      await victim.save(null, { useMasterKey: true });

      const res = await callFn(
        'sendmailv3',
        body({ docId: doc.id, recipient: contact.get('Email'), extUserId: victim.id }),
        { 'X-Parse-Session-Token': ownerSession }
      );
      expect(res.ok).toBe(true);
      // The branding tenant and the mail counter follow the document's owner,
      // not whatever ext user the client named.
      expect(mailbox[0].extUserId).toBe(ownerExt.id);
    });

    it('refuses an anonymous caller who only knows a document id', async () => {
      const doc = await makeSentDoc();
      const res = await callFn(
        'sendmailv3',
        body({ docId: doc.id, recipient: contact.get('Email') })
      );
      // It used to be enough for the recipients to be participants of the
      // document, so anyone holding a docId could mail every signer on it.
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(mailbox.length).toBe(0);
    });

    it('lets a guest with a signing link send the next-signer template only', async () => {
      const doc = await makeSentDoc();
      const signingToken = mintSigningToken({ docId: doc.id, contactId: contact.id });

      const refused = await callFn(
        'sendmailv3',
        body({ docId: doc.id, signingToken, recipient: contact.get('Email') })
      );
      expect(refused.ok).toBe(false);
      expect(mailbox.length).toBe(0);

      const sent = await callFn('sendmailv3', {
        docId: doc.id,
        signingToken,
        template: 'next_signer',
        recipient: contact.get('Email'),
      });
      expect(sent.ok).toBe(true);
      expect(sent.result.status).toBe('success');
      expect(mailbox.length).toBe(1);
      // The server rendered the mail: the guest's html never reaches a recipient.
      expect(mailbox[0].recipient).toBe(contact.get('Email'));
      expect(mailbox[0].html).not.toContain('<p>hi</p>');
      expect(mailbox[0].html).toContain('/login/');
    });

    it('refuses a guest asking for a document they hold no link to', async () => {
      const doc = await makeSentDoc();
      const other = await makeSentDoc();
      const signingToken = mintSigningToken({ docId: other.id, contactId: contact.id });
      const res = await callFn('sendmailv3', {
        docId: doc.id,
        signingToken,
        template: 'next_signer',
        recipient: contact.get('Email'),
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(mailbox.length).toBe(0);
    });
  });

  /* --------------------------------------------------------------- */
  describe('batchdocuments', () => {
    let requestMails;
    let requestMailResult;

    function documentFor(name, extra = {}) {
      return {
        Name: name,
        URL: `${TEST_SERVER}/files/test/mail-spec.pdf`,
        Note: 'Please sign',
        // Ownership is derived from the caller; these are ignored on purpose.
        CreatedBy: pointer('_User', 'someoneelse'),
        ExtUserPtr: { className: 'contracts_Users', objectId: 'someoneelse' },
        ACL: { someoneelse: { read: true, write: true } },
        SendinOrder: false,
        Signers: [{ objectId: contact.id, Name: contact.get('Name'), Email: contact.get('Email') }],
        Placeholders: [
          {
            Id: 1,
            Role: 'Role 1',
            signerObjId: contact.id,
            signerPtr: { objectId: contact.id, Email: contact.get('Email') },
            email: contact.get('Email'),
            placeHolder: [],
          },
        ],
        ...extra,
      };
    }

    async function callBatch(documents) {
      const res = await http.post(
        `${TEST_SERVER}/functions/batchdocuments`,
        { Documents: JSON.stringify(documents) },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Parse-Application-Id': APP_ID,
            'X-Parse-Javascript-Key': JS_KEY,
            'X-Parse-Session-Token': ownerSession,
            sessiontoken: ownerSession,
            public_url: PUBLIC_URL,
            'x-real-ip': '127.0.0.1',
          },
        }
      );
      return res.data.result;
    }

    beforeAll(async () => {
      // `allowClientClassCreation` is false and /batch runs with a session token.
      const seed = new Parse.Object('contracts_Document');
      seed.set('Name', 'mail spec class seed');
      await seed.save(null, { useMasterKey: true });
      await seed.destroy({ useMasterKey: true });
    }, 60000);

    beforeEach(() => {
      requestMails = [];
      requestMailResult = { status: 'success' };
      setRequestMailTransport(async params => {
        requestMails.push(params);
        return requestMailResult;
      });
      // The bulk send posts its /batch call to the hard-coded production url.
      spyOn(axios, 'post').and.callFake(async (url, payload, config) => {
        if (url !== 'batch') throw new Error(`unexpected axios.post to ${url}`);
        const requests = payload.requests.map(r => ({
          ...r,
          path: r.path.replace(/^\/app\//, '/test/'),
        }));
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
      });
    });

    afterEach(() => setRequestMailTransport(null));

    async function documentNamed(name) {
      const query = new Parse.Query('contracts_Document');
      query.equalTo('Name', name);
      return await query.first({ useMasterKey: true });
    }

    it('mails in process and takes ownership from the caller', async () => {
      const name = `mail-batch-${Date.now()}`;
      const result = await callBatch([documentFor(name)]);

      expect(result.created).toBe(1);
      expect(result.mailFailed).toEqual([]);
      // No HTTP loopback to `sendmailv3` any more: the mail is rendered here, so
      // a batch of more than 30 no longer runs into the anonymous rate limit.
      expect(requestMails.length).toBe(1);
      expect(requestMails[0].recipient).toBe(contact.get('Email'));
      expect(requestMails[0].html).toContain('/login/');

      const saved = await documentNamed(name);
      expect(saved.get('CreatedBy').id).toBe(owner.id);
      expect(saved.get('ExtUserPtr').id).toBe(ownerExt.id);
      const acl = saved.getACL();
      expect(acl.getReadAccess(owner.id)).toBe(true);
      expect(acl.getWriteAccess('someoneelse')).toBe(false);
    }, 60000);

    it('reports the recipients it could not email, and still creates the document', async () => {
      requestMailResult = { status: 'error', reason: 'mailbox full' };
      const name = `mail-batch-fail-${Date.now()}`;
      const result = await callBatch([documentFor(name)]);

      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.mailFailed.length).toBe(1);
      expect(result.mailFailed[0].email).toBe(contact.get('Email'));
      expect(result.mailFailed[0].reason).toContain('mailbox full');
      expect(result.results[0].objectId).toBeDefined();
      expect(result.results[0].mailFailed.length).toBe(1);
      expect(await documentNamed(name)).toBeDefined();
    }, 60000);

    it('persists SendinOrder as given', async () => {
      const offName = `mail-order-off-${Date.now()}`;
      const onName = `mail-order-on-${Date.now()}`;
      const result = await callBatch([
        documentFor(offName, { SendinOrder: false }),
        documentFor(onName, { SendinOrder: true }),
      ]);
      expect(result.created).toBe(2);
      // `x.SendinOrder || true` used to force every bulk document into signing order.
      expect((await documentNamed(offName)).get('SendinOrder')).toBe(false);
      expect((await documentNamed(onName)).get('SendinOrder')).toBe(true);
    }, 60000);
  });
});
