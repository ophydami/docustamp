import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import pLimit from 'p-limit';
import { cloudServerUrl, serverAppId } from '../../../Utils.js';
import { makeS3Client, s3ParamsFor } from '../../lib/fileUrls.js';

// === Configuration ===
const CONCURRENCY_LIMIT = 5;

/**
 * Hosts whose files live on this server rather than in S3.
 *
 * This used to be `new URL(process.env.SERVER_URL).hostname` evaluated at
 * import time, which threw `Invalid URL` and took the whole process down at
 * boot (and any test that imported the deletion routes) whenever `SERVER_URL`
 * was unset. It is computed on first use now, falls back to `cloudServerUrl`,
 * and drops the host-derived entry entirely when neither parses.
 */
let localHostsCache = null;
export function localHosts() {
  const configured = process.env.SERVER_URL || cloudServerUrl || '';
  if (localHostsCache?.key === configured) return localHostsCache.hosts;
  const hosts = new Set(['localhost', '127.0.0.1']);
  try {
    hosts.add(new URL(configured).hostname);
  } catch {
    console.log(
      `deleteFileUrl: SERVER_URL ("${configured}") is not a URL, treating only localhost as local`
    );
  }
  localHostsCache = { key: configured, hosts };
  return hosts;
}

// === S3 Client Setup ===
/**
 * One client, shared with the presigner (`cloud/lib/fileUrls.js`).
 *
 * This file used to build its own with `endpoint: 'https://' + DO_ENDPOINT`,
 * which produces `https://https://...` for a DO_ENDPOINT that already carries a
 * scheme (the spelling `getSignedUrl.js` and the files adapter both accept), so
 * every delete failed DNS resolution and the failure was swallowed. Built lazily
 * so a deployment without object storage configured does not construct one at
 * import time.
 */
let s3Client = null;
function s3() {
  if (!s3Client) s3Client = makeS3Client();
  return s3Client;
}

// === Helpers ===
/**
 * Bucket and key for a stored file url.
 *
 * The bucket used to be `hostname.split('.')[0]`, which is only right for the
 * virtual-host spelling (`https://<bucket>.endpoint/<key>`); in the path-style
 * spelling (`https://endpoint/<bucket>/<key>`) it produced a bucket named after
 * the endpoint and a key with the real bucket glued onto the front, so the
 * delete silently missed. `s3ParamsFor` is the same mapping the presigner uses,
 * so a url that can be read can be deleted.
 */
const getS3ParamsFromUrl = s3ParamsFor;

async function deleteS3File(fileUrl) {
  const params = getS3ParamsFromUrl(fileUrl);
  if (!params) {
    console.error('S3 delete skipped, no bucket/key for url:', fileUrl);
    return false;
  }
  try {
    await s3().send(new DeleteObjectCommand(params));
    return true;
  } catch (err) {
    console.error(`S3 delete failed: ${params.Key}:`, err.message);
    return false;
  }
}

async function deleteLocalFile(fileUrl) {
  try {
    const url = new URL(fileUrl);
    const filePath = decodeURIComponent(url.pathname);
    if (!filePath.includes('/files/')) return false;

    const localPath = url?.pathname?.split(`/files/${serverAppId}/`)?.pop();

    if (!localPath) return false;
    await fs.unlink(`./files/files/${localPath}`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('⚠️ Local file not found:', fileUrl);
    } else {
      console.error('❌ Local delete failed:', err.message);
    }
    return false;
  }
}

/**
 * Best effort delete of one stored file. Never throws: a storage failure must
 * not abort an account deletion halfway through.
 *
 * @param {string} fileUrl
 * @returns {Promise<boolean>} true when a file was actually removed
 */
export async function deleteFileByUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  try {
    const url = new URL(fileUrl);
    if (localHosts().has(url.hostname)) {
      return await deleteLocalFile(fileUrl);
    }
    return await deleteS3File(fileUrl);
  } catch {
    console.warn('⚠️ Invalid URL, skipping:', fileUrl);
    return false;
  }
}

/**
 * Delete a batch of file URLs, deduplicated, at the usual concurrency.
 * @param {Array<string|undefined>} fileUrls
 * @returns {Promise<number>} how many files were removed
 */
export async function deleteFileUrls(fileUrls = []) {
  const urls = [...new Set(fileUrls.filter(url => typeof url === 'string' && url))];
  if (!urls.length) return 0;
  const limiter = pLimit(CONCURRENCY_LIMIT);
  const results = await Promise.all(urls.map(url => limiter(() => deleteFileByUrl(url))));
  return results.filter(Boolean).length;
}

// === Main Batch Deletion Function ===
/**
 * parse-server refuses a page larger than `maxLimit` (500), so the old
 * `limit(1000)` came back capped at 500 and `results.length === limit` was
 * never true: only the first page was ever deleted.
 */
const PAGE_SIZE = 500;

/**
 * Build the query one deletion page runs.
 *
 * Deletion is authorised by a `contracts_Users` row in the calling admin's
 * tenant, so every query has to be scoped to that membership. Scoping by the
 * bare `_User` pointer (what this file used to do) reaches every tenant that
 * `_User` belongs to and destroys other workspaces' documents.
 *
 * @param {string} className
 * @param {{extUserPtr?: object, createdBy?: object, userId?: object,
 *          tenantPtr?: object, tenantField?: string}} scope
 *   `extUserPtr` is a `contracts_Users` pointer and is tenant-scoped on its own.
 *   `createdBy`/`userId` are `_User` pointers and must be paired with
 *   `tenantPtr` (matched against `tenantField`, default `TenantId`).
 * @returns {Parse.Query}
 */
export function scopedDeletionQuery(className, scope = {}) {
  const { extUserPtr, createdBy, userId, tenantPtr, tenantField = 'TenantId' } = scope;
  if (!extUserPtr && !createdBy && !userId) {
    throw new Error(`scopedDeletionQuery(${className}): refusing an unscoped deletion query`);
  }
  const query = new Parse.Query(className);
  if (extUserPtr) query.equalTo('ExtUserPtr', extUserPtr);
  if (createdBy) query.equalTo('CreatedBy', createdBy);
  if (userId) query.equalTo('UserId', userId);
  // `extUserPtr` already names one tenant membership; the `_User`-keyed classes
  // only become tenant-safe once the tenant is pinned too.
  if (tenantPtr) query.equalTo(tenantField, tenantPtr);
  query.limit(PAGE_SIZE);
  query.ascending('objectId');
  return query;
}

/** Runs `handlePage` over every page the scoped query matches. */
async function deletePages(className, scope, urlFields) {
  const limiter = pLimit(CONCURRENCY_LIMIT);
  let total = 0;
  let filesNotDeleted = 0;
  for (;;) {
    const results = await scopedDeletionQuery(className, scope).find({ useMasterKey: true });
    if (results.length) {
      if (urlFields.length) {
        const fileDeletePromises = [];
        for (const obj of results) {
          const urls = urlFields.map(field => obj.get(field)).filter(Boolean);
          for (const fileUrl of urls)
            fileDeletePromises.push(limiter(() => deleteFileByUrl(fileUrl)));
        }
        const outcomes = await Promise.all(fileDeletePromises);
        // A storage failure must not abort an account deletion halfway through,
        // but it must not be invisible either: the rows are about to go, so a
        // file that was not removed is orphaned for good.
        const missed = outcomes.filter(ok => !ok).length;
        if (missed) {
          filesNotDeleted += missed;
          console.error(
            `${className}: ${missed} stored file(s) could not be deleted; they are now orphaned`
          );
        }
      }
      await Parse.Object.destroyAll(results, { useMasterKey: true });
      total += results.length;
      console.log(`Deleted ${results.length} Parse objects from ${className}`);
    }
    // A short page means the last one; deleting always shrinks the match set,
    // so a full page is only ever followed by more rows.
    if (results.length < PAGE_SIZE) break;
  }
  console.log(
    `Finished deletion from ${className} (${total} rows, ${filesNotDeleted} file(s) left behind) for scope`,
    describeScope(scope)
  );
  return total;
}

function describeScope(scope) {
  return {
    extUser: scope?.extUserPtr?.objectId,
    createdBy: scope?.createdBy?.objectId,
    userId: scope?.userId?.objectId,
    tenant: scope?.tenantPtr?.objectId,
  };
}

/** contracts_Document / contracts_Template: scoped by `ExtUserPtr`. */
export async function deleteInBatches(className, scope) {
  // `CertificateUrl` is the real field name; the old `certificateUrl` spelling
  // never matched, so completion certificates were orphaned in storage.
  return await deletePages(className, scope, ['URL', 'SignedUrl', 'CertificateUrl']);
}

/** partners_DataFiles: `UserId` + `TenantPtr`. */
export async function deleteDataFiles(className, scope) {
  return await deletePages(className, scope, ['FileUrl']);
}

/** contracts_Contactbook: `CreatedBy` + `TenantId`. */
export async function deleteContactsInBatch(className, scope) {
  return await deletePages(className, scope, []);
}
