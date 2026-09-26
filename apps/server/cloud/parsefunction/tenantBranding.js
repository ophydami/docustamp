/**
 * Per-tenant mail branding (`partners_Tenant`).
 *
 * `updatetenant` lets a tenant admin set a sender display name, a plain-text
 * footer and a "hide the Powered by line" flag (§4.1). Every outgoing mail goes
 * through one of the three `sendMailProvider` implementations, so the branding
 * is applied there, in `withTenantBranding`, rather than at each call site.
 *
 * When the mail carries neither `tenantId` nor `extUserId` the tenant is not
 * knowable (password resets, the delete-account route) and behaviour is exactly
 * what it was before: the caller's `from`, and the default report footer.
 */
import { appName, complaintsEmail, serverAppId } from '../../Utils.js';
import { isValidEmail } from '../lib/email.js';
import { objectStorageOrigins } from '../lib/fileUrls.js';
import { localFileUrlParts } from './fileUpload.js';

export const MAX_TENANT_NAME = 100;
export const MAX_SENDER_NAME = 80;
export const MAX_FOOTER = 500;
export const MAX_URL_LENGTH = 2048;

/**
 * Tenant lookups are cheap but happen once per recipient, so cache briefly.
 *
 * The cache is per process and only holds successful reads. Two consequences
 * worth knowing about: `resetTenantBrandingCache` (called after a tenant save)
 * clears the process that served that request only, so in a multi-instance
 * deployment the other instances keep serving the previous branding until the
 * TTL expires; and entries are evicted lazily on read plus by a size cap, so
 * the map cannot grow without bound over the life of the process.
 */
const CACHE_TTL = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map();

/** Test seam: drop the memoised tenant rows. */
export function resetTenantBrandingCache() {
  cache.clear();
}

/** Drop every entry whose TTL has passed, then trim to the size cap. */
function evictStaleCacheEntries(now) {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL) cache.delete(key);
  }
  // Map iterates in insertion order, so the oldest inserts go first.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export const EMPTY_BRANDING = Object.freeze({
  tenantId: '',
  tenantName: '',
  senderName: '',
  footer: '',
  hidePoweredBy: false,
  replyTo: '',
  logo: '',
});

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The branding view of a tenant, from a Parse object or its JSON. */
export function brandingFromTenant(tenant) {
  if (!tenant) return EMPTY_BRANDING;
  const json = tenant.toJSON ? tenant.toJSON() : tenant;
  return {
    tenantId: json.objectId || '',
    tenantName: str(json.TenantName),
    senderName: str(json.EmailSenderName),
    footer: str(json.EmailFooter),
    hidePoweredBy: json.HidePoweredBy === true,
    replyTo: str(json.ReplyTo),
    logo: str(json.Logo),
  };
}

async function loadBranding(extUserId) {
  const extQuery = new Parse.Query('contracts_Users');
  extQuery.include('TenantId');
  const extUser = await extQuery.get(extUserId, { useMasterKey: true });
  const tenant = extUser?.get('TenantId');
  if (!tenant) return EMPTY_BRANDING;
  // A pointer that came back unfetched carries an id but no fields.
  if (!tenant.get('TenantName') && !tenant.get('EmailSenderName')) {
    await tenant.fetch({ useMasterKey: true }).catch(() => null);
  }
  return brandingFromTenant(tenant);
}

/**
 * Branding for a mail, resolved from the sending `extUserId`.
 *
 * `params.tenantId` used to win over `extUserId` and was read with the master
 * key without anyone checking that the caller belonged to that workspace. Since
 * `sendmailv3` lets an authenticated caller send with no document context at
 * all, passing a victim's tenant objectId was enough to send a fully branded
 * impersonation from the install's own sender: their display name, their
 * reply-to, their footer, their Powered-by setting. No server-side mail builder
 * ever passed `tenantId` (`requestMail.js` and `sendReminder.js` both pass
 * `extUserId`, and no frontend sends it either), so the parameter is simply not
 * consulted any more and the tenant always comes from the authorised sender.
 *
 * Never throws: mail must not fail over branding.
 *
 * @param {Object} params mail params as handed to `sendmailv3` / `sendSystemMail`.
 * @returns {Promise<Object>} a branding record, possibly `EMPTY_BRANDING`.
 */
export async function resolveTenantBranding(params = {}) {
  const extUserId = str(params.extUserId);
  if (!extUserId) return EMPTY_BRANDING;
  const key = `e:${extUserId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL) return hit.value;
  try {
    const value = await loadBranding(extUserId);
    // Only successful reads are memoised. A transient `partners_Tenant` read
    // failure used to be cached as "this tenant has no branding" for the full
    // TTL, so the rest of a bulk send went out unbranded, with the Powered-by
    // line a white-label workspace pays to hide, and nothing reported it.
    evictStaleCacheEntries(now);
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    console.log('resolveTenantBranding: could not read tenant', err?.message);
    return EMPTY_BRANDING;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The "Powered by" line: the platform attribution and spam-report link that
 * every mail used to carry unconditionally. `HidePoweredBy` removes it; with no
 * `APP_COMPLAINTS_EMAIL` it is a plain "Sent via <app name>" line.
 */
export function poweredByHtml(extUserId = '') {
  if (!complaintsEmail) {
    return `<p style="font-size: 13px; color:grey; text-align: center;">Sent via ${appName}.</p>`;
  }
  return `<p style="font-size: 13px; color:grey; text-align: center;">If you think this email is inappropriate or spam, you may file a complaint with ${appName} <a href="mailto:${complaintsEmail}?subject=Spam%20report%20for%20user%20ID%20${extUserId}&body=Hello%20Support%20Team%2C%0D%0A%0D%0AI%E2%80%99m%20reporting%20spam%20activity%20coming%20from%20a%20sender%20using%20your%20platform.%0D%0A%0D%0AThe%20messages%20I%20received%20appear%20unsolicited%20and%20suspicious.%20The%20user%20ID%20associated%20with%20the%20emails%20is%3A%20${extUserId}.%20Please%20investigate%20this%20account%20and%20take%20appropriate%20action%20to%20prevent%20further%20abuse.%0D%0A%0D%0AIf%20you%20need%20additional%20details%2C%20I%E2%80%99m%20happy%20to%20provide%20the%20original%20email%20headers%20or%20screenshots.%0D%0A%0D%0AThank%20you%20for%20looking%20into%20this.%0D%0A%0D%0ABest%20regards%2C%0D%0A%5BYour%20Name%5D">here</a>.</p>`;
}

/** Custom footer (escaped, newlines kept) followed by the Powered by line. */
export function mailFooterHtml(branding, extUserId = '') {
  const parts = [];
  if (branding?.footer) {
    parts.push(
      `<p style="font-size: 13px; color:grey; text-align: center;">${escapeHtml(
        branding.footer
      ).replace(/\r?\n/g, '<br/>')}</p>`
    );
  }
  if (!branding?.hidePoweredBy) parts.push(poweredByHtml(extUserId));
  return parts.join('');
}

/** The same footer for a text/plain part: no markup, no complaint link markup. */
export function mailFooterText(branding) {
  const parts = [];
  if (branding?.footer) parts.push(branding.footer);
  if (!branding?.hidePoweredBy) {
    parts.push(
      complaintsEmail
        ? `Sent via ${appName}. Report spam to ${complaintsEmail}.`
        : `Sent via ${appName}.`
    );
  }
  return parts.join('\n');
}

/**
 * Put the footer inside the document rather than after it. Mail templates end
 * in `</body></html>`, and appending to the string produced markup that some
 * clients drop and every validator rejects.
 */
function withFooter(html, footer) {
  if (!footer) return html;
  const closing = html.search(/<\/body\s*>/i);
  if (closing === -1) return html + footer;
  return html.slice(0, closing) + footer + html.slice(closing);
}

/**
 * Apply branding to one set of mail params. The address stays whatever the
 * transport is configured with; only the display name, the reply-to fallback
 * and the footer change.
 *
 * Precedence is deliberate: a workspace that has set `EmailSenderName` wants
 * every message to carry the workspace's name, so it wins over the per-document
 * sender name the mail builders compute. Without one, the per-document value
 * (which honours the sender's `UseNameAsSender` preference) is used unchanged.
 */
export function applyBranding(params = {}, branding = EMPTY_BRANDING) {
  const extUserId = str(params.extUserId);
  const branded = {
    ...params,
    from: branding.senderName || params.from || '',
    replyto: str(params.replyto) || branding.replyTo || '',
    __branded: true,
  };
  // A text-only mail used to have `html: ''` forced into its params, which both
  // dropped its tenant footer and handed nodemailer an empty HTML alternative.
  if (params?.html) {
    branded.html = withFooter(params.html, mailFooterHtml(branding, extUserId));
  } else if (params?.text) {
    const footer = mailFooterText(branding);
    if (footer) branded.text = `${params.text}\n\n${footer}`;
  }
  return branded;
}

/**
 * Idempotent: params already branded (by `sendreminder`, which brands before it
 * hands them to its pluggable transport) pass straight through.
 * @param {Object} params mail params.
 * @returns {Promise<Object>} branded mail params.
 */
export async function withTenantBranding(params = {}) {
  if (params.__branded) return params;
  return applyBranding(params, await resolveTenantBranding(params));
}

/* ------------------------------------------------------- write-side checks */

function invalid(message) {
  return new Parse.Error(Parse.Error.VALIDATION_ERROR, message);
}

/** A single line of user text: no control characters, no angle brackets. */
function assertPlainLine(value, label, max) {
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(text)) {
    throw invalid(`${label} contains characters that are not allowed.`);
  }
  return text;
}

export function normaliseTenantName(value) {
  const name = assertPlainLine(value, 'Workspace name', MAX_TENANT_NAME);
  if (!name) throw invalid('Workspace name cannot be empty.');
  return name;
}

/** Goes into a mail header, so CR/LF would be a header-injection vector. */
export function normaliseSenderName(value) {
  return assertPlainLine(value, 'Sender name', MAX_SENDER_NAME);
}

/** Plain text, rendered escaped; newlines are kept, markup is refused. */
export function normaliseFooter(value) {
  if (typeof value !== 'string') throw invalid('Footer text must be text.');
  const text = value.trim();
  if (text.length > MAX_FOOTER) {
    throw invalid(`Footer text must be ${MAX_FOOTER} characters or fewer.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f<>]/.test(text)) {
    throw invalid('Footer text must be plain text.');
  }
  return text;
}

export function normaliseReplyTo(value) {
  const email = assertPlainLine(value, 'Reply-to address', 254).toLowerCase();
  if (email && !isValidEmail(email)) throw invalid('Reply-to must be a valid email address.');
  return email;
}

/**
 * A logo must be a file this deployment produced: a `/files/<appId>/<name>` URL
 * on an origin this server answers on, or an object on the configured storage
 * bucket. The query string (a presigned token) is dropped so the stored value
 * stays re-signable by the `partners_Tenant` afterFind trigger.
 *
 * Both tests are the shared ones: `localFileUrlParts` (which already knows our
 * own origins, the Parse file path shape and the safe file-name pattern) and
 * `objectStorageOrigins`. This function used to carry its own `serverHosts()`,
 * `storageHosts()` and file-name regular expression, which disagreed with them:
 * the storage copy read only `DO_ENDPOINT`/`DO_SPACE` and never `DO_BASEURL`, so
 * a logo stored on a bucket fronted by a public base url was refused.
 *
 * @param {string} rawUrl candidate url.
 * @returns {string} the url to store.
 */
export function normaliseLogoUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const value = rawUrl.trim();
  if (value.length > MAX_URL_LENGTH) throw invalid('Logo url is too long.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid('Logo must be a url.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid('Logo must be an http(s) url.');
  }
  const local = localFileUrlParts(value);
  if (local && local.appId === serverAppId) return local.url;
  if (objectStorageOrigins().has(parsed.origin)) return `${parsed.origin}${parsed.pathname}`;
  throw invalid('Logo must be a file uploaded to this server.');
}
