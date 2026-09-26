/**
 * Coverage for the de-duplication wave: the things that used to exist two, three
 * or four times and have now collapsed to one, plus the storage-accounting cloud
 * function that replaced the browser's direct writes.
 *
 * What is asserted here is that the *one* implementation is actually the one on
 * every path, which is what a copy-paste fix silently loses again:
 *
 *   - the request mail and the reminder come out of `cloud/lib/requestMail.js`,
 *     so a tenant template with newlines renders as `<br/>` in both;
 *   - the reminder falls back to the sender's own stored templates the same way
 *     the request mail does;
 *   - one email shape: what `Utils.emailRegex` accepts is what the mail layer
 *     accepts (no commas, no semicolons);
 *   - one file-url signer for local files and one for bucket objects;
 *   - `savesignature` upserts one row and never clears an omitted key;
 *   - `recordfileusage` requires a session, refuses a foreign url and counts the
 *     bytes once.
 */
import axios from 'axios';
import { appName, emailRegex, senderLineHtml } from '../Utils.js';
import { bodyCarriesUrl, mailTemplate } from '../cloud/lib/mailShell.js';
import { EMAIL_RE, isValidEmail, normaliseEmail } from '../cloud/lib/email.js';
import {
  buildRequestMail,
  buildSigningUrl,
  customRequestBody,
  hasSigningLinkMarker,
  resolveAppOrigin,
  senderDisplayName,
} from '../cloud/lib/requestMail.js';
import {
  reminderMailTemplate,
  setReminderMailTransport,
} from '../cloud/parsefunction/sendReminder.js';
import { signLocalUrl, signStoredUrl } from '../cloud/lib/fileUrls.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

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
        'x-real-ip': '10.0.0.31',
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

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
}

describe('de-duplicated mail, file urls, signatures and usage', () => {
  Parse.User.enableUnsafeCurrentUser();

  const password = 'Str0ng!pass';
  let user;
  let session;
  let extUser;
  let tenant;

  beforeAll(async () => {
    const email = `${unique('dedupe')}@example.test`;
    user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('password', password);
    user.set('name', 'Dedupe Owner');
    await user.signUp();
    session = await loginToken(email, password);

    tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Dedupe Ltd');
    tenant.set('UserId', pointer('_User', user.id));
    await tenant.save(null, { useMasterKey: true });

    extUser = new Parse.Object('contracts_Users');
    extUser.set('UserId', pointer('_User', user.id));
    extUser.set('Email', email);
    extUser.set('Name', 'Dedupe Owner');
    extUser.set('UserRole', 'contracts_Admin');
    extUser.set('TenantId', pointer('partners_Tenant', tenant.id));
    await extUser.save(null, { useMasterKey: true });
  }, 60000);

  beforeEach(() => {
    resetRateLimits();
  });

  afterAll(() => {
    setReminderMailTransport(null);
  });

  /* ------------------------------------------------------- one mail builder */

  /** A document whose tenant supplies a two-paragraph RequestBody. */
  function docWithTemplate(extra = {}) {
    return {
      objectId: 'doc-dedupe',
      Name: 'Lease agreement',
      Note: 'Sign before Friday',
      ExpiryDate: { iso: new Date('2026-09-01T00:00:00Z').toISOString() },
      ExtUserPtr: {
        objectId: 'ext1',
        Name: 'Dana Owner',
        Email: 'dana@example.test',
        Company: 'Dedupe Ltd',
        TenantId: {
          objectId: 'tenant1',
          RequestSubject: 'Please sign {{document_title}}',
          RequestBody: 'Hello {{receiver_name}},\nplease sign.\nThanks,\n{{sender_name}}',
        },
      },
      ...extra,
    };
  }

  const recipient = { name: 'Sam Signer', email: 'sam@example.test', phone: '' };

  it('renders the tenant template with line breaks on the request path', () => {
    const mail = buildRequestMail(docWithTemplate(), recipient, 'https://sign.test/login/abc');
    expect(mail.subject).toBe('Please sign Lease agreement');
    expect(mail.html).toContain('<br/>');
    expect(mail.html).toContain('Hello Sam Signer,');
    expect(mail.recipient).toBe('sam@example.test');
  });

  it('goes out under the sender company by default, never the bare address', () => {
    const mail = buildRequestMail(docWithTemplate(), recipient, 'https://sign.test/login/abc');
    expect(mail.from).toBe('Dedupe Ltd');
    expect(mail.replyto).toBe('dana@example.test');
  });

  it('uses the sender name when they asked for it or when there is no company, then the app name', () => {
    const named = docWithTemplate();
    named.ExtUserPtr.UseNameAsSender = true;
    expect(buildRequestMail(named, recipient, 'https://sign.test/x').from).toBe('Dana Owner');

    const snapshot = docWithTemplate({ SenderName: 'Dana from Dedupe' });
    expect(buildRequestMail(snapshot, recipient, 'https://sign.test/x').from).toBe(
      'Dana from Dedupe'
    );

    const noCompany = docWithTemplate();
    noCompany.ExtUserPtr.Company = '';
    expect(buildRequestMail(noCompany, recipient, 'https://sign.test/x').from).toBe('Dana Owner');

    expect(senderDisplayName({ senderName: 'x@y.test', company: ' ' })).toBe('x@y.test');
    expect(senderDisplayName({})).toBe(appName);
  });

  it('renders the same template, with the same line breaks, on the reminder path', () => {
    // The reminder used to be built by a second copy that did not convert
    // newlines, so the identical body arrived as one unbroken paragraph.
    const mail = buildRequestMail(docWithTemplate(), recipient, 'https://sign.test/login/abc', {
      fallback: reminderMailTemplate,
      subjectPrefix: 'Reminder:',
    });
    expect(mail.html).toContain('<br/>');
    expect(mail.subject).toBe('Reminder: Please sign Lease agreement');
  });

  it('does not double the reminder prefix on a subject that already says it', () => {
    const doc = docWithTemplate();
    doc.RequestSubject = 'Reminder about {{document_title}}';
    doc.RequestBody = 'Please sign.';
    const mail = buildRequestMail(doc, recipient, 'https://sign.test/login/abc', {
      fallback: reminderMailTemplate,
      subjectPrefix: 'Reminder:',
    });
    expect(mail.subject).toBe('Reminder about Lease agreement');
  });

  it('falls back to the sender own contracts_Users templates on both paths', () => {
    // A member with no tenant-admin rights keeps their templates on their own
    // `contracts_Users` row, and both mail paths have to read them.
    const doc = docWithTemplate();
    doc.ExtUserPtr.TenantId = { objectId: 'tenant1' };
    doc.ExtUserPtr.RequestSubject = 'From {{sender_name}}: {{document_title}}';
    doc.ExtUserPtr.RequestBody = 'Personal template.';
    const request = buildRequestMail(doc, recipient, 'https://sign.test/login/abc');
    const reminder = buildRequestMail(doc, recipient, 'https://sign.test/login/abc', {
      fallback: reminderMailTemplate,
      subjectPrefix: 'Reminder:',
    });
    expect(request.subject).toBe('From Dana Owner: Lease agreement');
    expect(request.html).toContain('Personal template.');
    expect(reminder.subject).toBe('Reminder: From Dana Owner: Lease agreement');
  });

  it('appends the signing link to a custom body that never placed {{signing_url}}', () => {
    // The tenant body in docWithTemplate() has no marker, which is exactly how
    // the web app's default body used to be stored: the mail went out as text
    // with nothing to click.
    const doc = docWithTemplate();
    expect(hasSigningLinkMarker(customRequestBody(doc))).toBeFalse();
    const url = 'https://sign.test/login/abc?x=1&y=2';
    const mail = buildRequestMail(doc, recipient, url);
    expect(mail.html).toContain('Review and sign');
    expect(mail.html).toContain('href="https://sign.test/login/abc?x=1&amp;y=2"');
    // Inside the document, not after it.
    expect(mail.html.indexOf('Review and sign')).toBeLessThan(mail.html.indexOf('</body>'));
    expect(mail.html).toContain('Hello Sam Signer,');

    // Same on the reminder path: a reminder without its link is just as useless.
    const reminder = buildRequestMail(doc, recipient, url, {
      fallback: reminderMailTemplate,
      subjectPrefix: 'Reminder:',
    });
    expect(reminder.html).toContain('href="https://sign.test/login/abc?x=1&amp;y=2"');
  });

  it('leaves a body that places the link itself alone', () => {
    const doc = docWithTemplate();
    doc.RequestSubject = 'Sign {{document_title}}';
    doc.RequestBody = 'Open {{signing_url}} to sign.';
    expect(hasSigningLinkMarker(doc.RequestBody)).toBeTrue();
    expect(hasSigningLinkMarker('Open {{ SIGNING_URL }} to sign.')).toBeTrue();
    const mail = buildRequestMail(doc, recipient, 'https://sign.test/login/abc');
    expect(mail.html).not.toContain('Review and sign');
    expect(mail.html.split('https://sign.test/login/abc').length - 1).toBe(1);

    // The built-in template carries its own button, once.
    const plain = docWithTemplate();
    plain.ExtUserPtr.TenantId = { objectId: 'tenant1' };
    const builtIn = buildRequestMail(plain, recipient, 'https://sign.test/login/abc');
    expect(builtIn.html.split('Review and sign').length - 1).toBe(1);
    expect(builtIn.html).toContain('Signature request');
  });

  it('bodyCarriesUrl sees the url raw or as the merge escapes it', () => {
    expect(bodyCarriesUrl('<p>Hi</p>', 'https://s.test/a?b=1&c=2')).toBeFalse();
    expect(
      bodyCarriesUrl('<p><a href="https://s.test/a?b=1&amp;c=2">go</a></p>', 'https://s.test/a?b=1&c=2')
    ).toBeTrue();
    expect(bodyCarriesUrl('<p>Hi</p>', '')).toBeTrue();
  });

  it('never prints the sender address in the closing line, only the name with a mailto', () => {
    const mail = buildRequestMail(docWithTemplate(), recipient, 'https://sign.test/login/abc');
    expect(mail.html).toContain("href='mailto:dana@example.test'");
    expect(mail.html).toContain('Contact');
    expect(mail.html).not.toMatch(/>dana@example\.test</);
    expect(mail.html).not.toContain('contact the sender dana@example.test');
  });

  it('renders the note and the sender name in the built-in reminder template', () => {
    // Both were passed in and rendered nowhere.
    const rendered = reminderMailTemplate({
      title: 'Lease agreement',
      senderName: 'Dana Owner',
      senderMail: 'dana@example.test',
      organization: 'Dedupe Ltd',
      localExpireDate: '1 September 2026',
      signingUrl: 'https://sign.test/login/abc',
      note: 'Sign before Friday',
    });
    expect(rendered.body).toContain('Dana Owner');
    expect(rendered.body).toContain('Sign before Friday');
  });

  it('leads the Sender row with the name, then the organisation, never the bare address', () => {
    const base = { senderMail: 'dana@example.test', organization: 'Dedupe Ltd' };
    expect(senderLineHtml({ ...base, senderName: 'Dana Owner' })).toBe(
      "<a href='mailto:dana@example.test' style='color:#626363'>Dana Owner</a>"
    );
    expect(senderLineHtml(base)).toContain('>Dedupe Ltd</a>');
    expect(senderLineHtml({ senderMail: 'dana@example.test' })).toContain('>dana@example.test</a>');
    expect(senderLineHtml({ senderName: 'No Mail' })).toBe('No Mail');
    expect(senderLineHtml({ senderName: '<b>x</b>', senderMail: 'a@b.test' })).not.toContain('<b>');

    const params = {
      title: 'Lease agreement',
      senderName: 'Dana Owner',
      senderMail: 'dana@example.test',
      organization: 'Dedupe Ltd',
      localExpireDate: '1 September 2026',
      signingUrl: 'https://sign.test/login/abc',
      note: 'Sign before Friday',
    };
    for (const rendered of [mailTemplate(params), reminderMailTemplate(params)]) {
      const row = rendered.body.match(/Sender<\/th><td[^>]*>(.*?)<\/td>/)[1];
      expect(row).toContain('>Dana Owner</a>');
      expect(row).toContain("href='mailto:dana@example.test'");
      expect(row).not.toMatch(/>dana@example\.test</);
    }
  });

  it('escapes owner-supplied text in the reminder template', () => {
    const rendered = reminderMailTemplate({
      title: 'Lease',
      senderName: '<script>x</script>',
      senderMail: 'dana@example.test',
      organization: '',
      localExpireDate: '',
      signingUrl: 'https://sign.test/login/abc',
      note: '<img onerror=1>',
    });
    expect(rendered.body).not.toContain('<script>');
    expect(rendered.body).not.toContain('<img onerror');
  });

  it('builds one signing url shape, from one origin resolver', () => {
    const origin = resolveAppOrigin('https://sign.example.test/app');
    expect(origin).toBe('https://sign.example.test');
    const withContact = buildSigningUrl(origin, 'doc1', 'a@b.test', 'c1', 'tok');
    const withoutContact = buildSigningUrl(origin, 'doc1', 'a@b.test', '');
    const decoded = Buffer.from(withContact.split('/login/')[1], 'base64').toString('utf8');
    expect(decoded).toBe('doc1/a@b.test/c1/tok');
    expect(Buffer.from(withoutContact.split('/login/')[1], 'base64').toString('utf8')).toBe(
      'doc1/a@b.test'
    );
  });

  /* --------------------------------------------------------- one email shape */

  it('uses one email pattern everywhere, and it rejects header separators', () => {
    expect(emailRegex).toBe(EMAIL_RE);
    expect(isValidEmail('sam@example.test')).toBe(true);
    expect(isValidEmail(' Sam@Example.test ')).toBe(true);
    // A comma or a semicolon starts a second address in a mail header.
    expect(isValidEmail('sam@example.test,evil@example.test')).toBe(false);
    expect(isValidEmail('sam@example.test;evil@example.test')).toBe(false);
    expect(emailRegex.test('sam@example.test,evil@example.test')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('normalises an address one way', () => {
    expect(normaliseEmail('  SAM@Example.TEST ')).toBe('sam@example.test');
    expect(normaliseEmail('sa m@example.test')).toBe('sam@example.test');
    expect(normaliseEmail(undefined)).toBe('');
  });

  it('refuses a recipient the permissive regex would have accepted before', async () => {
    // A comma is a legitimate separator in `to`/`cc` and is split first; a
    // semicolon is not, so it reaches the address check as one string. The
    // permissive pattern this file used to share with the contact API accepted
    // it, and it starts a second address in the header.
    const res = await callFn(
      'sendmailv3',
      { recipient: 'sam@example.test;evil@example.test', subject: 'hi', html: 'x' },
      { 'X-Parse-Session-Token': session }
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('Invalid recipient address');
  });

  /* ------------------------------------------------------ one file-url signer */

  it('signs a local file url through the single signer', async () => {
    const bare = `${TEST_SERVER}/files/test/dedupe.pdf`;
    const signed = signLocalUrl(bare, 60);
    expect(signed.startsWith(`${bare}?token=`)).toBe(true);
    // A caller-supplied token is dropped before re-signing, never appended.
    const resigned = signLocalUrl(`${bare}?token=stale`, 60);
    expect(resigned.split('?token=')[0]).toBe(bare);
    expect(resigned.split('?').length).toBe(2);
    // signStoredUrl routes a local url to exactly the same signer.
    const viaStored = await signStoredUrl(bare, 60);
    expect(viaStored.split('?token=')[0]).toBe(bare);
  });

  it('leaves a url that is not ours unsigned', async () => {
    const foreign = 'https://files.elsewhere.test/some/object.pdf';
    expect(await signStoredUrl(foreign)).toBe(foreign);
  });

  /* ------------------------------------------------------- savesignature */

  it('savesignature upserts one row and keeps the keys the caller omitted', async () => {
    const saved = await callFn(
      'savesignature',
      {
        userId: user.id,
        signature: 'data:image/png;base64,AAAA',
        initials: 'data:image/png;base64,BBBB',
        stamp: 'data:image/png;base64,CCCC',
      },
      { 'X-Parse-Session-Token': session }
    );
    expect(saved.ok).toBe(true);
    const rowId = saved.result?.objectId;
    expect(rowId).toBeDefined();

    // Only the signature is sent, so initials and stamp survive: the settings
    // screen saves one image at a time.
    const partial = await callFn(
      'savesignature',
      { userId: user.id, signature: 'data:image/png;base64,DDDD' },
      { 'X-Parse-Session-Token': session }
    );
    expect(partial.ok).toBe(true);
    expect(partial.result?.objectId).toBe(rowId);
    const row = await new Parse.Query('contracts_Signature').get(rowId, { useMasterKey: true });
    expect(row.get('ImageURL')).toBe('data:image/png;base64,DDDD');
    expect(row.get('Initials')).toBe('data:image/png;base64,BBBB');
    expect(row.get('Stamp')).toBe('data:image/png;base64,CCCC');
  });

  it('savesignature refuses a signature that is not the callers', async () => {
    const res = await callFn(
      'savesignature',
      { userId: 'someoneelse', signature: 'x' },
      { 'X-Parse-Session-Token': session }
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('Cannot save signature');
  });

  /* ------------------------------------------------------- recordfileusage */

  it('recordfileusage requires a session', async () => {
    const res = await callFn('recordfileusage', {
      url: `${TEST_SERVER}/files/test/usage.pdf`,
      size: 1024,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(209);
  });

  it('recordfileusage refuses a url this server did not store', async () => {
    const res = await callFn(
      'recordfileusage',
      { url: 'https://files.elsewhere.test/x.pdf', size: 1024 },
      { 'X-Parse-Session-Token': session }
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('stored on this server');
  });

  it('recordfileusage refuses a size that is not a positive number', async () => {
    for (const size of [0, -5, 'lots']) {
      const res = await callFn(
        'recordfileusage',
        { url: `${TEST_SERVER}/files/test/usage.pdf`, size },
        { 'X-Parse-Session-Token': session }
      );
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('positive number of bytes');
    }
  });

  it('recordfileusage records the file and increments the tenant counter atomically', async () => {
    const url = `${TEST_SERVER}/files/test/${unique('usage')}.pdf`;
    const first = await callFn(
      'recordfileusage',
      { url: `${url}?token=whatever`, size: 2048 },
      { 'X-Parse-Session-Token': session }
    );
    expect(first.ok).toBe(true);
    expect(first.result).toEqual(jasmine.objectContaining({ ok: true, bytes: 2048 }));

    const rows = await new Parse.Query('partners_DataFiles')
      .equalTo('FileUrl', url)
      .find({ useMasterKey: true });
    expect(rows.length).toBe(1);
    // The query string is dropped: the durable url is what is recorded.
    expect(rows[0].get('FileUrl')).toBe(url);
    expect(rows[0].get('FileSize')).toBe(2048);
    expect(rows[0].get('TenantPtr')?.id).toBe(tenant.id);
    expect(rows[0].get('UserId')?.id).toBe(user.id);
    // Row-level ACL, which the class never had.
    expect(rows[0].getACL()?.getPublicReadAccess()).toBe(false);

    const before = await tenantUsedStorage();
    await callFn(
      'recordfileusage',
      { url: `${TEST_SERVER}/files/test/${unique('usage')}.pdf`, size: 1000 },
      { 'X-Parse-Session-Token': session }
    );
    expect(await tenantUsedStorage()).toBe(before + 1000);
  });

  async function tenantUsedStorage() {
    const row = await new Parse.Query('partners_TenantCredits')
      .equalTo('PartnersTenant', pointer('partners_Tenant', tenant.id))
      .first({ useMasterKey: true });
    return Number(row?.get('usedStorage') || 0);
  }
});
