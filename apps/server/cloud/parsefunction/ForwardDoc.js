import { renderMail, strong } from '../lib/mailShell.js';
import { checkRateLimit } from './authGuard.js';
import { isValidEmail, normaliseEmail } from '../lib/email.js';
import sendMailWithAttachment from './sendMailWithAttachment.js';
import { senderDisplayName } from '../lib/requestMail.js';

const MAX_RECIPIENTS = 10;
/** Forwards per minute per account, and addresses per hour per account. */
const RATE_CALLS_PER_MIN = 10;
const RATE_RECIPIENTS_PER_HOUR = 100;
const HOUR = 60 * 60 * 1000;

/**
 * Addresses this call may mail: validated, lowercased and de-duplicated.
 *
 * The shape is `cloud/lib/email.js`'s, the same one `sendmailv3` enforces, so
 * what one mail entry point accepts the other accepts too; this file used to
 * carry its own copy of the pattern.
 *
 * `sendmailv3` grew `validateMailParams`, a recipient cap and a rate limit
 * precisely so it would not be a generic relay; forwarddoc reached the same
 * providers through `sendMailWithAttachment` with none of them, so any
 * authenticated user could put the platform's own SMTP identity behind ten
 * arbitrary addresses per call, in a loop. Forwarding a copy to someone who is
 * *not* on the document is the whole feature, so there is no participant rule to
 * apply here; syntax, a cap and a rate limit are what is left.
 */
function validateRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'please provide parameters.');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `At most ${MAX_RECIPIENTS} recipients per forward.`
    );
  }
  const seen = [];
  for (const entry of recipients) {
    const email = normaliseEmail(entry);
    if (!isValidEmail(email)) {
      throw new Parse.Error(
        Parse.Error.INVALID_QUERY,
        `Invalid recipient address: ${String(entry).slice(0, 100)}`
      );
    }
    if (!seen.includes(email)) seen.push(email);
  }
  return seen;
}

export default async function forwardDoc(request) {
  try {
    if (!request.user) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'unauthorized.');
    }
    const { docId } = request.params;
    const recipients = validateRecipients(request.params?.recipients);
    checkRateLimit('forwarddoc', `user:${request.user.id}`, RATE_CALLS_PER_MIN);
    // One tick per address, so ten calls of ten cost the same as one of a hundred.
    for (let i = 0; i < recipients.length; i++) {
      checkRateLimit('forwarddoc-to', `user:${request.user.id}`, RATE_RECIPIENTS_PER_HOUR, HOUR);
    }
    if (docId) {
      const userPtr = { __type: 'Pointer', className: '_User', objectId: request.user.id };
      const docQuery = new Parse.Query('contracts_Document');
      docQuery
        .equalTo('objectId', docId)
        .equalTo('CreatedBy', userPtr)
        .notEqualTo('IsArchive', true)
        .notEqualTo('IsDeclined', true)
        .include('Signers')
        .include('ExtUserPtr')
        .include('Placeholders.signerPtr')
        .include('ExtUserPtr.TenantId');
      const docRes = await docQuery.first({ useMasterKey: true });
      if (!docRes) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
      }
      const _docRes = docRes?.toJSON();
      const docName = _docRes.Name;
      const extUserId = _docRes?.ExtUserPtr?.objectId;
      const from = senderDisplayName({
        senderName: _docRes?.SenderName || _docRes?.ExtUserPtr?.Name,
        company: _docRes?.ExtUserPtr?.Company,
        useNameAsSender: Boolean(_docRes?.SenderName) || _docRes?.ExtUserPtr?.UseNameAsSender === true,
      });
      const replyTo = _docRes?.SenderMail || _docRes?.ExtUserPtr?.Email;
      const senderName = _docRes?.SenderName || _docRes?.ExtUserPtr?.Name;

      try {
        const sent = [];
        const failed = [];
        for (let i = 0; i < recipients.length; i++) {
          let params = {
            extUserId: extUserId,
            pdfName: docName,
            url: _docRes?.SignedUrl || '',
            // Named explicitly: `sendMailWithAttachment` no longer falls back to a
            // shared ./exports/certificate.pdf, which could be another document's.
            certificateUrl: _docRes?.CertificateUrl || '',
            recipient: recipients[i],
            subject: `${senderName} has signed the doc - ${docName}`,
            replyto: replyTo || '',
            from: from,
            html: renderMail({
              title: 'Your copy of the signed document',
              preheader: `A copy of ${docName} is attached`,
              paragraphs: [
                `A copy of ${strong(docName)} is attached to this email, together with its completion certificate.`,
              ],
              sender: { senderName, senderMail: replyTo },
            }),
          };
          // Per recipient, so a provider error on number three does not stop the
          // remaining seven from being attempted: the loop used to share one
          // `mailRes` inside a try that rethrew, and the caller was told the
          // whole operation had failed with no way to know who had received it.
          try {
            const mailRes = await sendMailWithAttachment(params);
            // Anything that is not an explicit success is a failure; the providers
            // used to answer `undefined` and this reported it to the caller as sent.
            if (mailRes?.status === 'success') sent.push(recipients[i]);
            else failed.push({ email: recipients[i], reason: mailRes?.reason || 'mail_failed' });
          } catch (mailErr) {
            failed.push({
              email: recipients[i],
              reason: String(
                mailErr?.response?.data?.error || mailErr?.message || 'mail_failed'
              ).slice(0, 200),
            });
          }
        }
        // Only a run in which nobody was reached is an error. A partial failure
        // used to be reported as a total one, and the obvious retry mailed the
        // document twice to everyone it had already reached.
        if (sent.length === 0) {
          throw new Parse.Error(
            Parse.Error.SCRIPT_FAILED,
            `Mail could not be sent: ${failed.map(f => `${f.email} (${f.reason})`).join(', ')}`
          );
        }
        return {
          status: 'success',
          sent,
          failed,
          ...(failed.length
            ? { message: `Sent to ${sent.length} of ${recipients.length} recipients.` }
            : {}),
        };
      } catch (error) {
        if (error instanceof Parse.Error) throw error;
        const msg =
          error?.response?.data?.error ||
          error?.response?.data ||
          error?.message ||
          'Something went wrong.';
        throw new Parse.Error(400, msg);
      }
    } else {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'please provide parameters.');
    }
  } catch (err) {
    console.log('Err in forwardDoc', err);
    throw err;
  }
}
