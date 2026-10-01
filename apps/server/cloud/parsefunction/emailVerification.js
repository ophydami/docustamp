import { appName, escapeHtml, mailThemeColor } from '../../Utils.js';
import { isValidEmail } from '../lib/email.js';
import { renderMail } from '../lib/mailShell.js';
import { clearOtp, consumeOtp, issueOtp } from '../lib/otp.js';
import { checkRateLimit, clientIp, normaliseEmail, resolveCaller } from './authGuard.js';
import sendSystemMail from './sendSystemMail.js';

/**
 * Who an account is, and proving it.
 *
 * Signup never proves the mailbox (index.js `verifyUserEmails: false`), and
 * until now any signed-in account could also rewrite its own `email` and
 * `username` straight through `PUT /users/:id`: there was no `beforeSave` on
 * `_User` and the CLP lets an owner update their row. Contacts bind to a `_User`
 * by username (`lib/contacts.js` `shadowUserFor`), so an address was only ever
 * as good as the last client that typed it.
 *
 * Two things fix that:
 *  - `userBeforeSave` freezes `email`, `username` and `emailVerified` for every
 *    non-master write on an existing account, and makes a master-key change of
 *    the address drop the verified flag (unless the same write sets it).
 *  - `getemailverification` / `sendemailverification` / `verifyemail` let a
 *    signed-in user prove their address with a 6 digit emailed code (the same
 *    codes as the OTP sign-in, `lib/otp.js`). Signing in with an emailed code
 *    (`AuthLoginAsMail`) or with Google verifies the address as well.
 *
 * `emailVerified` is what the signer guard (`authGuard.resolveDocumentActor`)
 * and agent signing (`lib/agentIdentity.js`) trust.
 */

/** Fields only the server may change on an existing account. */
const FROZEN_FIELDS = ['email', 'username', 'emailVerified'];

/** 5 codes per account per 10 minutes, 20 per source address per minute. */
const SEND_PER_USER = 5;
const SEND_PER_USER_WINDOW = 10 * 60 * 1000;
const SEND_PER_IP = 20;
const SEND_PER_IP_WINDOW = 60 * 1000;
/** 10 guesses per account per 10 minutes, on top of the 5 per code. */
const VERIFY_PER_USER = 10;
const VERIFY_PER_USER_WINDOW = 10 * 60 * 1000;

function same(a, b) {
  return (a ?? null) === (b ?? null);
}

/* ------------------------------------------------------------------------- *
 * beforeSave(_User)
 * ------------------------------------------------------------------------- */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when another `_User` already holds this address as username or email, in any case. */
async function addressTaken(email, exceptId) {
  const pattern = `^${escapeRegExp(email)}$`;
  for (const field of ['username', 'email']) {
    const query = new Parse.Query(Parse.User);
    query.matches(field, pattern, 'i');
    if (exceptId) query.notEqualTo('objectId', exceptId);
    // eslint-disable-next-line no-await-in-loop -- two indexed lookups, the first hit wins
    if (await query.first({ useMasterKey: true })) return true;
  }
  return false;
}

/** The claims of the Google ID token in `authData`, or null. */
function googleClaims(authData) {
  const token = authData?.google?.id_token;
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * A new account created by "Sign in with Google" gets its address from the
 * Google ID token rather than from the browser.
 *
 * Parse Server's google adapter has already verified that token (signature,
 * audience, issuer, `sub`) by the time a beforeSave runs: `validateAuthData`
 * precedes the trigger in RestWrite. The web app used to set `email` itself
 * after the sign-in, from its own unverified decode of the token, and nothing
 * stopped it from setting any other address. It now finds the address already
 * there. The username becomes the address too, as every other signup path does,
 * so contacts and agent signing can bind to the account.
 *
 * An address another account already holds (a contact's shadow user, a password
 * signup) is left alone, exactly as before: the browser's own attempt failed on
 * the duplicate then, and the onboarding step tells the person to sign in.
 */
async function fillFromGoogle(user) {
  if (user.get('email')) return;
  const authData = user.get('authData');
  const claims = googleClaims(authData);
  if (!claims || claims.sub !== authData?.google?.id) return;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return;
  const email = normaliseEmail(claims.email);
  if (!isValidEmail(email)) return;
  if (await addressTaken(email, user.id)) return;
  user.set('email', email);
  user.set('normalizedEmail', email);
  user.set('username', email);
  user.set('emailVerified', true);
}

/**
 * `beforeSave(Parse.User)`.
 *
 * New accounts (signup, `adduser`, contact shadow users, Google) are untouched
 * apart from the Google address fill. On an existing account a non-master write
 * may not change `email`, `username` or `emailVerified` (parse-server refuses
 * the last one on its own before this runs; this is the backstop). A master
 * write that changes the address or the username clears `emailVerified`, unless
 * it sets the flag itself (the account-deletion tombstone does).
 */
export async function userBeforeSave(request) {
  const user = request.object;
  const original = request.original;
  if (!original) {
    await fillFromGoogle(user);
    return;
  }

  const changed = FROZEN_FIELDS.filter(
    field => user.dirty(field) && !same(user.get(field), original.get(field))
  );
  if (!changed.length) return;

  if (!request.master) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'Your sign-in email cannot be changed from here. Contact support to change it.'
    );
  }
  const addressChanged = changed.includes('email') || changed.includes('username');
  if (addressChanged && !user.dirty('emailVerified')) {
    user.set('emailVerified', false);
  }
}

/* ------------------------------------------------------------------------- *
 * Cloud functions
 * ------------------------------------------------------------------------- */

/** The caller's `_User`, read fresh with the master key, or throws. */
async function signedInUser(request) {
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const user = await new Parse.Query(Parse.User).get(caller.id, { useMasterKey: true });
  if (user.get('IsDisabled') === true) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This account is disabled.');
  }
  return user;
}

/** The address a code is sent to and checked against. */
function accountEmail(user) {
  return normaliseEmail(user.get('email') || '');
}

function assertHasEmail(email) {
  if (!email || !isValidEmail(email)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'This account has no email address to verify. Contact support.'
    );
  }
}

/**
 * `getemailverification {}` -> `{ email, verified }`
 */
export async function getEmailVerification(request) {
  const user = await signedInUser(request);
  return { email: accountEmail(user), verified: user.get('emailVerified') === true };
}

/**
 * `sendemailverification {}` -> `{ sent: true, email }`
 *
 * Mails a fresh 6 digit code to the caller's own address. Nothing else can be
 * named: the address comes from the session, never from the request. An
 * address that is already verified gets no mail and answers
 * `{ sent: false, email, verified: true }`.
 */
export async function sendEmailVerification(request) {
  const user = await signedInUser(request);
  const email = accountEmail(user);
  assertHasEmail(email);
  if (user.get('emailVerified') === true) return { sent: false, email, verified: true };

  checkRateLimit('emailVerifySendIp', clientIp(request), SEND_PER_IP, SEND_PER_IP_WINDOW);
  checkRateLimit('emailVerifySendUser', user.id, SEND_PER_USER, SEND_PER_USER_WINDOW);

  const code = await issueOtp(email);
  const res = await sendSystemMail({
    params: {
      from: appName,
      recipient: email,
      subject: `Your ${appName} verification code`,
      text: `Your ${appName} code to verify your email address is ${code}. It expires in 10 minutes and can only be used once.`,
      html: renderMail({
        title: 'Verify your email address',
        preheader: `${code} is your ${appName} verification code`,
        paragraphs: [
          `Enter this code in ${escapeHtml(appName)} to verify your email address:`,
          `<span style="display:inline-block;font-family:Consolas,'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:${mailThemeColor};padding:10px 16px;background:#f4f4f5;border-radius:8px">${escapeHtml(code)}</span>`,
          'It expires in 10 minutes and can only be used once. If you did not ask for it, you can ignore this email.',
        ],
      }),
    },
  });
  if (res?.status !== 'success') {
    // Never log the code itself. A code nobody can read must not stay live.
    console.log('sendemailverification: mail failed', res?.reason || 'unknown mail failure');
    await clearOtp(email);
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      `The code could not be emailed: ${res?.reason || 'the mail provider did not accept the message.'}`
    );
  }
  return { sent: true, email };
}

/** What each `consumeOtp` failure tells the person. */
const OTP_FAILURES = {
  missing: 'That code has expired. Ask for a new one.',
  expired: 'That code has expired. Ask for a new one.',
  locked: 'Too many wrong codes. Ask for a new one.',
  mismatch: 'That code is not right. Check the email and try again.',
};

/**
 * `verifyemail { otp }` -> `{ verified: true }`
 *
 * Checks the code against the caller's own address (the code row is burnt
 * either way, see `consumeOtp`) and marks the address verified with the master
 * key, the only kind of write `userBeforeSave` lets change the flag.
 */
export async function verifyEmail(request) {
  const user = await signedInUser(request);
  const email = accountEmail(user);
  assertHasEmail(email);
  if (user.get('emailVerified') === true) return { verified: true };

  const otp = String(request.params?.otp ?? '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Enter the 6 digit code from the email.');
  }
  checkRateLimit('emailVerifyUser', user.id, VERIFY_PER_USER, VERIFY_PER_USER_WINDOW);

  const check = await consumeOtp(email, otp);
  if (!check.ok) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      OTP_FAILURES[check.reason] || OTP_FAILURES.mismatch
    );
  }
  user.set('emailVerified', true);
  await user.save(null, { useMasterKey: true });
  return { verified: true };
}
