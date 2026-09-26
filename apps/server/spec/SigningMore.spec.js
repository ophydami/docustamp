/**
 * The medium/low signing, certificate, file and template fixes that have no
 * home in the existing specs.
 *
 * Everything here is either a pure helper or a cloud function that needs no
 * PDF signing, so this file does not need the port 8080 loopback proxy
 * `SignPdf.spec.js` stands up.
 */
import {
  certificateBlocks,
  formatDateStr,
  toDate,
} from '../cloud/parsefunction/pdf/GenerateCertificate.js';
import { assertLocalFileUrl } from '../cloud/parsefunction/fileUpload.js';
import { extractKeyFromUrl } from '../cloud/parsefunction/getSignedUrl.js';
import { reminderSkipReason } from '../cloud/jobs/autoReminders.js';
import { reminderCooldownRemaining } from '../cloud/parsefunction/sendReminder.js';
import { safeHeaderLine } from '../cloud/parsefunction/sendSystemMail.js';
import { serverAppId } from '../Utils.js';

process.env.MASTER_KEY = process.env.MASTER_KEY || 'test';

function pointer(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

describe('signing, certificate and file fixes', () => {
  Parse.User.enableUnsafeCurrentUser();

  /* ----------------------------------------------------------------- */
  describe('certificate blocks', () => {
    const owner = { objectId: 'ext1', Name: 'Owner O', Email: 'owner@example.test' };
    const doc = {
      ExtUserPtr: owner,
      Signers: [
        { objectId: 'c1', Name: 'Ada', Email: 'ada@example.test' },
        { objectId: 'c2', Name: 'Grace', Email: 'grace@example.test' },
      ],
      Placeholders: [
        { signerObjId: 'c1', Role: 'Approver' },
        { signerObjId: 'c2', Role: 'Role 2' },
      ],
      AuditTrail: [
        // Grace only opened the link; `triggerEvent` writes this.
        { UserPtr: pointer('contracts_Contactbook', 'c2'), Activity: 'Viewed', SignedOn: 'x' },
        {
          UserPtr: pointer('contracts_Contactbook', 'c1'),
          Activity: 'Signed',
          SignedOn: '2026-02-01T10:00:00.000Z',
          ipAddress: '1.2.3.4',
        },
        // An owner self-sign entry: a contracts_Users pointer, never in Signers.
        { UserPtr: pointer('contracts_Users', 'ext1'), Activity: 'Signed', ipAddress: '5.6.7.8' },
      ],
      // Ada opened her link three times; the owner's opens were never counted.
      OpenStats: {
        c1: { count: 3, firstAt: '2026-02-01T09:00:00.000Z', lastAt: '2026-02-01T10:00:00.000Z' },
      },
    };

    it('leaves out participants who only viewed the document', () => {
      const emails = certificateBlocks(doc).map(block => block.Email);
      expect(emails).not.toContain('grace@example.test');
      expect(emails).toContain('ada@example.test');
    });

    it('names the owner on an entry that points at contracts_Users', () => {
      const ownerBlock = certificateBlocks(doc).find(block => block.ipAddress === '5.6.7.8');
      expect(ownerBlock.Name).toBe('Owner O');
      expect(ownerBlock.Email).toBe('owner@example.test');
      // No SignedOn on that entry, so the field stays blank rather than being
      // stamped with the certificate's own generation time.
      expect(ownerBlock.SignedOn).toBe('');
    });

    it('labels each block with the placeholder role', () => {
      const ada = certificateBlocks(doc).find(block => block.Email === 'ada@example.test');
      expect(ada.role).toBe('Approver');
    });

    it('carries how often each signer opened the link, zero when never counted', () => {
      const blocks = certificateBlocks(doc);
      expect(blocks.find(block => block.Email === 'ada@example.test').OpenCount).toBe(3);
      expect(blocks.find(block => block.ipAddress === '5.6.7.8').OpenCount).toBe(0);
      expect(certificateBlocks({ ...doc, OpenStats: { c1: { count: 'junk' } } })[0].OpenCount).toBe(
        0
      );
    });

    it('does not throw for a document with no audit trail and no signers', () => {
      const blocks = certificateBlocks({ ExtUserPtr: owner, Signers: [] });
      expect(blocks.length).toBe(1);
      expect(blocks[0].Email).toBe('owner@example.test');
      expect(blocks[0].ipAddress).toBe('');
    });
  });

  /* ----------------------------------------------------------------- */
  describe('certificate dates', () => {
    const iso = '2026-08-22T06:09:40.859Z';

    it('reads a Date, an ISO string and the Parse date encoding alike', () => {
      expect(toDate(new Date(iso)).toISOString()).toBe(iso);
      expect(toDate(iso).toISOString()).toBe(iso);
      expect(toDate({ __type: 'Date', iso }).toISOString()).toBe(iso);
      expect(toDate('')).toBeNull();
      expect(toDate(null)).toBeNull();
      expect(toDate('not a date')).toBeNull();
      expect(toDate({ __type: 'Date' })).toBeNull();
    });

    it('prints a stored SignedOn as a date, never as [object Object]', () => {
      const printed = formatDateStr({ __type: 'Date', iso }, 'MM/DD/YYYY', 'UTC', false);
      expect(printed).toContain('08/22/2026');
      expect(printed).toContain('06:09:40');
      expect(printed).not.toContain('[object');
      expect(formatDateStr(undefined, 'MM/DD/YYYY', 'UTC', false)).toBe('');
      expect(formatDateStr('garbage', 'MM/DD/YYYY', 'UTC', false)).toBe('');
    });

    it('normalises the trail timestamps on every block, whatever shape they were stored in', () => {
      const owner = { objectId: 'ext1', Name: 'Owner', Email: 'owner@example.test' };
      const signers = [
        { objectId: 'c1', Name: 'First', Email: 'first@example.test' },
        { objectId: 'c2', Name: 'Last', Email: 'last@example.test' },
      ];
      const doc = {
        ExtUserPtr: owner,
        Signers: signers,
        AuditTrail: [
          // Read back from the database: Parse encoding.
          {
            UserPtr: { className: 'contracts_Contactbook', objectId: 'c1' },
            Activity: 'Signed',
            SignedOn: { __type: 'Date', iso },
            ViewedOn: '2026-08-22T06:09:00.000Z',
          },
          // Still in memory on the completing request: a JS Date.
          {
            UserPtr: { className: 'contracts_Contactbook', objectId: 'c2' },
            Activity: 'Signed',
            SignedOn: new Date('2026-08-22T06:10:56.347Z'),
          },
        ],
      };
      const blocks = certificateBlocks(doc);
      expect(blocks.map(b => b.SignedOn)).toEqual([iso, '2026-08-22T06:10:56.347Z']);
      expect(blocks[0].ViewedOn).toBe('2026-08-22T06:09:00.000Z');
      expect(blocks[1].ViewedOn).toBe('');
    });
  });

  describe('local file urls', () => {
    const own = `http://localhost:30001/files/${serverAppId}/report.pdf`;

    it('refuses a foreign host that copies our path shape', () => {
      // The validator checked the protocol, the path shape, the app id and the
      // file name, but never the host, so this url used to be signed.
      expect(() =>
        assertLocalFileUrl(`https://evil.example.com/files/${serverAppId}/report.pdf`)
      ).toThrowMatching(err => err.code === Parse.Error.INVALID_QUERY);
    });

    it('accepts a file on this server', () => {
      expect(assertLocalFileUrl(own)).toBe(own);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('object storage keys', () => {
    const bucket = process.env.DO_SPACE;
    afterEach(() => {
      if (bucket === undefined) delete process.env.DO_SPACE;
      else process.env.DO_SPACE = bucket;
    });

    it('keeps a key prefix instead of only the file name', () => {
      process.env.DO_SPACE = 'mybucket';
      expect(
        extractKeyFromUrl('https://mybucket.blr1.digitaloceanspaces.com/tenant7/signed/deal.pdf')
      ).toBe('tenant7/signed/deal.pdf');
    });

    it('strips the bucket segment in the path style spelling and decodes the key', () => {
      process.env.DO_SPACE = 'mybucket';
      expect(extractKeyFromUrl('https://blr1.digitaloceanspaces.com/mybucket/my%20deal.pdf')).toBe(
        'my deal.pdf'
      );
    });
  });

  /* ----------------------------------------------------------------- */
  describe('reminder scheduling helpers', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const due = {
      AutomaticReminders: true,
      SignedUrl: 'https://files.example.test/a.pdf',
      NextReminderDate: '2026-02-28T12:00:00.000Z',
      ExpiryDate: '2026-04-01T12:00:00.000Z',
      RemindOnceInEvery: 3,
    };

    it('treats a freshly due document as due', () => {
      expect(reminderSkipReason(due, now)).toBe('');
    });

    it('skips a document that was completed after the sweep selected it', () => {
      expect(reminderSkipReason({ ...due, IsCompleted: true }, now)).toBe('completed');
      expect(reminderSkipReason({ ...due, ExpiryDate: '2026-02-01T00:00:00.000Z' }, now)).toBe(
        'expired'
      );
    });

    it('skips a document reminded inside its own RemindOnceInEvery window', () => {
      // LastReminderAt was written but never read, so a NextReminderDate left in
      // the past mailed everyone again on every tick.
      expect(reminderSkipReason({ ...due, LastReminderAt: '2026-02-28T13:00:00.000Z' }, now)).toBe(
        'reminded_recently'
      );
    });

    it('reports the wait left before a document may be reminded again', () => {
      expect(reminderCooldownRemaining({}, now)).toBe(0);
      const remaining = reminderCooldownRemaining(
        { LastReminderAt: '2026-03-01T11:59:00.000Z' },
        now
      );
      expect(remaining).toBeGreaterThan(0);
    });
  });

  /* ----------------------------------------------------------------- */
  describe('mail header safety', () => {
    it('collapses a CRLF injection attempt into one line', () => {
      const value = safeHeaderLine('Acme\r\nBcc: victim@example.test');
      expect(value).not.toContain('\n');
      expect(value).not.toContain('\r');
    });

    it('removes the angle brackets that would open a second address group', () => {
      expect(safeHeaderLine('Acme <evil@example.test>')).not.toContain('<');
    });
  });
});
