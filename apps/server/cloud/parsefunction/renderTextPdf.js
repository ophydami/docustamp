import { normaliseContent, renderTextDocument } from '../lib/textDocument.js';
import { assertNotDisabled, checkRateLimit, extUserForUser } from './authGuard.js';

/**
 * `rendertextpdf { title?, content }`: turn a written document into the PDF
 * that gets signed (docs/TEXT_DOCUMENTS.md).
 *
 * The web editor calls this on every pause in typing to refresh the preview,
 * and once more before it saves. Nothing is stored here: the browser uploads
 * the bytes through its usual `Parse.File` path and records storage usage
 * itself, so this function has no side effects and can be called freely.
 *
 * The title is the document `Name`, so it is held to the same 250 characters.
 * The content is normalised before rendering, and a shape or size the model
 * refuses answers with VALIDATION_ERROR rather than a half-drawn page.
 *
 * @param {Object} request Parse cloud function request.
 * @returns {Promise<{pdfBase64: string, pageCount: number, bytes: number}>}
 */

/** Renders per account per minute. A preview refresh after each pause. */
const RATE_PER_MIN = 240;

const TITLE_MAX_LENGTH = 250;

export default async function renderTextPdfFn(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const extUser = await extUserForUser(request.user);
  if (!extUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User profile not found.');
  }
  assertNotDisabled(extUser);
  checkRateLimit('rendertextpdf', request.user.id, RATE_PER_MIN);

  const rawTitle = request.params?.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, TITLE_MAX_LENGTH) : '';
  const content = normaliseContent(request.params?.content);

  const { bytes, pageCount } = await renderTextDocument({ title, content });
  return {
    pdfBase64: Buffer.from(bytes).toString('base64'),
    pageCount,
    bytes: bytes.length,
  };
}
