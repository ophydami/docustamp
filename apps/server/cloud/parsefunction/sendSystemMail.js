import { sendMail } from '../lib/mailTransport.js';
import { withTenantBranding } from './tenantBranding.js';

/** Longest sender display name kept; `updatetenant` uses the same limit. */
const MAX_FROM = 80;

/**
 * Strip anything that would break out of a mail header.
 *
 * `from` and `replyto` are pasted straight into `From:`/`Reply-To:` by the
 * transport (`from + ' <' + mailsender + '>'`), so a CR/LF in either injects a
 * header, and an angle bracket opens a second address group ahead of the real
 * sender. Server-originated mail must never fail over a bad display name, so
 * this sanitises rather than throws; `sendmailv3`, whose values come from a
 * client, refuses them instead.
 *
 * @param {string} value candidate header text.
 * @param {number} [max] length cap.
 * @returns {string} a single safe line.
 */
export function safeHeaderLine(value, max = MAX_FROM) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** Apply `safeHeaderLine` to the two params that reach a mail header. */
export function safeMailHeaders(params = {}) {
  const from = safeHeaderLine(params.from);
  const replyto = safeHeaderLine(params.replyto, 254);
  if (from === params.from && replyto === (params.replyto || '')) return params;
  return { ...params, from, ...(replyto ? { replyto } : {}) };
}

/**
 * Server-originated mail (reminders, request mails, declines, account mail).
 *
 * Called as `sendSystemMail({ params })` and answers the shared transport result:
 * `{status: 'success'|'error', reason?, provider, messageId?}`. Every caller must
 * treat anything that is not `'success'` as a failure; it never returns undefined.
 */
async function sendSystemMail(req) {
  // Same tenant branding as `sendmailv3`; see tenantBranding.js.
  const params = await withTenantBranding(req?.params || {});
  return await sendMail(safeMailHeaders(params));
}

export default sendSystemMail;
