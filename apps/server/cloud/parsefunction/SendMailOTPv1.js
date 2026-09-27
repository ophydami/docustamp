import { appName, emailRegex, escapeHtml, mailThemeColor } from '../../Utils.js';
import { renderMail } from '../lib/mailShell.js';
import { checkRateLimit, clientIp, documentParticipantEmails } from './authGuard.js';
import { clearOtp, issueOtp } from '../lib/otp.js';
import { sendMail } from '../lib/mailTransport.js';

/** 5 codes per address per 10 minutes. */
const SEND_PER_EMAIL = 5;
const SEND_PER_EMAIL_WINDOW = 10 * 60 * 1000;
/** 20 sends per source address per minute, whatever the recipient. */
const SEND_PER_IP = 20;
const SEND_PER_IP_WINDOW = 60 * 1000;

/**
 * The document a guest is signing, with everything `documentParticipantEmails`
 * needs. Master key: the caller has no session at this point by design.
 */
async function loadDocument(docId) {
  try {
    const query = new Parse.Query('contracts_Document');
    query.equalTo('objectId', docId);
    query.include('ExtUserPtr');
    query.include('CreatedBy');
    query.include('Signers');
    query.include('AuditTrail.UserPtr');
    query.include('ExtUserPtr.TenantId');
    query.include('Placeholders');
    query.notEqualTo('IsArchive', true);
    const res = await query.first({ useMasterKey: true });
    return res?.toJSON() || null;
  } catch (err) {
    console.log('err ', err);
    return null;
  }
}

/**
 * Mail a one-time code.
 *
 * The answer is `'Otp send'` for any well-formed address the server accepted,
 * including addresses it deliberately mailed nothing for: the frontends
 * (apps/web `requestOtp`, the old `GuestLogin`) only branch on that string, and
 * a truthful answer would turn this into an account/participant oracle. Nothing
 * is mailed when the address has no `_User`, or when a `docId` was given and the
 * address is not on that document.
 *
 * A mail provider that refuses the message is a different matter: it says
 * nothing about the address, and reporting it as sent is how a misconfigured
 * SMTP setup silently stops every OTP-protected signature. That case throws.
 *
 * @returns {Promise<'Otp send'|'Please Enter valid email'>}
 */
async function sendMailOTPv1(request) {
  try {
    const email = (request.params?.email || '').toLowerCase().replace(/\s/g, '');
    const TenantId = request.params?.TenantId ? String(request.params.TenantId) : undefined;
    const AppName = appName;

    if (!email || !emailRegex.test(email)) return 'Please Enter valid email';

    checkRateLimit('otpSendIp', clientIp(request), SEND_PER_IP, SEND_PER_IP_WINDOW);
    checkRateLimit('otpSendEmail', email, SEND_PER_EMAIL, SEND_PER_EMAIL_WINDOW);

    const docId = request.params?.docId;
    let extUserId = '';
    if (docId) {
      const docJson = await loadDocument(docId);
      // Unknown document, or an address that is not on it: answer as if sent.
      if (!docJson || !documentParticipantEmails(docJson).has(email)) return 'Otp send';
      extUserId = docJson?.ExtUserPtr?.objectId || '';
    } else {
      const userQuery = new Parse.Query(Parse.User);
      userQuery.equalTo('email', email);
      const user = await userQuery.first({ useMasterKey: true });
      // No account to log in as, so a code would be useless. Say nothing.
      if (!user) return 'Otp send';
    }

    const code = await issueOtp(email, { tenantId: TenantId });
    // `cloud/lib/mailTransport.js` rather than `Parse.Cloud.sendEmail`: it is
    // the one place that decides "did it send?" correctly, it counts the mail
    // against `extUserId` only when it did, and specs can stub it.
    const res = await sendMail({
      from: AppName,
      recipient: email,
      subject: `Your ${AppName} OTP`,
      text: `Your OTP for ${AppName} verification is ${code}. It expires in 10 minutes and can only be used once.`,
      html: renderMail({
        title: 'Your verification code',
        preheader: `${code} is your ${AppName} verification code`,
        paragraphs: [
          `Use this code to continue with ${escapeHtml(AppName)}:`,
          `<span style="display:inline-block;font-family:Consolas,'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:${mailThemeColor};padding:10px 16px;background:#f4f4f5;border-radius:8px">${escapeHtml(code)}</span>`,
          'It expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.',
        ],
      }),
      ...(extUserId ? { extUserId } : {}),
    });
    if (res?.status !== 'success') {
      // A code nobody can read is worse than no code: it would keep the row
      // alive and count against the resend budget. Drop it and say so, rather
      // than answering the 'Otp send' sentinel both frontends read as success.
      // Never log the code itself.
      console.log('error in send OTP mail', res?.reason || 'unknown mail failure');
      await clearOtp(email);
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        `The code could not be emailed: ${res?.reason || 'the mail provider did not accept the message.'}`
      );
    }
    return 'Otp send';
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('err in sendMailOTPv1');
    console.log(err);
    return err;
  }
}
export default sendMailOTPv1;
