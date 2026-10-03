/**
 * What the AI review adds for the account's rules (cloud/ai/review.js): the
 * model's `facts`, made cautious by `shapeFacts`; the deterministic `scanTerms`,
 * which a document cannot talk down; and the 15-minute cache that lets
 * review_document and sign_document share one AI call.
 */
import axios from 'axios';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setAiClientForTests } from '../cloud/ai/client.js';
import {
  resetReviewCache,
  reviewDocument,
  scanTerms,
  shapeFacts,
} from '../cloud/ai/review.js';
import { loadCaller } from '../cloud/lib/context.js';
import { createDocument } from '../cloud/lib/documents.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';

const BASE = 'http://localhost:30001';

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`.toLowerCase();
}

async function makeCaller(prefix, name) {
  const email = `${unique(prefix)}@example.test`;
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', `${name} Co`);
  tenant.set('UserId', user.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', name);
  extUser.set('Email', email);
  extUser.set('UserId', user.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  return await loadCaller(user, { publicUrl: 'https://sign.example.test' });
}

/** One page per array of lines. */
async function pdfWith(...pages) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    lines.forEach((text, i) => page.drawText(text, { x: 72, y: 720 - i * 24, size: 11, font }));
  }
  return new Uint8Array(await pdf.save());
}

async function patchDoc(docId, apply) {
  const update = new Parse.Object('contracts_Document');
  update.id = docId;
  apply(update);
  await update.save(null, { useMasterKey: true });
}

/** The model's answer for a mutual NDA that claims to have no money in it. */
function ndaAnswer(facts = {}) {
  return {
    summary: 'A mutual NDA between two companies.',
    overall: 'standard',
    parties: [{ name: 'Acme Corp', role: 'Discloser' }],
    keyTerms: [],
    flags: [],
    instructionsAimedAtAI: false,
    facts: {
      documentType: 'nda',
      moneyInvolved: false,
      valueKnown: true,
      totalValueUsd: 0,
      currency: null,
      paymentObligation: false,
      autoRenewal: false,
      personalGuarantee: false,
      nonCompete: false,
      ...facts,
    },
  };
}

const fake = {
  calls: 0,
  answer: null,
  delayMs: 0,
  messages: {
    create: async () => {
      fake.calls += 1;
      if (fake.delayMs) await new Promise(resolve => setTimeout(resolve, fake.delayMs));
      return {
        model: 'fake-claude',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'tu_1', name: 'report_contract_review', input: fake.answer }],
      };
    },
  },
};

describe('AI review facts and term scan', () => {
  describe('scanTerms', () => {
    it('finds amounts in every common format, with their currency and page', () => {
      const scan = scanTerms(
        [
          '--- page 1 ---',
          'Fees: US$1,000 now, USD 2,500.50 later, and 1,000 USD on renewal.',
          '--- page 2 ---',
          'A retainer of $25k, a cap of $2.5M and a bonus of $1.2 million.',
          'Twenty-five thousand dollars (25,000 dollars) is due. Sign here: $ ____',
          '--- page 3 ---',
          'Canadian office: CA$750 or 900 Canadian dollars. Europe: EUR 3,000 and 450 €. UK: £500.',
        ].join('\n')
      );
      const pick = currency => scan.amounts.filter(a => a.currency === currency).map(a => [a.amount, a.page]);
      expect(pick('USD')).toEqual([
        [1000, 1],
        [2500.5, 1],
        [1000, 1],
        [25000, 2],
        [2500000, 2],
        [1200000, 2],
        [25000, 2],
      ]);
      expect(pick('CAD')).toEqual([
        [750, 3],
        [900, 3],
      ]);
      expect(pick('EUR')).toEqual([
        [3000, 3],
        [450, 3],
      ]);
      expect(pick('GBP')).toEqual([[500, 3]]);
      expect(scan.maxUsd).toBe(2500000);
      expect(scan.maxUsdPage).toBe(2);
      expect(scan.otherCurrencies).toEqual(['CAD', 'EUR', 'GBP']);
      // "USD $" is one amount, and the blank "$ ____" none.
      expect(scan.amounts.some(a => a.text === '$ ____')).toBeFalse();
      expect(scan.amounts.find(a => a.amount === 2500.5).text).toBe('USD 2,500.50');
    });

    it('reports the printed amount even when the document says there is no money', () => {
      const scan = scanTerms(
        '--- page 1 ---\nThis contract has no fees and costs nothing.\n--- page 2 ---\nTotal due on signing: $48,000.'
      );
      expect(scan.maxUsd).toBe(48000);
      expect(scan.maxUsdPage).toBe(2);
      expect(scan.amounts).toEqual([{ text: '$48,000', amount: 48000, currency: 'USD', page: 2 }]);
      expect(scan.hits.paymentTerms.length).toBe(1);
      expect(scan.hits.paymentTerms[0]).toContain('no fees');
    });

    it('finds the always-ask wording and leaves look-alike boilerplate out', () => {
      const hits = text => scanTerms(`--- page 1 ---\n${text}`).hits;
      expect(hits('This Agreement renews automatically each year.').autoRenewal.length).toBe(1);
      expect(hits('The term is evergreen.').autoRenewal.length).toBe(1);
      expect(hits('An auto-renewal applies.').autoRenewal.length).toBe(1);
      expect(hits('Owner gives a personal guaranty of the lease.').personalGuarantee.length).toBe(1);
      expect(hits('The Guarantor signs below.').personalGuarantee.length).toBe(1);
      expect(hits('A non-solicitation clause applies.').nonCompete.length).toBe(1);
      expect(hits('Employee shall not compete with the Company.').nonCompete.length).toBe(1);
      expect(hits('An exclusivity period of 90 days.').nonCompete.length).toBe(1);
      expect(hits('Buyer will purchase exclusively from Seller.').nonCompete.length).toBe(1);
      expect(hits('Invoices are due Net 30.').paymentTerms.length).toBe(1);
      expect(hits('The Client agrees to pay the deposit.').paymentTerms.length).toBe(1);

      // Common clauses that only look like the risky ones.
      const nda = hits(
        'The courts of Delaware have exclusive jurisdiction. The prevailing party recovers reasonable attorneys’ fees and legal fees.'
      );
      expect(nda.nonCompete).toEqual([]);
      expect(nda.paymentTerms).toEqual([]);
      expect(nda.autoRenewal).toEqual([]);
      expect(nda.personalGuarantee).toEqual([]);
    });

    it('quotes each passage once, at most five per topic', () => {
      const text = Array.from({ length: 12 }, (_, i) => `Clause ${i}: a long stretch of ordinary words here. Late fee ${i} applies.`).join(' ');
      const { hits } = scanTerms(`--- page 1 ---\n${text}`);
      expect(hits.paymentTerms.length).toBe(5);
      expect(new Set(hits.paymentTerms).size).toBe(5);
      expect(hits.paymentTerms.every(s => s.length <= 160)).toBeTrue();
    });

    it('keeps at most 20 amounts, always including the largest dollar figure', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Item ${i}: EUR ${1000 + i}`);
      lines.splice(15, 0, 'Grand total $9,999,999');
      const scan = scanTerms(`--- page 1 ---\n${lines.join('\n')}`);
      expect(scan.amounts.length).toBe(20);
      expect(scan.amounts.some(a => a.amount === 9999999 && a.currency === 'USD')).toBeTrue();
      expect(scan.maxUsd).toBe(9999999);
    });

    it('works on text without page markers', () => {
      const scan = scanTerms('Pay $100 now.');
      expect(scan.maxUsd).toBe(100);
      expect(scan.maxUsdPage).toBeNull();
    });
  });

  describe('shapeFacts', () => {
    const cautious = {
      documentType: 'other',
      moneyInvolved: true,
      valueKnown: false,
      totalValueUsd: null,
      currency: null,
      paymentObligation: true,
      autoRenewal: true,
      personalGuarantee: true,
      nonCompete: true,
    };

    it('reads missing or malformed facts as the cautious answer', () => {
      expect(shapeFacts(undefined)).toEqual(cautious);
      expect(shapeFacts('nda')).toEqual(cautious);
      expect(shapeFacts([1, 2])).toEqual(cautious);
      expect(shapeFacts({ documentType: 'treaty', autoRenewal: 'no' })).toEqual(cautious);
    });

    it('keeps a clear answer and normalises its spelling', () => {
      expect(
        shapeFacts({
          documentType: 'Order Form',
          moneyInvolved: true,
          valueKnown: true,
          totalValueUsd: '$48,000',
          currency: '$',
          paymentObligation: false,
          autoRenewal: false,
          personalGuarantee: false,
          nonCompete: false,
        })
      ).toEqual({
        documentType: 'order_form',
        moneyInvolved: true,
        valueKnown: true,
        totalValueUsd: 48000,
        currency: 'USD',
        paymentObligation: false,
        autoRenewal: false,
        personalGuarantee: false,
        nonCompete: false,
      });
      expect(shapeFacts({ documentType: 'lease', currency: 'eur' }).currency).toBe('EUR');
      expect(shapeFacts({ currency: 'dollars' }).currency).toBeNull();
    });

    it('never claims a total it cannot back', () => {
      // "Known" with no usable number is not known.
      for (const totalValueUsd of [null, -5, 'lots', Number.NaN, 1e20]) {
        const f = shapeFacts({ moneyInvolved: true, valueKnown: true, totalValueUsd });
        expect(f.valueKnown).withContext(String(totalValueUsd)).toBeFalse();
        expect(f.totalValueUsd).withContext(String(totalValueUsd)).toBeNull();
      }
      // "No money" with a total is money.
      const said = shapeFacts({ moneyInvolved: false, valueKnown: true, totalValueUsd: 5000 });
      expect(said.moneyInvolved).toBeTrue();
      expect(said.totalValueUsd).toBe(5000);
    });

    it('lets the printed amounts overrule "no money"', () => {
      const claim = ndaAnswer().facts;
      expect(shapeFacts(claim, scanTerms('--- page 1 ---\nNo cost to either party.'))).toEqual({
        ...claim,
        moneyInvolved: false,
        valueKnown: true,
        totalValueUsd: 0,
      });
      const printed = shapeFacts(claim, scanTerms('--- page 1 ---\nThis contract has no fees. Fee: $48,000.'));
      expect(printed.moneyInvolved).toBeTrue();
      expect(printed.valueKnown).toBeFalse();
      expect(printed.totalValueUsd).toBeNull();
      const euros = shapeFacts(claim, scanTerms('--- page 1 ---\nPenalty EUR 1,000.'));
      expect(euros.moneyInvolved).toBeTrue();
      expect(euros.valueKnown).toBeFalse();
    });
  });

  describe('reviewDocument', () => {
    Parse.User.enableUnsafeCurrentUser();

    const NDA_URL = `${BASE}/files/test/${unique('facts-nda')}.pdf`;
    const SIGNED_URL = `${BASE}/files/test/${unique('facts-signed')}.pdf`;
    let owner;
    let participant;
    let files;

    async function sentDoc(url) {
      const doc = await createDocument(owner, {
        name: 'Mutual NDA',
        url,
        recipients: [{ name: 'Pat Participant', email: participant.email, role: 'Recipient' }],
      });
      await patchDoc(doc.objectId, u => u.set('DocSentAt', new Date()));
      return doc.objectId;
    }

    beforeAll(async () => {
      owner = await makeCaller('rf-owner', 'Olive Owner');
      participant = await makeCaller('rf-part', 'Pat Participant');
      files = new Map([
        [
          NDA_URL,
          await pdfWith(
            ['Mutual Non-Disclosure Agreement', 'This contract has no fees.'],
            ['Liquidated damages for any breach: $48,000.']
          ),
        ],
        [SIGNED_URL, await pdfWith(['Mutual Non-Disclosure Agreement', 'Signed copy.'])],
      ]);
      spyOn(axios, 'get').and.callFake(async url => {
        const bytes = files.get(String(url).split('?')[0]);
        if (!bytes) throw new Error(`unexpected axios.get ${url}`);
        return { data: bytes.buffer.slice(0), status: 200 };
      });
      setAiClientForTests(fake);
    });

    beforeEach(() => {
      resetRateLimits();
      resetReviewCache();
      fake.calls = 0;
      fake.delayMs = 0;
      fake.answer = ndaAnswer();
    });

    afterAll(() => setAiClientForTests(null));

    it("does not take the document's word for its money", async () => {
      const docId = await sentDoc(NDA_URL);
      const review = await reviewDocument(participant, docId);
      expect(review.facts.documentType).toBe('nda');
      expect(review.facts.moneyInvolved).toBeTrue();
      expect(review.facts.valueKnown).toBeFalse();
      expect(review.facts.totalValueUsd).toBeNull();
      expect(review.scan.maxUsd).toBe(48000);
      expect(review.scan.maxUsdPage).toBe(2);
      expect(review.scan.hits.paymentTerms.some(s => s.includes('Liquidated damages'))).toBeTrue();
      expect(review.partial).toBeFalse();
    });

    it('answers a second review of the same file from the cache, without an AI call', async () => {
      const docId = await sentDoc(NDA_URL);
      const first = await reviewDocument(participant, docId);
      expect(first.cached).toBeFalse();
      expect(fake.calls).toBe(1);

      first.summary = 'changed by the caller';
      fake.answer = ndaAnswer({ documentType: 'lease' });
      const second = await reviewDocument(participant, docId);
      expect(fake.calls).toBe(1);
      expect(second.cached).toBeTrue();
      expect(second.summary).toBe('A mutual NDA between two companies.');
      expect(second.facts.documentType).toBe('nda');
      expect(second.reviewedAt).toBe(first.reviewedAt);

      // Cached answers cost no AI budget: well past the 10-a-minute limit.
      for (let i = 0; i < 12; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose
        expect((await reviewDocument(participant, docId)).cached).toBeTrue();
      }
      expect(fake.calls).toBe(1);
    });

    it('reviews again for another person, a new signed copy, or after a reset', async () => {
      const docId = await sentDoc(NDA_URL);
      await reviewDocument(participant, docId);
      await reviewDocument(owner, docId);
      expect(fake.calls).toBe(2);

      // A co-signer signed: the signed copy is a new file.
      await patchDoc(docId, u => u.set('SignedUrl', SIGNED_URL));
      const fresh = await reviewDocument(participant, docId);
      expect(fresh.cached).toBeFalse();
      expect(fake.calls).toBe(3);

      resetReviewCache();
      await reviewDocument(participant, docId);
      expect(fake.calls).toBe(4);
    });

    it('runs one AI call for reviews that arrive together', async () => {
      const docId = await sentDoc(NDA_URL);
      fake.delayMs = 150;
      const [a, b, c] = await Promise.all([
        reviewDocument(participant, docId),
        reviewDocument(participant, docId),
        reviewDocument(participant, docId),
      ]);
      expect(fake.calls).toBe(1);
      expect([a.cached, b.cached, c.cached].filter(Boolean).length).toBe(2);
      expect(b.facts).toEqual(a.facts);
    });

    it('does not cache a failure', async () => {
      const docId = await sentDoc(NDA_URL);
      fake.answer = { flags: [] };
      await expectAsync(reviewDocument(participant, docId)).toBeRejectedWithError(/malformed/);
      fake.answer = ndaAnswer();
      const review = await reviewDocument(participant, docId);
      expect(review.cached).toBeFalse();
      expect(fake.calls).toBe(2);
    });
  });
});
