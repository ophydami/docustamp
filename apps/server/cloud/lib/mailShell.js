import { appName, escapeHtml, mailLogoHtml, mailThemeColor, senderLineHtml } from '../../Utils.js';

/**
 * One shell for every mail the server sends.
 *
 * Nine builders (request, reminder, signed-by, completed, declined, copy,
 * withdrawn, OTP, plus the tenant's custom request/completion bodies) each
 * hand-rolled the same `<div style='background:#f5f5f5'>` markup with a solid
 * colour bar, a raw `<button>` inside an `<a>`, and a closing line that printed
 * the sender's bare address ("please contact the sender jane.doe@example.com
 * directly"). They drifted: some escaped their values, some did not; some set
 * a font, some left it to the client.
 *
 * `renderMail` renders the one layout: wordmark, a card with a theme-coloured
 * top rule, title, copy, an optional note, a details table, a button with the
 * plain link under it, and a "Questions about this document? Contact <Name>"
 * line that carries the address as a mailto link rather than printing it. The
 * tenant footer and the Powered-by line are added afterwards by
 * `applyBranding` (tenantBranding.js), which inserts them before `</body>`.
 *
 * Everything that comes from a document or a user is escaped here or by the
 * caller: `paragraphs` and `bodyHtml` are html (callers escape their values,
 * `strong()` helps), `title`, `greeting`, `note` and detail `value`s are text.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = '#1c1b18';
const INK_2 = '#3a3834';
const MUTED = '#6e6a62';
const FAINT = '#8a867e';
const LINE = '#e8e4dc';
const PAGE = '#f4f1ea';
const CARD_WIDTH = 560;

/** Escaped text in bold, for the document title or a person's name inside a paragraph. */
export function strong(text) {
  return `<strong style="color:${INK}">${escapeHtml(text)}</strong>`;
}

/** The call-to-action button plus the plain link under it (for clients that drop buttons). */
export function mailButton(url, label) {
  const href = escapeHtml(String(url || ''));
  return (
    `<p style="margin:22px 0 0"><a href="${href}" target="_blank" style="display:inline-block;background:${mailThemeColor};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:1;padding:13px 22px;border-radius:8px;font-family:${FONT}">${escapeHtml(label)}</a></p>` +
    `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">Or paste this link into your browser:<br/><a href="${href}" style="color:${mailThemeColor};word-break:break-all">${href}</a></p>`
  );
}

/** Whether a rendered body already carries `url`, raw or as the merge escapes it. */
export function bodyCarriesUrl(html, url) {
  const body = String(html || '');
  const link = String(url || '');
  if (!link) return true;
  return body.includes(link) || body.includes(escapeHtml(link));
}

function paragraph(html) {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK_2}">${html}</p>`;
}

function detailsTable(details) {
  const rows = (details || [])
    .filter(
      d => d && (d.html || (d.value !== undefined && d.value !== null && String(d.value).trim()))
    )
    .map(
      d =>
        `<tr><th align="left" style="padding:6px 18px 6px 0;font-weight:600;font-size:13px;color:${MUTED};white-space:nowrap;vertical-align:top">${escapeHtml(d.label)}</th>` +
        `<td style="padding:6px 0;font-size:14px;color:${INK};vertical-align:top">${d.html || escapeHtml(d.value)}</td></tr>`
    );
  if (!rows.length) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 6px;border-collapse:collapse;font-family:${FONT}">${rows.join('')}</table>`;
}

/**
 * "Questions about this document? Contact <Name>." The name links to the
 * address; the address itself is never printed (that is what the old footer
 * did, and a mail that leads with "jane.doe@example.com" reads like spam).
 */
function contactLine(sender) {
  const who = senderLineHtml(
    {
      senderName: sender?.senderName,
      senderMail: sender?.senderMail,
      organization: sender?.organization,
    },
    { color: mailThemeColor }
  );
  if (!who) return '';
  const org =
    sender?.organization && sender?.senderName ? ` at ${escapeHtml(sender.organization)}` : '';
  return `<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid ${LINE};font-size:13px;line-height:1.5;color:${MUTED}">Questions about this document? Contact ${who}${org}.</p>`;
}

/**
 * Render a mail.
 * @param {Object} o
 * @param {string} [o.title] heading inside the card (text).
 * @param {string} [o.preheader] hidden preview text (text).
 * @param {string} [o.greeting] e.g. "Hi Dana," (text).
 * @param {string[]} [o.paragraphs] body copy, html (escape your values).
 * @param {string} [o.bodyHtml] a whole custom body (tenant template), html.
 * @param {string} [o.note] the owner's note on the document (text).
 * @param {Array<{label: string, value?: string, html?: string}>} [o.details]
 * @param {{url: string, label: string}} [o.cta]
 * @param {{senderName?: string, senderMail?: string, organization?: string}} [o.sender]
 * @returns {string} a complete html document.
 */
export function renderMail({
  title = '',
  preheader = '',
  greeting = '',
  paragraphs = [],
  bodyHtml = '',
  note = '',
  details = [],
  cta = undefined,
  sender = undefined,
} = {}) {
  const content = [
    title
      ? `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:600;color:${INK};font-family:${FONT}">${escapeHtml(title)}</h1>`
      : '',
    greeting ? paragraph(escapeHtml(greeting)) : '',
    ...(paragraphs || []).filter(Boolean).map(paragraph),
    bodyHtml ? `<div style="font-size:15px;line-height:1.6;color:${INK_2}">${bodyHtml}</div>` : '',
    note
      ? `<div style="margin:4px 0 18px;padding:12px 14px;background:${PAGE};border-radius:8px;font-size:14px;line-height:1.6;color:${INK_2}"><em>${escapeHtml(note)}</em></div>`
      : '',
    detailsTable(details),
    cta?.url ? mailButton(cta.url, cta.label || 'Open') : '',
    contactLine(sender),
  ].join('');
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAGE}">${escapeHtml(preheader)}</div>`
    : '';
  return (
    "<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /><meta name='viewport' content='width=device-width' /></head>" +
    `<body style="margin:0;padding:0;background:${PAGE};font-family:${FONT};color:${INK}">${hidden}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" style="padding:28px 16px 8px">` +
    `<table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" style="width:${CARD_WIDTH}px;max-width:100%">` +
    `<tr><td style="padding:0 2px 14px">${mailLogoHtml()}</td></tr>` +
    `<tr><td style="background:#ffffff;border:1px solid ${LINE};border-top:4px solid ${mailThemeColor};border-radius:12px;padding:30px 34px;font-family:${FONT}">${content}</td></tr>` +
    `<tr><td style="padding:16px 2px 0;font-size:12px;line-height:1.5;color:${FAINT};text-align:center">This is an automated message from ${escapeHtml(appName)}.</td></tr>` +
    '</table></td></tr></table></body></html>'
  );
}

/**
 * The built-in signature-request mail (used when neither the document, the
 * tenant nor the sender defines a RequestSubject/RequestBody pair). Lived in
 * Utils.js as `mailTemplate`; the name is kept for its callers.
 */
export const mailTemplate = param => {
  const who = param.senderName || param.organization || 'Someone';
  const subject = `${param.senderName} has requested you to sign "${param.title}"`;
  const body = renderMail({
    title: 'Signature request',
    preheader: `${who} has asked you to sign ${param.title}`,
    paragraphs: [`${strong(who)} has asked you to review and sign ${strong(param.title)}.`],
    note: param.note,
    details: requestDetails(param),
    cta: { url: param.signingUrl, label: 'Review and sign' },
    sender: param,
  });
  return { subject, body };
};

/** Sender / Organization / Expires on, for the request and reminder mails. */
export function requestDetails(param) {
  return [
    { label: 'Sender', html: senderLineHtml(param, { color: mailThemeColor }) },
    { label: 'Organization', value: param.organization },
    { label: 'Expires on', value: param.localExpireDate },
  ];
}
