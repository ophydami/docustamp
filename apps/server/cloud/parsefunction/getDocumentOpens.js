import { loadCaller } from '../lib/context.js';
import { listDocumentOpens } from '../lib/documentOpens.js';
import { resolveCaller } from './authGuard.js';

/**
 * `getdocumentopens`: who opened a document, how many times, and each open.
 *
 * Owners only (the summary is also on the document row as `OpenStats`, so the
 * inbox and the document page do not need this call for the counts alone).
 */
export default async function getDocumentOpens(request) {
  const docId = request?.params?.docId;
  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'missing parameter docId.');
  }
  const user = await resolveCaller(request);
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
  }
  const caller = await loadCaller(user, { publicUrl: request.headers?.public_url });
  return await listDocumentOpens(caller, docId, { limit: request?.params?.limit });
}
