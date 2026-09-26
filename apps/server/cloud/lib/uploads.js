import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { PDFDocument } from 'pdf-lib';
import { generateId, sanitizeFileName } from '../../Utils.js';
import { fileTokenSecret, makeS3Client, storageBucket } from './fileUrls.js';
import { MAX_PDF_BYTES, bytesFromInput, isPdfBytes, uploadPdfBytesDetailed } from './files.js';

/**
 * Two ways around "a 700 KB PDF is 1 MB of base64 in a tool argument":
 *
 *  - `createUpload` hands out a presigned PUT url on object storage; the client
 *    PUTs the raw bytes there (curl -T), then `completeUpload` reads them back,
 *    flattens and stores them like any other upload and returns the stored url.
 *    Local-disk storage has no presigned PUT, so it answers with `mode: "direct"`
 *    and the caller falls back to upload_document / a public url.
 *  - `mergePdfs` concatenates several PDFs (urls or base64) into one stored file
 *    and reports where each one starts, for one envelope signed under one link.
 */

const UPLOAD_PREFIX = 'uploads/';
const UPLOAD_TTL_SECONDS = 900;

function storesLocally() {
  return String(process.env.USE_LOCAL || '').toLowerCase() === 'true';
}

function sign(key, userId) {
  return createHmac('sha256', fileTokenSecret()).update(`${key}\n${userId}`).digest('hex').slice(0, 32);
}

export async function createUpload(caller, { fileName, size } = {}) {
  if (storesLocally() || !storageBucket()) {
    return {
      mode: 'direct',
      message:
        'This server stores files on its own disk, so there is no presigned upload. Use upload_document with fileBase64, or pass a public https url to create_document / analyze_document (it is copied into storage).',
    };
  }
  const n = Number(size);
  if (Number.isFinite(n) && n > MAX_PDF_BYTES) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The PDF is larger than 80 MB.');
  }
  const base = sanitizeFileName(String(fileName || 'document.pdf').replace(/\.pdf$/i, '')) || 'document';
  const key = `${UPLOAD_PREFIX}${generateId(16)}_${base.slice(0, 60)}.pdf`;
  const uploadId = `${key}.${sign(key, caller.userId)}`;
  const client = makeS3Client();
  const putUrl = await presign(
    client,
    new PutObjectCommand({ Bucket: storageBucket(), Key: key, ContentType: 'application/pdf' }),
    { expiresIn: UPLOAD_TTL_SECONDS }
  );
  return {
    mode: 'presigned',
    uploadId,
    putUrl,
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    example: `curl -T your.pdf -H 'Content-Type: application/pdf' '${putUrl}'`,
    then: 'Call complete_upload with the uploadId to get the stored url.',
  };
}

function parseUploadId(uploadId, userId) {
  const raw = String(uploadId || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const key = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!key.startsWith(UPLOAD_PREFIX) || !/^[0-9a-f]{32}$/.test(sig)) return null;
  const expected = sign(key, userId);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return key;
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function completeUpload(caller, { uploadId, fileName, keepOriginal = false } = {}) {
  const key = parseUploadId(uploadId, caller.userId);
  if (!key) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Unknown uploadId.');
  const client = makeS3Client();
  let bytes;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: storageBucket(), Key: key }));
    bytes = await streamToBuffer(res.Body);
  } catch (err) {
    throw new Parse.Error(
      Parse.Error.OBJECT_NOT_FOUND,
      `Nothing was uploaded for this uploadId yet (${err?.name || err?.message || 'not found'}). PUT the file to putUrl first.`
    );
  }
  if (!isPdfBytes(bytes)) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The uploaded file is not a PDF.');
  }
  const stored = await uploadPdfBytesDetailed(
    bytes,
    fileName || key.slice(UPLOAD_PREFIX.length).replace(/^[^_]*_/, ''),
    { flatten: keepOriginal !== true }
  );
  // The raw object is only a staging copy.
  client.send(new DeleteObjectCommand({ Bucket: storageBucket(), Key: key })).catch(() => undefined);
  return {
    url: stored.url,
    bytes: bytes.length,
    flattened: stored.flattened,
    ...(stored.flattened || keepOriginal ? {} : { warnings: [`The existing form fields in this PDF could not be flattened (${stored.flattenError}).`] }),
  };
}

/* ------------------------------------------------------------------ merging */

/**
 * @param {Array<{url?: string, fileBase64?: string, fileName?: string}>} files
 * @returns {Promise<{bytes: Uint8Array, parts: Array<{index: number, fileName?: string, firstPage: number, pageCount: number}>, pageCount: number}>}
 */
export async function mergePdfBytes(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length < 1) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Give at least one file.');
  if (list.length > 20) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'At most 20 files per envelope.');
  const out = await PDFDocument.create();
  const parts = [];
  let page = 1;
  let total = 0;
  for (const [index, f] of list.entries()) {
    const bytes = await bytesFromInput(f);
    total += bytes.length;
    if (total > MAX_PDF_BYTES) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'The merged PDF would be larger than 80 MB.');
    if (!isPdfBytes(bytes)) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `File ${index + 1} is not a PDF.`);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
    parts.push({ index, fileName: f.fileName || undefined, firstPage: page, pageCount: copied.length });
    page += copied.length;
  }
  return { bytes: await out.save(), parts, pageCount: page - 1 };
}

/** Merge and store; the stored url is what create_document takes. */
export async function mergeAndStore(files, fileName = 'envelope.pdf') {
  const merged = await mergePdfBytes(files);
  const stored = await uploadPdfBytesDetailed(merged.bytes, fileName);
  return { url: stored.url, pageCount: merged.pageCount, parts: merged.parts, flattened: stored.flattened };
}
