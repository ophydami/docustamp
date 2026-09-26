import {
  msUntil,
  sendDeleteOtpEmail,
  OTP_EXPIRES_MIN,
  RESEND_COOLDOWN_SEC,
  MAX_ATTEMPTS,
} from './deleteUtils.js';
import { authoriseDeletionRequest } from '../../lib/deletionToken.js';
import { checkRateLimit, clientIp } from '../../parsefunction/authGuard.js';
import { generateOtp, hashOtp } from '../../lib/otp.js';

/**
 * Abuse limits on top of the 30 s resend cooldown, which only ever slowed one
 * account down: the route was anonymous, so a script could walk a list of
 * userIds and mail every admin a deletion code twice a minute forever.
 */
const IP_MAX_PER_HOUR = 20;
const USER_MAX_PER_HOUR = 6;
const HOUR = 60 * 60 * 1000;

/**
 * 2. Mail the confirmation code.
 *
 * Requires the emailed link token or a session for that same account, and
 * answers 404 for both "no such account" and "not yours".
 *
 * The code itself is never stored: only `sha256(userId + ':' + code)` goes on
 * the row, next to its expiry. The attempt counter deliberately survives a
 * resend, so mailing a fresh code can no longer be used to reset the five
 * guesses; only a new deletion request (a new signed link) clears it.
 */
export const deleteUserOtp = async (req, res) => {
  const authorised = await authoriseDeletionRequest(req);
  if (!authorised) return res.status(404).json({ error: 'User not found' });
  const { extUser, userId } = authorised;

  try {
    checkRateLimit('deleteAccountOtpIp', clientIp(req), IP_MAX_PER_HOUR, HOUR);
    checkRateLimit('deleteAccountOtpUser', userId, USER_MAX_PER_HOUR, HOUR);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const now = Date.now();
  const lastSentAt = extUser.get('DeleteOTPSentAt')?.getTime?.() || 0;
  const cooldownEndsAt = lastSentAt + RESEND_COOLDOWN_SEC * 1000;
  const remainingMs = msUntil(now, cooldownEndsAt);

  if (remainingMs > 0) {
    return res
      .status(429)
      .json({ error: 'Cooldown not finished', retryAfterSec: Math.ceil(remainingMs / 1000) });
  }

  const tries = Number(extUser.get('DeleteOTPTries') || 0);
  if (tries >= MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ error: 'Too many invalid attempts. Please start the deletion request again.' });
  }

  const otp = generateOtp();
  const expiresAt = new Date(now + OTP_EXPIRES_MIN * 60 * 1000);

  try {
    await sendDeleteOtpEmail(extUser, otp);
    extUser.set('DeleteOTPHash', hashOtp(userId, otp));
    extUser.set('DeleteOTPExpiry', expiresAt);
    extUser.set('DeleteOTPSentAt', new Date(now));
    // Carried over, never reset: a resend must not buy five more guesses.
    extUser.set('DeleteOTPTries', tries);
    extUser.unset('DeleteOTP'); // scrub the plaintext column of the old scheme
    await extUser.save(null, { useMasterKey: true });
    return res.json({ ok: true, cooldownSec: RESEND_COOLDOWN_SEC, expiresInMin: OTP_EXPIRES_MIN });
  } catch (err) {
    console.log('Error sending delete OTP (POST /otp):', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
};
