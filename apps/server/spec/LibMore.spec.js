/**
 * The cloud/lib layer on its own: the widget factory, the document/send rules,
 * the draft mutations and their history, and the search/settings validation the
 * REST and MCP entry points sit on top of.
 */
import { ensureContact, findContactByEmail, searchPattern } from '../cloud/lib/contacts.js';
import { loadCaller } from '../cloud/lib/context.js';
import {
  assertSendable,
  assertSettingsInput,
  createDocument,
  findByIdempotencyKey,
  listDocuments,
  sendDocument,
} from '../cloud/lib/documents.js';
import {
  duplicateDocument,
  getDraft,
  getDraftVersion,
  listDraftVersions,
  pairAiRoles,
  restoreDraftVersion,
  reviewDraft,
  setDraftFields,
  snapshotDraft,
  undoDraftChange,
  updateDraft,
  updateDraftField,
} from '../cloud/lib/drafts.js';
import { setRequestMailTransport } from '../cloud/lib/requestMail.js';
import {
  countFields,
  countSignerFields,
  createWidget,
  fieldKeysIn,
  randomKey,
  sanitisePlaceholders,
  specFor,
} from '../cloud/lib/widgets.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';
process.env.PUBLIC_URL = 'https://sign.example.test';

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
}

/** Every document in this spec points at its own stored file, never a shared one. */
function fileUrl() {
  return `http://localhost:30001/files/${unique('lib')}.pdf`;
}

async function makeUser(prefix) {
  const email = `${unique(prefix)}@example.test`;
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  return await Parse.User.logIn(email, 'pa55word!');
}

async function makeCaller(prefix) {
  const user = await makeUser(prefix);
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', user.get('email'));
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  return await loadCaller(user, { publicUrl: 'https://sign.example.test' });
}

async function rawDoc(docId) {
  const obj = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
  return JSON.parse(JSON.stringify(obj));
}

async function patchDoc(docId, apply) {
  const update = new Parse.Object('contracts_Document');
  update.id = docId;
  apply(update);
  await update.save(null, { useMasterKey: true });
}

describe('cloud/lib (M2a)', () => {
  Parse.User.enableUnsafeCurrentUser();

  let caller;
  let mails;

  beforeAll(async () => {
    caller = await makeCaller('lib-owner');
    mails = [];
    setRequestMailTransport(async params => {
      mails.push(params);
      return { status: 'success' };
    });
  });

  afterAll(() => setRequestMailTransport(null));

  /* ------------------------------------------------------------- widgets */

  describe('widgets', () => {
    it('honours defaultValue and readOnly on the create path', () => {
      const w = createWidget({
        type: 'text input',
        x: 10,
        y: 20,
        defaultValue: '$1,200',
        readOnly: true,
      });
      expect(w.options.defaultValue).toBe('$1,200');
      expect(w.options.isReadOnly).toBeTrue();
    });

    it('gives a list field with no values one option named after its label', () => {
      const box = createWidget({
        type: 'checkbox',
        x: 0,
        y: 0,
        label: 'I have read the pet policy',
      });
      expect(box.options.values).toEqual(['I have read the pet policy']);
      expect(box.Height).toBe(19);
      const generic = createWidget({ type: 'checkbox', x: 0, y: 0 });
      expect(generic.options.values).toEqual(['Option-1', 'Option-2']);
    });

    it('never draws a key that is already used in the document', () => {
      const used = new Set();
      const keys = [];
      for (let i = 0; i < 200; i++) keys.push(randomKey(8, used));
      expect(new Set(keys).size).toBe(keys.length);
      const taken = fieldKeysIn([{ placeHolder: [{ pageNumber: 1, pos: [{ key: keys[0] }] }] }]);
      expect(taken.has(keys[0])).toBeTrue();
      expect(randomKey(8, taken)).not.toBe(keys[0]);
    });

    it('has a spec for a legacy widget type instead of throwing', () => {
      expect(specFor('textbox').minWidth).toBe(specFor('text input').minWidth);
      expect(specFor('something-invented').minWidth).toBeGreaterThan(0);
    });

    it('validates caller-supplied placeholders and repairs their sizes', () => {
      const groups = sanitisePlaceholders([
        {
          Role: 'Signer',
          placeHolder: [{ pageNumber: 1, pos: [{ type: 'sign', xPosition: '40', yPosition: 50 }] }],
        },
      ]);
      const widget = groups[0].placeHolder[0].pos[0];
      expect(widget.type).toBe('signature');
      expect(widget.xPosition).toBe(40);
      expect(widget.Width).toBe(150);
      expect(typeof widget.key).toBe('number');
      expect(() =>
        sanitisePlaceholders([
          {
            Role: 'S',
            placeHolder: [
              { pageNumber: 1, pos: [{ type: 'fingerprint', xPosition: 1, yPosition: 1 }] },
            ],
          },
        ])
      ).toThrowError(/unknown field type/i);
      expect(() =>
        sanitisePlaceholders([
          {
            Role: 'S',
            placeHolder: [
              { pageNumber: 1, pos: [{ type: 'signature', xPosition: 'abc', yPosition: 1 }] },
            ],
          },
        ])
      ).toThrowError(/must be numbers/i);
    });

    it('counts prefill fields in the total but not in the signers total', () => {
      const placeholders = [
        { Role: 'Signer', placeHolder: [{ pageNumber: 1, pos: [{ key: 1 }] }] },
        { Role: 'prefill', placeHolder: [{ pageNumber: 1, pos: [{ key: 2 }, { key: 3 }] }] },
      ];
      expect(countFields(placeholders)).toBe(3);
      expect(countSignerFields(placeholders)).toBe(1);
    });
  });

  /* ------------------------------------------------------------- search */

  it('escapes a search term instead of compiling it as a regular expression', async () => {
    expect(searchPattern(' (a+)+$ ')).toBe('\\(a\\+\\)\\+\\$');
    expect(searchPattern('   ')).toBe('');
    const created = await createDocument(caller, {
      name: 'Rate (a+)+$ plan',
      url: fileUrl(),
      recipients: [{ email: 'search@example.test' }],
    });
    const hits = await listDocuments(caller, { search: '(a+)+$' });
    expect(hits.some(d => d.objectId === created.objectId)).toBeTrue();
    // A wildcard is a literal too, so it matches nothing rather than everything.
    const misses = await listDocuments(caller, { search: '.*' });
    expect(misses.some(d => d.objectId === created.objectId)).toBeFalse();
  });

  /* ------------------------------------------------------------- settings */

  it('refuses strictOrder without sendInOrder rather than dropping it', () => {
    expect(() => assertSettingsInput({ strictOrder: true })).toThrowError(/sendInOrder/);
    expect(() => assertSettingsInput({ strictOrder: true, sendInOrder: true })).not.toThrow();
    expect(() => assertSettingsInput({ strictOrder: true }, { sendInOrder: true })).not.toThrow();
  });

  it('treats settings: {} as nothing to change', async () => {
    const created = await createDocument(caller, {
      name: 'No-op edit',
      url: fileUrl(),
      recipients: [{ email: 'noop@example.test' }],
    });
    await expectAsync(
      updateDraft(caller, created.objectId, { settings: {} })
    ).toBeRejectedWithError(/Nothing to change/);
    expect((await getDraft(caller, created.objectId)).versions).toBe(0);
  });

  /* ------------------------------------------------------------- sending */

  describe('the send gate', () => {
    it('refuses a document whose only fields belong to the sender', async () => {
      const created = await createDocument(caller, {
        name: 'Prefill only',
        url: fileUrl(),
        recipients: [{ email: 'prefill-only@example.test' }],
        fields: [{ recipient: 'prefill', type: 'text input', page: 1, x: 10, y: 10 }],
      });
      expect(created.fieldCount).toBe(1);
      await expectAsync(sendDocument(caller, created.objectId)).toBeRejectedWithError(
        /at least one field for a signer/
      );
    });

    it('refuses a recipient that is not linked to a contact', async () => {
      const created = await createDocument(caller, {
        name: 'Unbound',
        url: fileUrl(),
        recipients: [{ email: 'unbound@example.test' }],
      });
      const d = await rawDoc(created.objectId);
      const placeholders = d.Placeholders.map(g => ({ ...g, signerObjId: '', signerPtr: {} }));
      await patchDoc(created.objectId, u => u.set('Placeholders', placeholders));
      const fresh = await rawDoc(created.objectId);
      expect(() => assertSendable(fresh)).toThrowError(/not linked to a contact/);
    });

    it('refuses a field on a page the PDF does not have, using the cached geometry', async () => {
      const created = await createDocument(caller, {
        name: 'Off page',
        url: fileUrl(),
        recipients: [{ email: 'offpage@example.test' }],
        fields: [{ recipient: 0, type: 'signature', page: 4, x: 10, y: 10 }],
      });
      const d = await rawDoc(created.objectId);
      d.PageSizes = { url: d.URL, pages: [{ number: 1, width: 612, height: 792 }] };
      expect(() => assertSendable(d)).toThrowError(/page 4 but the PDF has 1 page/);
    });

    it('starts the expiry clock when the document is sent, not when it was drafted', async () => {
      const created = await createDocument(caller, {
        name: 'Old draft',
        url: fileUrl(),
        recipients: [{ email: 'stale@example.test' }],
      });
      const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      await patchDoc(created.objectId, u => u.set('ExpiryDate', past));
      expect((await rawDoc(created.objectId)).ExpiryDate.iso).toBe(past.toISOString());
      const sent = await sendDocument(caller, created.objectId);
      expect(sent.status).toBe('in_progress');
      expect(new Date(sent.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('mails only the signers who still owe a signature on a resend', async () => {
      const created = await createDocument(caller, {
        name: 'Resend',
        url: fileUrl(),
        recipients: [
          { email: 'first-resend@example.test' },
          { email: 'second-resend@example.test' },
        ],
      });
      const before = mails.length;
      const sent = await sendDocument(caller, created.objectId);
      expect(sent.mail.sent.length).toBe(2);
      const d = await rawDoc(created.objectId);
      const firstContact = d.Placeholders[0].signerObjId;
      await patchDoc(created.objectId, u =>
        u.set('AuditTrail', [
          {
            Activity: 'Signed',
            SignedOn: new Date(),
            UserPtr: {
              __type: 'Pointer',
              className: 'contracts_Contactbook',
              objectId: firstContact,
            },
          },
        ])
      );
      const again = await sendDocument(caller, created.objectId, { resend: true });
      expect(again.mail.sent).toEqual(['second-resend@example.test']);
      expect(mails.length).toBe(before + 3);
    });
  });

  it('puts a sent document with no expiry date in the in_progress bucket', async () => {
    const created = await createDocument(caller, {
      name: 'No expiry',
      url: fileUrl(),
      recipients: [{ email: 'noexpiry@example.test' }],
    });
    await patchDoc(created.objectId, u => {
      u.set('DocSentAt', new Date());
      u.unset('ExpiryDate');
    });
    const inProgress = await listDocuments(caller, { status: 'in_progress', limit: 200 });
    expect(inProgress.some(d => d.objectId === created.objectId)).toBeTrue();
    const drafts = await listDocuments(caller, { status: 'draft', limit: 200 });
    expect(drafts.some(d => d.objectId === created.objectId)).toBeFalse();
  });

  it('refuses a folder that belongs to somebody else', async () => {
    const stranger = await makeCaller('lib-stranger');
    const folder = new Parse.Object('contracts_Document');
    folder.set('Name', 'Their folder');
    folder.set('Type', 'Folder');
    folder.set('CreatedBy', { __type: 'Pointer', className: '_User', objectId: stranger.userId });
    const saved = await folder.save(null, { useMasterKey: true });
    await expectAsync(
      createDocument(caller, {
        name: 'Filed elsewhere',
        url: fileUrl(),
        recipients: [{ email: 'folder@example.test' }],
        folderId: saved.id,
      })
    ).toBeRejectedWithError(/not found/i);
  });

  /* ------------------------------------------------------------- drafts */

  it('re-seeds the identity fields when the person in a slot changes', async () => {
    const created = await createDocument(caller, {
      name: 'Swap the signer',
      url: fileUrl(),
      recipients: [{ name: 'Alpha One', email: 'alpha-swap@example.test', role: 'Tenant' }],
      fields: [
        { recipient: 0, type: 'name', page: 1, x: 10, y: 10 },
        { recipient: 0, type: 'email', page: 1, x: 10, y: 40 },
      ],
    });
    const before = await getDraft(caller, created.objectId);
    expect(before.recipients[0].fields.find(f => f.type === 'name').defaultValue).toBe('Alpha One');
    const after = await updateDraft(caller, created.objectId, {
      recipients: [{ name: 'Beta Two', email: 'beta-swap@example.test', role: 'Tenant' }],
    });
    expect(after.recipients[0].fields.length).toBe(2);
    expect(after.recipients[0].fields.find(f => f.type === 'name').defaultValue).toBe('Beta Two');
    expect(after.recipients[0].fields.find(f => f.type === 'email').defaultValue).toBe(
      'beta-swap@example.test'
    );
  });

  it('renders an old version with the people it had at the time', async () => {
    const created = await createDocument(caller, {
      name: 'History names',
      url: fileUrl(),
      recipients: [{ name: 'Alpha One', email: 'alpha-hist@example.test' }],
    });
    await updateDraft(caller, created.objectId, {
      recipients: [{ name: 'Beta Two', email: 'beta-hist@example.test' }],
    });
    const v1 = await getDraftVersion(caller, created.objectId, 1);
    expect(v1.state.recipients[0].email).toBe('alpha-hist@example.test');
    expect(v1.state.recipients[0].name).toBe('Alpha One');
  });

  it('undoes the last real change, not the checkpoint taken after it', async () => {
    const created = await createDocument(caller, {
      name: 'Original name',
      url: fileUrl(),
      recipients: [{ email: 'undo@example.test' }],
    });
    await updateDraft(caller, created.objectId, { name: 'Changed name' });
    const checkpoint = await snapshotDraft(caller, created.objectId, { label: 'before rollback' });
    expect(checkpoint.label).toBe('before rollback');
    const undone = await undoDraftChange(caller, created.objectId);
    expect(undone.name).toBe('Original name');
    expect(undone.restored.version).toBe(1);
  });

  it('warns when a custom message body has no {{signing_url}}', async () => {
    const created = await createDocument(caller, {
      name: 'Link lint',
      url: fileUrl(),
      recipients: [{ email: 'link-lint@example.test' }],
    });
    expect((await reviewDraft(caller, created.objectId)).warnings.map(w => w.code)).not.toContain(
      'message_without_link'
    );
    const edited = await updateDraft(caller, created.objectId, {
      message: { subject: 'Please sign', body: 'Hello {{receiver_name}}' },
    });
    expect(edited.warnings?.[0]?.code).toBe('message_without_link');
    expect(edited.warnings[0].message).toContain('{{signing_url}}');
    const review = await reviewDraft(caller, created.objectId);
    expect(review.warnings.some(w => w.code === 'message_without_link')).toBeTrue();

    // A rename says nothing about the message; fixing the body clears it.
    const renamed = await updateDraft(caller, created.objectId, { name: 'Link lint 2' });
    expect(renamed.warnings).toBeUndefined();
    const fixed = await updateDraft(caller, created.objectId, {
      message: { body: 'Hello {{receiver_name}}, sign here: {{signing_url}}' },
    });
    expect(fixed.warnings).toBeUndefined();
    expect(
      (await reviewDraft(caller, created.objectId)).warnings.some(
        w => w.code === 'message_without_link'
      )
    ).toBeFalse();
  });

  it('sends a custom body without {{signing_url}} with the link appended, and says so', async () => {
    const created = await createDocument(caller, {
      name: 'Link appended',
      url: fileUrl(),
      recipients: [{ email: 'link-appended@example.test' }],
      message: {
        subject: 'Please sign {{document_title}}',
        body: 'Hello {{receiver_name}}, please sign.',
      },
    });
    const before = mails.length;
    const sent = await sendDocument(caller, created.objectId);
    expect(sent.warnings?.some(w => /signing_url/.test(w))).toBeTrue();
    const mail = mails[before];
    expect(mail.recipient).toBe('link-appended@example.test');
    expect(mail.html).toContain('Hello');
    expect(mail.html).toContain('Review and sign');
    expect(mail.html).toContain('/login/');
  });

  it('records an edit made from the browser in the version history', async () => {
    const created = await createDocument(caller, {
      name: 'Web edited',
      url: fileUrl(),
      recipients: [{ name: 'Alpha One', email: 'web-edit@example.test' }],
    });
    expect(await listDraftVersions(caller, created.objectId)).toEqual([]);

    // The web app writes the same fields with a plain PUT under the user's session.
    const session = caller.user.getSessionToken();
    const put = async apply => {
      const update = new Parse.Object('contracts_Document');
      update.id = created.objectId;
      apply(update);
      await update.save(null, { sessionToken: session });
    };
    await put(u => {
      u.set('Name', 'Renamed in the browser');
      u.set('RequestBody', 'Hi there');
    });
    let versions = await listDraftVersions(caller, created.objectId);
    expect(versions.length).toBe(1);
    expect(versions[0].origin).toBe('web');
    expect(versions[0].reason).toBe('web: edited name, message');
    const v1 = await getDraftVersion(caller, created.objectId, 1);
    expect(v1.state.name).toBe('Web edited');
    expect(v1.state.recipients[0].name).toBe('Alpha One');
    expect(v1.state.recipients[0].email).toBe('web-edit@example.test');

    // A second autosave moments later shares the entry; its reason grows.
    await put(u => u.set('Note', 'added a note'));
    versions = await listDraftVersions(caller, created.objectId);
    expect(versions.length).toBe(1);
    expect(versions[0].reason).toBe('web: edited name, message, note');

    // Fields the history does not cover leave no entry.
    await put(u => u.set('SendMail', false));
    expect((await listDraftVersions(caller, created.objectId)).length).toBe(1);

    // An MCP edit after that gets its own entry, holding the browser's state.
    await updateDraft(caller, created.objectId, { name: 'Renamed by MCP' });
    versions = await listDraftVersions(caller, created.objectId);
    expect(versions.length).toBe(2);
    expect(versions[0].origin).toBeUndefined();
    const v2 = await getDraftVersion(caller, created.objectId, 2);
    expect(v2.state.name).toBe('Renamed in the browser');
    expect(v2.state.note).toBe('added a note');

    // Undo walks back to the browser's state; version 1 is the state before it.
    const undone = await undoDraftChange(caller, created.objectId);
    expect(undone.name).toBe('Renamed in the browser');
    const first = await restoreDraftVersion(caller, created.objectId, 1);
    expect(first.name).toBe('Web edited');
    expect(first.recipients[0].name).toBe('Alpha One');
  });

  it('edits a widget stored under a legacy type name', async () => {
    const created = await createDocument(caller, {
      name: 'Legacy widget',
      url: fileUrl(),
      recipients: [{ email: 'legacy@example.test' }],
      fields: [{ recipient: 0, type: 'text input', page: 1, x: 10, y: 10 }],
    });
    const d = await rawDoc(created.objectId);
    const placeholders = JSON.parse(JSON.stringify(d.Placeholders));
    placeholders[0].placeHolder[0].pos[0].type = 'textbox';
    const key = placeholders[0].placeHolder[0].pos[0].key;
    await patchDoc(created.objectId, u => u.set('Placeholders', placeholders));
    const edited = await updateDraftField(caller, created.objectId, key, { width: 220 });
    expect(edited.field.width).toBe(220);
  });

  it('duplicates a self-signed document whose placeholders are a flat page list', async () => {
    const created = await createDocument(caller, {
      name: 'Self signed',
      url: fileUrl(),
      recipients: [{ email: 'self@example.test' }],
      fields: [{ recipient: 0, type: 'signature', page: 1, x: 10, y: 10 }],
    });
    const d = await rawDoc(created.objectId);
    const flat = [{ pageNumber: 1, pos: d.Placeholders[0].placeHolder[0].pos }];
    await patchDoc(created.objectId, u => {
      u.set('Placeholders', flat);
      u.unset('Signers');
    });
    const copy = await duplicateDocument(caller, created.objectId, { name: 'Self signed copy' });
    expect(copy.fieldCount).toBe(1);
    expect(copy.status).toBe('draft');
  });

  it('never copies a previous signing run into a duplicate', async () => {
    const created = await createDocument(caller, {
      name: 'Signed once',
      url: fileUrl(),
      recipients: [{ name: 'Sam Signer', email: 'signed-copy@example.test' }],
      fields: [{ recipient: 0, type: 'signature', page: 1, x: 10, y: 10 }],
    });
    const d = await rawDoc(created.objectId);
    const placeholders = JSON.parse(JSON.stringify(d.Placeholders));
    placeholders[0].SignUrl = 'https://sign.example.test/files/signed.pdf';
    placeholders[0].SignedOn = new Date().toISOString();
    placeholders[0].placeHolder[0].pos[0].SignUrl = 'https://sign.example.test/files/sig.png';
    placeholders[0].placeHolder[0].pos[0].signatureType = 'draw';
    placeholders[0].placeHolder[0].pos[0].options.response = 'data:image/png;base64,AAAA';
    await patchDoc(created.objectId, u => {
      u.set('Placeholders', placeholders);
      u.set('IsCompleted', true);
      u.set('SignedUrl', 'https://sign.example.test/files/signed.pdf');
      u.set('DocSentAt', new Date());
    });
    const copy = await duplicateDocument(caller, created.objectId, { name: 'Fresh copy' });
    const copied = JSON.stringify((await rawDoc(copy.objectId)).Placeholders);
    for (const leak of ['SignUrl', 'SignedOn', 'signatureType', 'response']) {
      expect(copied).not.toContain(leak);
    }
    expect(copy.status).toBe('draft');
  });

  it('refuses to clear every field unless the caller says so', async () => {
    const created = await createDocument(caller, {
      name: 'Keep the layout',
      url: fileUrl(),
      recipients: [{ email: 'clear@example.test' }],
      fields: [{ recipient: 0, type: 'signature', page: 1, x: 10, y: 10 }],
    });
    // A `fields` that never arrived must not wipe the layout.
    await expectAsync(
      setDraftFields(caller, created.objectId, undefined, { mode: 'replace' })
    ).toBeRejectedWithError(/must be an array/);
    await expectAsync(
      setDraftFields(caller, created.objectId, { recipient: 0 }, { mode: 'replace' })
    ).toBeRejectedWithError(/must be an array/);
    expect((await getDraft(caller, created.objectId)).fieldCount).toBe(1);
    // Saying so explicitly still clears everything.
    const byFlag = await setDraftFields(caller, created.objectId, undefined, {
      mode: 'replace',
      clearAll: true,
    });
    expect(byFlag.fieldCount).toBe(0);
    const cleared = await setDraftFields(caller, created.objectId, [], { mode: 'replace' });
    expect(cleared.fieldCount).toBe(0);
  });

  it('finds a document again by the idempotency key it was created with', async () => {
    const key = unique('idem');
    const created = await createDocument(caller, {
      name: 'Replayable',
      url: fileUrl(),
      recipients: [{ email: 'idem@example.test' }],
      idempotencyKey: key,
    });
    const replay = await findByIdempotencyKey(caller, key);
    expect(replay.objectId).toBe(created.objectId);
    expect(await findByIdempotencyKey(caller, unique('other'))).toBeNull();
    expect(await findByIdempotencyKey(caller, '')).toBeNull();
  });

  it('binds AI roles by email and label before falling back to position', () => {
    const current = [
      { role: 'Tenant', email: 'tina@example.test' },
      { role: 'Landlord', email: 'larry@example.test' },
    ];
    const byLabel = pairAiRoles(
      [
        { role: 'Landlord', email: '' },
        { role: 'Tenant', email: '' },
      ],
      current
    );
    expect(byLabel.forRecipient).toEqual([1, 0]);
    const byEmail = pairAiRoles(
      [
        { role: 'Second party', email: 'larry@example.test' },
        { role: 'First party', email: 'tina@example.test' },
      ],
      current
    );
    expect(byEmail.forRecipient).toEqual([1, 0]);
    const positional = pairAiRoles(
      [
        { role: 'A', email: '' },
        { role: 'B', email: '' },
      ],
      current
    );
    expect(positional.forRecipient).toEqual([0, 1]);
    const extra = pairAiRoles(
      [{ role: 'Tenant', email: '' }],
      [current[0], { role: 'X', email: 'x@e.test' }]
    );
    expect(extra.forRecipient).toEqual([0, -1]);
    expect(extra.unmatchedAi).toEqual([]);
  });

  /* ------------------------------------------------------------- contacts */

  it('resolves a duplicated contact to the same row every time', async () => {
    const email = unique('dupe') + '@example.test';
    const ids = [];
    for (const name of ['First row', 'Second row']) {
      const contact = new Parse.Object('contracts_Contactbook');
      contact.set('Name', name);
      contact.set('Email', email);
      contact.set('IsDeleted', false);
      contact.set('CreatedBy', { __type: 'Pointer', className: '_User', objectId: caller.userId });
      const saved = await contact.save(null, { useMasterKey: true });
      ids.push(saved.id);
    }
    const found = await findContactByEmail(caller, email);
    expect(found.id).toBe(ids[0]);
    const ensured = await ensureContact(caller, { email, name: 'Third try' });
    expect(ensured.objectId).toBe(ids[0]);
    expect(ensured.created).toBeFalse();
  });
});
