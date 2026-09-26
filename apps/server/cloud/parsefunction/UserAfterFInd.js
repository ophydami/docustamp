import { signStoredUrl } from '../lib/fileUrls.js';
import { mapWithConcurrency } from './authGuard.js';

const MAX_SIGNED_OBJECTS = 200;
const SIGN_CONCURRENCY = 10;

/** Re-signs one field. A field that cannot be signed is left as it was. */
async function signField(obj, field) {
  const rawUrl = obj?.get(field);
  if (!rawUrl) return;
  try {
    obj.set(field, await signStoredUrl(rawUrl));
  } catch (err) {
    console.log(`UserAfterFind: could not sign ${field}`, err?.message);
  }
}

async function signObject(obj) {
  await signField(obj, 'ProfilePic');
}

/** Signs every object in the result, not just single-object queries (§11.12). */
async function UserAfterFind(request) {
  const objects = request.objects || [];
  if (!objects.length) return objects;
  await mapWithConcurrency(objects.slice(0, MAX_SIGNED_OBJECTS), SIGN_CONCURRENCY, signObject);
  return objects;
}
export default UserAfterFind;
