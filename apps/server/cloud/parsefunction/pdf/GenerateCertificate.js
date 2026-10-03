import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { format, toZonedTime } from 'date-fns-tz';
import { appName, formatDateTime, selectFormat } from '../../../Utils.js';
import { COMPLETION_ACTIVITIES } from '../../../utils/workflowUtils.js';
import { fetchStoredImage, isJpegBytes } from '../../lib/upload.js';
import { agentLabel } from '../../lib/agentIdentity.js';

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

/** The date alone (no time) in the document's format and zone, '' when there is none. */
export const formatDateOnlyStr = (value, DateFormat, timezone) => {
  const date = toDate(value);
  if (!date) return '';
  return format(toZonedTime(date, timezone), selectFormat(DateFormat || 'MM/DD/YYYY'), {
    timeZone: timezone,
  });
};

function toTs(v) {
  return toDate(v)?.getTime() || 0;
}

/** One line of plain text: newlines and runs of spaces in stored values would break the layout. */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `value` cut to `max` characters, ending in "..." when it was longer. */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}

/**
 * The agent behind an audit entry, normalised, or null when a person signed.
 *
 * lib/agentSign.js records `Method: 'agent'` with `Agent`, `OnBehalfOf` and
 * `AllowedBy` on the entry. The dates in `AllowedBy` arrive as a JS Date on the
 * request that wrote them and as the Parse encoding `{__type: 'Date', iso}`
 * after a round trip through the database, so both become ISO strings here.
 * The OAuth client id and the user id stay out: neither belongs on a
 * certificate a counterparty reads.
 *
 * @param {Object} entry an AuditTrail entry (or a certificate block)
 * `AllowedBy.nameMismatch` is there only when the document printed another
 * name for the signer's party and the user confirmed they sign for it
 * (lib/signerName.js).
 *
 * @returns {{Method: 'agent', Agent: {kind: string, name: string, host: string},
 *   OnBehalfOf: {name: string, email: string},
 *   AllowedBy: {via: string, name: string, email: string, at: string,
 *   signingEnabledAt: string|null, approvalId?: string,
 *   nameMismatch?: {printed: string, expected: string, confirmed: boolean, via?: string}}}|null}
 */
export function agentRecord(entry) {
  if (entry?.Method !== 'agent') return null;
  const agent = entry.Agent || {};
  const behalf = entry.OnBehalfOf || {};
  const allowed = entry.AllowedBy || {};
  const mismatch = allowed.nameMismatch;
  return {
    Method: 'agent',
    Agent: { kind: oneLine(agent.kind), name: oneLine(agent.name), host: oneLine(agent.host) },
    OnBehalfOf: { name: oneLine(behalf.name), email: oneLine(behalf.email).toLowerCase() },
    AllowedBy: {
      via: oneLine(allowed.via),
      name: oneLine(allowed.name),
      email: oneLine(allowed.email).toLowerCase(),
      at: toDate(allowed.at)?.toISOString() || '',
      signingEnabledAt: toDate(allowed.signingEnabledAt)?.toISOString() || null,
      ...(allowed.approvalId ? { approvalId: String(allowed.approvalId) } : {}),
      ...(mismatch && typeof mismatch === 'object' && oneLine(mismatch.printed)
        ? {
            nameMismatch: {
              printed: oneLine(mismatch.printed),
              expected: oneLine(mismatch.expected),
              confirmed: mismatch.confirmed === true,
              ...(mismatch.via ? { via: oneLine(mismatch.via) } : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * The rows an agent's signature adds to its signer block, in print order.
 *
 * "Signed by" says which app signed and for whom. The second row says who let
 * it: on the person's own document they did so by turning agent signing on for
 * that app ("Allowed by"); on a document someone else sent they approved this
 * signature, in the web app or in the chat ("Approved by"). Dates use the
 * document's format and zone, as every other date on the certificate does.
 * When the document printed another name for the signer's party and the user
 * confirmed they sign for it, a third row says so ("Name on document").
 *
 * @param {Object} block from certificateBlocks
 * @param {{DateFormat?: string, timezone?: string, Is12Hr?: boolean}} [opts]
 * @returns {Array<{label: string, value: string}>} [] for a person's signature
 */
export function agentCertificateRows(block, { DateFormat, timezone = '', Is12Hr = true } = {}) {
  const record = agentRecord(block);
  if (!record) return [];
  const { Agent: agent, OnBehalfOf: behalf, AllowedBy: allowed } = record;
  // The app names itself when it registers, so its name can be any length;
  // it is shortened so the person it signed for always stays on the row.
  const name = clip(agent.name, 40);
  const host = clip(agent.host, 60);
  const forWhom = behalf.name || behalf.email || oneLine(block?.Name) || 'the signer';
  const by =
    agent.kind === 'api_token' && !host
      ? 'using an API key'
      : agentLabel({ name: name || host || 'app', host: name ? host : '' });
  const rows = [{ label: 'Signed by', value: `AI agent ${by} for ${forWhom}` }];

  const who = allowed.name || allowed.email || forWhom;
  if (allowed.via === 'own_document') {
    const since = formatDateOnlyStr(allowed.signingEnabledAt, DateFormat, timezone);
    rows.push({
      label: 'Allowed by',
      value: `${who}, own document${since ? ` (agent signing on since ${since})` : ''}`,
    });
  } else if (allowed.via === 'web' || allowed.via === 'chat') {
    const where =
      allowed.via === 'web' ? appName : (agent.kind !== 'api_token' && name) || 'the AI app';
    const at = formatDateStr(allowed.at, DateFormat, timezone, Is12Hr);
    rows.push({ label: 'Approved by', value: `${who} in ${where}${at ? `, ${at}` : ''}` });
  }
  const mismatch = allowed.nameMismatch;
  if (mismatch?.confirmed && mismatch.printed) {
    rows.push({
      label: 'Name on document',
      value: `${clip(mismatch.printed, 120)} (signed as ${mismatch.expected || forWhom}, confirmed by ${who})`,
    });
  }
  return rows;
}

/**
 * `value` broken into lines no wider than `maxWidth`, at most `maxLines` of
 * them; the last one ends in "..." when the text did not fit. A single word
 * wider than the column (a long host or address) is cut by character.
 *
 * @param {string} value
 * @param {import('pdf-lib').PDFFont} font
 * @param {number} size
 * @param {number} maxWidth
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapText(value, font, size, maxWidth, maxLines = 2) {
  const fits = s => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines = [];
  let line = '';
  for (const word of oneLine(value).split(' ').filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (line.length > 1 && !fits(line)) {
      let cut = line.length - 1;
      while (cut > 1 && !fits(line.slice(0, cut))) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && !fits(`${last}...`)) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}...`;
  return kept;
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
 *   and Signature; plus, when an AI agent signed, the `agentRecord` keys
 *   (Method, Agent, OnBehalfOf, AllowedBy). A person's block has none of them.
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
    // Method, Agent, OnBehalfOf and AllowedBy, only when an AI agent signed.
    ...agentRecord(entry),
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
      : docDetails?.ExtUserPtr?.Is12HourTime !== false; // 12-hour unless the user chose 24-hour
  const DateFormat = docDetails?.DateFormat || docDetails?.ExtUserPtr?.DateFormat || 'MM/DD/YYYY';
  const pdfDoc = await PDFDocument.create();
  // `fontBytes` is used to embed custom font in pdf
  const fontBytes = fs.readFileSync('./font/times.ttf'); //
  pdfDoc.registerFontkit(fontkit);
  const timesRomanFont = await pdfDoc.embedFont(fontBytes, { subset: true });
  // The Buffers themselves, not `.buffer`: a Buffer's ArrayBuffer can be a
  // larger shared slab (Node 22+ reads small files into a pool), and handing
  // that to pdf-lib made it read another file's bytes as the PNG.
  const pngUrl = fs.readFileSync('./images/docustamp-logo.png');
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
  // The DocuStamp wordmark (brand/png/docustamp-logo-1200.png), drawn at its own
  // aspect ratio and centred on the band the old 100 x 25 logo used.
  const logo = pngImage.scale(110 / pngImage.width);
  page.drawImage(pngImage, {
    x: 30,
    y: 802.5 - logo.height / 2,
    width: logo.width,
    height: logo.height,
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
  // `extra` is the height an agent's rows add above the signature.
  const minY = startY + 5;
  const blockBottom = (extra = 0) => Math.min(yPosition7 - 30, yPosition8) - extra;
  // An agent row sits one row step below the last; a wrapped value continues
  // a little tighter, so it reads as the same row.
  const rowStep = 20;
  const wrapStep = 15;
  const rightEdge = width - 30;

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
    // An AI agent's signature adds its rows ("Signed by", then "Allowed by" or
    // "Approved by") between the IP address and the signature, which moves
    // the signature and the separator down by their height. A person's block
    // has no rows and keeps its layout exactly.
    const agentRows = agentCertificateRows(x, { DateFormat, timezone, Is12Hr }).map(row => {
      const label = `${row.label} :`;
      const valueX = 30 + timesRomanFont.widthOfTextAtSize(label, signertext) + 5;
      const lines = wrapText(row.value, timesRomanFont, signertext, rightEdge - valueX, 3);
      return { label, valueX, lines };
    });
    const extra = agentRows.reduce(
      (sum, row) => sum + rowStep + (row.lines.length - 1) * wrapStep,
      0
    );
    // If the next block would overflow the bottom border, move to a new page.
    if (blockBottom(extra) < minY) {
      currentPage = startNewPage();
    }
    yPosition7 -= extra;
    yPosition8 -= extra;
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
      // An agent never types the emailed code: it signs through the app its
      // person connected (OAuth) or an API key, on a verified address.
      const security = !agentRows.length
        ? 'Email, OTP Auth'
        : x?.Agent?.kind === 'api_token'
          ? 'Email, API key'
          : 'Email, OAuth';
      currentPage.drawText(security, {
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

    let rowY = yPosition6 - rowStep;
    for (const row of agentRows) {
      currentPage.drawText(row.label, {
        x: 30,
        y: rowY,
        size: signertext,
        font: timesRomanFont,
        color: textKeyColor,
      });
      row.lines.forEach((line, n) => {
        currentPage.drawText(line, {
          x: row.valueX,
          y: rowY - n * wrapStep,
          size: signertext,
          font: timesRomanFont,
          color: textValueColor,
        });
      });
      rowY -= rowStep + (row.lines.length - 1) * wrapStep;
    }

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
