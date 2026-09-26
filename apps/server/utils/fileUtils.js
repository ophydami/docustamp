import axios from 'axios';
import { cloudServerUrl, sanitizeFileName, serverAppId } from '../Utils.js';

function formatFixedDate(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const mmm = months[date.getMonth()];
  const yyyy = String(date.getFullYear());
  let h = date.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const HH12 = String(h).padStart(2, '0');
  const MM = String(date.getMinutes()).padStart(2, '0');
  return `${dd}-${mmm}-${yyyy} ${HH12}:${MM} ${ampm}`;
}

/**
 * Remove characters not allowed in file names for major OSes.
 */
function sanitizeDownloadFilename(name) {
  return (
    name
      // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ') // reserved + control
      .replace(/\s+/g, ' ') // collapse spaces
      .trim()
  );
}

/**
 * Build filename using the selected format ID and runtime values.
 * @param {string} formatId - One of FILENAME_FORMATS ids
 * @param {object} ctx - { docName, email, date, ext, isSigned, datePattern }
 * @returns {string}
 */
export function buildDownloadFilename(formatId, ctx) {
  const {
    docName = 'Document',
    email = 'user@example.com',
    date = new Date(),
    ext = 'pdf',
    isSigned = false,
  } = ctx || {};

  const base = sanitizeDownloadFilename(String(docName) || 'Document');
  const safeEmail = sanitizeDownloadFilename(String(email) || 'user@example.com');
  const dateStr = formatFixedDate(date);

  let stem;
  switch (formatId) {
    case 'DOCNAME':
      stem = base;
      break;
    case 'DOCNAME_SIGNED':
      stem = isSigned ? `${base} - Signed` : base; // if not signed, fallback to base
      break;
    case 'DOCNAME_EMAIL':
      stem = `${base} - ${safeEmail}`;
      break;
    case 'DOCNAME_EMAIL_DATE':
      stem = `${base} - ${safeEmail} - ${dateStr}`;
      break;
    default:
      stem = base; // safe default
  }

  const safeExt = ext.replace(/\.+/g, '').toLowerCase() || 'pdf';
  return `${stem}.${safeExt}`;
}

/**
 * Uploads bytes to the Parse files endpoint with the master key.
 *
 * The name goes straight into the request path, so it is stripped to
 * `[A-Za-z0-9._-]` and percent-encoded first: an unescaped name could otherwise
 * walk out of /files/ or smuggle a query string into a master-key request.
 * @param {string} fileName
 * @param {Buffer | Uint8Array | string} fileData
 * @param {string} mimeType
 */
export async function parseUploadFile(fileName, fileData, mimeType) {
  const raw = String(fileName ?? '');
  // sanitizeFileName substitutes a 'document' stem for a name that has nothing
  // usable in it, which is right for a display name but wrong here: a caller who
  // passed '/////' passed a path, not a file, and should hear about it.
  const hasUsableChar = /[a-zA-Z0-9]/.test(raw);
  const safeName = sanitizeFileName(raw);
  if (
    !hasUsableChar ||
    !safeName ||
    safeName.includes('/') ||
    safeName.includes('\\') ||
    safeName.includes('..')
  ) {
    throw Object.assign(new Error(`Invalid file name: ${fileName}`), { code: 400 });
  }
  try {
    const res = await axios.post(
      `${cloudServerUrl}/files/${encodeURIComponent(safeName)}`,
      fileData,
      {
        headers: {
          'X-Parse-Application-Id': serverAppId,
          'X-Parse-Master-Key': process.env.MASTER_KEY,
          'Content-Type': mimeType,
        },
      }
    );

    // console.log('File uploaded:', res.data);
    return res.data;
  } catch (err) {
    // The old catch only looked at err.response.data.error, which exists for a
    // Parse REST rejection but not for the failures that actually happen here:
    // ECONNREFUSED against the loopback Parse url, a socket timeout, an HTML
    // error page from a proxy. Those all read "Unknown error" with the stack and
    // the cause gone, and because a plain object was thrown rather than an Error
    // nothing upstream could tell what had failed.
    const statusCode = err?.response?.status || 500;
    const responseError =
      err?.response?.data?.error ||
      (typeof err?.response?.data === 'string' ? err.response.data.slice(0, 200) : '');
    const detail = responseError || [err?.code, err?.message].filter(Boolean).join(': ');
    const message = `Could not upload ${safeName}: ${detail || 'unknown error'}`;
    console.error('Err in parseUploadFile', message);
    throw Object.assign(new Error(message), { code: statusCode, cause: err });
  }
}
