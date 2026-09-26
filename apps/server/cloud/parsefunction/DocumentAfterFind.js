import { handleValidImage } from '../../Utils.js';
import { signStoredUrl } from '../lib/fileUrls.js';
import { mapWithConcurrency } from './authGuard.js';

// Signing is local work: a JWT for `/files/` urls, or an S3 SigV4 presign, which
// is HMAC over the request and never touches the network. It used to stop after
// the first 200 objects and hand the rest back untouched, with nothing in the
// response or the log to say so, while `index.js` sets maxLimit 500 and several
// callers legitimately ask for more than 200 rows: everything past the cap came
// back with a raw storage key that 401s or 403s when the thumbnail is fetched.
// Every object is signed now. The ceiling below is a backstop for a query that
// asks for an implausible number of rows, and past it the url fields are cleared
// rather than left raw, so the client falls back to `getsignedurl` instead of
// using a url that cannot work.
const MAX_SIGNED_OBJECTS = 1000;
const SIGN_CONCURRENCY = 10;
const URL_FIELDS = ['SignedUrl', 'URL', 'CertificateUrl'];

/** Re-signs one field. A field that cannot be signed is left as it was. */
async function signField(obj, field) {
  const rawUrl = obj?.get(field);
  if (!rawUrl) return;
  try {
    obj.set(field, await signStoredUrl(rawUrl));
  } catch (err) {
    // Louder than a debug line: the client gets a url it cannot use.
    console.error(`DocumentAfterFind: could not sign ${field}`, err?.message);
  }
}

async function signDocument(obj) {
  const placeholders = obj?.get('Placeholders') || [];
  if (placeholders.some(x => x?.Role === 'prefill')) {
    try {
      obj.set('Placeholders', await handleValidImage(placeholders));
    } catch (err) {
      console.log('DocumentAfterFind: could not sign prefill images', err?.message);
    }
  }
  await signField(obj, 'SignedUrl');
  await signField(obj, 'URL');
  await signField(obj, 'CertificateUrl');
}

/**
 * Signs the file urls on every object in the result, not just on single-object
 * queries as before (§11.12): list queries used to hand back raw urls that
 * 400 against local storage.
 */
async function DocumentAfterFind(request) {
  const objects = request.objects || [];
  if (!objects.length) return objects;
  await mapWithConcurrency(objects.slice(0, MAX_SIGNED_OBJECTS), SIGN_CONCURRENCY, signDocument);
  const overflow = objects.slice(MAX_SIGNED_OBJECTS);
  if (overflow.length) {
    console.error(
      `DocumentAfterFind: ${overflow.length} objects over the signing ceiling; their file urls were cleared`
    );
    for (const obj of overflow) {
      for (const field of URL_FIELDS) if (obj?.get(field)) obj.set(field, '');
    }
  }
  return objects;
}
export default DocumentAfterFind;
