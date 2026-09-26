import { handleValidImage } from '../../Utils.js';
import { signStoredUrl } from '../lib/fileUrls.js';
import { mapWithConcurrency } from './authGuard.js';

// Every object is signed, not just the first 200: the rest used to come back
// with raw storage keys that 401 or 403 when the thumbnail is fetched, and the
// SPA asks for 300 templates. Signing is local (HMAC / JWT), so the ceiling
// below is only a backstop, and past it the url fields are cleared rather than
// left raw so the client falls back to `getsignedurl`.
const MAX_SIGNED_OBJECTS = 1000;
const SIGN_CONCURRENCY = 10;
const URL_FIELDS = ['SignedUrl', 'URL', 'CertificateUrl'];

async function signField(obj, field) {
  const rawUrl = obj?.get(field);
  if (!rawUrl) return;
  try {
    obj.set(field, await signStoredUrl(rawUrl));
  } catch (err) {
    // Louder than a debug line: the client gets a url it cannot use.
    console.error(`TemplateAfterFind: could not sign ${field}`, err?.message);
  }
}

async function signTemplate(obj) {
  const placeholders = obj?.get('Placeholders') || [];
  if (placeholders.some(x => x?.Role === 'prefill')) {
    try {
      obj.set('Placeholders', await handleValidImage(placeholders));
    } catch (err) {
      console.log('TemplateAfterFind: could not sign prefill images', err?.message);
    }
  }
  await signField(obj, 'SignedUrl');
  await signField(obj, 'URL');
  await signField(obj, 'CertificateUrl');
}

/** Signs every object in the result, not just single-object queries (§11.12). */
async function TemplateAfterFind(request) {
  const objects = request.objects || [];
  if (!objects.length) return objects;
  await mapWithConcurrency(objects.slice(0, MAX_SIGNED_OBJECTS), SIGN_CONCURRENCY, signTemplate);
  const overflow = objects.slice(MAX_SIGNED_OBJECTS);
  if (overflow.length) {
    console.error(
      `TemplateAfterFind: ${overflow.length} objects over the signing ceiling; their file urls were cleared`
    );
    for (const obj of overflow) {
      for (const field of URL_FIELDS) if (obj?.get(field)) obj.set(field, '');
    }
  }
  return objects;
}
export default TemplateAfterFind;
