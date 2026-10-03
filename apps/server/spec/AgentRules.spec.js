/**
 * The account's rules for its AI apps (cloud/lib/agentRules.js): the decision
 * an agent signature on someone else's document goes through, the domains an
 * agent may send to, saving and reading them from the web app, and their
 * removal with the account.
 */
import { loadCaller } from '../cloud/lib/context.js';
import {
  assertRecipientsAllowed,
  checkSignRules,
  defaultRules,
  describeRules,
  domainMatches,
  evaluateSignRules,
  getAgentRules,
  normaliseDomain,
  normaliseRules,
  publicRuleCheck,
  setAgentRules,
} from '../cloud/lib/agentRules.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { deleteUser } from '../cloud/routes/deleteAccount/deleteUser.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';

/** Rules with auto-sign on, over the defaults. */
function rulesWith(autoSign = {}, rest = {}) {
  const base = defaultRules();
  return {
    ...base,
    ...rest,
    autoSign: { ...base.autoSign, enabled: true, ...autoSign },
    alwaysAsk: { ...base.alwaysAsk, ...(rest.alwaysAsk || {}) },
  };
}

/** A clean review of a standard NDA: nothing in it stops a signature. */
function review(over = {}) {
  const base = {
    summary: 'A mutual NDA.',
    overall: 'standard',
    parties: [],
    keyTerms: [],
    flags: [],
    instructionsAimedAtAI: false,
    partial: false,
    facts: {
      documentType: 'nda',
      moneyInvolved: false,
      valueKnown: false,
      totalValueUsd: null,
      currency: null,
      paymentObligation: false,
      autoRenewal: false,
      personalGuarantee: false,
      nonCompete: false,
    },
    scan: {
      maxUsd: null,
      maxUsdPage: null,
      amounts: [],
      otherCurrencies: [],
      hits: { autoRenewal: [], personalGuarantee: [], nonCompete: [], paymentTerms: [] },
    },
  };
  return {
    ...base,
    ...over,
    facts: { ...base.facts, ...(over.facts || {}) },
    scan: {
      ...base.scan,
      ...(over.scan || {}),
      hits: { ...base.scan.hits, ...(over.scan?.hits || {}) },
    },
  };
}

const MATCH = { status: 'match', expected: 'Morgan Avery', printed: [] };

function codes(check) {
  return check.reasons.map(r => r.code);
}

describe('Agent rules: the signing decision', () => {
  it('does nothing while the rules are off', () => {
    const check = evaluateSignRules({ rules: defaultRules(), review: review(), nameCheck: MATCH });
    expect(check.enabled).toBe(false);
    expect(check.allowed).toBe(false);
    expect(check.reasons).toEqual([]);
  });

  it('allows a clean NDA with no money', () => {
    const check = evaluateSignRules({
      rules: rulesWith(),
      review: review(),
      nameCheck: MATCH,
      senderEmail: 'legal@vendor.com',
    });
    expect(check.allowed).toBe(true, JSON.stringify(check.reasons));
    expect(check.reasons).toEqual([]);
    expect(check.summary).toBe('NDA, no money involved');
    expect(check.matched).toEqual({
      documentType: 'nda',
      valueUsd: null,
      limitUsd: 0,
      senderDomain: 'vendor.com',
    });
  });

  it('allows money within the limit and says so', () => {
    const check = evaluateSignRules({
      rules: rulesWith({ documentTypes: ['order_form'], maxValueUsd: 25000 }, { alwaysAsk: { paymentTerms: false } }),
      review: review({
        facts: { documentType: 'order_form', moneyInvolved: true, valueKnown: true, totalValueUsd: 12000, currency: 'USD' },
        scan: { maxUsd: 12000, maxUsdPage: 1 },
      }),
      nameCheck: MATCH,
    });
    expect(check.allowed).toBe(true, JSON.stringify(check.reasons));
    expect(check.summary).toBe('Order form, $12,000, within your $25,000 limit');
  });

  it('needs the person when the review could not run', () => {
    const check = evaluateSignRules({ rules: rulesWith(), review: null, nameCheck: MATCH });
    expect(codes(check)).toEqual(['review_unavailable']);
    expect(check.reasons[0].text).toBe('The AI review could not run, so this needs you.');
    expect(check.summary).toBe('Needs you: The AI review could not run, so this needs you.');
  });

  it('refuses a document type the rules do not name', () => {
    const lease = evaluateSignRules({
      rules: rulesWith({ documentTypes: ['nda', 'order_form'] }),
      review: review({ facts: { documentType: 'lease' } }),
      nameCheck: MATCH,
    });
    expect(codes(lease)).toEqual(['doc_type']);
    expect(lease.reasons[0].text).toBe("It's a lease, and your rules only cover: NDA and order form.");

    const msa = evaluateSignRules({
      rules: rulesWith(),
      review: review({ facts: { documentType: 'msa' } }),
      nameCheck: MATCH,
    });
    expect(msa.reasons[0].text).toBe("It's an MSA, and your rules only cover: NDA.");

    for (const type of ['other', 'made_up', undefined]) {
      const check = evaluateSignRules({
        rules: rulesWith(),
        review: review({ facts: { documentType: type } }),
        nameCheck: MATCH,
      });
      expect(codes(check)).toEqual(['doc_type']);
      expect(check.reasons[0].text).toBe("It isn't one of the document types your rules cover (NDA).");
      expect(check.matched.documentType).toBe('other');
    }
  });

  it('takes the larger of the review and the scan, with the page when the scan found it', () => {
    const scanLarger = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({
        facts: { moneyInvolved: true, valueKnown: true, totalValueUsd: 10000, currency: 'USD' },
        scan: { maxUsd: 48000, maxUsdPage: 3 },
      }),
      nameCheck: MATCH,
    });
    expect(codes(scanLarger)).toEqual(['over_limit']);
    expect(scanLarger.reasons[0].text).toBe("It's over your $25,000 limit ($48,000 on page 3).");
    expect(scanLarger.matched.valueUsd).toBe(48000);

    const factsLarger = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({
        facts: { moneyInvolved: true, valueKnown: true, totalValueUsd: 60000, currency: 'USD' },
        scan: { maxUsd: 1000, maxUsdPage: 1 },
      }),
      nameCheck: MATCH,
    });
    expect(factsLarger.reasons[0].text).toBe("It's over your $25,000 limit ($60,000).");

    // A document cannot talk the scan down: the review says no money, the scan
    // found some.
    const hidden = evaluateSignRules({
      rules: rulesWith(),
      review: review({ facts: { moneyInvolved: false }, scan: { maxUsd: 1200.5, maxUsdPage: 2 } }),
      nameCheck: MATCH,
    });
    expect(codes(hidden)).toEqual(['over_limit']);
    expect(hidden.reasons[0].text).toBe(
      'Your rules only cover documents with no money involved, and this one has $1,200.50 on page 2.'
    );
  });

  it('needs the person when money is involved but the total is not clear', () => {
    const check = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({ facts: { moneyInvolved: true, valueKnown: false, totalValueUsd: null } }),
      nameCheck: MATCH,
    });
    expect(codes(check)).toEqual(['value_unknown']);
    expect(check.reasons[0].text).toBe("It involves money but the total isn't clear.");

    // A value the review calls known but does not give is not known either.
    const missing = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({ facts: { moneyInvolved: true, valueKnown: true, totalValueUsd: null } }),
      nameCheck: MATCH,
    });
    expect(codes(missing)).toEqual(['value_unknown']);
  });

  it('needs the person for amounts in another currency', () => {
    const fromScan = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({ scan: { otherCurrencies: ['eur'] } }),
      nameCheck: MATCH,
    });
    expect(codes(fromScan)).toEqual(['other_currency']);
    expect(fromScan.reasons[0].text).toBe('It has amounts in another currency (EUR).');

    const fromFacts = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 25000 }),
      review: review({
        facts: { moneyInvolved: true, valueKnown: true, totalValueUsd: 500, currency: 'GBP' },
      }),
      nameCheck: MATCH,
    });
    expect(codes(fromFacts)).toEqual(['other_currency']);
    expect(fromFacts.reasons[0].text).toContain('GBP');
  });

  it("needs the person when the review is not 'standard' or flags a warning", () => {
    const reviewed = evaluateSignRules({
      rules: rulesWith(),
      review: review({ overall: 'review' }),
      nameCheck: MATCH,
    });
    expect(codes(reviewed)).toEqual(['not_standard']);
    expect(reviewed.reasons[0].text).toBe("The review rated it 'review' (it needs a close read).");

    const concerning = evaluateSignRules({
      rules: rulesWith(),
      review: review({
        overall: 'concerning',
        flags: [
          { severity: 'warning', title: 'One-sided indemnity', why: '', quote: '' },
          { severity: 'caution', title: 'Long term', why: '', quote: '' },
        ],
      }),
      nameCheck: MATCH,
    });
    expect(codes(concerning)).toEqual(['not_standard', 'warning_flag']);
    expect(concerning.reasons[0].text).toBe("The review rated it 'concerning'.");
    expect(concerning.reasons[1].text).toBe('The review flagged: One-sided indemnity.');
  });

  it('needs the person for text aimed at an AI, without counting its flag twice', () => {
    const check = evaluateSignRules({
      rules: rulesWith(),
      review: review({
        overall: 'concerning',
        instructionsAimedAtAI: true,
        flags: [{ severity: 'warning', title: 'Text aimed at AI assistants', why: '', quote: '' }],
      }),
      nameCheck: MATCH,
    });
    expect(codes(check)).toEqual(['not_standard', 'ai_text']);
    expect(check.reasons[1].text).toBe('It contains text aimed at an AI.');
  });

  it('needs the person when only part of the document was reviewed', () => {
    const check = evaluateSignRules({
      rules: rulesWith(),
      review: review({ partial: true }),
      nameCheck: MATCH,
    });
    expect(codes(check)).toEqual(['partial_review']);
    expect(check.reasons[0].text).toBe('Only part of it was reviewed.');
  });

  it('asks about every always-ask term, from the review or from the scan', () => {
    const check = evaluateSignRules({
      rules: rulesWith(),
      review: review({
        facts: { autoRenewal: true, nonCompete: true },
        scan: { hits: { personalGuarantee: ['personally guarantees'], paymentTerms: ['shall pay'] } },
      }),
      nameCheck: MATCH,
    });
    expect(codes(check)).toEqual(['auto_renewal', 'personal_guarantee', 'non_compete', 'payment_terms']);
    expect(check.reasons.map(r => r.text)).toEqual([
      'It renews automatically.',
      'It asks for a personal guarantee.',
      'It has a non-compete, non-solicit or exclusivity clause.',
      'It says you would owe money.',
    ]);

    const owes = evaluateSignRules({
      rules: rulesWith(),
      review: review({ facts: { paymentObligation: true } }),
      nameCheck: MATCH,
    });
    expect(codes(owes)).toEqual(['payment_terms']);
  });

  it('lets a term through when the person turned that question off', () => {
    const check = evaluateSignRules({
      rules: rulesWith({}, { alwaysAsk: { autoRenewal: false, paymentTerms: false } }),
      review: review({
        facts: { autoRenewal: true, paymentObligation: true },
        scan: { hits: { autoRenewal: ['renews automatically'] } },
      }),
      nameCheck: MATCH,
    });
    expect(check.allowed).toBe(true, JSON.stringify(check.reasons));
  });

  it('needs the person unless the name on the document is the account holder', () => {
    const mismatch = evaluateSignRules({
      rules: rulesWith(),
      review: review(),
      nameCheck: { status: 'mismatch' },
    });
    expect(codes(mismatch)).toEqual(['name_mismatch']);
    expect(mismatch.reasons[0].text).toBe('It names someone else for your side.');

    for (const nameCheck of [{ status: 'unknown' }, null]) {
      const check = evaluateSignRules({ rules: rulesWith(), review: review(), nameCheck });
      expect(codes(check)).toEqual(['name_mismatch']);
      expect(check.reasons[0].text).toBe("DocuStamp couldn't confirm your name on it.");
    }
  });

  it('only signs for trusted senders when the person named some', () => {
    const rules = rulesWith({ trustedSenderDomains: ['vendor.com'] });
    const trusted = evaluateSignRules({
      rules,
      review: review(),
      nameCheck: MATCH,
      senderEmail: 'Legal@Sub.Vendor.com',
    });
    expect(trusted.allowed).toBe(true, JSON.stringify(trusted.reasons));
    expect(trusted.summary).toBe('NDA, no money involved, from a trusted sender (sub.vendor.com)');

    for (const senderEmail of ['x@evilvendor.com', 'x@vendor.com.evil.test', '']) {
      const check = evaluateSignRules({ rules, review: review(), nameCheck: MATCH, senderEmail });
      expect(codes(check)).toEqual(['sender_domain']);
    }
    const other = evaluateSignRules({ rules, review: review(), nameCheck: MATCH, senderEmail: 'x@other.com' });
    expect(other.reasons[0].text).toBe("The sender (x@other.com) isn't on your trusted senders list.");
  });

  it('collects every reason at once and the public shape drops what is only for the caller', () => {
    const check = evaluateSignRules({
      rules: rulesWith({ maxValueUsd: 100 }),
      review: review({
        overall: 'review',
        facts: { documentType: 'lease', autoRenewal: true },
        scan: { maxUsd: 500, maxUsdPage: 1 },
      }),
      nameCheck: { status: 'mismatch' },
    });
    expect(codes(check)).toEqual(['doc_type', 'over_limit', 'not_standard', 'auto_renewal', 'name_mismatch']);
    const shown = publicRuleCheck({ ...check, review: { big: true }, rules: {} });
    expect(Object.keys(shown).sort()).toEqual(
      ['allowed', 'enabled', 'matched', 'reasons', 'rulesUpdatedAt', 'summary'].sort()
    );
  });
});

describe('Agent rules: shape and domains', () => {
  it('normalises domains', () => {
    expect(normaliseDomain('Vendor.com')).toBe('vendor.com');
    expect(normaliseDomain(' https://www.Vendor.com/path?q=1 ')).toBe('vendor.com');
    expect(normaliseDomain('@vendor.com')).toBe('vendor.com');
    expect(normaliseDomain('bob@legal.vendor.com')).toBe('legal.vendor.com');
    expect(normaliseDomain('*.vendor.com')).toBe('vendor.com');
    expect(normaliseDomain('vendor.com:443')).toBe('vendor.com');
    for (const junk of ['not a domain', 'localhost', '', null, '-bad.com', 'a..b']) {
      expect(normaliseDomain(junk)).toBe('', String(junk));
    }
  });

  it('matches a domain and its subdomains only', () => {
    expect(domainMatches('vendor.com', 'vendor.com')).toBe(true);
    expect(domainMatches('legal.vendor.com', 'vendor.com')).toBe(true);
    expect(domainMatches('evilvendor.com', 'vendor.com')).toBe(false);
    expect(domainMatches('vendor.com.evil.test', 'vendor.com')).toBe(false);
    expect(domainMatches('', 'vendor.com')).toBe(false);
  });

  it('refuses rules that are not rules, with a reason', () => {
    const bad = [
      [{ autoSign: { documentTypes: ['nda', 'contracts'] } }, 'Unknown document type "contracts"'],
      [{ autoSign: { maxValueUsd: -1 } }, 'whole number of dollars'],
      [{ autoSign: { maxValueUsd: 10.5 } }, 'whole number of dollars'],
      [{ autoSign: { maxValueUsd: '100' } }, 'whole number of dollars'],
      [{ autoSign: { enabled: true, documentTypes: [] } }, 'at least one document type'],
      [{ autoSign: { enabled: 'yes' } }, 'autoSign.enabled must be true or false'],
      [{ sendOnlyTo: ['vendor.com', 'not a domain'] }, '"not a domain" is not a domain'],
      [{ sendOnlyTo: 'vendor.com' }, 'must be a list'],
      [{ alwaysAsk: { autoRenewal: 'no' } }, 'alwaysAsk.autoRenewal must be true or false'],
      ['rules', 'Rules must be an object'],
    ];
    for (const [input, message] of bad) {
      let error;
      try {
        normaliseRules(input, { strict: true });
      } catch (err) {
        error = err;
      }
      expect(error?.message).toContain(message, JSON.stringify(input));
      expect(error?.code).toBe(Parse.Error.VALIDATION_ERROR);
    }
  });

  it('keeps sections left out and tidies what it keeps', () => {
    const base = normaliseRules(
      { autoSign: { enabled: true, documentTypes: ['nda'], maxValueUsd: 500 }, sendOnlyTo: ['a.com'] },
      { strict: true }
    );
    const next = normaliseRules(
      { autoSign: { documentTypes: ['order_form', 'NDA', 'nda'] } },
      { strict: true, base }
    );
    expect(next.autoSign).toEqual({
      enabled: true,
      documentTypes: ['nda', 'order_form'],
      maxValueUsd: 500,
      trustedSenderDomains: [],
    });
    expect(next.sendOnlyTo).toEqual(['a.com']);
    // Lenient reading drops junk instead of failing.
    const read = normaliseRules({ autoSign: { documentTypes: ['nda', 'junk'], maxValueUsd: -4 }, sendOnlyTo: ['ok.com', '???'] });
    expect(read.autoSign.documentTypes).toEqual(['nda']);
    expect(read.autoSign.maxValueUsd).toBe(0);
    expect(read.sendOnlyTo).toEqual(['ok.com']);
  });

  it('describes the rules in plain sentences', () => {
    expect(describeRules(defaultRules())).toEqual([
      'Asks you before signing any document someone else sends you.',
      'Signs documents you send yourself as soon as you say so.',
      'May send documents to anyone.',
    ]);
    const lines = describeRules(
      rulesWith(
        { documentTypes: ['nda', 'order_form', 'msa'], maxValueUsd: 25000, trustedSenderDomains: ['vendor.com'] },
        { sendOnlyTo: ['acme.com'], alwaysAsk: { paymentTerms: false } }
      )
    );
    expect(lines).toEqual([
      'Signs documents others send you without asking when they are: NDA, order form and MSA.',
      'Asks you about anything over $25,000.',
      'Only when the sender is from: vendor.com.',
      'Always asks you about auto-renewals, personal guarantees and non-competes.',
      'Always asks you when the review finds anything unusual, text aimed at an AI, or a name that is not yours.',
      'Signs documents you send yourself as soon as you say so.',
      'Only sends documents to: acme.com.',
    ]);
    expect(describeRules(rulesWith())[1]).toBe('Signs on its own only when no money is involved.');
  });
});

describe('Agent rules: saving, reading, sending and deleting', () => {
  Parse.User.enableUnsafeCurrentUser();

  async function makeAccount(prefix) {
    const email = uniqueEmail(prefix, 'example.test');
    const user = new Parse.User();
    user.set('username', email);
    user.set('password', 'pa55word!');
    user.set('email', email);
    await user.signUp();
    const signedIn = await Parse.User.logIn(email, 'pa55word!');
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', `${prefix} co`);
    tenant.set('UserId', signedIn.toPointer());
    await tenant.save(null, { useMasterKey: true });
    const extUser = new Parse.Object('contracts_Users');
    extUser.set('Name', 'Morgan Avery');
    extUser.set('Email', email);
    extUser.set('UserId', signedIn.toPointer());
    extUser.set('TenantId', tenant.toPointer());
    extUser.set('UserRole', 'contracts_Admin');
    await extUser.save(null, { useMasterKey: true });
    const caller = await loadCaller(signedIn, { publicUrl: BASE, extUser });
    return { user: signedIn, extUser, email, caller, session: signedIn.getSessionToken() };
  }

  function run(name, params, account) {
    return Parse.Cloud.run(name, params, { sessionToken: account.session });
  }

  beforeEach(() => resetRateLimits());

  it('reads the defaults, saves, merges a partial save and records who set them', async () => {
    const account = await makeAccount('rules.save');
    const first = await run('getagentrules', {}, account);
    expect(first.rules.autoSign.enabled).toBe(false);
    expect(first.rules.updatedAt).toBeNull();
    expect(first.summary[0]).toBe('Asks you before signing any document someone else sends you.');

    const saved = await run(
      'setagentrules',
      {
        rules: {
          autoSign: { enabled: true, documentTypes: ['nda', 'order_form'], maxValueUsd: 25000 },
          sendOnlyTo: ['Vendor.com', 'https://www.acme.com/'],
        },
      },
      account
    );
    expect(saved.rules.autoSign).toEqual({
      enabled: true,
      documentTypes: ['nda', 'order_form'],
      maxValueUsd: 25000,
      trustedSenderDomains: [],
    });
    expect(saved.rules.sendOnlyTo).toEqual(['vendor.com', 'acme.com']);
    expect(saved.rules.updatedBy).toEqual({ name: 'Morgan Avery', email: account.email });
    expect(typeof saved.rules.updatedAt).toBe('string');
    expect(saved.summary).toContain('Asks you about anything over $25,000.');

    const partial = await run('setagentrules', { rules: { alwaysAsk: { paymentTerms: false } } }, account);
    expect(partial.rules.autoSign.maxValueUsd).toBe(25000);
    expect(partial.rules.sendOnlyTo).toEqual(['vendor.com', 'acme.com']);
    expect(partial.rules.alwaysAsk).toEqual({
      autoRenewal: true,
      personalGuarantee: true,
      nonCompete: true,
      paymentTerms: false,
    });

    const read = await getAgentRules(account.caller);
    expect(read.autoSign.documentTypes).toEqual(['nda', 'order_form']);
    const rows = await new Parse.Query('contracts_AgentRules')
      .equalTo('User', account.user.toPointer())
      .count({ useMasterKey: true });
    expect(rows).toBe(1);
  });

  it('refuses bad rules, a caller with no session, and an app or API key', async () => {
    const account = await makeAccount('rules.refuse');
    await expectAsync(
      run('setagentrules', { rules: { autoSign: { documentTypes: ['contracts'] } } }, account)
    ).toBeRejectedWithError(/Unknown document type/);
    await expectAsync(
      Parse.Cloud.run('getagentrules', {}, { useMasterKey: true })
    ).toBeRejectedWithError(/not authenticated/);
    await expectAsync(
      Parse.Cloud.run('setagentrules', { rules: {} }, { useMasterKey: true })
    ).toBeRejectedWithError(/not authenticated/);
    await expectAsync(
      setAgentRules({ ...account.caller, viaToken: true }, { autoSign: { enabled: true } })
    ).toBeRejectedWithError(/only be changed by you in DocuStamp/);
    // Nothing was stored by any of those.
    expect((await getAgentRules(account.caller)).updatedAt).toBeNull();
  });

  it('keeps the rules away from the open REST class', async () => {
    const account = await makeAccount('rules.locked');
    await run('setagentrules', { rules: { sendOnlyTo: ['vendor.com'] } }, account);
    await expectAsync(
      new Parse.Query('contracts_AgentRules').find({ sessionToken: account.session })
    ).toBeRejected();
  });

  it('limits who an app or API key sends to, never the person or their own address', async () => {
    const account = await makeAccount('rules.send');
    const token = { ...account.caller, viaToken: true };
    // No list: anyone.
    await expectAsync(assertRecipientsAllowed(token, ['x@other.com'])).toBeResolved();

    await run('setagentrules', { rules: { sendOnlyTo: ['vendor.com'] } }, account);
    await expectAsync(
      assertRecipientsAllowed(token, ['a@Legal.Vendor.com', account.email.toUpperCase(), '', null])
    ).toBeResolved();
    // The web app is the person: no limit.
    await expectAsync(assertRecipientsAllowed(account.caller, ['x@other.com'])).toBeResolved();

    let error;
    try {
      await assertRecipientsAllowed(token, ['a@vendor.com', 'X@Other.com']);
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
    expect(error?.message).toBe(
      'Your DocuStamp rules only let your AI send to: vendor.com. x@other.com is not on that list, so nothing was sent. Ask the user to add the domain in DocuStamp (Settings > Rules for your AI), or to send it themselves.'
    );
    await expectAsync(
      assertRecipientsAllowed(token, ['x@other.com', 'y@third.com'])
    ).toBeRejectedWithError(/x@other\.com and y@third\.com are not on that list/);
  });

  it('checks a document without an AI call while the rules are off, and reports a failed review when on', async () => {
    const account = await makeAccount('rules.check');
    const docJson = {
      objectId: 'doesNotExist1',
      ExtUserPtr: { Email: 'Legal@Vendor.com' },
      Placeholders: [],
      Signers: [],
    };
    const off = await checkSignRules(account.caller, docJson);
    expect(off.enabled).toBe(false);
    expect(off.allowed).toBe(false);
    expect(off.review).toBeNull();

    await run('setagentrules', { rules: { autoSign: { enabled: true, documentTypes: ['nda'] } } }, account);
    // The review cannot find the document: the rules say ask, nothing throws.
    const failed = await checkSignRules(account.caller, docJson, { nameCheck: MATCH });
    expect(failed.enabled).toBe(true);
    expect(failed.allowed).toBe(false);
    expect(codes(failed)).toEqual(['review_unavailable']);
    expect(failed.matched.senderDomain).toBe('vendor.com');

    // Given a review and a name check, it decides from them alone.
    const given = await checkSignRules(account.caller, docJson, { review: review(), nameCheck: MATCH });
    expect(given.allowed).toBe(true, JSON.stringify(given.reasons));
    expect(given.rules.autoSign.enabled).toBe(true);
    expect(given.rulesUpdatedAt).toBe(given.rules.updatedAt);
  });

  it('goes with the account, and only that account', async () => {
    const leaving = await makeAccount('rules.leaving');
    const staying = await makeAccount('rules.staying');
    await run('setagentrules', { rules: { sendOnlyTo: ['vendor.com'] } }, leaving);
    await run('setagentrules', { rules: { sendOnlyTo: ['acme.com'] } }, staying);

    const result = await deleteUser(leaving.user.id);
    expect(result.code).toBe(200, result.message);
    const count = user =>
      new Parse.Query('contracts_AgentRules').equalTo('User', user.toPointer()).count({ useMasterKey: true });
    expect(await count(leaving.user)).toBe(0);
    expect(await count(staying.user)).toBe(1);
  });
});
