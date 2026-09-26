import { extUserForUser, resolveCaller } from './authGuard.js';

/**
 * Preferences a caller may write to their own `contracts_Users` row.
 *
 * The entry gate used to recognise three of them (`SignatureType`,
 * `NotifyOnSignatures`, `Timezone`) while the body wrote eleven, so a patch
 * touching only, say, `DateFormat` came back as INVALID_QUERY. The web app had
 * to work around that by attaching a `Timezone` to every preference write,
 * which meant every preference change silently rewrote the stored timezone with
 * whatever the browser guessed. The gate is now "at least one recognised key".
 */
const WRITABLE_KEYS = [
  'SignatureType',
  'NotifyOnSignatures',
  'Timezone',
  'SendinOrder',
  'IsTourEnabled',
  'DateFormat',
  'Is12HourTime',
  'IsLTVEnabled',
  'DownloadFilenameFormat',
  'UseNameAsSender',
];

/**
 * An IANA zone name the runtime actually knows.
 *
 * The value is read back by `GenerateCertificate`, which hands it to date-fns-tz
 * `toZonedTime`/`format`; those throw `RangeError: Invalid time zone specified`
 * for a garbage string, and the completion path awaits certificate generation
 * with no local fallback. A client that stored `not/a/zone` therefore broke
 * completion for every document that user sent.
 *
 * @param {*} value candidate zone.
 * @returns {string} the zone to store.
 */
function validTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Timezone must be a time zone name.');
  }
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
  } catch {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `"${zone}" is not a time zone this server recognises.`
    );
  }
  return zone;
}

export default async function updatePreferences(request) {
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const params = request.params || {};
  // An empty `SignatureType` array has always meant "not part of this patch"
  // (the old gate tested `SignatureType?.length > 0`), and the web app sends
  // one on writes that are only about other preferences.
  const present = WRITABLE_KEYS.filter(key => {
    if (params[key] === undefined) return false;
    if (key === 'SignatureType') return Array.isArray(params[key]) && params[key].length > 0;
    return true;
  });
  if (!present.length) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide parameters.');
  }

  try {
    const resUser = await extUserForUser(caller);
    if (!resUser) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Premission denied.');
    }
    const newOrg = new Parse.Object('contracts_Users');
    newOrg.id = resUser.id;

    for (const key of present) {
      const value = params[key];
      if (key === 'SignatureType') {
        newOrg.set('SignatureType', validSignatureType(value));
      } else if (key === 'Timezone') {
        newOrg.set('Timezone', validTimezone(value));
      } else {
        newOrg.set(key, value);
      }
    }

    const updateUserRes = await newOrg.save(null, { useMasterKey: true });
    return JSON.parse(JSON.stringify(updateUserRes));
  } catch (err) {
    if (err instanceof Parse.Error) throw err;
    console.log('err in updatepreferences', err);
    const code = err?.code || 400;
    const msg = err?.message || 'Something went wrong.';
    throw new Parse.Error(code, msg);
  }
}

/** At least one type enabled, and not the default on its own. */
function validSignatureType(value) {
  const types = Array.isArray(value) ? value : [];
  const enabled = types.filter(x => x?.enabled);
  if (enabled.length === 0) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'At least one signature type should be enabled.'
    );
  }
  if (enabled.length === 1 && enabled[0]?.name === 'default') {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'At least one signature type other than the default should be enabled.'
    );
  }
  return types;
}
