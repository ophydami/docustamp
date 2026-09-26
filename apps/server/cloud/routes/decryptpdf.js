/**
 * POST /decryptpdf - strip the open password from an uploaded PDF.
 *
 * The route used to write the upload to disk under `exports/` using the
 * client-supplied `originalname` verbatim. multer joins destination + filename
 * without sanitising, so an anonymous caller could post
 * `../files/files/<id>_<name>.pdf` and overwrite a stored contract, and two
 * callers uploading the same name raced on one path and could receive each
 * other's decrypted bytes. Nothing ever touches the disk now: the bytes stay in
 * memory, the caller must present a session, and the payload must actually be a
 * PDF and stay under the upload cap.
 *
 * Request  (unchanged): multipart/form-data, field `file`, field `password`,
 *          plus a session token header (`sessiontoken` or `X-Parse-Session-Token`).
 * Response (unchanged): 200 with `application/pdf` bytes, or a JSON `{ error }`
 *          with 400 (not a PDF / unreadable), 401 (no session, wrong password),
 *          413 (too large) or 429 (rate limited).
 */
import multer from 'multer';
import Coherentpdf from 'coherentpdf';
import {
  checkRateLimit,
  clientIp,
  resolveCaller,
  RATE_LIMIT_CODE,
} from '../parsefunction/authGuard.js';

/** Same cap the rest of the upload paths use for a single PDF. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Decrypt attempts allowed per IP per minute; a password oracle should be slow. */
const RATE_LIMIT_PER_MINUTE = Number(process.env.DECRYPTPDF_RATE_LIMIT || 20);

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 4 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname || '';
    const okExt = /\.pdf$/i.test(name);
    const okMime =
      file.mimetype === 'application/pdf' || file.mimetype === 'application/octet-stream';
    // The web client posts a Blob, which can arrive as octet-stream, so accept
    // either signal here; the `%PDF-` magic check below is the real gate.
    if (okMime || okExt) return cb(null, true);
    cb(new UploadError(400, 'Only PDF files are supported.'));
  },
}).single('file');

/** True when the buffer starts with the PDF magic (a leading BOM/junk is tolerated). */
export function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 1024).includes('%PDF-');
}

/**
 * Rate limit, authenticate, then parse the multipart body. Auth runs before
 * multer so an anonymous caller never gets to stream a 25 MB body at us.
 */
export function uploadDecryptPdf(req, res, next) {
  const ip = clientIp(req);
  try {
    checkRateLimit('decryptpdf', ip, RATE_LIMIT_PER_MINUTE);
  } catch (err) {
    const status = err?.code === RATE_LIMIT_CODE ? 429 : 400;
    return res.status(status).json({ error: 'Too many requests. Please try again in a minute.' });
  }

  resolveCaller({ headers: req.headers })
    .then(user => {
      if (!user) return res.status(401).json({ error: 'Please sign in to unlock this PDF.' });
      req.decryptCaller = user;
      memoryUpload(req, res, err => {
        if (!err) return next();
        if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
        if (err?.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'That PDF is too large to unlock.' });
        }
        return res.status(400).json({ error: 'Could not read the uploaded file.' });
      });
    })
    .catch(() => res.status(401).json({ error: 'Please sign in to unlock this PDF.' }));
}

/** Back-compat alias: `upload.single('file')` used to be the route middleware. */
export const upload = { single: () => uploadDecryptPdf };

export default async function decryptpdf(req, res) {
  const buffer = req.file?.buffer;
  if (!buffer?.length) return res.status(400).json({ error: 'No file uploaded.' });
  if (!looksLikePdf(buffer))
    return res.status(400).json({ error: 'Only PDF files are supported.' });

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const pdf = await Coherentpdf.fromMemory(buffer, password);
    await Coherentpdf.decryptPdf(pdf, password);
    const out = await Coherentpdf.toMemory(pdf, false, false);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="decrypted.pdf"',
      'Content-Length': out.length,
    });
    return res.send(Buffer.from(out));
  } catch (err) {
    // Never echo library internals: the message is the only signal a caller
    // brute-forcing a password would get.
    const detail = err?.[2]?.c || err?.message || '';
    console.log('Error in decrypt file: ', detail);
    if (/bad password|decrypt_pdf_inner/i.test(String(detail))) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    return res.status(400).json({ error: 'This PDF could not be unlocked.' });
  }
}
