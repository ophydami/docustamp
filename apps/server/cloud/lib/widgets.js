import crypto from 'node:crypto';
import { color as SIGNER_COLORS, prefillBlockColor } from '../../Utils.js';

/**
 * Server-side widget factory. Produces exactly the `Placeholders[].placeHolder[].pos[]`
 * objects the frontends write (apps/web/docs/BACKEND_API.md §7.2, §7.3), so a
 * document prepared by the API or by the AI opens in the editor and signs like
 * one built by hand. Casing is load-bearing: `xPosition`/`yPosition`/`scale`/`zIndex`
 * are lower-camel, `Width`/`Height`/`IsResize` upper-camel.
 */

export const PREFILL_ROLE = 'prefill';

export const WIDGET_TYPES = [
  'signature',
  'stamp',
  'initials',
  'text input',
  'name',
  'job title',
  'company',
  'email',
  'date',
  'text',
  'cells',
  'checkbox',
  'dropdown',
  'radio button',
  'image',
  'draw',
];

/** Default size in PDF points at scale 1 (§7.1). */
export const WIDGET_SPEC = {
  signature: { width: 150, height: 60, minWidth: 60, minHeight: 24 },
  stamp: { width: 150, height: 60, minWidth: 40, minHeight: 24, isStamp: true },
  initials: { width: 50, height: 50, minWidth: 24, minHeight: 20 },
  'text input': { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  name: { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  'job title': { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  company: { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  email: { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  date: { width: 100, height: 20, minWidth: 50, minHeight: 14 },
  text: { width: 150, height: 19, minWidth: 40, minHeight: 14 },
  cells: { width: 112, height: 22, minWidth: 40, minHeight: 16 },
  checkbox: { width: 15, height: 19, minWidth: 12, minHeight: 12 },
  dropdown: { width: 120, height: 22, minWidth: 40, minHeight: 16 },
  'radio button': { width: 5, height: 10, minWidth: 5, minHeight: 10 },
  image: { width: 70, height: 70, minWidth: 24, minHeight: 24, isStamp: true },
  draw: { width: 150, height: 60, minWidth: 40, minHeight: 24 },
};

/** Types the API accepts under friendlier aliases. */
const TYPE_ALIASES = {
  textbox: 'text input',
  textinput: 'text input',
  text_input: 'text input',
  'text-input': 'text input',
  input: 'text input',
  sign: 'signature',
  initial: 'initials',
  jobtitle: 'job title',
  job_title: 'job title',
  'job-title': 'job title',
  title: 'job title',
  radio: 'radio button',
  radiobutton: 'radio button',
  radio_button: 'radio button',
  select: 'dropdown',
  check: 'checkbox',
  fullname: 'name',
  full_name: 'name',
};

export function normaliseWidgetType(type) {
  if (typeof type !== 'string') return null;
  const t = type.trim().toLowerCase();
  if (WIDGET_TYPES.includes(t)) return t;
  return TYPE_ALIASES[t] || null;
}

const DEFAULT_FONT_SIZE = 12;
const DEFAULT_DATE_FORMAT = 'MM/dd/yyyy';
const DEFAULT_OPTION_VALUES = ['Option-1', 'Option-2'];
const OPTION_ROW_HEIGHT = 15;
const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * `randomId(8)` in the old app: an integer with `digits` digits, stored as a Number.
 *
 * The whole field API addresses fields by this key, so a collision inside one
 * document means editing one field and deleting two. Pass the keys already in
 * use (see `fieldKeysIn`) and the draw is repeated until it is free; the set is
 * updated in place, so successive calls in one pass cannot collide either.
 *
 * @param {number} [digits]
 * @param {Set<number|string>} [used] keys already taken in this document.
 * @returns {number}
 */
export function randomKey(digits = 8, used) {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits - 1;
  const draw = () => min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
  if (!used) return draw();
  const taken = used instanceof Set ? used : new Set(used);
  for (let attempt = 0; attempt < 50; attempt++) {
    const key = draw();
    if (!taken.has(key) && !taken.has(String(key))) {
      taken.add(key);
      taken.add(String(key));
      return key;
    }
  }
  return draw();
}

/** Every field key already used in a `Placeholders` array, as numbers and strings. */
export function fieldKeysIn(placeholders) {
  const keys = new Set();
  for (const g of placeholders || []) {
    for (const p of g?.placeHolder || []) {
      for (const w of p?.pos || []) {
        if (w?.key === undefined || w?.key === null) continue;
        keys.add(w.key);
        keys.add(String(w.key));
      }
    }
  }
  return keys;
}

function slug(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

export function widgetName(type, count) {
  return `${type}-${slug(6)}-${count}`;
}

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** `addWidgetOptions` from the old app, plus the defaults the rebuilt editor seeds (§7.3). */
export function defaultOptions(type, count, signer = {}) {
  const base = { name: widgetName(type, count), status: 'required' };
  const text = { fontSize: DEFAULT_FONT_SIZE, fontColor: 'black' };
  switch (type) {
    case 'checkbox':
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: [],
        layout: 'vertical',
        isReadOnly: false,
        isHideLabel: false,
        ...text,
      };
    case 'radio button':
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: '',
        layout: 'vertical',
        isReadOnly: false,
        isHideLabel: false,
        ...text,
      };
    case 'dropdown':
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: '',
        isReadOnly: false,
        ...text,
      };
    case 'text input':
      return { ...base, isReadOnly: false, ...text };
    case 'cells':
      return {
        ...base,
        cellCount: 5,
        defaultValue: '',
        validation: { type: '', pattern: '' },
        isReadOnly: false,
        ...text,
      };
    case 'name':
      return { ...base, defaultValue: signer?.name || '', ...text };
    case 'company':
      return { ...base, defaultValue: signer?.company || '', ...text };
    case 'job title':
      return { ...base, defaultValue: signer?.jobTitle || '', ...text };
    case 'email':
      return {
        ...base,
        validation: { type: 'email', pattern: '' },
        defaultValue: signer?.email || '',
        ...text,
      };
    case 'date':
      return {
        ...base,
        response: '',
        isReadOnly: false,
        validation: { type: 'date-format', format: DEFAULT_DATE_FORMAT },
        ...text,
      };
    case 'text':
      return { ...base, defaultValue: '', ...text };
    case 'signature':
    case 'initials':
      return { ...base, rotation: 0 };
    default:
      return base;
  }
}

function isListType(type) {
  return type === 'dropdown' || type === 'radio button' || type === 'checkbox';
}

/** A sane fallback for a widget whose stored type predates `WIDGET_SPEC`. */
const FALLBACK_SPEC = Object.freeze({ width: 150, height: 19, minWidth: 12, minHeight: 12 });

/**
 * The spec for a stored widget type, aliases and legacy names included.
 * Never undefined: an unknown type gets the fallback rather than throwing a bare
 * `TypeError` deep inside an edit.
 */
export function specFor(type) {
  return WIDGET_SPEC[type] || WIDGET_SPEC[normaliseWidgetType(type)] || FALLBACK_SPEC;
}

/**
 * Types whose `defaultValue` is the signer's own identity. They are seeded when
 * the widget is built, so they have to be re-seeded whenever the person in a
 * recipient slot changes, or the new signer sees the previous one's details.
 */
const AUTOFILL_DEFAULTS = {
  name: c => String(c?.name || c?.Name || ''),
  email: c => String(c?.email || c?.Email || '').toLowerCase(),
  company: c => String(c?.company || c?.Company || ''),
  'job title': c => String(c?.jobTitle || c?.JobTitle || ''),
};

/**
 * Re-seed the identity `defaultValue`s of a group's widgets from `contact`.
 * Returns the group; `placeHolder` pages are rewritten with fresh widget objects.
 *
 * @param {Object} group a Placeholders group.
 * @param {Object} contact `{name, email, company, jobTitle}` (or the Contactbook casing).
 */
export function reseedAutofillDefaults(group, contact) {
  for (const page of group?.placeHolder || []) {
    page.pos = (page.pos || []).map(w => {
      const seed = AUTOFILL_DEFAULTS[normaliseWidgetType(w?.type) || w?.type];
      if (!seed) return w;
      return { ...w, options: { ...(w?.options || {}), defaultValue: seed(contact) } };
    });
  }
  return group;
}

export function heightForOptions(type, count) {
  const spec = specFor(type);
  const known = normaliseWidgetType(type);
  if (known !== 'checkbox' && known !== 'radio button') return spec.height;
  return spec.height + Math.max(0, count - 1) * OPTION_ROW_HEIGHT;
}

/**
 * Build one widget.
 * @param {Object} input
 * @param {string} input.type widget type (aliases accepted)
 * @param {number} input.x top-left x in PDF points
 * @param {number} input.y top-left y in PDF points (from the page top)
 * @param {number} [input.width]
 * @param {number} [input.height]
 * @param {number} [input.count] how many widgets of this type the signer already has
 * @param {Object} [input.signer] `{ name, email, company, jobTitle }` for auto-fill defaults
 * @param {boolean} [input.required=true]
 * @param {string[]} [input.values] options for dropdown/radio/checkbox
 * @param {string} [input.label] stored as `options.hint` (max 40 chars)
 * @param {*} [input.defaultValue] pre-filled value (stored as `options.defaultValue`)
 * @param {boolean} [input.readOnly] stored as `options.isReadOnly`
 * @param {Object} [input.options] extra option keys merged last (e.g. validation)
 * @param {number} [input.zIndex]
 * @param {Set<number|string>} [input.usedKeys] keys already used in this document
 */
/**
 * The stored form of a list field's `defaultValue`, which the API accepts in
 * either of the two shapes that were in circulation:
 *
 *  - checkbox: the legacy signer and the stamping code tick by option INDEX
 *    (`defaultValue.includes(i)`), so the stored form is an array of integer
 *    indexes. Labels given by the API (`["Elected"]`) are mapped to indexes;
 *    an unknown label is refused rather than silently dropped.
 *  - radio button / dropdown: the stored form is the option LABEL (the
 *    stamping code compares `label.trim() === chosen.trim()`); an index given by
 *    the API is mapped to its label.
 *  - everything else: stored as given.
 *
 * `fieldJson` presents checkbox defaults back as labels, so the API speaks
 * labels both ways while the widget JSON keeps the legacy contract.
 */
export function normaliseDefaultValue(type, values, raw) {
  const known = normaliseWidgetType(type) || type;
  const list = Array.isArray(values) ? values : [];
  const toIndex = v => {
    if (Number.isInteger(v) && v >= 0 && v < list.length) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim()) && Number(v) < list.length && !list.includes(v)) {
      return Number(v);
    }
    const i = list.findIndex(l => String(l).trim().toLowerCase() === String(v).trim().toLowerCase());
    if (i === -1) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `defaultValue "${v}" is not one of the options (${list.join(', ') || 'none'}).`
      );
    }
    return i;
  };
  if (known === 'checkbox') {
    if (raw === '' || raw === null || raw === undefined) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return [...new Set(arr.map(toIndex))].sort((a, b) => a - b);
  }
  if (known === 'radio button' || known === 'dropdown') {
    if (raw === '' || raw === null || raw === undefined) return '';
    const one = Array.isArray(raw) ? raw[0] : raw;
    if (one === undefined || one === '') return '';
    return String(list[toIndex(one)]);
  }
  return raw;
}

/** The API view of a stored `defaultValue`: checkbox indexes back to labels. */
export function presentDefaultValue(type, values, stored) {
  const known = normaliseWidgetType(type) || type;
  if (known === 'checkbox' && Array.isArray(stored)) {
    const list = Array.isArray(values) ? values : [];
    return stored.map(v => (Number.isInteger(v) && list[v] !== undefined ? list[v] : v));
  }
  return stored;
}

export function createWidget(input) {
  const type = normaliseWidgetType(input.type);
  if (!type) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Unknown field type "${input.type}".`);
  }
  const spec = WIDGET_SPEC[type];
  const options = defaultOptions(type, input.count ?? 1, input.signer);
  if (input.required === false && type !== 'signature') options.status = 'optional';
  if (Array.isArray(input.values) && input.values.length && isListType(type)) {
    options.values = [...new Set(input.values.map(v => String(v).trim()).filter(Boolean))];
  }
  if (typeof input.label === 'string' && input.label.trim()) {
    options.hint = input.label.trim().slice(0, 40);
  }
  // A list field with no options at all used to keep the "Option-1 / Option-2"
  // placeholders and grow to two rows, which is never what a single printed tick
  // box means. The label is the only thing that box is about, so it becomes the
  // one option.
  if (isListType(type) && !(Array.isArray(input.values) && input.values.length) && options.hint) {
    options.values = [options.hint];
  }
  // `defaultValue` and `readOnly` are part of the public field shape, so they
  // belong here rather than being patched on by one of the two builders (they
  // used to be dropped entirely on the create path).
  if (input.defaultValue !== undefined) {
    options.defaultValue = normaliseDefaultValue(type, options.values, input.defaultValue);
  }
  if (input.readOnly !== undefined) options.isReadOnly = input.readOnly === true;
  if (input.hideLabel !== undefined && isListType(type)) options.isHideLabel = input.hideLabel === true;
  if (input.options && typeof input.options === 'object') Object.assign(options, input.options);

  const width = Math.max(spec.minWidth, Number(input.width) || spec.width);
  const listHeight =
    isListType(type) && options.values?.length
      ? heightForOptions(type, options.values.length)
      : spec.height;
  const height = Math.max(spec.minHeight, Number(input.height) || listHeight);

  return {
    key: randomKey(8, input.usedKeys),
    type,
    xPosition: round2(input.x),
    yPosition: round2(input.y),
    isStamp: Boolean(spec.isStamp),
    scale: 1,
    zIndex: input.zIndex ?? 1,
    IsResize: false,
    options,
    Width: round2(width),
    Height: round2(height),
  };
}

/** The colour the Nth role gets (same palette as both frontends). */
export function roleColor(index, isPrefill = false) {
  if (isPrefill) return prefillBlockColor;
  return SIGNER_COLORS[index % SIGNER_COLORS.length];
}

/**
 * Turn per-role field lists into the persisted `Placeholders` array (§6.2).
 * @param {Array<{Id?: number, role: string, name?: string, email?: string, contactId?: string, isPrefill?: boolean, fields: Array<Object>}>} roles
 *   each field is `createWidget` input plus `page` (1-based)
 * @returns {Array<Object>}
 */
export function buildPlaceholders(roles) {
  let z = 1;
  const groups = [];
  // One set for the whole document: two roles can never draw the same field key.
  const usedKeys = new Set();
  roles.forEach((role, index) => {
    const isPrefill = role.isPrefill === true || role.role === PREFILL_ROLE;
    const group = {
      Id: role.Id ?? randomKey(8),
      Role: isPrefill ? PREFILL_ROLE : role.role || `Role ${index + 1}`,
      blockColor: roleColor(index, isPrefill),
      signerObjId: role.contactId || '',
      signerPtr: role.contactId
        ? { __type: 'Pointer', className: 'contracts_Contactbook', objectId: role.contactId }
        : {},
      email: (role.email || '').toLowerCase(),
    };
    if (isPrefill) group.Name = 'Prefill by owner';
    const byPage = new Map();
    const counts = new Map();
    for (const field of role.fields || []) {
      const type = normaliseWidgetType(field.type);
      if (!type) continue;
      const count = (counts.get(type) || 0) + 1;
      counts.set(type, count);
      const widget = createWidget({
        ...field,
        type,
        count,
        zIndex: z++,
        usedKeys,
        signer: {
          name: role.name,
          email: role.email,
          company: role.company,
          jobTitle: role.jobTitle,
        },
      });
      const page = Math.max(1, Math.floor(Number(field.page) || 1));
      const list = byPage.get(page) || [];
      list.push(widget);
      byPage.set(page, list);
    }
    const placeHolder = [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageNumber, pos]) => ({ pageNumber, pos }));
    if (placeHolder.length) group.placeHolder = placeHolder;
    groups.push(group);
  });
  return groups;
}

/** Every field on the document, owner-prefill boxes included: what summaries report. */
export function countFields(placeholders) {
  let n = 0;
  for (const g of placeholders || [])
    for (const p of g?.placeHolder || []) n += (p.pos || []).length;
  return n;
}

/**
 * Only the fields a real signer has to fill or sign.
 *
 * The send gate and review's `no_fields` error use this rather than the total:
 * a document whose only fields are the owner's prefill boxes gives every signer
 * a link with nothing assigned to them, and used to pass both.
 */
export function countSignerFields(placeholders) {
  let n = 0;
  for (const g of placeholders || []) {
    if (g?.Role === PREFILL_ROLE) continue;
    for (const p of g?.placeHolder || []) n += (p.pos || []).length;
  }
  return n;
}

/* ------------------------------------------------------- copying a document */

/**
 * Everything that belongs to a signing run rather than to the layout, whether it
 * sits on a role group or on a widget.
 */
export const SIGNED_STATE_KEYS = Object.freeze([
  'SignUrl',
  'SignedUrl',
  'SignedOn',
  'IsSigned',
  'Signature',
  'signedUrl',
]);

/** The same, inside `options`. */
export const SIGNED_OPTION_KEYS = Object.freeze([
  'response',
  'signedUrl',
  'SignUrl',
  'Signature',
  'SignedOn',
]);

/** A copy of `obj` without `keys`. */
function without(obj, keys) {
  const out = { ...(obj || {}) };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * Reset one widget for a copy of the document it lives on.
 *
 * @param {Object} widget the stored widget.
 * @param {Object} [opts] see `resetPlaceholdersForCopy`.
 * @returns {Object} a new widget object; the input is never mutated.
 */
export function resetWidgetForCopy(widget, opts = {}) {
  const w = without(widget || {}, [...SIGNED_STATE_KEYS, 'signatureType']);
  // Only on the paths that already did it. `text` is a real type of its own in
  // this schema (a static label with a `defaultValue`), and it is also what the
  // original app called what is now `text input`, so rewriting it unconditionally
  // would turn every label on a duplicated document into an input box.
  const type = opts.legacyTextType && w.type === 'text' ? 'text input' : w.type;
  // `response` and the signature image go with `SIGNED_OPTION_KEYS`, and
  // `signatureType` (the kind of signature the previous signer chose) with
  // `SIGNED_STATE_KEYS` above. They are *removed* rather than blanked, so a copy
  // carries no trace of the run it came from: every reader here treats an absent
  // value and an empty one the same, and a stored `""` is one more thing to have
  // to strip later.
  const options = without(widget?.options || {}, SIGNED_OPTION_KEYS);
  // A `defaultValue` is the *sender's* pre-filled value rather than an answer, so
  // it only goes when the copy is meant to start blank: a template made from a
  // signed document, or a recreate of a run that is over.
  if (opts.clearDefaults && options.defaultValue !== undefined) options.defaultValue = '';
  if (opts.clearReadOnly && options.isReadOnly) options.isReadOnly = false;
  if (opts.requireAll) options.status = 'required';
  const out = { ...w, type, options };
  if (opts.newKeys) out.key = randomKey(8, opts.usedKeys);
  return out;
}

/**
 * The one copy-and-reset for `Placeholders`.
 *
 * `duplicateDocument`, `recreateDocument`, `createDuplicate` and `saveAsTemplate`
 * each had their own version of this, and they disagreed about what a copy keeps:
 * only one of them dropped the per-signer signed urls, only one normalised the
 * legacy `text` type, only one drew fresh field keys, and `createDuplicate`
 * carried a template's stored answers into every document made from it.
 *
 * @param {Array} placeholders the stored groups.
 * @param {Object} [opts]
 * @param {boolean} [opts.keepPrefill=true] keep the owner's prefill groups.
 * @param {boolean} [opts.unbind=false] clear the recipient binding (signerObjId,
 *   signerPtr, email) and renumber roles: what a template needs.
 * @param {boolean} [opts.newKeys=false] draw fresh field keys, so the copy and
 *   the original can be edited independently.
 * @param {boolean} [opts.clearDefaults=false] blank `options.defaultValue` too.
 * @param {boolean} [opts.clearReadOnly=false] make read-only fields editable again.
 * @param {boolean} [opts.requireAll=false] mark every field required.
 * @param {boolean} [opts.legacyTextType=false] rewrite the original app's `text`
 *   type to `text input` (only the paths that already did it pass this).
 * @returns {Array} new groups; the input is never mutated.
 */
export function resetPlaceholdersForCopy(placeholders, opts = {}) {
  const list = Array.isArray(placeholders) ? placeholders : [];
  const groups = opts.keepPrefill === false ? list.filter(g => g?.Role !== PREFILL_ROLE) : list;
  // One set for the whole document: two roles can never draw the same field key.
  const usedKeys = opts.newKeys ? new Set() : undefined;
  const widgetOpts = { ...opts, usedKeys };
  return groups.map((group, index) => {
    const g = without(group, SIGNED_STATE_KEYS);
    const out = {
      ...g,
      placeHolder: (g.placeHolder || []).map(page => ({
        ...page,
        pos: (page?.pos || []).map(w => resetWidgetForCopy(w, widgetOpts)),
      })),
    };
    if (opts.unbind) {
      out.signerObjId = '';
      out.signerPtr = {};
      out.email = '';
      out.Role = group?.Role || `Role ${index + 1}`;
    }
    return out;
  });
}

const MAX_WIDGET_SIZE = 5000;

/**
 * Check (and repair) a caller-supplied `Placeholders` array.
 *
 * `create_document { placeholders }` used to be persisted exactly as sent, so a
 * widget with `xPosition: "abc"` or an unknown type stored cleanly, rendered in
 * the editor and only blew up at stamping time, after the signer had signed.
 * Types are normalised (aliases and legacy names included), sizes fall back to
 * the type's spec, and anything that cannot be guessed is refused.
 *
 * @param {Array} placeholders groups as sent.
 * @returns {Array} the same groups with validated widgets.
 */
export function sanitisePlaceholders(placeholders) {
  const groups = Array.isArray(placeholders) ? placeholders : [];
  const fail = message => new Parse.Error(Parse.Error.VALIDATION_ERROR, message);
  return groups.map((g, gi) => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      throw fail(`placeholders[${gi}] is not a role group.`);
    }
    const pages = Array.isArray(g.placeHolder) ? g.placeHolder : [];
    const placeHolder = pages.map((p, pi) => {
      const where = `placeholders[${gi}].placeHolder[${pi}]`;
      const pageNumber = Math.floor(Number(p?.pageNumber));
      if (!Number.isFinite(pageNumber) || pageNumber < 1)
        throw fail(`${where}: pageNumber must be >= 1.`);
      const pos = (Array.isArray(p?.pos) ? p.pos : []).map((w, wi) => {
        const at = `${where}.pos[${wi}]`;
        const type = normaliseWidgetType(w?.type);
        if (!type) throw fail(`${at}: unknown field type "${w?.type}".`);
        const x = Number(w?.xPosition);
        const y = Number(w?.yPosition);
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw fail(`${at}: xPosition and yPosition must be numbers.`);
        const spec = specFor(type);
        const width = Number(w?.Width);
        const height = Number(w?.Height);
        return {
          ...w,
          type,
          key: typeof w?.key === 'number' ? w.key : randomKey(8),
          xPosition: round2(x),
          yPosition: round2(y),
          Width: round2(
            Math.min(
              MAX_WIDGET_SIZE,
              Math.max(spec.minWidth, Number.isFinite(width) && width > 0 ? width : spec.width)
            )
          ),
          Height: round2(
            Math.min(
              MAX_WIDGET_SIZE,
              Math.max(spec.minHeight, Number.isFinite(height) && height > 0 ? height : spec.height)
            )
          ),
          options:
            w?.options && typeof w.options === 'object' ? w.options : defaultOptions(type, wi + 1),
        };
      });
      return { ...p, pageNumber, pos };
    });
    if (placeHolder.length) return { ...g, placeHolder };
    const { placeHolder: _empty, ...rest } = g;
    return rest;
  });
}
