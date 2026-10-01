/**
 * Agent signatures in the audit trail JSON and on the completion certificate.
 *
 * lib/agentSign.js records `Method: 'agent'` with `Agent`, `OnBehalfOf` and
 * `AllowedBy` on the audit entry. get_audit_trail exposes them as `method`,
 * `agent`, `onBehalfOf` and `allowedBy`, and the certificate prints a
 * "Signed by" row and an "Allowed by" or "Approved by" row in that signer's
 * block. A person's entry and block must come out exactly as before.
 */
import {
  agentCertificateRows,
  agentRecord,
  certificateBlocks,
  formatDateStr,
  wrapText,
} from '../cloud/parsefunction/pdf/GenerateCertificate.js';
import GenerateCertificate from '../cloud/parsefunction/pdf/GenerateCertificate.js';
import { entryJson, getAuditTrail } from '../cloud/lib/audit.js';
import { loadCaller } from '../cloud/lib/context.js';
import { appName, serverAppId } from '../Utils.js';
import { uniqueEmail } from './support/env.js';

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

const SIGNED_AT = '2026-10-01T19:05:12.000Z';
const ENABLED_AT = '2026-10-01T14:00:00.000Z';
const APPROVED_AT = '2026-10-01T19:04:00.000Z';

/** An audit entry as lib/agentSign.js writes it, read back from the database. */
function agentEntry(contactId, allowed = {}) {
  return {
    UserPtr: pointer('contracts_Contactbook', contactId),
    Activity: 'Signed',
    SignedOn: { __type: 'Date', iso: SIGNED_AT },
    ipAddress: '52.230.152.7',
    Method: 'agent',
    Agent: { kind: 'oauth', clientId: 'client_123', name: 'ChatGPT', host: 'chatgpt.com' },
    OnBehalfOf: { name: 'Gboyega Ofi', email: 'Gboyega.Ofi@Example.test', userId: 'user_1' },
    AllowedBy: {
      via: 'own_document',
      name: 'Gboyega Ofi',
      email: 'gboyega.ofi@example.test',
      at: { __type: 'Date', iso: SIGNED_AT },
      signingEnabledAt: { __type: 'Date', iso: ENABLED_AT },
      ...allowed,
    },
  };
}

const personEntry = {
  UserPtr: pointer('contracts_Contactbook', 'c2'),
  Activity: 'Signed',
  SignedOn: { __type: 'Date', iso: '2026-10-01T20:30:00.000Z' },
  ViewedOn: '2026-10-01T20:10:00.000Z',
  ipAddress: '73.14.2.9',
};

function sampleDoc(extra = {}) {
  return {
    objectId: 'docAgent1',
    Name: 'Residential Lease Agreement',
    ExtUserPtr: { objectId: 'ext1', Name: 'Gboyega Ofi', Email: 'gboyega.ofi@example.test' },
    SenderName: 'Gboyega Ofi',
    SenderMail: 'gboyega.ofi@example.test',
    OriginIp: '52.230.152.7',
    DateFormat: 'MMM DD, YYYY',
    Timezone: 'UTC',
    completedAt: '2026-10-01T20:30:00.000Z',
    DocSentAt: '2026-10-01T19:00:00.000Z',
    Signers: [
      { objectId: 'c1', Name: 'Gboyega Ofi', Email: 'gboyega.ofi@example.test' },
      { objectId: 'c2', Name: 'Jordan Tenant', Email: 'jordan.tenant@example.test' },
    ],
    Placeholders: [
      { signerObjId: 'c1', Role: 'Landlord' },
      { signerObjId: 'c2', Role: 'Tenant' },
    ],
    AuditTrail: [agentEntry('c1'), personEntry],
    ...extra,
  };
}

const opts = { DateFormat: 'MMM DD, YYYY', timezone: 'UTC', Is12Hr: true };

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * Every text run on every page, with its baseline position and size in PDF
 * points. pdf.js joins a label and its value on the same line into one run
 * ("Signed by : AI agent ..."), so lookups match with `includes`.
 */
async function textItems(bytes) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      // eslint-disable-next-line no-await-in-loop -- pages in order, one at a time
      const page = await doc.getPage(n);
      // eslint-disable-next-line no-await-in-loop -- same page
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter(item => typeof item.str === 'string' && item.str.trim())
          .map(item => ({
            str: item.str,
            x: item.transform[4],
            y: item.transform[5],
            w: item.width,
            h: item.height || Math.abs(item.transform[3]),
          }))
      );
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/** Pairs of text runs whose boxes intersect on the same page. */
function overlaps(items) {
  const box = i => ({
    left: i.x,
    right: i.x + i.w,
    bottom: i.y - 0.15 * i.h,
    top: i.y + 0.7 * i.h,
  });
  const found = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const p = box(items[a]);
      const q = box(items[b]);
      const across = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const down = Math.min(p.top, q.top) - Math.max(p.bottom, q.bottom);
      if (across > 0.5 && down > 0.5) found.push([items[a].str, items[b].str]);
    }
  }
  return found;
}

describe('agent signatures on the certificate', () => {
  describe('certificate blocks', () => {
    it('carries the agent record on the agent block only, without ids', () => {
      const blocks = certificateBlocks(sampleDoc());
      const agent = blocks.find(b => b.Email === 'gboyega.ofi@example.test');
      const person = blocks.find(b => b.Email === 'jordan.tenant@example.test');

      expect(agent.Method).toBe('agent');
      expect(agent.Agent).toEqual({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' });
      expect(agent.OnBehalfOf).toEqual({ name: 'Gboyega Ofi', email: 'gboyega.ofi@example.test' });
      expect(agent.AllowedBy).toEqual({
        via: 'own_document',
        name: 'Gboyega Ofi',
        email: 'gboyega.ofi@example.test',
        at: SIGNED_AT,
        signingEnabledAt: ENABLED_AT,
      });

      for (const key of ['Method', 'Agent', 'OnBehalfOf', 'AllowedBy']) {
        expect(Object.prototype.hasOwnProperty.call(person, key)).toBe(false);
      }
    });

    it('reads AllowedBy dates as a JS Date, the Parse encoding or a string, and keeps a null', () => {
      const record = agentRecord(
        agentEntry('c1', {
          at: new Date(APPROVED_AT),
          signingEnabledAt: null,
          approvalId: 'ap_7',
          via: 'chat',
        })
      );
      expect(record.AllowedBy.at).toBe(APPROVED_AT);
      expect(record.AllowedBy.signingEnabledAt).toBeNull();
      expect(record.AllowedBy.approvalId).toBe('ap_7');
      expect(agentRecord(agentEntry('c1', { at: APPROVED_AT })).AllowedBy.at).toBe(APPROVED_AT);
      expect(agentRecord(personEntry)).toBeNull();
    });
  });

  describe('certificate rows', () => {
    const blockWith = allowed =>
      certificateBlocks(sampleDoc({ AuditTrail: [agentEntry('c1', allowed)] }))[0];

    it('says which app signed for whom and that the owner allowed it', () => {
      expect(agentCertificateRows(blockWith({}), opts)).toEqual([
        { label: 'Signed by', value: 'AI agent ChatGPT (chatgpt.com) for Gboyega Ofi' },
        {
          label: 'Allowed by',
          value: 'Gboyega Ofi, own document (agent signing on since Oct 01, 2026)',
        },
      ]);
    });

    it('drops the "since" note when the switch date is unknown', () => {
      const rows = agentCertificateRows(blockWith({ signingEnabledAt: null }), opts);
      expect(rows[1]).toEqual({ label: 'Allowed by', value: 'Gboyega Ofi, own document' });
    });

    it('names where an approval was given, with its date and time', () => {
      const at = formatDateStr(APPROVED_AT, opts.DateFormat, opts.timezone, opts.Is12Hr);
      expect(at).toContain('Oct 01, 2026');
      const web = agentCertificateRows(
        blockWith({ via: 'web', at: { __type: 'Date', iso: APPROVED_AT }, approvalId: 'ap_1' }),
        opts
      );
      expect(web[1]).toEqual({ label: 'Approved by', value: `Gboyega Ofi in ${appName}, ${at}` });
      const chat = agentCertificateRows(blockWith({ via: 'chat', at: APPROVED_AT }), opts);
      expect(chat[1]).toEqual({ label: 'Approved by', value: `Gboyega Ofi in ChatGPT, ${at}` });
    });

    it('adds nothing for a person', () => {
      const person = certificateBlocks(sampleDoc()).find(
        b => b.Email === 'jordan.tenant@example.test'
      );
      expect(agentCertificateRows(person, opts)).toEqual([]);
    });

    it('wraps long text inside the column and marks a cut', () => {
      const font = { widthOfTextAtSize: (s, size) => s.length * size * 0.5 };
      const lines = wrapText('word '.repeat(80), font, 10, 100, 2);
      expect(lines.length).toBe(2);
      expect(lines.every(l => font.widthOfTextAtSize(l, 10) <= 100)).toBe(true);
      expect(lines[1].endsWith('...')).toBe(true);
      // A single word wider than the column is cut by character, not left to overflow.
      const long = wrapText('x'.repeat(50), font, 10, 100, 3);
      expect(long.every(l => font.widthOfTextAtSize(l, 10) <= 100)).toBe(true);
      expect(wrapText('short', font, 10, 100)).toEqual(['short']);
    });
  });

  describe('audit trail JSON', () => {
    const d = sampleDoc();

    it('reports an agent signature with who allowed it', () => {
      const out = entryJson(agentEntry('c1', { approvalId: 'ap_1', via: 'web' }), d);
      expect(out.method).toBe('agent');
      expect(out.who.email).toBe('gboyega.ofi@example.test');
      expect(out.agent).toEqual({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' });
      expect(out.onBehalfOf).toEqual({ name: 'Gboyega Ofi', email: 'gboyega.ofi@example.test' });
      expect(out.allowedBy).toEqual({
        via: 'web',
        name: 'Gboyega Ofi',
        email: 'gboyega.ofi@example.test',
        at: SIGNED_AT,
        signingEnabledAt: ENABLED_AT,
        approvalId: 'ap_1',
      });
      // Neither the OAuth client id nor the user id leaves the server.
      expect(JSON.stringify(out)).not.toContain('client_123');
      expect(JSON.stringify(out)).not.toContain('user_1');
    });

    it('reports a person signature with no agent keys', () => {
      const out = entryJson(personEntry, d);
      expect(out.method).toBe('person');
      expect(out.activity).toBe('Signed');
      expect(out.ip).toBe('73.14.2.9');
      for (const key of ['agent', 'onBehalfOf', 'allowedBy']) {
        expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(false);
      }
    });
  });

  describe('rendered certificate', () => {
    it('prints the agent rows in the agent block only, with nothing overlapping', async () => {
      const bytes = await GenerateCertificate(sampleDoc({ IsEnableOTP: true }));
      const pages = await textItems(bytes);
      const all = pages.flat();
      const find = text => all.filter(i => i.str.includes(text));

      expect(find('Signed by :').length).toBe(1);
      expect(find('Allowed by :').length).toBe(1);
      expect(find('Approved by :').length).toBe(0);
      expect(find('AI agent ChatGPT (chatgpt.com) for Gboyega Ofi').length).toBe(1);
      expect(find('Gboyega Ofi, own document (agent signing on since Oct 01, 2026)').length).toBe(
        1
      );
      // The agent did not type the emailed code; the person did.
      expect(find('Email, OAuth').length).toBe(1);
      expect(find('Email, OTP Auth').length).toBe(1);

      // Agent block: the rows sit between the IP address and the signature.
      const ips = find('IP address :').sort((a, b) => b.y - a.y);
      const signatures = find('Signature :').sort((a, b) => b.y - a.y);
      // The originator's IP row comes first, then one per signer block.
      expect(ips.length).toBe(3);
      expect(signatures.length).toBe(2);
      const [, agentIp, personIp] = ips;
      const [agentSig, personSig] = signatures;
      expect(find('Signed by :')[0].y).toBeCloseTo(agentIp.y - 20, 1);
      expect(find('Allowed by :')[0].y).toBeCloseTo(agentIp.y - 40, 1);
      expect(agentSig.y).toBeCloseTo(agentIp.y - 60, 1);
      // Person block: the signature follows the IP address directly, as before.
      expect(personSig.y).toBeCloseTo(personIp.y - 20, 1);
      // The next block starts below the agent's signature box (its bottom is 30pt under the label).
      const tenantHeader = find('2. Tenant')[0];
      expect(tenantHeader.y).toBeLessThan(agentSig.y - 30);

      for (const items of pages) {
        expect(overlaps(items)).toEqual([]);
        // Everything stays inside the column (30pt margins on an A4 page).
        for (const item of items) expect(item.x + item.w).toBeLessThanOrEqual(595.28 - 15);
      }
    });

    it('wraps a long agent name inside the column and moves to a new page cleanly', async () => {
      const signers = Array.from({ length: 6 }, (_, i) => ({
        objectId: `s${i}`,
        Name: `Alexandria Catherine Montgomery-Wellington ${i}`,
        Email: `alexandria.${i}@example.test`,
      }));
      const doc = sampleDoc({
        Signers: signers,
        Placeholders: signers.map((s, i) => ({ signerObjId: s.objectId, Role: `Party ${i + 1}` })),
        AuditTrail: signers.map((s, i) => ({
          ...agentEntry(s.objectId, { via: i % 2 ? 'chat' : 'own_document', name: s.Name }),
          SignedOn: { __type: 'Date', iso: `2026-10-01T19:0${i}:00.000Z` },
          OnBehalfOf: { name: s.Name, email: s.Email },
          Agent: {
            kind: 'oauth',
            name: 'Acme Contract Assistant Enterprise Edition for Legal and Procurement Teams',
            host: 'assistant.acme-enterprise-legal-procurement.example.com',
          },
        })),
      });
      const pages = await textItems(await GenerateCertificate(doc));
      expect(pages.length).toBeGreaterThan(1);
      for (const items of pages) {
        expect(overlaps(items)).toEqual([]);
        for (const item of items) {
          expect(item.x + item.w).toBeLessThanOrEqual(595.28 - 30 + 0.5);
          // Nothing drawn under the page border.
          expect(item.y).toBeGreaterThan(15);
        }
      }
      // The person an agent signed for is never cut off the row.
      const text = pages
        .flat()
        .map(i => i.str)
        .join(' ');
      for (const s of signers)
        expect(text).toContain(`for ${s.Name.split(' ').slice(0, 2).join(' ')}`);
      expect(pages.flat().filter(i => i.str.includes('Signed by :')).length).toBe(6);
    });
  });

  describe('get_audit_trail on a stored document', () => {
    Parse.User.enableUnsafeCurrentUser();

    let owner;
    let ownerExt;
    let agentContact;
    let personContact;

    beforeAll(async () => {
      const email = uniqueEmail('owner.certagent');
      owner = new Parse.User();
      owner.set('username', email);
      owner.set('email', email);
      owner.set('password', 'Str0ng!pass');
      owner.set('name', 'Gboyega Ofi');
      await owner.signUp();

      const ext = new Parse.Object('contracts_Users');
      ext.set('UserId', pointer('_User', owner.id));
      ext.set('Email', email);
      ext.set('Name', 'Gboyega Ofi');
      ext.set('UserRole', 'contracts_User');
      ownerExt = await ext.save(null, { useMasterKey: true });

      const contact = (name, mail) => {
        const row = new Parse.Object('contracts_Contactbook');
        row.set('Name', name);
        row.set('Email', mail);
        row.set('CreatedBy', pointer('_User', owner.id));
        row.set('IsDeleted', false);
        return row.save(null, { useMasterKey: true });
      };
      agentContact = await contact('Gboyega Ofi', email);
      personContact = await contact('Jordan Tenant', uniqueEmail('tenant.certagent'));
    }, 60000);

    it('returns the agent keys on the agent entry and certificate signer only', async () => {
      const doc = new Parse.Object('contracts_Document');
      doc.set('Name', 'Agent certificate spec');
      const file = `http://localhost:30001/test/files/${serverAppId}/agent-cert.pdf`;
      doc.set('URL', file);
      doc.set('SignedUrl', file);
      doc.set('CreatedBy', pointer('_User', owner.id));
      doc.set('ExtUserPtr', pointer('contracts_Users', ownerExt.id));
      doc.set('Signers', [
        pointer('contracts_Contactbook', agentContact.id),
        pointer('contracts_Contactbook', personContact.id),
      ]);
      doc.set('Placeholders', [
        { Id: 1, Role: 'Landlord', signerObjId: agentContact.id, placeHolder: [] },
        { Id: 2, Role: 'Tenant', signerObjId: personContact.id, placeHolder: [] },
      ]);
      doc.set('DocSentAt', new Date('2026-10-01T19:00:00.000Z'));
      doc.set('IsCompleted', true);
      // Written the way lib/agentSign.js writes it: JS Dates, nested.
      doc.set('AuditTrail', [
        {
          UserPtr: pointer('contracts_Contactbook', agentContact.id),
          Activity: 'Signed',
          SignedOn: new Date(SIGNED_AT),
          ipAddress: '52.230.152.7',
          Method: 'agent',
          Agent: { kind: 'oauth', clientId: 'client_123', name: 'ChatGPT', host: 'chatgpt.com' },
          OnBehalfOf: { name: 'Gboyega Ofi', email: owner.get('email'), userId: owner.id },
          AllowedBy: {
            via: 'own_document',
            name: 'Gboyega Ofi',
            email: owner.get('email'),
            at: new Date(SIGNED_AT),
            signingEnabledAt: new Date(ENABLED_AT),
          },
        },
        {
          UserPtr: pointer('contracts_Contactbook', personContact.id),
          Activity: 'Signed',
          SignedOn: new Date('2026-10-01T20:30:00.000Z'),
          ipAddress: '73.14.2.9',
        },
      ]);
      const acl = new Parse.ACL();
      acl.setReadAccess(owner.id, true);
      acl.setWriteAccess(owner.id, true);
      doc.setACL(acl);
      await doc.save(null, { useMasterKey: true });

      const trail = await getAuditTrail(await loadCaller(owner), doc.id);
      const agentRow = trail.entries.find(e => e.who.contactId === agentContact.id);
      const personRow = trail.entries.find(e => e.who.contactId === personContact.id);
      expect(agentRow.method).toBe('agent');
      expect(agentRow.agent).toEqual({ kind: 'oauth', name: 'ChatGPT', host: 'chatgpt.com' });
      expect(agentRow.allowedBy.via).toBe('own_document');
      expect(agentRow.allowedBy.at).toBe(SIGNED_AT);
      expect(agentRow.allowedBy.signingEnabledAt).toBe(ENABLED_AT);
      expect(personRow.method).toBe('person');
      expect(personRow.agent).toBeUndefined();
      expect(personRow.allowedBy).toBeUndefined();

      const [first, second] = trail.certificate.signers;
      expect(first.role).toBe('Landlord');
      expect(first.method).toBe('agent');
      expect(first.onBehalfOf.name).toBe('Gboyega Ofi');
      expect(first.allowedBy.signingEnabledAt).toBe(ENABLED_AT);
      expect(second.method).toBe('person');
      expect(Object.keys(second)).not.toContain('agent');
      expect(JSON.stringify(trail)).not.toContain('client_123');
    }, 60000);
  });
});
