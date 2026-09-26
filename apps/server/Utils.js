import dotenv from 'dotenv';
import { format, toZonedTime } from 'date-fns-tz';
import { signLocalUrl, signStoredUrl } from './cloud/lib/fileUrls.js';
import crypto from 'node:crypto';
import { EMAIL_RE } from './cloud/lib/email.js';
import { PDFDocument, PDFName } from 'pdf-lib';

dotenv.config({ quiet: true });

/**
 * The url the server uses to call its own Parse API (file uploads, the internal
 * REST calls in PDF.js and the batch functions). It stays on the loopback
 * interface so those calls never leave the box, but it has to follow the port
 * and mount path this process actually listens on.
 *   INTERNAL_SERVER_URL  overrides it outright, e.g. http://127.0.0.1:8080/app
 *   PORT / PARSE_MOUNT   otherwise decide it, matching index.js.
 */
export const cloudServerUrl =
  process.env.INTERNAL_SERVER_URL?.trim().replace(/\/+$/, '') ||
  `http://localhost:${process.env.PORT || 8080}${process.env.PARSE_MOUNT || '/app'}`;
// Internal Parse application id. Never shown to users, but the web app must be
// built with the same value (VITE_APPID); docker-compose.yml feeds both from APP_ID.
export const serverAppId = process.env.APP_ID || 'docustamp';
/**
 * Platform branding for everything the server writes into emails, PDF signatures
 * and the Parse mail adapter. Every value can be overridden per deployment:
 *   APP_NAME             display name (default "DocuStamp")
 *   APP_LOGO_URL         public image url for the mail header; empty or "none" =
 *                        no image, the name is shown as a text wordmark instead
 *   APP_MAIL_COLOR       header bar colour, e.g. #0f6e56
 *   APP_COMPLAINTS_EMAIL address behind the "file a complaint" link in the
 *                        Powered-by footer; empty = a plain "Sent via <name>" line
 *   APP_SUPPORT_EMAIL    contact written into PDF signatures and shown in error
 *                        messages; empty = none
 */
const envText = (key, fallback) => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};
export const appName = envText('APP_NAME', 'DocuStamp');
export const appLogoUrl = (() => {
  const value = envText('APP_LOGO_URL', '');
  return /^(none|off|false|-)$/i.test(value) ? '' : value;
})();
export const mailThemeColor = envText('APP_MAIL_COLOR', '#0f6e56');
export const complaintsEmail = envText('APP_COMPLAINTS_EMAIL', '');
export const supportEmail = envText('APP_SUPPORT_EMAIL', '');

/**
 * The header logo of the HTML mails: the configured image, or the app name as a
 * text wordmark when no image is configured.
 * @param {string} [style] extra inline style for the element.
 */
export const mailLogoHtml = (style = '') => {
  const extra = style ? ` style='${style}'` : '';
  if (appLogoUrl) return `<img src='${appLogoUrl}' height='50' alt='${appName}'${extra} />`;
  return `<span style='display:inline-block;font-family:system-ui,sans-serif;font-size:22px;font-weight:700;color:${mailThemeColor};${style}'>${appName}</span>`;
};
export const prefillDraftDocWidget = ['date', 'textbox', 'checkbox', 'radio button', 'image'];
export const prefillDraftTemWidget = [
  'date',
  'textbox',
  'checkbox',
  'radio button',
  'image',
  'dropdown',
];
export const MAX_NAME_LENGTH = 250;
export const MAX_NOTE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;
export const color = [
  '#93a3db',
  '#e6c3db',
  '#c0e3bc',
  '#bce3db',
  '#b8ccdb',
  '#ceb8db',
  '#ffccff',
  '#99ffcc',
  '#cc99ff',
  '#ffcc99',
  '#66ccff',
  '#ffffcc',
];

export const prefillBlockColor = 'transparent';

/** The five characters that change the meaning of surrounding HTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `{{name}}` for a variable name, with the name's regex metacharacters escaped. */
function variablePattern(name) {
  return new RegExp(`\\{\\{${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
}

/**
 * Substitutes `{{variable}}` placeholders in a mail subject and body.
 *
 * Two things the naive `String.replace(regex, value)` got wrong:
 *  - the values are user data (a document name, a signer's name), and the body
 *    is HTML, so anything containing markup was injected verbatim into the
 *    outgoing mail. Body substitutions are HTML-escaped; the subject is a plain
 *    text header and is substituted raw.
 *  - a value containing `$&`, `$1` or `$'` was expanded by the replacement
 *    pattern syntax, producing garbled text. Passing a function as the
 *    replacement makes every `$` literal.
 */
export function replaceMailVaribles(subject, body, variables) {
  let replacedSubject = subject;
  let replacedBody = body;

  for (const variable in variables) {
    const regex = variablePattern(variable);
    const value = variables[variable] ?? '';
    if (subject) {
      replacedSubject = replacedSubject.replace(regex, () => String(value));
    }
    if (body) {
      replacedBody = replacedBody.replace(regex, () => escapeHtml(value));
    }
  }
  const result = { subject: replacedSubject, body: replacedBody };
  return result;
}

/**
 * The workspace a user belongs to.
 *
 * `partners_Tenant.UserId` names only the account that created the workspace, so
 * resolving the tenant that way counted storage for the creator and silently
 * skipped every member added through `adduser` and every guest. The membership
 * row (`contracts_Users.TenantId`) is the pointer everything else in the
 * codebase uses; the old lookup stays as a fallback for a creator whose
 * membership row has not been written yet.
 *
 * @param {{__type: 'Pointer', className: '_User', objectId: string}} userPtr
 * @returns {Promise<string|null>} the partners_Tenant objectId.
 */
export const tenantIdForUser = async userPtr => {
  const extQuery = new Parse.Query('contracts_Users');
  extQuery.equalTo('UserId', userPtr);
  const ext = await extQuery.first({ useMasterKey: true });
  const tenantId = ext?.get('TenantId')?.id;
  if (tenantId) return tenantId;

  const tenantQuery = new Parse.Query('partners_Tenant');
  tenantQuery.equalTo('UserId', userPtr);
  const tenant = await tenantQuery.first({ useMasterKey: true });
  return tenant?.id || null;
};

export const saveFileUsage = async (size, fileUrl, userId) => {
  //checking server url and save file's size
  try {
    if (userId) {
      const userPtr = { __type: 'Pointer', className: '_User', objectId: userId };
      const tenantId = await tenantIdForUser(userPtr);
      if (tenantId) {
        const tenantPtr = { __type: 'Pointer', className: 'partners_Tenant', objectId: tenantId };
        try {
          const tenantCredits = new Parse.Query('partners_TenantCredits');
          tenantCredits.equalTo('PartnersTenant', tenantPtr);
          const res = await tenantCredits.first({ useMasterKey: true });
          if (res) {
            // increment() is a single atomic $inc. Reading usedStorage, adding in
            // JavaScript and writing the whole value back lost a count whenever
            // two uploads finished together, so the quota drifted low over time.
            res.increment('usedStorage', size);
            await res.save(null, { useMasterKey: true });
          } else {
            const newCredit = new Parse.Object('partners_TenantCredits');
            newCredit.set('usedStorage', size);
            newCredit.set('PartnersTenant', tenantPtr);
            await newCredit.save(null, { useMasterKey: true });
          }
        } catch (err) {
          console.error('err in save usage', err?.message || err);
        }
        await saveDataFile(size, fileUrl, tenantPtr, userPtr);
      }
    }
  } catch (err) {
    console.error('err in fetch tenant Id', err?.message || err);
  }
};

//function for save fileUrl and file size in particular client db class partners_DataFiles
const saveDataFile = async (size, fileUrl, tenantPtr, UserId) => {
  try {
    const newDataFiles = new Parse.Object('partners_DataFiles');
    newDataFiles.set('FileUrl', fileUrl);
    newDataFiles.set('FileSize', size);
    newDataFiles.set('TenantPtr', tenantPtr);
    newDataFiles.set('UserId', UserId);
    await newDataFiles.save(null, { useMasterKey: true });
  } catch (err) {
    console.error('error in save usage ', err?.message || err);
  }
};

/**
 * Bumps `contracts_Users.EmailCount` for the sender of a mail.
 *
 * One round trip, not two: `increment()` is an atomic `$inc`, so the row does
 * not have to be fetched first. It used to be queried, cloned into a full JSON
 * copy that was never read, and then saved.
 *
 * The counter is surfaced on the profile (apps/web/src/lib/extUser.ts) but no
 * quota consumes it, so a failure is logged and swallowed rather than failing
 * the mail that triggered it.
 */
export const updateMailCount = async extUserId => {
  if (!extUserId) return;
  try {
    const contractUser = Parse.Object.extend('contracts_Users').createWithoutData(extUserId);
    contractUser.increment('EmailCount', 1);
    await contractUser.save(null, { useMasterKey: true });
  } catch (error) {
    // A row that no longer exists is not worth a line: the account was deleted
    // between sending the mail and counting it.
    if (error?.code === Parse.Error.OBJECT_NOT_FOUND) return;
    console.error('Error updating EmailCount in contracts_Users: ' + error.message);
  }
};

/**
 * A file name safe to put in a url path and hand to a files adapter.
 *
 * Invalid characters are replaced rather than deleted: deleting them turned a
 * fully CJK, Cyrillic or Arabic name into '' (or into a bare '.pdf'), and the
 * empty string then reached the file adapter. Non-strings are coerced, and a
 * name that sanitises away to nothing becomes 'document'.
 */
export function sanitizeFileName(fileName) {
  const raw = typeof fileName === 'string' ? fileName : String(fileName ?? '');
  // Runs of invalid characters become one '-'; only the final dot survives, so
  // no '..' can reach a url path.
  let file = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\.(?=.*\.)/g, '');
  file = file.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  // '' (a fully CJK / Cyrillic / Arabic name) or a bare '.pdf' both need a stem.
  if (!file || file.startsWith('.')) file = `document${file}`;
  return file;
}

export const useLocal = process.env.USE_LOCAL ? process.env.USE_LOCAL.toLowerCase() : 'false';
export const smtpsecure = process.env.SMTP_PORT && process.env.SMTP_PORT !== '465' ? false : true;
export const smtpenable =
  process.env.SMTP_ENABLE && process.env.SMTP_ENABLE.toLowerCase() === 'true' ? true : false;
/**
 * Kept as a named export because five modules import it; the definition itself
 * lives in `cloud/lib/email.js`, which is the only place an address shape is
 * decided. It used to be a fourth, more permissive variant that accepted the
 * commas and semicolons the mail layer refuses, so the contact API stored
 * addresses that could never be mailed.
 */
export const emailRegex = EMAIL_RE;

/**
 * A random lowercase alphanumeric id.
 *
 * Not just a file-adapter suffix: this also mints the `BulkSendToken` that
 * authorises access to a bulk-send document and the replacement password of a
 * deleted account, so it has to come from the CSPRNG. `Math.random` is seeded
 * per process and predictable from a handful of outputs.
 *
 * `crypto.randomInt` over a 36 character alphabet is unbiased (36 does not
 * divide 256, so rejection sampling matters and randomInt does it for us).
 */
export function generateId(length) {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(crypto.randomInt(charactersLength));
  }
  return result;
}

/**
 * Flattens a pdf: every AcroForm field value (text, checkbox, radio, dropdown,
 * list) is baked into the page content as static graphics and the interactive
 * form layer is removed, so pre-filled values survive into the signed copy.
 * Non-widget annotations (links, comments, stamps) are preserved.
 *
 * pdf-lib's `form.flatten()` regenerates the field appearance streams and draws
 * them into the page content. It throws on some malformed documents (a widget
 * with no appearance stream, a font it cannot subset); those fall back to
 * stripping the widgets, which loses the field values but never fails an
 * upload.
 * @param {string | Uint8Array | ArrayBuffer} pdfFile - pdf file.
 * @returns {Promise<Uint8Array>} flatPdf - pdf file in Uint8Array
 */
export const flattenPdf = async pdfFile => {
  let pdfDoc = await PDFDocument.load(pdfFile, { ignoreEncryption: true });

  try {
    pdfDoc.getForm().flatten();
  } catch (err) {
    console.log('flattenPdf: form flatten failed, removing widgets instead', err?.message);
    // flatten() can throw part way through, so start again from the original
    // bytes rather than saving a half-flattened document.
    pdfDoc = await PDFDocument.load(pdfFile, { ignoreEncryption: true });
  }

  // Either way the widget annotations have to go: pdf-lib's flatten() paints the
  // appearances into the pages but leaves the annotations themselves behind, and
  // a viewer would then draw the field twice.
  removeWidgetAnnotations(pdfDoc);

  try {
    pdfDoc.catalog.delete(PDFName.of('AcroForm'));
  } catch {
    // best effort cleanup
  }

  return await pdfDoc.save({ useObjectStreams: false });
};

/**
 * Drop the form fields and every widget annotation, keeping links, stamps and
 * comments. Run after a successful flatten to clear the annotations pdf-lib
 * leaves behind, and on its own as the fallback for documents pdf-lib cannot
 * flatten (which loses the field values but never fails an upload).
 */
function removeWidgetAnnotations(pdfDoc) {
  try {
    const acroFormEntry = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    const acroForm = pdfDoc.context.lookupMaybe
      ? pdfDoc.context.lookupMaybe(acroFormEntry)
      : pdfDoc.context.lookup(acroFormEntry);

    if (acroForm && typeof acroForm.set === 'function') {
      // Avoid pdf-lib form APIs here; some malformed PDFs crash while
      // iterating/removing fields. Clearing /Fields directly is safer.
      acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([]));
      acroForm.delete(PDFName.of('XFA'));
      acroForm.delete(PDFName.of('SigFlags'));
    }
  } catch {
    // If AcroForm is malformed, continue with page annotation cleanup.
  }

  for (const page of pdfDoc.getPages()) {
    try {
      const annotationsRef = page.node.get(PDFName.of('Annots'));
      if (!annotationsRef) continue;

      const annotations = pdfDoc.context.lookup(annotationsRef);
      if (!annotations || !annotations.asArray) continue;

      const filtered = annotations.asArray().filter(annotRef => {
        try {
          const annot = pdfDoc.context.lookup(annotRef);
          // A reference that no longer resolves is one pdf-lib's flatten() left
          // dangling when it deleted the field; drop it with the widgets.
          if (!annot?.get) return false;
          const subtype = annot.get(PDFName.of('Subtype'));
          return subtype?.toString() !== '/Widget';
        } catch {
          return false;
        }
      });

      if (filtered.length === 0) {
        page.node.delete(PDFName.of('Annots'));
      } else {
        page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(filtered));
      }
    } catch {
      // best effort cleanup
    }
  }
}

// Format date and time for the selected timezone
export const formatTimeInTimezone = (date, timezone) => {
  const nyDate = timezone && toZonedTime(date, timezone);
  const generatedDate = timezone
    ? format(nyDate, 'EEE, dd MMM yyyy HH:mm:ss zzz', { timeZone: timezone })
    : new Date(date).toUTCString();
  return generatedDate;
};

// `getSecureUrl` is used to return local secure url if local files.
// `new URL(url)` used to sit outside the try, so an undefined or relative value
// (parseUploadFile returning no data, for one) threw a TypeError out of the very
// function whose job is to answer { url: '' } when it cannot sign anything.
export const getSecureUrl = url => {
  try {
    const fileUrl = new URL(url)?.pathname?.includes('/files/');
    if (!fileUrl) return { url: url };
    const file = signLocalUrl(url);
    return { url: file || '' };
  } catch (err) {
    console.error('getSecureUrl: could not sign', url, err?.message || err);
    return { url: '' };
  }
};

/**
 * The "Sender" row of the built-in request and reminder mails.
 *
 * It used to print the bare address, so a request from a named sender at a
 * named organisation still led with "jane.doe@example.com". The visible text is
 * now the sender's name, then the organisation, then (only when neither is
 * known) the address; the address stays behind it as a mailto link so a
 * recipient can still reach the sender in one click. Everything is escaped:
 * it is owner-supplied text going into html.
 *
 * @param {{senderName?: string, senderMail?: string, organization?: string}} p
 * @returns {string} html
 */
export function senderLineHtml(
  { senderName = '', senderMail = '', organization = '' } = {},
  { color = '#626363' } = {}
) {
  const mail = String(senderMail || '').trim();
  const label = String(senderName || '').trim() || String(organization || '').trim() || mail;
  if (!label) return '';
  const text = escapeHtml(label);
  return mail ? `<a href='mailto:${escapeHtml(mail)}' style='color:${color}'>${text}</a>` : text;
}

export const selectFormat = data => {
  switch (data) {
    case 'L':
      return 'MM/dd/yyyy';
    case 'MM/DD/YYYY':
      return 'MM/dd/yyyy';
    case 'DD-MM-YYYY':
      return 'dd-MM-yyyy';
    case 'DD/MM/YYYY':
      return 'dd/MM/yyyy';
    case 'LL':
      return 'MMMM dd, yyyy';
    case 'DD MMM, YYYY':
      return 'dd MMM, yyyy';
    case 'YYYY-MM-DD':
      return 'yyyy-MM-dd';
    case 'MM-DD-YYYY':
      return 'MM-dd-yyyy';
    case 'MM.DD.YYYY':
      return 'MM.dd.yyyy';
    case 'MMM DD, YYYY':
      return 'MMM dd, yyyy';
    case 'MMMM DD, YYYY':
      return 'MMMM dd, yyyy';
    case 'DD MMMM, YYYY':
      return 'dd MMMM, yyyy';
    case 'DD.MM.YYYY':
      return 'dd.MM.yyyy';
    case 'DD-MMM-YYYY':
      return 'dd-MMM-yyyy';
    default:
      return 'MM/dd/yyyy';
  }
};

export function formatDateTime(date, dateFormat, timeZone, is12Hour) {
  const zonedDate = toZonedTime(date, timeZone); // Convert date to the given timezone
  const timeFormat = is12Hour ? 'hh:mm:ss a' : 'HH:mm:ss';
  return dateFormat
    ? format(zonedDate, `${selectFormat(dateFormat)}, ${timeFormat} 'GMT' XXX`, { timeZone })
    : formatTimeInTimezone(date, timeZone);
}

export const randomId = (digit = 8) => {
  // 1. Grab a cryptographically-secure 32-bit random value
  // Use crypto for stronger randomness
  const randomBytes = crypto.getRandomValues(new Uint32Array(1));
  const raw = randomBytes[0]; // 0 … 4,294,967,295

  // Calculate the min and max for the given digit length
  const min = Math.pow(10, digit - 1); // e.g., digit=3 → 100
  const max = Math.pow(10, digit) - 1; // e.g., digit=3 → 999
  const range = max - min + 1;

  // Collapse random value into the range and shift
  return min + (raw % range);
};
export const handleValidImage = async Placeholder => {
  const updatedPlaceholders = [];

  for (const placeholder of Placeholder || []) {
    //Clean and format signerPtr
    let signerPtr = placeholder.signerPtr;
    // Check if signerPtr exists and has an id
    if (signerPtr?.id) {
      // Case 1: If signerPtr is a Parse Object instance
      if (signerPtr instanceof Parse.Object) {
        // If signerPtr has no attributes, it’s a plain pointer already
        if (!signerPtr.attributes || Object.keys(signerPtr.attributes).length === 0) {
          // Convert to a clean pointer using Parse’s built-in method
          signerPtr = signerPtr.toPointer();
        } else {
          // If it has attributes, manually construct the pointer object
          signerPtr = {
            __type: 'Pointer',
            className: signerPtr.className,
            objectId: signerPtr.id,
          };
        }
        // Case 2: If signerPtr is already a plain JS object resembling a pointer
      } else if (typeof signerPtr === 'object' && signerPtr.className && signerPtr.objectId) {
        // Normalize it to a valid Parse pointer object
        signerPtr = {
          __type: 'Pointer',
          className: signerPtr.className,
          objectId: signerPtr.objectId,
        };
      }
    }

    //Process placeHolder if Role is 'prefill'
    if (placeholder?.Role === 'prefill') {
      const updatedRole = [];
      for (const item of placeholder.placeHolder || []) {
        const updatedPos = [];
        for (const posItem of item.pos || []) {
          if (
            (posItem?.type === 'image' || posItem?.type === 'draw') &&
            posItem?.options?.response
          ) {
            const validUrl = await signStoredUrl(posItem?.options?.response);
            updatedPos.push({
              ...posItem,
              ...(item.SignUrl !== undefined && { SignUrl: validUrl }),
              options: { ...posItem.options, response: validUrl },
            });
          } else {
            updatedPos.push(posItem);
          }
        }
        updatedRole.push({ ...item, pos: updatedPos });
      }

      updatedPlaceholders.push({ ...placeholder, signerPtr, placeHolder: updatedRole });
    } else {
      // Not prefill role, just push as-is
      updatedPlaceholders.push({ ...placeholder, signerPtr });
    }
  }
  return updatedPlaceholders;
};
