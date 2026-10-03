/**
 * The account's rules for its AI apps: when an agent may sign a document
 * someone else sent without asking, what it must always ask about, and who it
 * may send to.
 *
 * One set per account (`_User`), for every app the user connected and their
 * API key. Only the person sets them, from the web app (the `setagentrules`
 * cloud function needs a session); an agent can read them (the `get_rules`
 * MCP tool) and has no way to change them, so it cannot raise its own limits.
 *
 * The decision itself (`evaluateSignRules`) is plain code over facts: the AI
 * review's reading of the document, a deterministic scan of its text that a
 * document cannot talk down (cloud/ai/review.js `scan`), and the name check.
 * Anything unclear counts against signing: the default answer is "ask the
 * person", and a "no" is never an error, only `{allowed: false, reasons}`.
 *
 * The rules start switched off, so an account that never opens the page
 * behaves exactly as before: every document someone else sends needs the
 * person's approval, and the agent may send to anyone.
 */
import { normaliseEmail } from './email.js';

export const RULES_CLASS = 'contracts_AgentRules';

/** Document types a rule can name. 'other' is what the review answers when none fits; it never auto-signs. */
export const RULE_DOC_TYPES = Object.freeze([
  'nda',
  'order_form',
  'msa',
  'sow',
  'offer_letter',
  'lease',
  'renewal',
  'consent_form',
  'purchase_order',
  'vendor_agreement',
]);

/** How each type reads in a sentence. */
const DOC_TYPE_LABELS = Object.freeze({
  nda: 'NDA',
  order_form: 'order form',
  msa: 'MSA',
  sow: 'SOW',
  offer_letter: 'offer letter',
  lease: 'lease',
  renewal: 'renewal',
  consent_form: 'consent form',
  purchase_order: 'purchase order',
  vendor_agreement: 'vendor agreement',
  other: 'document of another kind',
});

/** The types whose label is said with "an" (an NDA, an order form). */
const TAKES_AN = new Set(['nda', 'order_form', 'msa', 'sow', 'offer_letter']);

/** What the person can ask to always be asked about. */
export const ALWAYS_ASK_KEYS = Object.freeze([
  'autoRenewal',
  'personalGuarantee',
  'nonCompete',
  'paymentTerms',
]);

const ALWAYS_ASK = Object.freeze({
  autoRenewal: { code: 'auto_renewal', text: 'It renews automatically.', label: 'auto-renewals' },
  personalGuarantee: {
    code: 'personal_guarantee',
    text: 'It asks for a personal guarantee.',
    label: 'personal guarantees',
  },
  nonCompete: {
    code: 'non_compete',
    text: 'It has a non-compete, non-solicit or exclusivity clause.',
    label: 'non-competes',
  },
  paymentTerms: {
    code: 'payment_terms',
    text: 'It says you would owe money.',
    label: 'payment terms',
  },
});

/** The facts flag the review sets for each always-ask key. */
const FACT_FOR_KEY = Object.freeze({
  autoRenewal: 'autoRenewal',
  personalGuarantee: 'personalGuarantee',
  nonCompete: 'nonCompete',
  paymentTerms: 'paymentObligation',
});

const MAX_DOMAINS = 50;
const MAX_VALUE_USD = 1e12;
/** A host name: labels of letters, digits and hyphens, at least one dot. */
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/** The rules an account has before anyone sets them: nothing signs on its own, anyone may be sent to. */
export function defaultRules() {
  return {
    autoSign: { enabled: false, documentTypes: ['nda'], maxValueUsd: 0, trustedSenderDomains: [] },
    alwaysAsk: { autoRenewal: true, personalGuarantee: true, nonCompete: true, paymentTerms: true },
    sendOnlyTo: [],
    updatedAt: null,
    updatedBy: null,
  };
}

/** "NDA", "order form": a document type as it reads in a sentence. */
export function documentTypeLabel(type) {
  return DOC_TYPE_LABELS[type] || DOC_TYPE_LABELS.other;
}

function fail(message, code = Parse.Error.VALIDATION_ERROR) {
  return new Parse.Error(code, message);
}

function formatUsd(amount) {
  const value = Number(amount) || 0;
  // Whole dollars stay whole ($25,000); cents always show two places ($1,200.50).
  const digits = Number.isInteger(value) ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function listText(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------- normalising */

/**
 * One domain as stored: lowercase, no scheme, path, port, `@` or `*.`. An
 * email address gives its domain. Returns '' for something that is not a
 * domain at all.
 */
export function normaliseDomain(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  s = s.split(/[/?#]/)[0].split(':')[0];
  // A pasted web address names the site; mail goes to the bare domain.
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(s) ? s : '';
}

/** True when `domain` is `allowed` or a subdomain of it. */
export function domainMatches(domain, allowed) {
  const d = String(domain || '').toLowerCase();
  const a = String(allowed || '').toLowerCase();
  if (!d || !a) return false;
  return d === a || d.endsWith(`.${a}`);
}

function domainAllowed(domain, list) {
  return list.some(allowed => domainMatches(domain, allowed));
}

function emailDomain(email) {
  const e = normaliseEmail(email);
  const at = e.lastIndexOf('@');
  return at > 0 ? e.slice(at + 1) : '';
}

/**
 * A list of domains from the person. Strict (a save) refuses anything that is
 * not a domain; lenient (reading a stored row) drops it.
 */
function domainList(value, { strict, label }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (strict) throw fail(`${label} must be a list of domains like vendor.com.`);
    return [];
  }
  const out = [];
  for (const raw of value) {
    const domain = normaliseDomain(raw);
    if (!domain) {
      if (strict) {
        throw fail(`"${String(raw ?? '').slice(0, 80)}" is not a domain. Enter domains like vendor.com.`);
      }
      continue;
    }
    if (!out.includes(domain)) out.push(domain);
  }
  if (out.length > MAX_DOMAINS) {
    if (strict) throw fail(`${label} can hold at most ${MAX_DOMAINS} domains.`);
    out.length = MAX_DOMAINS;
  }
  return out;
}

function booleanOr(value, fallback, { strict, label }) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (strict) throw fail(`${label} must be true or false.`);
  return fallback;
}

/**
 * Rules in their one stored shape, merged over `base` (the defaults, or the
 * current rules for a partial save). Strict validation is for what a person
 * saves; lenient is for what is read back, so a row written by an older
 * version never breaks a signature.
 *
 * @param {Object} input
 * @param {{strict?: boolean, base?: Object}} [opts]
 */
export function normaliseRules(input, { strict = false, base = defaultRules() } = {}) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    if (strict) throw fail('Rules must be an object.');
    input = {};
  }
  const src = input || {};
  const baseAuto = base.autoSign || defaultRules().autoSign;
  const baseAsk = base.alwaysAsk || defaultRules().alwaysAsk;

  const auto = src.autoSign && typeof src.autoSign === 'object' ? src.autoSign : {};
  if (strict && src.autoSign !== undefined && (typeof src.autoSign !== 'object' || src.autoSign === null || Array.isArray(src.autoSign))) {
    throw fail('autoSign must be an object.');
  }

  let documentTypes = baseAuto.documentTypes;
  if (auto.documentTypes !== undefined) {
    if (!Array.isArray(auto.documentTypes)) {
      if (strict) throw fail('documentTypes must be a list.');
    } else {
      documentTypes = [];
      for (const raw of auto.documentTypes) {
        const type = String(raw ?? '').trim().toLowerCase();
        if (!RULE_DOC_TYPES.includes(type)) {
          if (strict) {
            throw fail(
              `Unknown document type "${String(raw ?? '').slice(0, 40)}". Use: ${RULE_DOC_TYPES.join(', ')}.`
            );
          }
          continue;
        }
        if (!documentTypes.includes(type)) documentTypes.push(type);
      }
    }
  }
  documentTypes = RULE_DOC_TYPES.filter(t => documentTypes.includes(t));

  let maxValueUsd = baseAuto.maxValueUsd;
  if (auto.maxValueUsd !== undefined) {
    const n = auto.maxValueUsd;
    const ok = typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_VALUE_USD;
    if (ok) maxValueUsd = n;
    else if (strict) throw fail('The money limit must be a whole number of dollars, 0 or more.');
  }
  if (!(Number.isInteger(maxValueUsd) && maxValueUsd >= 0)) maxValueUsd = 0;

  const enabled = booleanOr(auto.enabled, baseAuto.enabled === true, {
    strict,
    label: 'autoSign.enabled',
  });
  const trustedSenderDomains =
    auto.trustedSenderDomains === undefined
      ? domainList(baseAuto.trustedSenderDomains, { strict: false, label: 'Trusted senders' })
      : domainList(auto.trustedSenderDomains, { strict, label: 'Trusted senders' });

  const askSrc = src.alwaysAsk && typeof src.alwaysAsk === 'object' ? src.alwaysAsk : {};
  if (strict && src.alwaysAsk !== undefined && (typeof src.alwaysAsk !== 'object' || src.alwaysAsk === null || Array.isArray(src.alwaysAsk))) {
    throw fail('alwaysAsk must be an object.');
  }
  const alwaysAsk = {};
  for (const key of ALWAYS_ASK_KEYS) {
    alwaysAsk[key] = booleanOr(askSrc[key], baseAsk[key] !== false, {
      strict,
      label: `alwaysAsk.${key}`,
    });
  }

  const sendOnlyTo =
    src.sendOnlyTo === undefined
      ? domainList(base.sendOnlyTo, { strict: false, label: 'Send only to' })
      : domainList(src.sendOnlyTo, { strict, label: 'Send only to' });

  if (strict && enabled && !documentTypes.length) {
    throw fail('Pick at least one document type your AI may sign on its own.');
  }

  return {
    autoSign: { enabled, documentTypes, maxValueUsd, trustedSenderDomains },
    alwaysAsk,
    sendOnlyTo,
    updatedAt: base.updatedAt ?? null,
    updatedBy: base.updatedBy ?? null,
  };
}

/* ------------------------------------------------------------------ schema */

const LOCKED_CLP = Object.freeze({
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

let schemaReady = false;

/**
 * Create the class, locked, before the first write. The migration
 * (databases/migrations/20261003150000-create_contracts_agentrules.cjs) does
 * the same; this covers a server that has not run it, because a class that a
 * master-key save creates on its own gets public permissions.
 */
async function ensureRulesSchema() {
  if (schemaReady) return;
  const schema = new Parse.Schema(RULES_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (!existing) {
    schema.addPointer('User', '_User');
    schema.addObject('AutoSign');
    schema.addObject('AlwaysAsk');
    schema.addArray('SendOnlyTo');
    schema.addObject('UpdatedBy');
    schema.setCLP(LOCKED_CLP);
    try {
      await schema.save();
    } catch (err) {
      if (!/already exists/i.test(err?.message || '')) throw err;
    }
  }
  schemaReady = true;
}

function userIdOf(callerOrUserId) {
  return typeof callerOrUserId === 'string' ? callerOrUserId : callerOrUserId?.userId || '';
}

async function findRow(userId) {
  if (!userId) return null;
  const query = new Parse.Query(RULES_CLASS);
  query.equalTo('User', { __type: 'Pointer', className: '_User', objectId: userId });
  query.ascending('createdAt');
  try {
    return await query.first({ useMasterKey: true });
  } catch (err) {
    // No class yet (nobody has saved rules on this server): the defaults.
    if (err?.code === Parse.Error.INVALID_CLASS_NAME || /does not exist|non-existent/i.test(err?.message || '')) {
      return null;
    }
    throw err;
  }
}

function rulesFromRow(row) {
  if (!row) return defaultRules();
  const stored = {
    autoSign: row.get('AutoSign') || undefined,
    alwaysAsk: row.get('AlwaysAsk') || undefined,
    sendOnlyTo: row.get('SendOnlyTo') || undefined,
  };
  const rules = normaliseRules(stored, { strict: false });
  const by = row.get('UpdatedBy');
  return {
    ...rules,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: by && typeof by === 'object' ? { name: String(by.name || ''), email: String(by.email || '') } : null,
  };
}

/**
 * The account's rules, or the defaults when it has none.
 *
 * @param {import('./context.js').Caller|string} caller the caller, or a `_User` id
 * @returns {Promise<ReturnType<typeof defaultRules>>}
 */
export async function getAgentRules(caller) {
  return rulesFromRow(await findRow(userIdOf(caller)));
}

/**
 * Save the account's rules. Only for a person in the web app: the cloud
 * function refuses anything without a session, and no token path calls this.
 * Sections left out keep their current values.
 *
 * @param {import('./context.js').Caller} caller
 * @param {Object} input
 */
export async function setAgentRules(caller, input) {
  if (!caller?.userId) throw fail('User is not authenticated.', Parse.Error.INVALID_SESSION_TOKEN);
  if (caller.viaToken) {
    throw fail(
      'Rules for your AI can only be changed by you in DocuStamp, not through an app or API key.',
      Parse.Error.OPERATION_FORBIDDEN
    );
  }
  const current = await getAgentRules(caller);
  const next = normaliseRules(input, { strict: true, base: current });
  await ensureRulesSchema();
  const row = (await findRow(caller.userId)) || new Parse.Object(RULES_CLASS);
  if (!row.id) {
    row.set('User', { __type: 'Pointer', className: '_User', objectId: caller.userId });
    row.setACL(new Parse.ACL()); // nothing granted: master key only
  }
  row.set('AutoSign', next.autoSign);
  row.set('AlwaysAsk', next.alwaysAsk);
  row.set('SendOnlyTo', next.sendOnlyTo);
  row.set('UpdatedBy', { name: String(caller.name || ''), email: normaliseEmail(caller.email) });
  await row.save(null, { useMasterKey: true });
  return rulesFromRow(row);
}

/**
 * Remove the account's rules row (account deletion).
 *
 * @param {string} userId `_User` id
 * @returns {Promise<number>} rows removed
 */
export async function deleteAgentRulesForUser(userId) {
  if (!userId) return 0;
  const query = new Parse.Query(RULES_CLASS);
  query.equalTo('User', { __type: 'Pointer', className: '_User', objectId: userId });
  let rows;
  try {
    rows = await query.find({ useMasterKey: true });
  } catch (err) {
    if (/does not exist|non-existent/i.test(err?.message || '')) return 0;
    throw err;
  }
  if (rows.length) await Parse.Object.destroyAll(rows, { useMasterKey: true });
  return rows.length;
}

/* ------------------------------------------------------------- describing */

/**
 * The rules as short plain sentences, for get_rules, approvals and the
 * certificate.
 *
 * @param {ReturnType<typeof defaultRules>} rules
 * @returns {string[]}
 */
export function describeRules(rules) {
  const r = normaliseRules(rules || {}, { strict: false });
  const out = [];
  if (r.autoSign.enabled) {
    const types = r.autoSign.documentTypes.map(documentTypeLabel);
    out.push(
      `Signs documents others send you without asking when they are: ${listText(types) || 'no type yet'}.`
    );
    out.push(
      r.autoSign.maxValueUsd > 0
        ? `Asks you about anything over ${formatUsd(r.autoSign.maxValueUsd)}.`
        : 'Signs on its own only when no money is involved.'
    );
    if (r.autoSign.trustedSenderDomains.length) {
      out.push(`Only when the sender is from: ${r.autoSign.trustedSenderDomains.join(', ')}.`);
    }
    const asks = ALWAYS_ASK_KEYS.filter(k => r.alwaysAsk[k]).map(k => ALWAYS_ASK[k].label);
    if (asks.length) out.push(`Always asks you about ${listText(asks)}.`);
    out.push(
      'Always asks you when the review finds anything unusual, text aimed at an AI, or a name that is not yours.'
    );
  } else {
    out.push('Asks you before signing any document someone else sends you.');
  }
  out.push('Signs documents you send yourself as soon as you say so.');
  out.push(
    r.sendOnlyTo.length
      ? `Only sends documents to: ${r.sendOnlyTo.join(', ')}.`
      : 'May send documents to anyone.'
  );
  return out;
}

/* ------------------------------------------------------------- sending */

/**
 * Throws when a token caller would send to an address the rules do not allow.
 * A person in the web app (no `caller.viaToken`) is never limited, and the
 * account holder's own address always passes.
 *
 * @param {import('./context.js').Caller} caller
 * @param {string[]} emails
 */
export async function assertRecipientsAllowed(caller, emails) {
  if (!caller?.viaToken) return;
  const rules = await getAgentRules(caller);
  if (!rules.sendOnlyTo.length) return;
  const own = normaliseEmail(caller.email);
  const blocked = [];
  for (const raw of Array.isArray(emails) ? emails : [emails]) {
    const email = normaliseEmail(raw);
    if (!email || email === own) continue;
    if (!domainAllowed(emailDomain(email), rules.sendOnlyTo)) {
      if (!blocked.includes(email)) blocked.push(email);
    }
  }
  if (!blocked.length) return;
  const who = blocked.length === 1 ? `${blocked[0]} is` : `${listText(blocked)} are`;
  throw fail(
    `Your DocuStamp rules only let your AI send to: ${rules.sendOnlyTo.join(', ')}. ${who} not on that list, so nothing was sent. Ask the user to add the domain in DocuStamp (Settings > Rules for your AI), or to send it themselves.`,
    Parse.Error.OPERATION_FORBIDDEN
  );
}

/* ------------------------------------------------------------- signing */

function reason(code, text) {
  return { code, text };
}

function finiteOrNull(value) {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const AI_FLAG_TITLE_RE = /aimed at ai/i;

/**
 * The money a document involves, from the review's reading and the scan. The
 * larger of the two counts: a document cannot lower what the scan found.
 */
function moneyOf(facts, scan) {
  const factValue = facts.valueKnown === true ? finiteOrNull(facts.totalValueUsd) : null;
  const scanValue = finiteOrNull(scan.maxUsd);
  if (factValue === null && scanValue === null) return { valueUsd: null, page: null };
  if (scanValue !== null && (factValue === null || scanValue >= factValue)) {
    return { valueUsd: scanValue, page: Number.isInteger(scan.maxUsdPage) ? scan.maxUsdPage : null };
  }
  return { valueUsd: factValue, page: null };
}

/**
 * Whether the rules let an agent sign this document someone else sent,
 * without asking. Pure: everything it needs is passed in.
 *
 * @param {{rules: Object, review: Object|null, nameCheck: Object|null, senderEmail?: string}} input
 * @returns {{enabled: boolean, allowed: boolean, reasons: Array<{code: string, text: string}>,
 *   matched: Object|null, rulesUpdatedAt: string|null, summary: string}}
 */
export function evaluateSignRules({ rules, review, nameCheck, senderEmail } = {}) {
  const r = normaliseRules(rules || {}, { strict: false });
  const rulesUpdatedAt = rules?.updatedAt ?? null;
  if (!r.autoSign.enabled) {
    return {
      enabled: false,
      allowed: false,
      reasons: [],
      matched: null,
      rulesUpdatedAt,
      summary: "Your rules don't let your AI sign documents others send you on its own.",
    };
  }

  const reasons = [];
  const limitUsd = r.autoSign.maxValueUsd;
  const senderDomain = emailDomain(senderEmail);
  let documentType = null;
  let valueUsd = null;
  let moneyInvolved = false;

  if (!review || typeof review !== 'object') {
    reasons.push(reason('review_unavailable', 'The AI review could not run, so this needs you.'));
  } else {
    const facts = review.facts && typeof review.facts === 'object' ? review.facts : {};
    const scan = review.scan && typeof review.scan === 'object' ? review.scan : {};
    const hits = scan.hits && typeof scan.hits === 'object' ? scan.hits : {};

    documentType = RULE_DOC_TYPES.includes(facts.documentType) ? facts.documentType : 'other';
    if (!r.autoSign.documentTypes.includes(documentType)) {
      const covered = listText(r.autoSign.documentTypes.map(documentTypeLabel));
      reasons.push(
        reason(
          'doc_type',
          documentType === 'other'
            ? `It isn't one of the document types your rules cover (${covered}).`
            : `It's ${TAKES_AN.has(documentType) ? 'an' : 'a'} ${documentTypeLabel(documentType)}, and your rules only cover: ${covered}.`
        )
      );
    }

    const otherCurrencies = new Set(
      (Array.isArray(scan.otherCurrencies) ? scan.otherCurrencies : [])
        .map(c => String(c || '').toUpperCase())
        .filter(Boolean)
    );
    const factCurrency = String(facts.currency || '').toUpperCase();
    if (facts.moneyInvolved === true && factCurrency && factCurrency !== 'USD') {
      otherCurrencies.add(factCurrency);
    }
    if (otherCurrencies.size) {
      reasons.push(
        reason('other_currency', `It has amounts in another currency (${[...otherCurrencies].join(', ')}).`)
      );
    }

    const money = moneyOf(facts, scan);
    valueUsd = money.valueUsd;
    moneyInvolved = facts.moneyInvolved === true || (valueUsd !== null && valueUsd > 0);
    if (valueUsd !== null && valueUsd > limitUsd) {
      const where = money.page ? ` on page ${money.page}` : '';
      reasons.push(
        reason(
          'over_limit',
          limitUsd > 0
            ? `It's over your ${formatUsd(limitUsd)} limit (${formatUsd(valueUsd)}${where}).`
            : `Your rules only cover documents with no money involved, and this one has ${formatUsd(valueUsd)}${where}.`
        )
      );
    } else if (facts.moneyInvolved === true && valueUsd === null) {
      reasons.push(reason('value_unknown', "It involves money but the total isn't clear."));
    }

    const overall = String(review.overall || '');
    if (overall !== 'standard') {
      reasons.push(
        reason(
          'not_standard',
          overall === 'concerning'
            ? "The review rated it 'concerning'."
            : "The review rated it 'review' (it needs a close read)."
        )
      );
    }
    const aiText = review.instructionsAimedAtAI === true;
    for (const flag of Array.isArray(review.flags) ? review.flags : []) {
      if (flag?.severity !== 'warning') continue;
      const title = String(flag.title || '').trim() || 'a warning';
      if (aiText && AI_FLAG_TITLE_RE.test(title)) continue;
      reasons.push(reason('warning_flag', `The review flagged: ${title}.`));
    }
    if (aiText) reasons.push(reason('ai_text', 'It contains text aimed at an AI.'));
    if (review.partial === true) reasons.push(reason('partial_review', 'Only part of it was reviewed.'));

    for (const key of ALWAYS_ASK_KEYS) {
      if (!r.alwaysAsk[key]) continue;
      const fromFacts = facts[FACT_FOR_KEY[key]] === true;
      const fromScan = Array.isArray(hits[key]) && hits[key].length > 0;
      if (fromFacts || fromScan) reasons.push(reason(ALWAYS_ASK[key].code, ALWAYS_ASK[key].text));
    }
  }

  const nameStatus = nameCheck?.status;
  if (nameStatus !== 'match') {
    reasons.push(
      reason(
        'name_mismatch',
        nameStatus === 'mismatch'
          ? 'It names someone else for your side.'
          : "DocuStamp couldn't confirm your name on it."
      )
    );
  }

  if (r.autoSign.trustedSenderDomains.length && !domainAllowed(senderDomain, r.autoSign.trustedSenderDomains)) {
    const who = normaliseEmail(senderEmail) || 'unknown';
    reasons.push(reason('sender_domain', `The sender (${who}) isn't on your trusted senders list.`));
  }

  const allowed = reasons.length === 0;
  const matched = { documentType, valueUsd, limitUsd, senderDomain: senderDomain || null };
  let summary;
  if (allowed) {
    const parts = [documentTypeLabel(documentType)];
    if (!moneyInvolved) parts.push('no money involved');
    else parts.push(`${formatUsd(valueUsd || 0)}, within your ${formatUsd(limitUsd)} limit`);
    if (r.autoSign.trustedSenderDomains.length) parts.push(`from a trusted sender (${senderDomain})`);
    summary = parts.join(', ');
    summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  } else {
    summary = `Needs you: ${reasons[0].text}`;
  }
  return { enabled: true, allowed, reasons, matched, rulesUpdatedAt, summary };
}

/** The stored and shown part of a check: what `checkSignRules` adds for its caller is left out. */
export function publicRuleCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const { enabled, allowed, reasons, matched, rulesUpdatedAt, summary } = check;
  return {
    enabled: enabled === true,
    allowed: allowed === true,
    reasons: Array.isArray(reasons) ? reasons.map(x => ({ code: String(x.code), text: String(x.text) })) : [],
    matched: matched || null,
    rulesUpdatedAt: rulesUpdatedAt ?? null,
    summary: String(summary || ''),
  };
}

function senderEmailOf(docJson) {
  const ext = docJson?.ExtUserPtr;
  if (ext && typeof ext === 'object' && ext.Email) return normaliseEmail(ext.Email);
  const by = docJson?.CreatedBy;
  if (by && typeof by === 'object' && (by.email || by.username)) return normaliseEmail(by.email || by.username);
  return '';
}

/**
 * Whether the rules let the caller's agent sign this document someone else
 * sent, without asking. Never throws for a rules reason: a "no" is
 * `{allowed: false, reasons}`. With the rules off it costs nothing (no AI
 * call); with them on it runs the review and the name check unless they are
 * given, and hands the review back so the caller can reuse it (an approval
 * shows it) instead of paying for a second one.
 *
 * @param {import('./context.js').Caller} caller
 * @param {Object} docJson the document (plain JSON, Placeholders and Signers included)
 * @param {{review?: Object|null, nameCheck?: Object|null, senderEmail?: string}} [known]
 * @returns {Promise<ReturnType<typeof evaluateSignRules> & {review: Object|null, rules: Object}>}
 */
export async function checkSignRules(caller, docJson, known = {}) {
  const rules = await getAgentRules(caller);
  if (!rules.autoSign.enabled) {
    return { ...evaluateSignRules({ rules }), review: known.review ?? null, rules };
  }
  // Loaded when needed: cloud/ai/review.js imports RULE_DOC_TYPES from this
  // file, and agentSign.js may come to as well, so a static import here would
  // make the load order decide whether either module starts.
  const [{ reviewDocument }, { findAgentSeat }, { accountOf, checkSeatName }] = await Promise.all([
    import('../ai/review.js'),
    import('./agentSign.js'),
    import('./signerName.js'),
  ]);
  let review = known.review ?? null;
  if (!review) {
    try {
      review = await reviewDocument(caller, docJson.objectId);
    } catch (err) {
      console.log('agentRules: review unavailable', err?.message || err);
      review = null;
    }
  }
  let nameCheck = known.nameCheck ?? null;
  if (!nameCheck) {
    try {
      nameCheck = await checkSeatName(docJson, findAgentSeat(docJson, caller), accountOf(caller));
    } catch (err) {
      console.log('agentRules: name check unavailable', err?.message || err);
      nameCheck = null;
    }
  }
  const senderEmail = known.senderEmail ?? senderEmailOf(docJson);
  const check = evaluateSignRules({ rules, review, nameCheck, senderEmail });
  return { ...check, review, rules };
}
