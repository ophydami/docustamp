/**
 * One-time codes for `SendOTPMailV1` / `AuthLoginAsMail`.
 *
 * The old scheme was a 4 digit `Math.random()` value written to
 * `defaultdata_Otp` in cleartext, with no expiry, no attempt counter and no
 * delete after use, on a class that parse-server had auto-created with the
 * default public CLP. Because `AuthLoginAsMail` mints a real session with the
 * master key, guessing all 9000 values took over any account.
 *
 * What is stored now: only `sha256(email + ':' + code)`, an `ExpiresAt` ten
 * minutes out, and an `Attempts` counter. One live row per email (a resend
 * overwrites it), the row carries an empty ACL, and the class is locked to the
 * master key by databases/migrations/20260822000100-lock_otp_class.cjs.
 */

import crypto from 'node:crypto';

export const OTP_CLASS = 'defaultdata_Otp';
/** Digits in a code. 6 => 1e6 values, versus 9000 before. */
export const OTP_DIGITS = 6;
/** How long a code stays usable. */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the row is destroyed and a new code must be requested. */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Test seam. Codes never leave the server otherwise (they used to be
 * `console.log`ged), so specs read the last issued code from here. Only
 * populated when `TESTING` is set.
 * @type {Map<string, string>}
 */
export const __lastOtpForTests = new Map();

export function normaliseOtpEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s/g, '') : '';
}

/** The only representation of a code that ever touches the database. */
export function hashOtp(email, code) {
  return crypto
    .createHash('sha256')
    .update(`${normaliseOtpEmail(email)}:${String(code ?? '').trim()}`)
    .digest('hex');
}

/** A zero-padded 6 digit code from the CSPRNG. */
export function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(OTP_DIGITS, '0');
}

/**
 * Replace whatever code that email had with a fresh one and return the
 * cleartext, which the caller mails and then forgets.
 *
 * @param {string} email
 * @param {{tenantId?: string}} [opts]
 * @returns {Promise<string>} the cleartext code
 */
export async function issueOtp(email, opts = {}) {
  const address = normaliseOtpEmail(email);
  const code = generateOtp();
  const query = new Parse.Query(OTP_CLASS);
  query.equalTo('Email', address);
  const row = (await query.first({ useMasterKey: true })) || new Parse.Object(OTP_CLASS);
  row.set('Email', address);
  row.set('OTPHash', hashOtp(address, code));
  row.set('ExpiresAt', new Date(Date.now() + OTP_TTL_MS));
  row.set('Attempts', 0);
  // Scrub the plaintext column rows created by the old scheme still carry.
  row.unset('OTP');
  if (typeof opts.tenantId === 'string' && opts.tenantId) row.set('TenantId', opts.tenantId);
  row.setACL(new Parse.ACL()); // nothing granted: master key only
  await row.save(null, { useMasterKey: true });
  if (process.env.TESTING) __lastOtpForTests.set(address, code);
  return code;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Check a submitted code and, whatever the outcome, leave the row in a state
 * that cannot be brute-forced: destroyed on success, destroyed once
 * `OTP_MAX_ATTEMPTS` wrong guesses have been made, otherwise incremented.
 *
 * @param {string} email
 * @param {string|number} code
 * @returns {Promise<{ok: boolean, reason?: 'missing'|'expired'|'mismatch'|'locked'}>}
 */
export async function consumeOtp(email, code) {
  const address = normaliseOtpEmail(email);
  const query = new Parse.Query(OTP_CLASS);
  query.equalTo('Email', address);
  const row = await query.first({ useMasterKey: true });
  if (!row) return { ok: false, reason: 'missing' };

  const destroy = () => row.destroy({ useMasterKey: true }).catch(() => {});

  const expected = row.get('OTPHash');
  const expiresAt = row.get('ExpiresAt');
  // A row with no hash is a leftover from the plaintext scheme: drop it and
  // make the caller ask for a new code rather than trusting the old column.
  if (typeof expected !== 'string' || !expected || !expiresAt) {
    await destroy();
    return { ok: false, reason: 'expired' };
  }
  if (new Date(expiresAt).getTime() <= Date.now()) {
    await destroy();
    return { ok: false, reason: 'expired' };
  }

  const attempts = Number(row.get('Attempts') || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await destroy();
    return { ok: false, reason: 'locked' };
  }

  if (!timingSafeEqualHex(expected, hashOtp(address, code))) {
    const next = attempts + 1;
    if (next >= OTP_MAX_ATTEMPTS) {
      await destroy();
      return { ok: false, reason: 'locked' };
    }
    row.set('Attempts', next);
    await row.save(null, { useMasterKey: true }).catch(() => {});
    return { ok: false, reason: 'mismatch' };
  }

  await destroy();
  if (process.env.TESTING) __lastOtpForTests.delete(address);
  return { ok: true };
}

/** Drop the live code for an address (used when an account is verified another way). */
export async function clearOtp(email) {
  const query = new Parse.Query(OTP_CLASS);
  query.equalTo('Email', normaliseOtpEmail(email));
  const row = await query.first({ useMasterKey: true });
  if (row) await row.destroy({ useMasterKey: true }).catch(() => {});
}
