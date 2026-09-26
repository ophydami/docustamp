import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { formatDateTime } from '../../../Utils.js';
import { COMPLETION_ACTIVITIES } from '../../../utils/workflowUtils.js';
import { fetchStoredImage, isJpegBytes } from '../../lib/upload.js';

/**
 * Audit activities that put a block on the certificate. `COMPLETION_ACTIVITIES`
 * is what the signing path treats as "this participant is done"; approvals and
 * declines are listed too so a certificate rendered for one of those documents
 * still names the people involved.
 */
const CERTIFICATE_ACTIVITIES = new Set([...COMPLETION_ACTIVITIES, 'Approved', 'Declined']);

/**
 * A timezone `date-fns-tz` will accept.
 *
 * `ExtUserPtr.Timezone` is free text on an old row (values such as "GMT+5" and
 * plain "" exist), and `format(..., {timeZone})` throws a RangeError on an
 * invalid one, out of an un-awaited certificate job. An unusable value becomes
 * '' , which renders the certificate in UTC rather than not at all.
 */
function safeTimezone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    console.log(`GenerateCertificate: ignoring an invalid Timezone value "${zone}"`);
    return '';
  }
}

/**
 * The signature image for one block, embedded in the certificate.
 *
 * The audit trail now records the url of the stored image; documents signed
 * before that change carry the base64 inline, so both are accepted. A failure
 * (a deleted file, an unreadable image) falls back to the "not available" mark
 * rather than aborting the certificate.
 */
async function embedSignatureImage(pdfDoc, value, fallback) {
  if (!value) return fallback;
  try {
    if (/^https?:\/\//i.test(value)) {
      const bytes = await fetchStoredImage(value);
      if (!bytes) return fallback;
      return isJpegBytes(bytes) ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
    }
    return await pdfDoc.embedPng(value);
  } catch (err) {
    console.log('GenerateCertificate: could not embed a signature image', err?.message || err);
    return fallback;
  }
}

/**
 * A date from any of the shapes an audit trail carries.
 *
 * The signing request writes `SignedOn: new Date()`, so the entry written by the
 * request that completes the document is a JS Date while it is still in memory,
 * but every earlier entry has been through the database and comes back as the
 * Parse encoding `{__type: 'Date', iso}`. `ViewedOn` is written as an ISO
 * string. `new Date({__type, iso})` is an Invalid Date, and the old
 * `formatDateStr` handed the unparseable value back as-is, so every signer but
 * the last had "Signed on : [object Object]" printed on their certificate.
 *
 * @param {Date|string|number|{iso: string}|null|undefined} value
 * @returns {Date|null} null when there is no usable date in `value`.
 */
export function toDate(value) {
  if (!value) return null;
  const raw = typeof value === 'object' && !(value instanceof Date) ? value.iso : value;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The date as the certificate prints it, '' when there is nothing printable. */
export const formatDateStr = (value, DateFormat, timezone, Is12Hr) => {
  const date = toDate(value);
  return date ? formatDateTime(date, DateFormat, timezone, Is12Hr) : '';
};

function toTs(v) {
  return toDate(v)?.getTime() || 0;
}

/**
 * The signatory blocks a certificate renders, in signing order.
 *
 * Two things were wrong with the old version. It took *every* audit entry that
 * carried a `UserPtr`, with no filter on `Activity`, so a `Viewed` entry
 * written by `triggerEvent` (someone who merely opened the link, and who may
 * since have been removed) was rendered on a legal document as a signer, with
 * `SignedOn` defaulting to the certificate's own generation time. And an owner
 * entry carries a `contracts_Users` pointer, which never matches an id in
 * `Signers` (those are `contracts_Contactbook` ids), so the spread of
 * `undefined` produced `{}` and the block was drawn with an empty name and
 * email next to a real signature image and IP address.
 *
 * @param {Object} docDetails contracts_Document as JSON, with Signers,
 *   Placeholders, ExtUserPtr and AuditTrail resolved.
 * @returns {Array<Object>} one block per signatory: identity plus role,
 *   ipAddress, SignedOn ('' when unknown), ViewedOn, OpenCount (how many times
 *   they opened their signing link, from `OpenStats`; 0 when never counted)
 *   and Signature.
 */
export function certificateBlocks(docDetails) {
  const placeholders = Array.isArray(docDetails?.Placeholders) ? docDetails.Placeholders : [];
  const signers = Array.isArray(docDetails?.Signers) ? docDetails.Signers : [];
  const ownerPtr = docDetails?.ExtUserPtr || {};
  const ownerName = docDetails?.SenderName || ownerPtr?.Name || '';
  const ownerEmail = docDetails?.SenderMail || ownerPtr?.Email || '';

  // Defaulted to `[]`: a document with no AuditTrail (an import, or a document
  // completed through the API) used to make `[...filteredaudit]` throw inside
  // the un-awaited certificate job, which is a process-level crash.
  const allAudit = Array.isArray(docDetails?.AuditTrail) ? docDetails.AuditTrail : [];
  const filteredaudit = allAudit.filter(x => x?.UserPtr?.objectId);

  // Entries with no Activity at all are legacy rows written before the field
  // existed, and those did record a signature.
  const signedAudit = filteredaudit.filter(
    x => CERTIFICATE_ACTIVITIES.has(x?.Activity) || (!x?.Activity && (x?.SignedOn || x?.Signature))
  );

  // A "Viewed" entry is still worth its timestamp on the block of the person
  // who later signed, so keep the first one seen per participant.
  const viewedAt = new Map();
  for (const entry of filteredaudit) {
    const id = entry?.UserPtr?.objectId;
    const seen = entry?.ViewedOn || (entry?.Activity === 'Viewed' ? entry?.SignedOn : null);
    if (id && seen && !viewedAt.has(id)) viewedAt.set(id, seen);
  }

  const openStats =
    docDetails?.OpenStats && typeof docDetails.OpenStats === 'object' ? docDetails.OpenStats : {};
  const openCountFor = id => Math.max(0, Math.trunc(Number(openStats?.[id]?.count)) || 0);

  const ownerIdentity = () => ({ ...ownerPtr, Name: ownerName, Email: ownerEmail });

  const placeholderFor = id =>
    id ? placeholders.find(p => (p?.signerObjId || p?.signerPtr?.objectId) === id) : null;

  const identityFor = entry => {
    const id = entry?.UserPtr?.objectId;
    if (entry?.UserPtr?.className === 'contracts_Users' || id === ownerPtr?.objectId) {
      return ownerIdentity();
    }
    const signer = signers.find(y => y?.objectId === id);
    if (signer) return signer;
    const placeholder = placeholderFor(id);
    return {
      Name: placeholder?.signerPtr?.Name || placeholder?.Name || '',
      Email: placeholder?.signerPtr?.Email || placeholder?.email || '',
    };
  };

  /** "Signer" unless the placeholder bound to this participant names a role. */
  const roleFor = entry => {
    const placeholder = placeholderFor(entry?.UserPtr?.objectId);
    const role = typeof placeholder?.Role === 'string' ? placeholder.Role.trim() : '';
    return role && role.toLowerCase() !== 'prefill' ? role : 'Signer';
  };

  const blockFor = entry => ({
    ...identityFor(entry),
    role: roleFor(entry),
    ipAddress: entry?.ipAddress || '',
    // Left blank rather than stamped with the certificate's own generation
    // time: an invented signing timestamp on a certificate of completion is
    // worse than an empty field.
    SignedOn: toDate(entry?.SignedOn)?.toISOString() || '',
    ViewedOn:
      toDate(entry?.ViewedOn || viewedAt.get(entry?.UserPtr?.objectId))?.toISOString() || '',
    OpenCount: openCountFor(entry?.UserPtr?.objectId),
    Signature: entry?.Signature || '',
    _signedOnTs: toTs(entry?.SignedOn),
  });

  // Self-sign (no Signers): the single block is the owner's, built from
  // whatever the trail recorded. `filteredaudit[0]` used to be indexed
  // unguarded, so an absent or empty trail threw a TypeError here.
  const selfEntry = signedAudit[0] || filteredaudit[0] || {};
  const blocks =
    signers.length > 0
      ? signedAudit.map(blockFor)
      : [{ ...blockFor(selfEntry), ...ownerIdentity(), role: 'Signer' }];
  blocks.sort((a, b) => (a?._signedOnTs || 0) - (b?._signedOnTs || 0));
  return blocks;
}

export default async function GenerateCertificate(docDetails) {
  // The document's own format / zone (settings.dateFormat, timezone, is12HourTime
  // on the API) win over the account defaults.
  const timezone = safeTimezone(docDetails?.Timezone || docDetails?.ExtUserPtr?.Timezone);
  const Is12Hr =
    typeof docDetails?.Is12HourTime === 'boolean'
      ? docDetails.Is12HourTime
      : docDetails?.ExtUserPtr?.Is12HourTime || false;
  const DateFormat = docDetails?.DateFormat || docDetails?.ExtUserPtr?.DateFormat || 'MM/DD/YYYY';
  const pdfDoc = await PDFDocument.create();
  // `fontBytes` is used to embed custom font in pdf
  const fontBytes = fs.readFileSync('./font/times.ttf'); //
  pdfDoc.registerFontkit(fontkit);
  const timesRomanFont = await pdfDoc.embedFont(fontBytes, { subset: true });
  // The Buffers themselves, not `.buffer`: a Buffer's ArrayBuffer can be a
  // larger shared slab (Node 22+ reads small files into a pool), and handing
  // that to pdf-lib made it read another file's bytes as the PNG.
  const pngUrl = fs.readFileSync('./images/logo.png');
  const naSignUrl = fs.readFileSync('./images/na_sign.png');
  const nasign = await pdfDoc.embedPng(naSignUrl);
  const pngImage = await pdfDoc.embedPng(pngUrl);
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const startX = 15;
  const startY = 15;
  const borderColor = rgb(0.12, 0.12, 0.12);
  const titleColor = rgb(0, 0.2, 0.4); //rgb(0, 0.53, 0.71);
  const titleUnderline = rgb(0, 0.2, 0.4); // rgb(0.12, 0.12, 0.12);
  const title = 25;
  const subtitle = 16;
  const text = 13;
  const signertext = 13;
  const timeText = 11;
  const textKeyColor = rgb(0.12, 0.12, 0.12);
  const textValueColor = rgb(0.3, 0.3, 0.3);
  // `completedAt` is the last signer's `SignedOn` when the certificate is
  // regenerated later (generateCertificatebydocId), so it arrives in the Parse
  // date encoding; an unreadable value falls back to now rather than throwing
  // a RangeError out of date-fns.
  const completedAt = toDate(docDetails?.completedAt) || new Date();
  const completedAtperTimezone = formatDateStr(completedAt, DateFormat, timezone, Is12Hr);
  const completedUTCtime = completedAtperTimezone;
  const signersCount = docDetails?.Signers?.length || 1;
  const generateAt = completedAt;
  const generatedAtperTimezone = formatDateTime(generateAt, DateFormat, timezone, Is12Hr);
  const generatedUTCTime = generatedAtperTimezone;
  const generatedOn = 'Generated On ' + generatedUTCTime;
  const textWidth = timesRomanFont.widthOfTextAtSize(generatedOn, 12);
  const margin = 30;
  const maxX = width - margin - textWidth; // Ensures text stays inside the border with 30px margin
  const OriginIp = docDetails?.OriginIp || '';
  const company = docDetails?.ExtUserPtr?.Company || '';
  const documentHash = docDetails?.DocumentHash || '';
  const createdAt = docDetails?.DocSentAt || docDetails?.createdAt;
  const createdAtperTimezone = formatDateStr(createdAt, DateFormat, timezone, Is12Hr);
  const IsEnableOTP = docDetails?.IsEnableOTP || false;
  const ownerName = docDetails?.SenderName || docDetails.ExtUserPtr?.Name || 'n/a';
  const ownerEmail = docDetails?.SenderMail || docDetails.ExtUserPtr?.Email || 'n/a';
  const auditTrail = certificateBlocks(docDetails);
  const half = width / 2;
  // Draw a border
  page.drawRectangle({
    x: startX,
    y: startY,
    width: width - 2 * startX,
    height: height - 2 * startY,
    borderColor: borderColor,
    borderWidth: 1,
  });
  page.drawImage(pngImage, {
    x: 30,
    y: 790,
    width: 100,
    height: 25,
  });

  page.drawText(generatedOn, {
    x: Math.max(startX, maxX), // Adjusts dynamically 320
    y: 810,
    size: 12,
    font: timesRomanFont,
    color: rgb(0.12, 0.12, 0.12),
  });

  page.drawText('Certificate of Completion', {
    x: 160,
    y: 755,
    size: title,
    font: timesRomanFont,
    color: titleColor,
  });

  const underlineY = 745;
  page.drawLine({
    start: { x: 30, y: underlineY },
    end: { x: width - 30, y: underlineY },
    color: titleUnderline,
    thickness: 1,
  });

  page.drawText('Summary', {
    x: 30,
    y: 727,
    size: subtitle,
    font: timesRomanFont,
    color: titleColor,
  });

  page.drawText('Document Id :', {
    x: 30,
    y: 710,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(docDetails.objectId, {
    x: 110,
    y: 710,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });

  page.drawText('Document Name :', {
    x: 30,
    y: 690,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(docDetails?.Name, {
    x: 130,
    y: 690,
    size: docDetails?.Name?.length >= 78 ? 12 : text,
    font: timesRomanFont,
    color: textValueColor,
  });

  if (documentHash) {
    page.drawText('Document hash (sha256) :', {
      x: 30,
      y: 670,
      size: text,
      font: timesRomanFont,
      color: textKeyColor,
    });

    page.drawText(documentHash, {
      x: 170,
      y: 670,
      size: text,
      font: timesRomanFont,
      color: textValueColor,
    });
  }

  const organizationY = documentHash ? 650 : 670;
  const createdOnY = organizationY - 20;
  const completedOnY = createdOnY - 20;
  const signersY = completedOnY - 20;
  const originatorHeaderY = signersY - 20;
  const nameY = originatorHeaderY - 17;
  const emailY = nameY - 20;
  const ipY = emailY - 20;

  page.drawText('Organization :', {
    x: 30,
    y: organizationY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(company, {
    x: 110,
    y: organizationY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Created on :', {
    x: 30,
    y: createdOnY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${createdAtperTimezone}`, {
    x: 97,
    y: createdOnY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Completed on :', {
    x: 30,
    y: completedOnY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${completedUTCtime}`, {
    x: 115,
    y: completedOnY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Signers :', {
    x: 30,
    y: signersY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${signersCount}`, {
    x: 80,
    y: signersY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Document originator', {
    x: 30,
    y: originatorHeaderY,
    size: 17,
    font: timesRomanFont,
    color: titleColor,
  });
  page.drawText('Name :', {
    x: 60,
    y: nameY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(ownerName, {
    x: 105,
    y: nameY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Email :', {
    x: 60,
    y: emailY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(ownerEmail, {
    x: 105,
    y: emailY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('IP address :', {
    x: 60,
    y: ipY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(`${OriginIp}`, {
    x: 125,
    y: ipY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });

  page.drawLine({
    start: { x: 30, y: ipY - 6 },
    end: { x: width - 30, y: ipY - 6 },
    color: rgb(0.12, 0.12, 0.12),
    thickness: 0.5,
  });
  let yPosition1 = ipY - 21;
  let yPosition2 = yPosition1 - 14;
  let yPosition3 = yPosition2 - 20;
  let yPosition4 = yPosition3 - 20;
  let yPosition5 = yPosition4 - 20;
  let yPosition6 = yPosition5 - 20;
  let yPosition7 = yPosition6 - 20;
  let yPosition8 = yPosition7 - 35;

  // A signer/approver block spans from yPosition1 down to yPosition8 (the
  // separator line at the bottom of the block). The signature image's
  // bottom edge sits at yPosition7 - 30 and must remain inside the page
  // border (whose bottom edge is at startY). Use the lowest of those two
  // values when deciding whether the next block fits on the current page.
  const minY = startY + 5;
  const blockBottom = () => Math.min(yPosition7 - 30, yPosition8);

  // Helper that resets the y-positions to the top of a freshly added page so
  // the next block starts cleanly under the border.
  const startNewPage = () => {
    const newPage = pdfDoc.addPage();
    newPage.drawRectangle({
      x: startX,
      y: startY,
      width: width - 2 * startX,
      height: height - 2 * startY,
      borderColor: borderColor,
      borderWidth: 1,
    });
    yPosition1 = newPage.getHeight() - 40;
    yPosition2 = yPosition1 - 20;
    yPosition3 = yPosition2 - 20;
    yPosition4 = yPosition3 - 20;
    yPosition5 = yPosition4 - 20;
    yPosition6 = yPosition5 - 20;
    yPosition7 = yPosition6 - 20;
    yPosition8 = yPosition7 - 35;
    return newPage;
  };

  let currentPage = page;
  for (let i = 0; i < auditTrail.length; i++) {
    const x = auditTrail[i];
    // If the next block would overflow the bottom border, move to a new page.
    if (blockBottom() < minY) {
      currentPage = startNewPage();
    }
    const embedPng = await embedSignatureImage(pdfDoc, x.Signature, nasign);
    const headerLabel = `${i + 1}. ${x?.role || 'Signer'}`;
    const signedOnLabel = 'Signed on :';

    currentPage.drawText(headerLabel, {
      x: 30,
      y: yPosition1,
      size: subtitle,
      font: timesRomanFont,
      color: titleColor,
    });
    currentPage.drawText('Name :', {
      x: 30,
      y: yPosition2,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.Name || '', {
      x: 75,
      y: yPosition2,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    if (IsEnableOTP) {
      currentPage.drawText('Security level :', {
        x: half + 120,
        y: yPosition2,
        size: timeText,
        font: timesRomanFont,
        color: textKeyColor,
      });
      currentPage.drawText('Email, OTP Auth', {
        x: half + 190,
        y: yPosition2,
        size: timeText,
        font: timesRomanFont,
        color: textValueColor,
      });
    }

    currentPage.drawText('Email :', {
      x: 30,
      y: yPosition3,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.Email || '', {
      x: 75,
      y: yPosition3,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('Viewed on :', {
      x: 30,
      y: yPosition4,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(`${formatDateStr(x?.ViewedOn, DateFormat, timezone, Is12Hr)}`, {
      x: 97,
      y: yPosition4,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    // How many times the signing link was opened, on the same line as the
    // first view. Only printed when it was counted: documents completed
    // before open tracking existed have no figure, and "0" would read as a
    // claim that they never opened it.
    if (x?.OpenCount > 0) {
      currentPage.drawText('Opened :', {
        x: half + 120,
        y: yPosition4,
        size: timeText,
        font: timesRomanFont,
        color: textKeyColor,
      });
      currentPage.drawText(x.OpenCount === 1 ? '1 time' : `${x.OpenCount} times`, {
        x: half + 165,
        y: yPosition4,
        size: timeText,
        font: timesRomanFont,
        color: textValueColor,
      });
    }

    currentPage.drawText(signedOnLabel, {
      x: 30,
      y: yPosition5,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    const signedOnValueX = 30 + timesRomanFont.widthOfTextAtSize(signedOnLabel, signertext) + 5;
    currentPage.drawText(`${formatDateStr(x?.SignedOn, DateFormat, timezone, Is12Hr)}`, {
      x: signedOnValueX,
      y: yPosition5,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('IP address :', {
      x: 30,
      y: yPosition6,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.ipAddress || '', {
      x: 95,
      y: yPosition6,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('Signature :', {
      x: 30,
      y: yPosition7,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawRectangle({
      x: 98,
      y: yPosition7 - 30,
      width: 104,
      height: 44,
      borderColor: rgb(0.22, 0.18, 0.47),
      borderWidth: 1,
    });
    if (embedPng) {
      currentPage.drawImage(embedPng, {
        x: 100,
        y: yPosition7 - 27,
        width: 100,
        height: 40,
      });
    }
    currentPage.drawLine({
      start: { x: 30, y: yPosition8 },
      end: { x: width - 30, y: yPosition8 },
      color: rgb(0.12, 0.12, 0.12),
      thickness: 0.5,
    });

    yPosition1 = yPosition8 - 20;
    yPosition2 = yPosition1 - 20;
    yPosition3 = yPosition2 - 20;
    yPosition4 = yPosition3 - 20;
    yPosition5 = yPosition4 - 20;
    yPosition6 = yPosition5 - 20;
    yPosition7 = yPosition6 - 20;
    yPosition8 = yPosition8 - 174;
  }

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}
