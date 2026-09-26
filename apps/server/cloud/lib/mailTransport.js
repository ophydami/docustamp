/**
 * The one place a mail actually leaves this server.
 *
 * `sendmailv3`, `sendSystemMail` and `sendMailWithAttachment` each carried their
 * own copy of the provider dance, and every copy decided "did it send?" wrongly:
 * nodemailer's info object has `accepted`/`rejected` and never an `err` key, so
 * `if (!res.err)` reported success for a message the SMTP server had rejected,
 * and the Mailgun branch fell off the end (returning `undefined`) on any non-200.
 * Callers then read "not `{status:'error'}`" as success and marked documents as
 * mailed that were never mailed.
 *
 * This module answers one shape and never returns undefined:
 *
 *   sendMail({from, replyto, recipient, cc, bcc, subject, text, html,
 *             extUserId, attachments}) ->
 *     {status: 'success'|'error', reason?: string, provider: string, messageId?: string}
 *
 * `attachments` is a provider-neutral `[{filename, content: Buffer}]`; the
 * provider-specific spelling (nodemailer `attachments[].content`, Mailgun
 * `attachment[].data`) is applied here.
 */
import formData from 'form-data';
import Mailgun from 'mailgun.js';
import { createTransport } from 'nodemailer';
import axios from 'axios';
import https from 'node:https';
import { smtpenable, smtpsecure, updateMailCount } from '../../Utils.js';

/** Reason used when neither SMTP nor Mailgun is configured. */
export const NO_PROVIDER_REASON = 'No mail provider is configured on this server.';

// Test seam: `setMailTransport(async params => ({status: 'success'}))`. Specs use
// it so no spec ever depends on SMTP or Mailgun being reachable.
let transportOverride = null;

/**
 * Replace the delivery step. Pass `null` to restore the real providers.
 * @param {Function|null} transport receives the same params `sendMail` takes and
 *   returns (or resolves to) a mail result. A partial result is normalised.
 */
export function setMailTransport(transport) {
  transportOverride = typeof transport === 'function' ? transport : null;
}

/** Which provider a send would use right now. */
export function currentProvider() {
  if (transportOverride) return 'stub';
  if (smtpenable) return 'smtp';
  if (process.env.MAILGUN_API_KEY) return 'mailgun';
  return 'none';
}

function errorResult(reason, provider) {
  return { status: 'error', reason, message: reason, provider: provider || currentProvider() };
}

function successResult(provider, messageId) {
  return { status: 'success', provider, ...(messageId ? { messageId } : {}) };
}

function readableError(err) {
  const detail =
    err?.details ||
    err?.response?.body?.message ||
    err?.response?.data?.message ||
    err?.response?.data ||
    err?.message;
  if (typeof detail === 'string' && detail) return detail;
  if (detail) {
    try {
      return JSON.stringify(detail).slice(0, 500);
    } catch {
      /* fall through to the generic text */
    }
  }
  return 'The mail provider rejected the message.';
}

function normaliseAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(item => item && item.content && item.filename);
}

/** The provider-neutral message, in the spelling the chosen provider wants. */
function buildMessage(params, provider) {
  const from = params.from || '';
  const mailsender = provider === 'smtp' ? process.env.SMTP_USER_EMAIL : process.env.MAILGUN_SENDER;
  const replyto = params?.replyto || '';
  const message = {
    from: from + ' <' + mailsender + '>',
    to: params.recipient,
    subject: params.subject,
    text: params.text || 'mail',
    html: params?.html || '',
    bcc: params.bcc ? params.bcc : undefined,
    cc: params.cc ? params.cc : undefined,
    replyTo: replyto ? replyto : undefined,
  };
  const attachments = normaliseAttachments(params.attachments);
  if (attachments.length) {
    if (provider === 'smtp') {
      message.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }));
    } else {
      message.attachment = attachments.map(a => ({ filename: a.filename, data: a.content }));
    }
  }
  return message;
}

function smtpTransporter() {
  const config = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 465,
    secure: smtpsecure,
  };
  // Auth whenever a password is set; some relays take none. The login defaults
  // to the sender address when SMTP_USERNAME is not given.
  const smtpUser = process.env.SMTP_USERNAME || process.env.SMTP_USER_EMAIL;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && smtpPass) {
    config.auth = { user: smtpUser, pass: smtpPass };
  }
  return createTransport(config);
}

/**
 * nodemailer resolves even when the server refused some or all recipients: the
 * refusals are in `info.rejected`. Only a message nobody accepted is a failure.
 * Exported so the mapping can be tested without an SMTP server.
 */
export function resultFromSmtpInfo(info) {
  const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
  const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
  if (!accepted.length && rejected.length) {
    return errorResult(`the mail server rejected ${rejected.join(', ')}`, 'smtp');
  }
  return successResult('smtp', info?.messageId);
}

/** Mailgun answers `{id, message, status}`; anything outside 2xx is a failure. */
export function resultFromMailgun(res) {
  const status = Number(res?.status);
  if (Number.isFinite(status) && status >= 200 && status < 300) {
    return successResult('mailgun', res?.id);
  }
  const detail = typeof res?.message === 'string' && res.message ? res.message : '';
  return errorResult(
    detail
      ? `Mailgun answered ${res?.status ?? 'no status'}: ${detail}`
      : `Mailgun answered ${res?.status ?? 'no status'}.`,
    'mailgun'
  );
}

function normaliseResult(result, provider) {
  if (!result || typeof result !== 'object')
    return errorResult('The transport returned nothing.', provider);
  if (result.status === 'success') return { provider, ...result, status: 'success' };
  return {
    provider,
    ...result,
    status: 'error',
    reason: result.reason || result.message || 'The transport reported a failure.',
    message: result.reason || result.message || 'The transport reported a failure.',
  };
}

/**
 * Deliver one message.
 * @param {Object} params mail params (see the module comment).
 * @returns {Promise<{status: 'success'|'error', reason?: string, provider: string, messageId?: string}>}
 */
export async function sendMail(params = {}) {
  if (transportOverride) {
    try {
      return normaliseResult(await transportOverride(params), 'stub');
    } catch (err) {
      return errorResult(readableError(err), 'stub');
    }
  }

  const provider = currentProvider();
  if (provider === 'none') return errorResult(NO_PROVIDER_REASON, 'none');

  let transporterSMTP;
  try {
    const message = buildMessage(params, provider);
    let result;
    if (provider === 'smtp') {
      transporterSMTP = smtpTransporter();
      const info = await transporterSMTP.sendMail(message);
      result = resultFromSmtpInfo(info);
    } else {
      const mailgun = new Mailgun(formData);
      const client = mailgun.client({ username: 'api', key: process.env.MAILGUN_API_KEY });
      const res = await client.messages.create(process.env.MAILGUN_DOMAIN, message);
      result = resultFromMailgun(res);
    }
    if (result.status === 'success' && params.extUserId) {
      // The mail is already out; a bookkeeping failure must not report it lost.
      try {
        await updateMailCount(params.extUserId);
      } catch (err) {
        console.log('mailTransport: could not update the mail count', err?.message || err);
      }
    }
    return result;
  } catch (err) {
    console.log('mailTransport: send failed', err?.message || err);
    return errorResult(readableError(err), provider);
  } finally {
    transporterSMTP?.close?.();
  }
}

/* ------------------------------------------------------------------ pdf fetch */

const PDF_MAGIC = '%PDF-';
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Fetch a PDF into memory for use as an attachment.
 *
 * The three attachment paths each streamed the file to `test_<0..4999>.pdf` in
 * the working directory, read it back after a 100 ms timer and treated the
 * string `'error'` as success, so a failed download was mailed as a truncated or
 * empty attachment (and two concurrent sends could collide on the same name).
 *
 * @param {string} url absolute url of the pdf.
 * @returns {Promise<{status: 'success', buffer: Buffer}|{status: 'error', reason: string}>}
 */
export async function downloadPdf(url) {
  if (!url || typeof url !== 'string')
    return { status: 'error', reason: 'No document url to attach.' };
  let target = url;
  let httpsAgent;
  try {
    const parsed = new URL(url);
    const isSecure = parsed.protocol === 'https:' && parsed.hostname !== 'localhost';
    if (!isSecure) {
      // Local development serves the files over the container port, and its
      // certificate is self-signed.
      target = url.replace('https://localhost:3001/api', 'http://localhost:8080');
      httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }
  } catch {
    return { status: 'error', reason: `Not a valid document url: ${url}` };
  }

  try {
    const res = await axios.get(target, {
      responseType: 'arraybuffer',
      httpsAgent,
      maxContentLength: MAX_PDF_BYTES,
      maxBodyLength: MAX_PDF_BYTES,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      return {
        status: 'error',
        reason: `The document could not be downloaded (HTTP ${res.status}).`,
      };
    }
    const buffer = Buffer.from(res.data);
    if (!buffer.length) return { status: 'error', reason: 'The document downloaded empty.' };
    if (buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
      return { status: 'error', reason: 'The downloaded document is not a pdf.' };
    }
    return { status: 'success', buffer };
  } catch (err) {
    return {
      status: 'error',
      reason: `The document could not be downloaded: ${readableError(err)}`,
    };
  }
}

export default sendMail;
