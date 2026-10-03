import { extractLayout } from '../ai/pdfLayout.js';
import { isParticipantBasic } from '../../utils/workflowUtils.js';
import { fetchPdfBytes } from './files.js';
import { fieldFromWidget } from './stamp.js';

/**
 * "Who is signing": the name a document prints for the party an agent is about
 * to sign for, checked against the account the signature will show.
 *
 * An agent always signs as the real account holder (lib/agentSign.js). A
 * document an AI drafted can still print somebody else for that party (a lease
 * naming "Jordan Ellis" as the Landlord, signed on the Landlord line as the
 * account holder), and then the page and the signature disagree. So before an
 * agent signs, the PDF's own text (ai/pdfLayout.js, no AI involved) is read for
 * the names it gives the seat's party:
 *  - role-anchored text anywhere, matched without case against the seat's role
 *    label: "Landlord: Jordan Ellis", "Landlord name: Jordan Ellis",
 *    "Jordan Ellis (Landlord)", 'Acme Corp ("Buyer")', "Jordan Ellis, Landlord";
 *  - labels by the seat's signature, initials and name fields (the same column,
 *    up to 100pt above or 40pt below, nearer to this seat's fields than to
 *    anybody else's, and with no other signing line or block heading between):
 *    "Name: X", "Print name: X", "Printed name: X", "By: X", or a bare party
 *    label such as "Lessor: X".
 * Blanks and placeholders ("____", "[Name]", "Name", "Signature", dates,
 * emails, addresses) are skipped, and so is anything that does not read as a
 * name.
 *
 * The verdict is `match`, `mismatch` or `unknown`. Unknown (nothing found, a
 * scanned page, a file that cannot be read) never blocks anything.
 */

/** How far from one of the seat's fields a printed name still counts as its, in PDF points. */
const NEAR_ABOVE = 100;
const NEAR_BELOW = 40;
const NEAR_SIDE = 40;
/** Widest gap between a label and its value printed after a tab stop. */
const MAX_TAB = 250;
/** The fields a printed name sits next to. */
const NEAR_TYPES = new Set(['signature', 'initials', 'name']);
const MAX_NAMES = 6;
const MAX_QUOTE = 160;
const MAX_NAME_LENGTH = 80;

/** Underlines and dot leaders: the place a value goes, not a value. */
const BLANK_RUN = /_{3,}|\.{4,}|…{2,}|-{5,}/gu;
const HAS_BLANK = /_{3,}|\.{4,}|…{2,}|-{5,}/u;

/** Party labels a document uses for the people who sign it. */
const PARTY_ROLES = new Set([
  'landlord',
  'tenant',
  'lessor',
  'lessee',
  'sublessor',
  'sublessee',
  'subtenant',
  'co-tenant',
  'cotenant',
  'renter',
  'owner',
  'homeowner',
  'occupant',
  'resident',
  'buyer',
  'seller',
  'purchaser',
  'vendor',
  'supplier',
  'customer',
  'client',
  'contractor',
  'subcontractor',
  'consultant',
  'freelancer',
  'provider',
  'service provider',
  'employer',
  'employee',
  'licensor',
  'licensee',
  'borrower',
  'lender',
  'guarantor',
  'grantor',
  'grantee',
  'assignor',
  'assignee',
  'mortgagor',
  'mortgagee',
  'debtor',
  'creditor',
  'payer',
  'payee',
  'discloser',
  'recipient',
  'disclosing party',
  'receiving party',
  'partner',
  'member',
  'manager',
  'agent',
  'broker',
  'principal',
  'sponsor',
  'investor',
  'founder',
  'shareholder',
  'trustee',
  'beneficiary',
  'executor',
  'franchisor',
  'franchisee',
  'distributor',
  'reseller',
  'host',
  'guest',
  'artist',
  'author',
  'publisher',
  'producer',
  'talent',
  'patient',
  'parent',
  'guardian',
  'student',
  'participant',
  'applicant',
  'volunteer',
  'party a',
  'party b',
  'first party',
  'second party',
  'signatory',
  'authorized signatory',
  'authorised signatory',
  'representative',
]);

/** Headings that open somebody else's signature block (a witness, a notary, the company). */
const OTHER_BLOCK_HEADINGS = new Set([
  'witness',
  'notary',
  'notary public',
  'company',
  'corporation',
]);

/** Words of a label ("Landlord", "Printed name", "Title") rather than of a name. */
const LABEL_WORDS = new Set([
  ...[...PARTY_ROLES].flatMap(r => r.split(/\s+/)).filter(w => w.length > 1),
  ...OTHER_BLOCK_HEADINGS,
  'name',
  'printed',
  'print',
  'full',
  'legal',
  'title',
  'date',
  'email',
  'e-mail',
  'phone',
  'address',
  'by',
  'its',
  'signature',
  'initials',
  'the',
  'party',
]);

/** Words that never make up a person's or a company's name. */
const NOT_NAME_WORDS = new Set([
  'and',
  'or',
  'with',
  'for',
  'from',
  'to',
  'in',
  'on',
  'at',
  'by',
  'as',
  'is',
  'are',
  'be',
  'shall',
  'must',
  'means',
  'who',
  'which',
  'that',
  'this',
  'these',
  'those',
  'each',
  'any',
  'all',
  'such',
  'said',
  'see',
  'per',
  'refer',
  'tbd',
  'tba',
  'none',
  'n/a',
  'na',
  'null',
  'pending',
  'required',
  'optional',
  'here',
  'below',
  'above',
  'herein',
  'hereinafter',
  'hereto',
  'whereas',
  'name',
  'names',
  'first',
  'last',
  'middle',
  'surname',
  'firstname',
  'lastname',
  'signature',
  'signed',
  'sign',
  'print',
  'printed',
  'initial',
  'initials',
  'date',
  'dated',
  'title',
  'address',
  'street',
  'avenue',
  'road',
  'suite',
  'boulevard',
  'apt',
  'apartment',
  'unit',
  'floor',
  'phone',
  'telephone',
  'fax',
  'email',
  'e-mail',
  'contact',
  'section',
  'article',
  'exhibit',
  'schedule',
  'appendix',
  'addendum',
  'attachment',
  'clause',
  'paragraph',
  'agreement',
  'contract',
  'lease',
  'rights',
  'obligations',
  'duties',
  'responsibilities',
  'information',
  'details',
  'terms',
  'conditions',
  'notice',
  'notices',
  'covenants',
  'representations',
  'warranties',
  'acknowledgment',
  'acknowledgement',
  'premises',
  'property',
  'rent',
  'deposit',
  'payment',
  'payments',
]);

/** Words a name stops at when read backwards from "(Landlord)": "between", "by", "The". */
const STOP_BEFORE = new Set([
  'between',
  'among',
  'amongst',
  'made',
  'entered',
  'parties',
  'undersigned',
  'named',
  'called',
  'following',
  'the',
  'i',
  'we',
  'me',
  'us',
  'our',
  'my',
]);

/** Lower-case pieces of names and company names: "de la Cruz", "van Dijk", "Bank of America". */
const PARTICLES = new Set([
  'de',
  'da',
  'di',
  'del',
  'della',
  'der',
  'den',
  'van',
  'von',
  'la',
  'le',
  'du',
  'dos',
  'das',
  'bin',
  'binti',
  'al',
  'el',
  'y',
  'of',
  '&',
]);

/** Courtesy titles, ignored when comparing names. */
const HONORIFICS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'professor',
  'sir',
  'dame',
  'madam',
  'madame',
  'mme',
  'rev',
  'hon',
]);

/** Generational and professional suffixes, ignored when comparing names. */
const NAME_SUFFIXES = new Set([
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'esq',
  'phd',
  'md',
  'dds',
  'cpa',
  'mba',
]);

/** Company forms, ignored when comparing a company name. */
const ORG_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'lp',
  'llp',
  'pllc',
  'gmbh',
  'sa',
  'ag',
  'nv',
  'bv',
  'pty',
  'sarl',
  'srl',
]);

/** Words that say a printed name is an organisation rather than a person. */
const ORG_WORDS = new Set([
  ...ORG_SUFFIXES,
  'trust',
  'foundation',
  'bank',
  'partners',
  'group',
  'holdings',
  'associates',
  'university',
  'school',
  'church',
  'agency',
  'authority',
  'council',
  'association',
  'institute',
  'studio',
  'studios',
]);

const MONTH_DATE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const NUMERIC_DATE = /\d{1,4}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{1,4}/;

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value, max) {
  const s = oneLine(value);
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A word without the punctuation around it, lower case, dots dropped ("Inc." -> "inc"). */
function bareWord(token) {
  return String(token || '')
    .replace(/^[(["“‘'«]+|[)\]"”’'»,;:!?]+$/gu, '')
    .replace(/\./g, '')
    .toLowerCase();
}

/* ------------------------------------------------------------------ names */

/**
 * The words of a name for comparing: accents, case, punctuation, courtesy
 * titles and suffixes gone. "Dr. José O'Neil-Ruiz Jr." -> ["jose", "oneil", "ruiz"].
 *
 * @param {string} value
 * @returns {string[]}
 */
export function nameTokens(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(t => t && !HONORIFICS.has(t) && !NAME_SUFFIXES.has(t));
}

/** A company name's words without its legal form: "Acme Holdings, L.L.C." -> ["acme", "holdings"]. */
function orgTokens(value) {
  const tokens = nameTokens(value).filter(t => !ORG_SUFFIXES.has(t));
  return tokens[0] === 'the' ? tokens.slice(1) : tokens;
}

/**
 * Every word of `short` is in `long`, as the whole word or (a single letter) as
 * the initial of a word not used yet, and at least one is a whole word. Order
 * does not matter, so "Avery, Morgan" covers "Morgan Avery".
 */
function covers(short, long, { initials = true } = {}) {
  if (!short.length || short.length > long.length) return false;
  const used = new Array(long.length).fill(false);
  let whole = 0;
  for (const t of short.filter(w => w.length > 1)) {
    const i = long.findIndex((w, k) => !used[k] && w === t);
    if (i < 0) return false;
    used[i] = true;
    whole += 1;
  }
  for (const t of short.filter(w => w.length === 1)) {
    if (!initials) return false;
    const i = long.findIndex((w, k) => !used[k] && w[0] === t);
    if (i < 0) return false;
    used[i] = true;
  }
  return whole > 0;
}

/** The same person: equal names, a middle name more or less, or initials ("M. Avery"). */
function samePerson(printed, accountName) {
  const a = nameTokens(printed);
  const b = nameTokens(accountName);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  return covers(a, b) || covers(b, a);
}

/** The same company, legal form aside ("Acme Inc." and "Acme, LLC" are both "acme"). */
function sameCompany(printed, company) {
  const a = orgTokens(printed);
  const b = orgTokens(company);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && covers(short, long, { initials: false });
}

/**
 * Whether a printed name is the account holder: the same person (case,
 * accents, punctuation and titles aside; a middle name more or less; initials),
 * or the account's own company (signing for their own company).
 *
 * @param {string} printed
 * @param {{name?: string, company?: string}} account
 * @returns {boolean}
 */
export function matchesAccount(printed, { name, company } = {}) {
  return samePerson(printed, name) || sameCompany(printed, company);
}

/** "Acme Holdings LLC", "First National Bank": a company, not a person. */
function isOrganisation(name) {
  return nameTokens(name).some(t => ORG_WORDS.has(t));
}

/* ------------------------------------------------------------------ reading values */

/**
 * The value up to the next label on the same text: "Jordan Ellis Title: CEO"
 * -> "Jordan Ellis". Null when the words before the colon are not a label we
 * know, since then where the name ends is a guess.
 */
function cutAtNextLabel(value) {
  const colon = value.search(/[:：]/u);
  if (colon < 0) return value;
  const words = value.slice(0, colon).trim().split(/\s+/).filter(Boolean);
  let keep = words.length;
  let dropped = 0;
  while (keep > 0 && dropped < 4 && LABEL_WORDS.has(bareWord(words[keep - 1]))) {
    keep -= 1;
    dropped += 1;
  }
  return dropped ? words.slice(0, keep).join(' ') : null;
}

/** One word of a name: capitalised, an initial, a particle, a company form, "3M". */
function nameLikeWord(token) {
  const word = token.replace(/^[("“‘'«]+|[)"”’'»,]+$/gu, '');
  if (!word) return false;
  const lower = bareWord(word);
  if (NOT_NAME_WORDS.has(lower)) return false;
  if (/^\d+$/.test(lower)) return false;
  if (PARTICLES.has(lower) || ORG_SUFFIXES.has(lower) || NAME_SUFFIXES.has(lower)) return true;
  if (/^[\p{Lu}\p{Lt}\p{Lo}]/u.test(word)) return true;
  if (/^\p{N}+\p{L}/u.test(word)) return true;
  // d'Arcy, l'Estrange
  return /^\p{Ll}['’]\p{Lu}/u.test(word);
}

/**
 * A printed value as a name, or null when it is a blank, a placeholder or not
 * a name at all ("[Name]", "Signature", "As defined in Section 2", a date, an
 * email, an address).
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function cleanName(raw) {
  let s = oneLine(raw);
  // A blank ends the value: "Name: ______ Date: ______" has no name in it.
  const blank = s.search(BLANK_RUN);
  if (blank >= 0) s = s.slice(0, blank).trim();
  if (!s) return null;
  s = cutAtNextLabel(s);
  if (!s) return null;
  s = s.replace(/^\/s\/\s*/i, '').trim();
  s = s.replace(/^["“‘'«]+|["”’'»]+$/gu, '').trim();
  // "[Landlord Name]", "<name>", "{{name}}": a template's placeholder.
  if (/^[[<{]/.test(s)) return null;
  s = oneLine(s.replace(/\([^)]*\)?/g, ' '));
  // "Jordan Ellis, residing at ..." ends at the comma; "Acme Holdings, LLC" does not.
  const parts = s.split(/\s*,\s*/);
  let name = parts[0];
  for (const part of parts.slice(1)) {
    const word = bareWord(part);
    if (!ORG_SUFFIXES.has(word) && !NAME_SUFFIXES.has(word)) break;
    name = `${name}, ${part}`;
  }
  name = name.replace(/[;:!?]+$/, '').trim();
  const last = name.split(' ').pop() || '';
  if (/\.$/.test(name) && last.length > 2 && !ORG_SUFFIXES.has(bareWord(last))) {
    name = name.slice(0, -1);
  }
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (/@|:\/\/|\bwww\./i.test(name)) return null;
  if (/[$€£¥]/.test(name)) return null;
  if ((name.match(/\p{N}/gu) || []).length > 4) return null;
  if (NUMERIC_DATE.test(name) || MONTH_DATE.test(name)) return null;
  const tokens = name.split(' ');
  if (tokens.length > 8) return null;
  if (!tokens.every(nameLikeWord)) return null;
  if (!tokens.some(t => /^[("“‘'«]*[\p{Lu}\p{Lt}\p{Lo}\p{N}]/u.test(t))) return null;
  // "Landlord", "The Tenant", "Printed Name": a label, not a name.
  if (tokens.every(t => LABEL_WORDS.has(bareWord(t)))) return null;
  return name;
}

/**
 * The name just before a "(Landlord)" or ", Landlord": the capitalised words
 * ending the text, read backwards. "This lease is made between Jordan Ellis"
 * -> "Jordan Ellis"; "Acme Corp, a Delaware corporation" -> "Acme Corp".
 */
function trailingName(before) {
  let s = oneLine(before);
  // ", an individual" / ", a Delaware corporation" describe the party; they are not its name.
  s = s.replace(/,\s*(?:an?|the)\s+[^,()]{1,60}$/iu, '');
  s = s.replace(/[\s,]+$/u, '');
  const tokens = s.split(' ').filter(Boolean);
  const kept = [];
  for (let i = tokens.length - 1; i >= 0 && kept.length < 8; i--) {
    let token = tokens[i];
    if (token.endsWith(',')) {
      // "Acme Holdings, LLC": the company form after a comma keeps the name going.
      if (!(kept.length === 1 && ORG_SUFFIXES.has(bareWord(kept[0])))) break;
      token = token.slice(0, -1);
    }
    // The end of a label or of a sentence; "J." and "Inc." are part of a name.
    if (/[:;!?]$/.test(token)) break;
    if (/\.$/.test(token) && !/^\p{L}\.$/u.test(token) && !ORG_SUFFIXES.has(bareWord(token))) {
      break;
    }
    const lower = bareWord(token);
    if (!lower || STOP_BEFORE.has(lower) || LABEL_WORDS.has(lower) || !nameLikeWord(token)) break;
    kept.unshift(token.replace(/^[("“‘'«]+/u, ''));
  }
  while (kept.length && PARTICLES.has(bareWord(kept[0]))) kept.shift();
  return kept.join(' ');
}

/**
 * One printed value as names: a single name, or two or more people for one
 * party ("Cameron Brooks and Jordan Ellis").
 *
 * @returns {{name: string, parts: string[]}|null}
 */
function parseNames(raw) {
  const whole = cleanName(raw);
  if (whole) return { name: whole, parts: [whole] };
  const pieces = oneLine(raw).split(/\s+and\s+/i);
  if (pieces.length < 2 || pieces.length > 4) return null;
  const parts = pieces.map(cleanName);
  if (parts.some(p => !p || p.split(' ').length < 2)) return null;
  return { name: parts.join(' and '), parts };
}

/* ------------------------------------------------------------------ the page */

/**
 * A line in pieces where the text has a wide gap: two signature blocks side by
 * side, or a label and its value after a tab stop. pdf.js joins everything on
 * one baseline into one line, so "Name: Jordan Ellis    Name: Cameron Brooks"
 * would otherwise read as one value.
 */
function segmentsOf(line, sideways) {
  const spans = (line.spans || []).filter(s => oneLine(s.text));
  if (sideways || !spans.length) {
    const text = oneLine(line.text);
    return text ? [{ x: line.x, w: line.w, text }] : [];
  }
  const height = line.h || 10;
  const gap = Math.max(18, height * 1.8);
  const out = [];
  let cur = null;
  for (const sp of [...spans].sort((a, b) => a.x - b.x)) {
    const end = cur ? cur.x + cur.w : 0;
    if (cur && sp.x - end <= gap) {
      cur.text += sp.x - end > height * 0.2 ? ` ${sp.text}` : sp.text;
      cur.w = Math.max(end, sp.x + sp.w) - cur.x;
    } else {
      cur = { x: sp.x, w: sp.w, text: sp.text };
      out.push(cur);
    }
  }
  return out.map(s => ({ ...s, text: oneLine(s.text) })).filter(s => s.text);
}

/** A segment's text split at its blanks; `blankAfter` says a blank followed the piece. */
function chunksOf(text) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(BLANK_RUN)) {
    out.push({ text: text.slice(from, m.index).trim(), blankAfter: true });
    from = m.index + m[0].length;
  }
  out.push({ text: text.slice(from).trim(), blankAfter: false });
  return out.filter(c => c.text);
}

function distance(a, b) {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function overlapsBand(seg, rect) {
  return seg.x <= rect.x + rect.w + NEAR_SIDE && seg.x + seg.w >= rect.x - NEAR_SIDE;
}

/** A role label as compared: lower case, no "the", no "'s", no trailing "name". */
function normaliseLabel(label) {
  return oneLine(label)
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/['’]s(?=\s|$)/g, '')
    .replace(/\s+(?:(?:printed|print|full|legal)\s+)?name$/, '')
    .trim();
}

/** The placeholder's role label, or '' for a default one ("Role 2") no document prints. */
function roleOf(placeholder) {
  const role = oneLine(placeholder?.Role);
  return /^role\s*\d*$/i.test(role) ? '' : role;
}

/** The spellings of a role to look for: as given, and without a parenthetical. */
function roleVariants(role) {
  const out = new Set();
  if (role) out.add(role);
  const bare = oneLine(role.replace(/\([^)]*\)/g, ' '));
  if (bare) out.add(bare);
  return [...out].filter(r => r.length >= 2 && r.length <= 60);
}

function roleRegexes(role) {
  const r = escapeRe(role).replace(/\s+/g, '\\s+');
  const pre = '(?<![\\p{L}\\p{N}-])';
  const post = '(?![\\p{L}\\p{N}])';
  const q = '["\'“”‘’«»„]';
  return {
    // "Landlord: X", "Landlord's printed name: X", "LANDLORD (print name): X", "Landlord signature: X"
    label: new RegExp(
      `${pre}${r}s?(?:['’]s)?${post}\\s*(?:\\(\\s*(?:print(?:ed)?\\s+)?name\\s*\\)\\s*)?(?:(?:full|legal|printed|print)\\s+)?(?:name|signature)?\\s*[:：]\\s*(.*)$`,
      'iu'
    ),
    // "X (Landlord)", 'X ("Buyer")', 'X (hereinafter referred to as the "Landlord")'
    paren: new RegExp(
      `\\(\\s*(?:(?:hereinafter|herein|collectively|individually)\\s*,?\\s*(?:(?:referred\\s+to|called|known)\\s+as\\s+)?)?(?:as\\s+)?(?:the\\s+)?${q}?\\s*${r}s?\\s*${q}?\\s*\\)`,
      'giu'
    ),
    // "X, Landlord" / "X, as Landlord", ending the text or a clause
    trailing: new RegExp(`,\\s*(?:as\\s+)?(?:the\\s+)?${r}${post}\\s*(?=[,;.)]|$)`, 'giu'),
  };
}

const NAME_LABEL_RE =
  /^(?:(?:print(?:ed)?|full|legal|signatory|signer['’]?s?)\s+)?name(?:\s+of\s+(?:signatory|signer))?(?:\s*\(\s*(?:please\s+)?print(?:ed)?\s*\))?\s*[:：]\s*(.*)$/iu;
const BY_RE = /^by\s*[:：]\s*(.*)$/iu;
const BARE_LABEL_RE = /^((?:the\s+)?\p{L}[\p{L}'’\- ]{1,40}?)\s*[:：]\s*(.*)$/iu;

function contactIdOf(placeholder) {
  return placeholder?.signerObjId || placeholder?.signerPtr?.objectId || '';
}

/** The fields of one placeholder as boxes in the stored top-left system. */
function rectsOf(placeholder, types) {
  const out = [];
  for (const page of placeholder?.placeHolder || []) {
    for (const w of page?.pos || []) {
      const f = fieldFromWidget(w, page?.pageNumber);
      if (f && (!types || types.has(f.type)))
        out.push({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h });
    }
  }
  return out;
}

/**
 * Something between a printed name above a field and the field itself that
 * says they are not one block: another signing line, or a heading such as
 * "TENANT" or "WITNESS".
 */
function blockBreakBetween(rows, top, field, ctx) {
  for (const row of rows) {
    const l = row.line;
    if (l.y < top - 0.5 || l.y + l.h > field.y + 0.5) continue;
    const band = { x: field.x, w: field.w };
    if ((l.blanks || []).some(b => overlapsBand({ x: b.x, w: b.w }, { ...band, y: 0, h: 0 }))) {
      return true;
    }
    for (const seg of row.segments) {
      if (!overlapsBand(seg, { ...band, y: 0, h: 0 })) continue;
      if (HAS_BLANK.test(seg.text)) return true;
      const heading = normaliseLabel(seg.text.replace(/[:：]\s*$/, ''));
      if (
        PARTY_ROLES.has(heading) ||
        OTHER_BLOCK_HEADINGS.has(heading) ||
        ctx.ownRoles.has(heading) ||
        ctx.otherRoles.has(heading)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** What a label by the seat's fields gives as a value, or null when it is not one we read. */
function nearbyValue(text, ctx) {
  let m = NAME_LABEL_RE.exec(text);
  if (m) return m[1];
  m = BY_RE.exec(text);
  if (m) return m[1];
  m = BARE_LABEL_RE.exec(text);
  if (m) {
    const label = normaliseLabel(m[1]);
    if (ctx.otherRoles.has(label)) return null;
    if (PARTY_ROLES.has(label) || ctx.ownRoles.has(label)) return m[2];
  }
  return null;
}

/**
 * The names a document prints for one seat's party.
 *
 * @param {Object} layout from ai/pdfLayout.js `extractLayout`.
 * @param {{placeholder: Object}|Object} seat the seat (lib/agentSign.js
 *   `findAgentSeat`), or its placeholder.
 * @param {Object} [docJson] the document as JSON; its other seats' fields and
 *   roles keep their names off this seat.
 * @returns {Array<{name: string, page: number, quote: string, source: 'role'|'nearby', parts?: string[]}>}
 */
export function printedNamesForSeat(layout, seat, docJson) {
  const placeholder = seat?.placeholder || seat || {};
  const role = roleOf(placeholder);
  const regexes = roleVariants(role).map(roleRegexes);
  const ownContact = contactIdOf(placeholder);
  const others = (docJson?.Placeholders || []).filter(
    p =>
      p !== placeholder && isParticipantBasic(p) && !(ownContact && contactIdOf(p) === ownContact)
  );
  const ctx = {
    ownRoles: new Set(roleVariants(role).map(normaliseLabel)),
    otherRoles: new Set(
      others.map(p => normaliseLabel(roleOf(p))).filter(r => r && r !== normaliseLabel(role))
    ),
  };
  const own = rectsOf(placeholder, NEAR_TYPES);
  const theirs = others.flatMap(p => rectsOf(p, null));

  const found = [];
  const seen = new Set();
  const push = (raw, page, quote, source) => {
    if (found.length >= MAX_NAMES) return;
    const parsed = parseNames(raw);
    if (!parsed) return;
    const key = nameTokens(parsed.name).join(' ');
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push({
      name: parsed.name,
      page,
      quote: clip(quote, MAX_QUOTE),
      source,
      ...(parsed.parts.length > 1 ? { parts: parsed.parts } : {}),
    });
  };

  for (const page of layout?.pages || []) {
    const sideways = page.rotation === 90 || page.rotation === 270;
    const rows = (page.lines || []).map(line => ({ line, segments: segmentsOf(line, sideways) }));
    const textRows = rows.filter(r => r.segments.length);

    // Role-anchored, anywhere on the page.
    textRows.forEach((row, li) => {
      row.segments.forEach((seg, si) => {
        const next = row.segments[si + 1];
        const prev = si > 0 ? row.segments[si - 1] : textRows[li - 1]?.segments.at(-1);
        for (const re of regexes) {
          const m = re.label.exec(seg.text);
          if (m) {
            let value = m[1];
            if (!value.trim() && next && next.x - (seg.x + seg.w) <= MAX_TAB) value = next.text;
            push(value, page.number, seg.text, 'role');
          }
          for (const p of seg.text.matchAll(re.paren)) {
            let before = seg.text.slice(0, p.index);
            if (!before.trim()) before = prev?.text || '';
            push(trailingName(before), page.number, seg.text, 'role');
          }
          for (const t of seg.text.matchAll(re.trailing)) {
            push(trailingName(seg.text.slice(0, t.index)), page.number, seg.text, 'role');
          }
        }
      });
    });

    // Labels by the seat's own fields.
    const mine = sideways ? [] : own.filter(r => r.page === page.number);
    if (!mine.length) continue;
    const near = theirs.filter(r => r.page === page.number);
    for (const row of textRows) {
      const l = row.line;
      row.segments.forEach((seg, si) => {
        const box = { x: seg.x, y: l.y, w: seg.w, h: l.h };
        let best = null;
        let bestDistance = Infinity;
        for (const r of mine) {
          if (l.y + l.h < r.y - NEAR_ABOVE || l.y > r.y + r.h + NEAR_BELOW) continue;
          if (!overlapsBand(seg, r)) continue;
          const d = distance(box, r);
          if (d < bestDistance) {
            bestDistance = d;
            best = r;
          }
        }
        if (!best) return;
        // Closer to somebody else's field: their block, not this seat's.
        if (near.some(r => distance(box, r) < bestDistance)) return;
        if (l.y + l.h <= best.y + 1 && blockBreakBetween(rows, l.y + l.h, best, ctx)) return;
        const chunks = chunksOf(seg.text);
        chunks.forEach((chunk, ci) => {
          let value = nearbyValue(chunk.text, ctx);
          if (value === null) return;
          if (!value.trim() && !chunk.blankAfter && ci === chunks.length - 1) {
            const next = row.segments[si + 1];
            if (next && next.x - (seg.x + seg.w) <= MAX_TAB)
              value = chunksOf(next.text)[0]?.text || '';
          }
          push(value, page.number, seg.text, 'nearby');
        });
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ verdict */

/**
 * The account a signature shows: the profile's name and company.
 *
 * @param {import('./context.js').Caller} caller
 * @returns {{name: string, company: string}}
 */
export function accountOf(caller) {
  return {
    name: oneLine(caller?.name),
    company: oneLine(caller?.company || caller?.extUser?.Company),
  };
}

/**
 * Check the names a document prints for a seat against the account.
 *
 * `mismatch` when any printed name is somebody else. One exception: when the
 * account holder is printed by name, a company printed for the same party is
 * the one they sign for ("By: Jane Cole" under "Acme LLC (Buyer)") and counts
 * as consistent. `unknown` when the account has no name, nothing is printed for
 * the party, or the page has no text (a scan).
 *
 * @param {Object} layout from `extractLayout` (null when the file could not be read).
 * @param {{placeholder: Object}} seat
 * @param {Object} docJson
 * @param {{name?: string, company?: string}} account
 * @returns {{status: 'match'|'mismatch'|'unknown', expected: string, role: string,
 *   printed: Array<{name: string, page: number, quote: string, source: string, matches: boolean}>}}
 */
export function checkSignerName(layout, seat, docJson, account = {}) {
  const expected = oneLine(account?.name);
  const out = { status: 'unknown', expected, role: roleOf(seat?.placeholder || seat), printed: [] };
  if (!expected || !layout?.pages?.length) return out;
  const found = printedNamesForSeat(layout, seat, docJson);
  if (!found.length) return out;
  const personal = found.some(p => (p.parts || [p.name]).some(n => samePerson(n, expected)));
  const printed = found.map(p => {
    const matches =
      (p.parts || [p.name]).some(n => matchesAccount(n, account)) ||
      (personal && isOrganisation(p.name));
    return { ...p, matches };
  });
  return { ...out, status: printed.every(p => p.matches) ? 'match' : 'mismatch', printed };
}

/**
 * Read the document and check the seat. Never throws: a file that cannot be
 * read is `unknown`, which blocks nothing.
 *
 * @param {Object} doc the document as JSON; the current copy (`SignedUrl`,
 *   else `URL`) is read unless `bytes` is given.
 * @param {{placeholder: Object}} seat
 * @param {{name?: string, company?: string}} account
 * @param {{bytes?: Uint8Array}} [opts] the PDF, when the caller has it already.
 */
export async function checkSeatName(doc, seat, account, { bytes } = {}) {
  const unknown = {
    status: 'unknown',
    expected: oneLine(account?.name),
    role: roleOf(seat?.placeholder),
    printed: [],
  };
  if (!unknown.expected || !seat?.placeholder) return unknown;
  try {
    const pdf = bytes || (await fetchPdfBytes(doc?.SignedUrl || doc?.URL));
    // A copy: the caller may go on to stamp the same bytes.
    const layout = await extractLayout(Uint8Array.from(pdf));
    return checkSignerName(layout, seat, doc, account);
  } catch (err) {
    console.log('signerName: the PDF could not be read for the name check:', err?.message || err);
    return unknown;
  }
}

/** The printed names that are not the account holder, in print order. */
export function mismatchedNames(check) {
  return (check?.printed || []).filter(p => !p.matches).map(p => p.name);
}

function quotedList(names) {
  const quoted = names.map(n => `"${n}"`);
  if (quoted.length <= 1) return quoted[0] || '';
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Why an agent did not sign: the names on the page, the name it signs as, and
 * the way forward.
 *
 * @param {{expected: string, role?: string, printed: Object[]}} check a `mismatch` check.
 * @returns {string}
 */
export function nameMismatchMessage(check) {
  const names = quotedList(mismatchedNames(check));
  const where = check?.role ? `as the ${check.role}` : 'next to your signature line';
  return `This document names ${names} ${where}, but your agent signs as ${check?.expected}. Fix the name in the document, or, if the user really signs for that party, ask them and call again with confirmNameMismatch: true.`;
}

/**
 * What the audit entry records for a signature made over a name mismatch
 * (`AuditTrail[].AllowedBy.nameMismatch`).
 *
 * @param {Object} check a `mismatch` check.
 * @param {{via?: string}} [extra] how it was confirmed, for an approval.
 * @returns {{printed: string, expected: string, confirmed: true, via?: string}}
 */
export function nameMismatchRecord(check, { via } = {}) {
  return {
    printed: clip(mismatchedNames(check).join(', '), 200),
    expected: oneLine(check?.expected),
    confirmed: true,
    ...(via ? { via } : {}),
  };
}
