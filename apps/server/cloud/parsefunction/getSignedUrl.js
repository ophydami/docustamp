import dotenv from 'dotenv';
import { signingTokenFromRequest } from '../lib/signingToken.js';
import { checkRateLimit, clientIp, resolveCaller, resolveDocumentActor } from './authGuard.js';
import { assertLocalFileUrl } from './fileUpload.js';
import { accessibleTemplateQuery, extUserForCaller } from './GetTemplate.js';
import {
  DEFAULT_URL_TTL,
  extractKeyFromUrl,
  objectStorageOrigins,
  signLocalUrl,
  signStoredUrl,
  validateSignedLocalUrl,
} from '../lib/fileUrls.js';
dotenv.config({ quiet: true });

/**
 * `getsignedurl` and the presigning helpers the afterFind triggers use.
 *
 * The signing itself moved to `cloud/lib/fileUrls.js`: this file used to hold
 * two near-identical local signers, its own S3 client and its own endpoint
 * normalisation, and three other modules held further copies. Everything here is
 * a thin re-export so existing imports keep working.
 */

export { extractKeyFromUrl, objectStorageOrigins, validateSignedLocalUrl };

/**
 * A short-lived link to a stored file.
 * @param {string} url the stored (unsigned) url.
 * @param {number} [expiresIn] lifetime in seconds; the default suits document reads.
 * @returns {Promise<string>} a signed url.
 */
export default async function getPresignedUrl(url, expiresIn = DEFAULT_URL_TTL) {
  return await signStoredUrl(url, expiresIn);
}

/* ------------------------------------------------------------------------- *
 * `getsignedurl` cloud function
 *
 * It used to presign whatever string it was handed: pass any docId (they travel
 * in every signing link) and any url, and the server would mint a short-lived
 * link to it, including files belonging to other tenants. The url is now checked
 * against the file fields actually stored on the named document or template, and
 * the caller has to be entitled to that row in the first place.
 * ------------------------------------------------------------------------- */

const RATE_AUTHENTICATED_PER_MIN = 240;
const RATE_ANONYMOUS_PER_MIN = 60;

/** Object keys that hold a stored file url. */
const FILE_URL_KEYS = new Set([
  'URL',
  'SignedUrl',
  'CertificateUrl',
  'SignUrl',
  'ImageURL',
  'Signature',
]);

/** Widget types whose `options.response` is an uploaded image rather than text. */
const IMAGE_WIDGET_TYPES = new Set(['image', 'draw', 'signature', 'stamp', 'initials']);

/** Every stored file url on one row, wherever it sits in the JSON. */
function collectFileUrls(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectFileUrls(item, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (FILE_URL_KEYS.has(key)) found.add(value);
      continue;
    }
    if (
      key === 'options' &&
      IMAGE_WIDGET_TYPES.has(node.type) &&
      typeof value?.response === 'string'
    ) {
      found.add(value.response);
    }
    collectFileUrls(value, found);
  }
  return found;
}

/**
 * Compare on the path and on the last path segment: presigning rewrites the
 * query string (local files) or the host (S3, where the last segment is the
 * object key), so those are the parts that identify the same stored file.
 */
function urlParts(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    return {
      path: `${parsed.origin}${parsed.pathname}`,
      name: decodeURIComponent(segments[segments.length - 1] || ''),
    };
  } catch {
    return null;
  }
}

function assertUrlBelongsTo(url, rowJson) {
  const requested = urlParts(url);
  if (!requested) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide a valid file url.');
  }
  for (const stored of collectFileUrls(rowJson)) {
    const allowed = urlParts(stored);
    if (!allowed) continue;
    if (allowed.path === requested.path) return;
    if (allowed.name && allowed.name === requested.name) return;
  }
  throw new Parse.Error(
    Parse.Error.OPERATION_FORBIDDEN,
    'That file does not belong to this document.'
  );
}

async function signUrl(url) {
  if (url.includes('/files/')) {
    // Same validation `fileupload` applies before it signs a local file url.
    return signLocalUrl(assertLocalFileUrl(url), DEFAULT_URL_TTL);
  }
  return await signStoredUrl(url);
}

export async function getSignedUrl(request) {
  try {
    const docId = request.params?.docId || '';
    const templateId = request.params?.templateId || '';
    const url = request.params?.url;
    if (typeof url !== 'string' || !url) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide a valid file url.');
    }

    const caller = request.master ? null : await resolveCaller(request);
    if (!request.master) {
      checkRateLimit(
        'getsignedurl',
        caller ? `u:${caller.id}` : `ip:${clientIp(request)}`,
        caller ? RATE_AUTHENTICATED_PER_MIN : RATE_ANONYMOUS_PER_MIN
      );
    }

    if (docId) {
      const query = new Parse.Query('contracts_Document');
      query.equalTo('objectId', docId);
      query.include('ExtUserPtr');
      query.include('Signers');
      query.include('Placeholders.signerPtr');
      query.notEqualTo('IsArchive', true);
      const res = await query.first({ useMasterKey: true });
      if (!res) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
      }
      // Throws for anyone who is not the owner or one of the signers.
      await resolveDocumentActor(request, res, {
        contactId: request.params?.contactId,
        signingToken: signingTokenFromRequest(request),
        ownerMayActForContact: true,
      });
      assertUrlBelongsTo(url, res.toJSON());
      return await signUrl(url);
    }

    if (templateId) {
      if (!request.master && !caller) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
      }
      let query;
      if (request.master) {
        query = new Parse.Query('contracts_Template');
        query.equalTo('objectId', templateId);
        query.notEqualTo('IsArchive', true);
      } else {
        query = accessibleTemplateQuery(templateId, caller, await extUserForCaller(caller));
      }
      const res = await query.first({ useMasterKey: true });
      if (!res) {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          "template deleted or you don't have access."
        );
      }
      assertUrlBelongsTo(url, res.toJSON());
      return await signUrl(url);
    }

    // No row named: only a signed-in caller may sign a url on trust.
    if (!request.master && !caller) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
    }
    return await signUrl(url);
  } catch (err) {
    console.log('error in getsignedurl', err);
    const code = err.code || 400;
    const msg = err.message;
    throw new Parse.Error(code, msg);
  }
}

/**
 * A local `/files/` url with a read token.
 *
 * Kept as a named export (`fileupload` and `cloud/lib/files.js` call it); the
 * implementation is `cloud/lib/fileUrls.signLocalUrl`.
 */
export function getSignedLocalUrl(fileUrl, expirationTimeInSeconds) {
  return signLocalUrl(fileUrl, expirationTimeInSeconds || DEFAULT_URL_TTL);
}

/**
 * The same signature, for a url that may or may not be a local file: anything
 * that is not one is handed back untouched. The afterFind triggers use it.
 */
export function presignedlocalUrl(signedUrl, expirationTimeInSeconds) {
  if (signedUrl?.includes('/files/')) {
    return signLocalUrl(signedUrl, expirationTimeInSeconds || DEFAULT_URL_TTL);
  }
  return signedUrl;
}
