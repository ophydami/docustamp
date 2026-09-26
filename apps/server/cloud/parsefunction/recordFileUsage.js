import { storedFileUrl } from '../lib/files.js';
import { checkRateLimit, extUserForUser, resolveCaller } from './authGuard.js';

/**
 * `recordfileusage { url, size }`: count one uploaded file against the
 * workspace's storage quota.
 *
 * The browser used to write both rows itself, with the (public) app id and no
 * session: a POST to `partners_DataFiles` and a read-modify-write of
 * `partners_TenantCredits.usedStorage`, with the tenant id taken from the
 * payload. Anyone could therefore insert usage rows for any tenant, set another
 * workspace's usage to whatever they liked, and two uploads finishing together
 * lost an increment. Both classes are master-key-only for writes now
 * (databases/migrations/20260823010000-...), and this is the only way in.
 *
 * What it does:
 *   - requires a session, and rate limits per account;
 *   - resolves the tenant from the caller's own `contracts_Users` row, never
 *     from the request;
 *   - refuses a url this deployment did not produce, so the class cannot be
 *     filled with arbitrary strings;
 *   - inserts one `partners_DataFiles` row (FileUrl, FileSize, TenantPtr, UserId);
 *   - increments `partners_TenantCredits.usedStorage` atomically (`$inc`),
 *     creating the tenant's row when it has none yet.
 *
 * @param {Object} request Parse cloud function request.
 * @returns {Promise<{ok: true, bytes: number}>}
 */

/** Uploads per account per minute. A signing session uploads a handful. */
const RATE_PER_MIN = 120;

/** Refuse an implausible size rather than corrupting the quota with it. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export default async function recordFileUsage(request) {
  const caller = await resolveCaller(request);
  if (!caller) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  checkRateLimit('recordfileusage', `u:${caller.id}`, RATE_PER_MIN);

  const size = Math.round(Number(request.params?.size));
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'size must be a positive number of bytes.');
  }
  // Only a url this deployment stored: `storedFileUrl` drops the query string
  // too, so a signed link is recorded in its durable form.
  const fileUrl = storedFileUrl(request.params?.url);
  if (!fileUrl) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'url must be a file stored on this server.'
    );
  }

  const extUser = await extUserForUser(caller);
  const tenantId = extUser?.get('TenantId')?.id;
  if (!tenantId) {
    // Nothing to charge it to. Not an error the user can act on, and never worth
    // failing an upload over, so it is reported plainly and counted nowhere.
    return { ok: true, bytes: 0, counted: false };
  }

  const tenantPtr = { __type: 'Pointer', className: 'partners_Tenant', objectId: tenantId };
  const userPtr = { __type: 'Pointer', className: '_User', objectId: caller.id };

  const dataFile = new Parse.Object('partners_DataFiles');
  dataFile.set('FileUrl', fileUrl);
  dataFile.set('FileSize', size);
  dataFile.set('TenantPtr', tenantPtr);
  dataFile.set('UserId', userPtr);
  dataFile.setACL(usageAcl(caller.id));
  await dataFile.save(null, { useMasterKey: true });

  await incrementUsedStorage(tenantPtr, size);
  return { ok: true, bytes: size, counted: true };
}

/**
 * Owner-readable, master-key-writable. The class had no ACL at all, so every row
 * relied on the (previously wide open) class permissions.
 */
function usageAcl(userId) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  acl.setReadAccess(userId, true);
  return acl;
}

/**
 * One atomic `$inc` on the tenant's credits row, created if it does not exist.
 *
 * `increment()` is a single `$inc`; reading `usedStorage`, adding in JavaScript
 * and writing the whole value back (which is what the browser did) lost a count
 * whenever two uploads finished together, so the quota drifted low over time.
 * The create races only on a tenant's very first upload, and a loser retries the
 * increment on the row the winner made.
 */
async function incrementUsedStorage(tenantPtr, size) {
  const query = new Parse.Query('partners_TenantCredits');
  query.equalTo('PartnersTenant', tenantPtr);
  const existing = await query.first({ useMasterKey: true });
  if (existing) {
    existing.increment('usedStorage', size);
    await existing.save(null, { useMasterKey: true });
    return;
  }
  const created = new Parse.Object('partners_TenantCredits');
  created.set('usedStorage', size);
  created.set('PartnersTenant', tenantPtr);
  try {
    await created.save(null, { useMasterKey: true });
  } catch (err) {
    console.log('recordfileusage: credits row insert lost a race, incrementing instead', err?.code);
    const again = await new Parse.Query('partners_TenantCredits')
      .equalTo('PartnersTenant', tenantPtr)
      .first({ useMasterKey: true });
    if (!again) throw err;
    again.increment('usedStorage', size);
    await again.save(null, { useMasterKey: true });
  }
}
