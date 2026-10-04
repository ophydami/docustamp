import { appName, escapeHtml, mailThemeColor } from '../../Utils.js';
import { isValidEmail } from '../lib/email.js';
import { renderMail } from '../lib/mailShell.js';
import { clearOtp, consumeOtp, issueOtp } from '../lib/otp.js';
import { checkRateLimit, clientIp } from './authGuard.js';
import { OTP_FAILURES, accountEmail, signedInUser } from './emailVerification.js';
import sendSystemMail from './sendSystemMail.js';

/**
 * Setting a password with an emailed code, for people who do not know one.
 *
 * The web app's "Change password" proves the old password by logging in with
 * it, which nobody who only ever signed in with an emailed code or Google can
 * do: a contact's shadow `_User` carries a random password nobody holds
 * (lib/contacts.js `randomShadowPassword`), and a Google account has none at
 * all. Their only way to a password was signing out and using "Forgot
 * password".
 *
 *   sendpasswordcode {}                   -> { sent: true, email }
 *   setpasswordwithcode { otp, password } -> { sessionToken }
 *
 * The code goes to the account's own address, never one named in the request,
 * and is the same kind as the sign-in and verify codes (lib/otp.js), so it
 * proves control of the mailbox exactly as the reset mail does. A session alone
 * is not enough: whoever holds a stolen one still cannot set a password and
 * lock the owner out.
 *
 * The password is stored with the master key, which ends every session the
 * account has (RestWrite `clearSessions`), so a fresh one is minted by logging
 * in with the new password and handed back. Connected apps and the API key keep
 * working, as they do after an ordinary password change.
 */

/** 5 codes per account per 10 minutes, 20 per source address per minute. */
const SEND_PER_USER = 5;
const SEND_PER_USER_WINDOW = 10 * 60 * 1000;
const SEND_PER_IP = 20;
const SEND_PER_IP_WINDOW = 60 * 1000;
/** 10 tries per account per 10 minutes, on top of the 5 per code. */
const SET_PER_USER = 10;
const SET_PER_USER_WINDOW = 10 * 60 * 1000;

/** Longer than anyone types; bcrypt only reads the first 72 bytes anyway. */
const MAX_PASSWORD = 256;

/** The same three rules the web app's password form shows (SecuritySection). */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Use at least 8 characters.';
  }
  if (password.length > MAX_PASSWORD) return 'That password is too long.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Use upper and lower case letters and a number.';
  }
  if (!/[!@#$%^&*()\-_=+{};:,<.>]/.test(password)) return 'Add one special character.';
  return '';
}

function assertHasEmail(email) {
  if (!email || !isValidEmail(email)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'This account has no email address to send a code to. Contact support.'
    );
  }
}

/**
 * `sendpasswordcode {}` -> `{ sent: true, email }`
 *
 * Mails a fresh 6 digit code to the caller's own address.
 */
export async function sendPasswordCode(request) {
  const user = await signedInUser(request);
  const email = accountEmail(user);
  assertHasEmail(email);

  checkRateLimit('passwordCodeSendIp', clientIp(request), SEND_PER_IP, SEND_PER_IP_WINDOW);
  checkRateLimit('passwordCodeSendUser', user.id, SEND_PER_USER, SEND_PER_USER_WINDOW);

  const code = await issueOtp(email);
  const res = await sendSystemMail({
    params: {
      from: appName,
      recipient: email,
      subject: `Your ${appName} code to set a password`,
      text: `Your ${appName} code to set a password is ${code}. It expires in 10 minutes and can only be used once. If you did not ask for it, you can ignore this email: nothing changes without the code.`,
      html: renderMail({
        title: 'Set a password',
        preheader: `${code} is your ${appName} code to set a password`,
        paragraphs: [
          `Enter this code in ${escapeHtml(appName)} to set a password for your account:`,
          `<span style="display:inline-block;font-family:Consolas,'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:${mailThemeColor};padding:10px 16px;background:#f4f4f5;border-radius:8px">${escapeHtml(code)}</span>`,
          'It expires in 10 minutes and can only be used once. If you did not ask for it, you can ignore this email: nothing changes without the code.',
        ],
      }),
    },
  });
  if (res?.status !== 'success') {
    // Never log the code itself. A code nobody can read must not stay live.
    console.log('sendpasswordcode: mail failed', res?.reason || 'unknown mail failure');
    await clearOtp(email);
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      `The code could not be emailed: ${res?.reason || 'the mail provider did not accept the message.'}`
    );
  }
  return { sent: true, email };
}

/**
 * `setpasswordwithcode { otp, password }` -> `{ sessionToken }`
 *
 * The password is checked before the code, so a weak one does not burn it.
 * The code also proves the address, so an unverified one becomes verified in
 * the same write.
 */
export async function setPasswordWithCode(request) {
  const user = await signedInUser(request);
  const email = accountEmail(user);
  assertHasEmail(email);

  const otp = String(request.params?.otp ?? '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Enter the 6 digit code from the email.');
  }
  const password = request.params?.password;
  const problem = passwordProblem(password);
  if (problem) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, problem);

  checkRateLimit('passwordCodeSetUser', user.id, SET_PER_USER, SET_PER_USER_WINDOW);

  const check = await consumeOtp(email, otp);
  if (!check.ok) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      OTP_FAILURES[check.reason] || OTP_FAILURES.mismatch
    );
  }

  user.set('password', password);
  if (user.get('emailVerified') !== true) user.set('emailVerified', true);
  await user.save(null, { useMasterKey: true });

  const loggedIn = await Parse.User.logIn(user.get('username'), password);
  return { sessionToken: loggedIn.getSessionToken() };
}
