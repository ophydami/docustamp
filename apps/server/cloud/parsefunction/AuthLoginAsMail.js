import { checkRateLimit, clientIp } from './authGuard.js';
import { consumeOtp } from '../lib/otp.js';

/** 10 guesses per address per 10 minutes, on top of the 5 per code. */
const VERIFY_PER_EMAIL = 10;
const VERIFY_PER_EMAIL_WINDOW = 10 * 60 * 1000;
/** 30 guesses per source address per minute, whatever the recipient. */
const VERIFY_PER_IP = 30;
const VERIFY_PER_IP_WINDOW = 60 * 1000;

/**
 * Swap a mailed one-time code for a session.
 *
 * Deliberately unauthenticated, so it is the single most attackable entry
 * point in the server: it mints a session for an arbitrary account with the
 * master key. The code is now 6 digits, hashed at rest, valid for 10 minutes,
 * destroyed after 5 wrong guesses and destroyed on use (cloud/lib/otp.js), and
 * the address must already have a `_User`.
 *
 * Response shape is unchanged, because both frontends branch on it:
 *   success -> the `_User` JSON with `objectId` and `sessionToken`
 *   bad/expired/spent code -> the string 'Invalid Otp'
 *   no account for that address -> the string 'user not found!'
 *   anything unexpected -> the string 'Result not found'
 */
async function AuthLoginAsMail(request) {
  try {
    const email = (request.params?.email || '').toLowerCase().replace(/\s/g, '');
    const otp = String(request.params?.otp ?? '').trim();
    if (!email) return 'user not found!';

    checkRateLimit('otpVerifyIp', clientIp(request), VERIFY_PER_IP, VERIFY_PER_IP_WINDOW);
    checkRateLimit('otpVerifyEmail', email, VERIFY_PER_EMAIL, VERIFY_PER_EMAIL_WINDOW);

    const userQuery = new Parse.Query(Parse.User);
    userQuery.equalTo('email', email);
    const user = await userQuery.first({ useMasterKey: true });
    if (!user) return 'user not found!';

    // Burns the row: nothing below can be retried with the same code.
    const check = await consumeOtp(email, otp);
    if (!check.ok) return 'Invalid Otp';

    // `Parse.User.loginAs` would additionally overwrite the SDK's "current
    // user", which is process-wide inside cloud code; go to the same endpoint
    // without that side effect. The body is the `_User` JSON + sessionToken,
    // exactly what this function has always returned.
    const result = await Parse.CoreManager.getRESTController().request(
      'POST',
      'loginAs',
      { userId: user.id },
      { useMasterKey: true }
    );
    if (!result?.sessionToken) return 'user not found!';

    if (!user.get('emailVerified')) {
      user.set('emailVerified', true);
      await user.save(null, { useMasterKey: true }).catch(err => {
        console.log('AuthLoginAsMail: could not mark email verified', err?.message);
      });
      result.emailVerified = true;
    }
    return { ...result, objectId: result.objectId || user.id };
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('err in Auth');
    console.log(err);
    return 'Result not found';
  }
}
export default AuthLoginAsMail;
