import { signStoredUrl } from '../lib/fileUrls.js';
import { mapWithConcurrency } from './authGuard.js';

const MAX_SIGNED_OBJECTS = 200;
const SIGN_CONCURRENCY = 10;

/**
 * A day, rather than the couple of minutes a document link gets. The logo is
 * public-facing decoration that the frontend caches (`useBrand`, one hour) and
 * that recipients load out of an email long after it was sent, so a link that
 * dies in 200 seconds would simply render as a broken image.
 */
const BRANDING_URL_TTL = 24 * 60 * 60;

/** Re-signs one field. A field that cannot be signed is left as it was. */
async function signField(obj, field) {
  const rawUrl = obj?.get(field);
  if (!rawUrl) return;
  try {
    obj.set(field, await signStoredUrl(rawUrl, BRANDING_URL_TTL));
  } catch (err) {
    console.log(`TenantAterFind: could not sign ${field}`, err?.message);
  }
}

async function signObject(obj) {
  await signField(obj, 'Logo');
  await signField(obj, 'Favicon');
}

/** Signs every object in the result, not just single-object queries (§11.12). */
async function TenantAterFind(request) {
  const objects = request.objects || [];
  if (!objects.length) return objects;
  await mapWithConcurrency(objects.slice(0, MAX_SIGNED_OBJECTS), SIGN_CONCURRENCY, signObject);
  return objects;
}
export default TenantAterFind;
