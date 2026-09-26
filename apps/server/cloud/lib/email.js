/**
 * One email shape, one normalisation.
 *
 * Four different regular expressions used to decide what an email address is:
 * two of them rejected commas and semicolons as a header-injection defence
 * (`sendmailv3`, `forwarddoc`) and two did not (`Utils.emailRegex`, which is
 * what the contact API validates with, and the draft recipient check). So the
 * contact book accepted an address the mail layer then refused, and a value
 * carrying a comma could be stored and only blow up at send time.
 *
 * `normaliseEmail` existed twice as well, with different behaviour, alongside
 * inline lowercase-and-strip copies, so the same address could normalise two
 * ways and defeat the unique index that is supposed to keep contacts unique.
 *
 * This module is the single definition. Import `EMAIL_RE`/`isValidEmail` for the
 * check and `normaliseEmail` for the stored form; never re-declare either.
 */

/**
 * The address shape this server accepts anywhere.
 *
 * Deliberately stricter than RFC 5322: a comma or a semicolon in a value that is
 * concatenated into a `To:`/`Reply-To:` header starts a second address, so both
 * are refused here rather than at the transport. Whitespace is refused for the
 * same reason (a CR/LF would inject a whole header).
 */
export const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Longest address accepted; the RFC limit on a full address path. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * The stored/compared form of an address: trimmed, lowercased, with every
 * internal whitespace character removed. Non-strings become ''.
 *
 * @param {*} value raw input.
 * @returns {string} the normalised address, or ''.
 */
export function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s/g, '') : '';
}

/**
 * Is this a usable address? Checks the normalised form, so `" A@B.test "` and
 * `"a@b.test"` answer the same.
 *
 * @param {*} value raw input.
 * @returns {boolean}
 */
export function isValidEmail(value) {
  const email = normaliseEmail(value);
  return Boolean(email) && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}

/**
 * The normalised address, or a `Parse.Error` when it is not one.
 *
 * @param {*} value raw input.
 * @param {string} [label] what to call it in the message.
 * @returns {string} the normalised address.
 */
export function assertValidEmail(value, label = 'email') {
  const email = normaliseEmail(value);
  if (!isValidEmail(email)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `Invalid ${label}: "${String(value ?? '').slice(0, 100)}".`
    );
  }
  return email;
}
