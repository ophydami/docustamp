/**
 * One upload helper for the generated pdfs (signed documents and certificates).
 *
 * `signPdf` and `generatecertificatebydocid` each carried their own copy. The
 * copy in generatecertificatebydocid swallowed the error, returned `undefined`,
 * and the caller then read `file.imageUrl` off it, so a storage failure surfaced
 * as "Cannot read properties of undefined" instead of anything a user or an
 * operator could act on. Both now come through here, and every call site has to
 * check the returned url.
 */

import fs from 'node:fs';
import axios from 'axios';
import { generateId, getSecureUrl } from '../../Utils.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import { resolveFileUrl } from './files.js';

/** Remove a temp file if it is still there. Never throws. */
export async function unlinkFile(filepath) {
  if (!filepath) return;
  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
    } catch (err) {
      console.log('Err in unlink file: ', filepath, err?.message);
    }
  }
}

/**
 * Store a generated pdf and hand back the url to save on the document.
 *
 * @param {string} pdfName name the file is stored under.
 * @param {string} filepath local file to upload.
 * @returns {Promise<{imageUrl: string}|undefined>} undefined when the upload failed.
 */
export async function uploadFile(pdfName, filepath) {
  try {
    const filedata = fs.readFileSync(filepath);
    const fileRes = await parseUploadFile(pdfName, filedata, 'application/pdf');
    const fileUrl = getSecureUrl(fileRes?.url)?.url;
    return { imageUrl: fileUrl };
  } catch (err) {
    console.log('Err in uploading generated pdf: ', err?.message, err?.stack);
    // Do not leave the generated file behind when it could not be stored.
    await unlinkFile(filepath);
    return undefined;
  }
}

/* ------------------------------------------------------- signature images */

/** Biggest signature/initials image accepted for storage. */
const MAX_SIGNATURE_BYTES = 4 * 1024 * 1024;

/** `data:image/png;base64,...` or a bare base64 blob. */
const DATA_URI_RE = /^data:image\/(png|jpe?g);base64,/i;

/**
 * Store the signer's rendered signature image and return the url to record.
 *
 * `signPdf` used to put the base64 image straight into the `AuditTrail` entry,
 * so every read of a document carried every signature image inline: a completed
 * three-signer document is megabytes of JSON, and the reports page (which has to
 * fetch `AuditTrail` whole, because Parse projects an array key down to its root
 * field) downloaded all of it for every row. The trail now carries a url.
 *
 * Never throws: a signature that cannot be stored is worth less than the
 * signature itself, so the caller records an empty image and the certificate
 * falls back to the "not available" mark.
 *
 * @param {string} value data uri or bare base64 of the image.
 * @param {{label?: string}} [opts] `label` ends the stored file's name
 *   ("signature", "initials").
 * @returns {Promise<string>} the stored url, '' when there was nothing to store.
 */
export async function storeSignatureImage(value, { label = 'signature' } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  // An earlier build (or a re-signed document) may already carry a url.
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const match = DATA_URI_RE.exec(raw);
    const isJpeg = match ? /jpe?g/i.test(match[1]) : false;
    const base64 = match ? raw.slice(match[0].length) : raw;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES) return '';
    const name = `${generateId(12)}_${label}.${isJpeg ? 'jpg' : 'png'}`;
    const res = await parseUploadFile(name, bytes, isJpeg ? 'image/jpeg' : 'image/png');
    // The bare url, not a signed one: the trail outlives any token, and every
    // reader signs it again (the afterFind triggers, `getsignedurl`).
    return res?.url || '';
  } catch (err) {
    console.log('Could not store the signature image: ', err?.message || err);
    return '';
  }
}

/**
 * Bytes of a stored image, for embedding in the certificate. Never throws.
 * @param {string} url a url this deployment stored.
 * @returns {Promise<Buffer|null>}
 */
export async function fetchStoredImage(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const target = await resolveFileUrl(url);
    const res = await axios.get(target, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_SIGNATURE_BYTES,
      maxBodyLength: MAX_SIGNATURE_BYTES,
      maxRedirects: 0,
      timeout: 20_000,
    });
    const bytes = Buffer.from(res.data);
    return bytes.length ? bytes : null;
  } catch (err) {
    console.log('Could not fetch the stored image: ', err?.message || err);
    return null;
  }
}

/** True for a JPEG magic number, so the right pdf-lib embedder is used. */
export function isJpegBytes(bytes) {
  return Boolean(bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8);
}
