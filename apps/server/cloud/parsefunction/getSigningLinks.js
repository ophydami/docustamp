import { assertOwner } from '../lib/documents.js';
import { signingLinksFor } from '../lib/requestMail.js';
import { resolveCaller } from './authGuard.js';

/**
 * `getsigninglinks` hands the document owner the per-recipient signing links,
 * tokens included, so the web app can compose the signature-request mail itself
 * and offer "copy signing link" without ever building a link in the browser
 * (the browser cannot mint the token, and that is the point).
 *
 * Owner session only: a link is access, so this is as sensitive as the document.
 */
export default async function getSigningLinks(request) {
  const docId = request.params?.docId;
  if (!docId || typeof docId !== 'string') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'missing parameter docId.');
  }

  const user = request.master ? null : await resolveCaller(request);
  if (!request.master && !user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', docId);
  query.include('ExtUserPtr');
  query.include('Signers');
  query.include('Placeholders.signerPtr');
  query.notEqualTo('IsArchive', true);
  const doc = await query.first({ useMasterKey: true });
  if (!doc) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
  }

  const _doc = JSON.parse(JSON.stringify(doc));
  if (!request.master) {
    // Same owner test the REST/MCP layer uses.
    assertOwner(_doc, { userId: user.id });
  }

  return { links: signingLinksFor(_doc, request.headers?.public_url) };
}
