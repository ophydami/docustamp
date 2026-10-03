import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import {
  appName,
  cloudServerUrl,
  escapeHtml,
  replaceMailVaribles,
  saveFileUsage,
  serverAppId,
  supportEmail,
} from '../../../Utils.js';
import { renderMail, strong } from '../../lib/mailShell.js';
import GenerateCertificate from './GenerateCertificate.js';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { emitInBackground } from '../../lib/webhooks.js';
import { runChainInBackground } from '../../lib/chain.js';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { buildDownloadFilename } from '../../../utils/fileUtils.js';
import sendMailWithAttachment from '../sendMailWithAttachment.js';
import sendSystemMail from '../sendSystemMail.js';
import {
  findPlaceholderIndex,
  findPendingPriorSigner,
  isCompletionRelevant,
} from '../../../utils/workflowUtils.js';
import { completedContactIds, upsertAuditEntry } from '../../lib/auditTrail.js';
import {
  MAX_WRITE_ATTEMPTS,
  readFresh,
  tryMarkCompleted,
  updateWithVersion,
} from '../../lib/atomic.js';
import { storeSignatureImage, unlinkFile, uploadFile } from '../../lib/upload.js';
import { checkRateLimit, clientIp, resolveDocumentActor } from '../authGuard.js';
import { mintSigningToken, signingTokenExpiry } from '../../lib/signingToken.js';
import { buildSigningUrl, formatExpiryDate, resolveAppOrigin } from '../sendReminder.js';
import { setDocumentCount } from '../../../utils/CountUtils.js';

const serverUrl = cloudServerUrl; // process.env.SERVER_URL;
const APPID = serverAppId;
const masterKEY = process.env.MASTER_KEY;
// Name and contact written into every PDF signature dictionary (what a PDF
// reader shows in its signature panel): the deployment's own brand.
const eSignName = appName;
const eSigncontact = supportEmail || 'n/a';
const docUrl = `${serverUrl}/classes/contracts_Document`;
const headers = {
  'Content-Type': 'application/json',
  'X-Parse-Application-Id': APPID,
  'X-Parse-Master-Key': masterKEY,
};

function generateDocumentHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * A unique path under the OS temp directory. Signing used to write the pfx into
 * the working directory and the exported pdf/certificate into ./exports with a
 * `Math.random() * 5000` suffix, so two concurrent signatures could collide on
 * the same file (one signer's pfx or pdf overwriting another's) and a crash left
 * key material lying next to the source. Callers push every path they create
 * into `bin` and unlink the whole list in a `finally`.
 */
function tempPath(bin, suffix) {
  const file = path.join(os.tmpdir(), `docustamp_${randomUUID()}_${suffix}`);
  if (Array.isArray(bin)) bin.push(file);
  return file;
}

/** The contact a completion-relevant placeholder belongs to, if it is bound to one. */
function placeholderContactId(placeholder) {
  return placeholder?.signerObjId || placeholder?.signerPtr?.objectId || '';
}

/**
 * Is the document finished once `auditTrail` is written?
 *
 * The rule is per-placeholder-contact: every non-prefill placeholder must be
 * bound to a contact that has a completion entry (Signed/Approved/Declined) in
 * the trail. It used to be a bare count ("as many completion entries as there
 * are placeholders"), which completed a two-signer document as soon as one
 * signer produced two entries and never noticed *who* had signed.
 *
 * Legacy documents whose placeholders carry no signerObjId cannot be matched by
 * contact, so for those we fall back to the old count so they can still finish.
 */
function isDocumentCompleted(docJson, auditTrail) {
  if (!(docJson?.Signers?.length > 0)) return true;
  const placeholders = Array.isArray(docJson?.Placeholders)
    ? docJson.Placeholders.filter(isCompletionRelevant)
    : [];
  if (placeholders.length === 0) return false;
  const done = completedContactIds(auditTrail);
  const unbound = placeholders.filter(p => !placeholderContactId(p));
  if (unbound.length > 0) return done.size >= placeholders.length;
  return placeholders.every(p => done.has(placeholderContactId(p)));
}

/**
 * The next placeholder still waiting, in placeholder order (the order the
 * strict-order check walks).
 *
 * On a `SendinOrder` document the signer page emails the next recipient from
 * the browser right after signing, and a guest has no way to mint that person's
 * signing token, so `signPdf` hands the ready-made link back with its result.
 *
 * @returns {{contactId: string, email: string, name: string}|null}
 */
function nextPendingSigner(docJson, auditTrail) {
  const placeholders = Array.isArray(docJson?.Placeholders)
    ? docJson.Placeholders.filter(isCompletionRelevant)
    : [];
  const done = completedContactIds(auditTrail);
  for (const placeholder of placeholders) {
    const contactId = placeholderContactId(placeholder);
    if (!contactId || done.has(contactId)) continue;
    const signer = (docJson?.Signers || []).find(s => s?.objectId === contactId);
    const email = signer?.Email || placeholder?.email || '';
    if (!email) continue;
    return { contactId, email, name: signer?.Name || placeholder?.Name || '' };
  }
  return null;
}

/** The signing link for the next pending recipient, or `null`. Never throws. */
function nextSignerHandoff(docJson, auditTrail, publicUrl) {
  try {
    if (docJson?.SendinOrder !== true) return null;
    const next = nextPendingSigner(docJson, auditTrail);
    if (!next) return null;
    const docId = docJson?.objectId;
    const token = mintSigningToken({
      docId,
      contactId: next.contactId,
      expiresAt: signingTokenExpiry(docJson),
    });
    return {
      nextSignerUrl: buildSigningUrl(
        resolveAppOrigin(publicUrl),
        docId,
        next.email,
        next.contactId,
        token
      ),
      nextSignerEmail: next.email,
      nextSignerName: next.name,
    };
  } catch (err) {
    console.log('signPdf: could not build the next signer link', err?.message);
    return null;
  }
}

/** How many completion-relevant placeholders are still waiting. */
function remainingSignerCount(docJson, auditTrail) {
  const placeholders = Array.isArray(docJson?.Placeholders)
    ? docJson.Placeholders.filter(isCompletionRelevant)
    : [];
  const done = completedContactIds(auditTrail);
  const unbound = placeholders.filter(p => !placeholderContactId(p));
  if (unbound.length > 0) return Math.max(0, placeholders.length - done.size);
  return placeholders.filter(p => !done.has(placeholderContactId(p))).length;
}

/** Record why a signature attempt went wrong on the document itself. Never throws. */
async function saveDebugLog(docId, message) {
  if (!docId || !message) return;
  try {
    await axios.put(
      `${docUrl}/${docId}`,
      { DebugginLog: String(message).slice(0, 2000) },
      { headers }
    );
  } catch (err) {
    console.log('err in saving debugginglog', err?.message);
  }
}

/** Was this a deliberate refusal (auth, rate limit, already signed) rather than a fault? */
function isRefusal(err) {
  const code = err?.code;
  return (
    code === Parse.Error.OPERATION_FORBIDDEN ||
    code === Parse.Error.INVALID_SESSION_TOKEN ||
    code === Parse.Error.OBJECT_NOT_FOUND ||
    code === (Parse.Error.REQUEST_LIMIT_EXCEEDED || 155) ||
    isBaseChangedError(err)
  );
}

/* ------------------------------------------------------- agent signatures */

/** Marks the error `signPdf` throws when the stamped base is no longer current. */
const BASE_CHANGED = 'base_changed';

/**
 * The pdf a server-side signer stamped (`baseUrl`) is no longer the document's
 * current one: another signature landed in between, and writing this one would
 * drop that signer's stamps. The caller re-stamps from the new file and retries.
 */
function baseChangedError() {
  const err = new Parse.Error(
    Parse.Error.OTHER_CAUSE,
    'The document changed while it was being signed. Please sign it again.'
  );
  err.reason = BASE_CHANGED;
  return err;
}

/** True for the retryable "base changed" refusal (lib/agentSign.js catches it). */
export function isBaseChangedError(err) {
  return err?.reason === BASE_CHANGED;
}

/** Same stored file? Compared without the query, which carries a read token. */
function sameFile(a, b) {
  const bare = value => String(value || '').split('?')[0];
  return Boolean(a) && bare(a) === bare(b);
}

/**
 * The audit-trail fields of a signature made by an AI agent for its user (see
 * lib/agentSign.js). Rebuilt key by key so nothing but these lands on the trail.
 *
 * @param {Object} agent `{Method, Agent, OnBehalfOf, AllowedBy}`; `AllowedBy`
 *   may carry `nameMismatch {printed, expected, confirmed, via?}`, and
 *   `rule {summary, documentType, valueUsd, limitUsd}` when `via` is 'rules'.
 * @returns {Object}
 */
function agentAuditFields(agent) {
  const text = (value, max = 200) => String(value ?? '').slice(0, max);
  const date = value => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value?.iso || value);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const a = agent?.Agent || {};
  const who = agent?.OnBehalfOf || {};
  const allowed = agent?.AllowedBy || {};
  const allowedBy = {
    via: text(allowed.via, 20),
    name: text(allowed.name),
    email: text(allowed.email, 254),
    at: date(allowed.at) || new Date(),
    signingEnabledAt: date(allowed.signingEnabledAt),
  };
  if (allowed.approvalId) allowedBy.approvalId = text(allowed.approvalId, 64);
  // Signed without asking because the document fit the user's rules for their
  // AI (lib/agentRules.js): which rule, and what it matched.
  const rule = allowed.rule;
  if (allowedBy.via === 'rules' && rule && typeof rule === 'object') {
    const amount = value =>
      value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
    allowedBy.rule = {
      summary: text(rule.summary, 300),
      documentType: text(rule.documentType, 40),
      valueUsd: amount(rule.valueUsd),
      limitUsd: amount(rule.limitUsd),
    };
  }
  // The document printed another name for this party and the user confirmed
  // they sign for it anyway (lib/signerName.js).
  const mismatch = allowed.nameMismatch;
  if (mismatch && typeof mismatch === 'object') {
    allowedBy.nameMismatch = {
      printed: text(mismatch.printed),
      expected: text(mismatch.expected),
      confirmed: mismatch.confirmed === true,
    };
    if (mismatch.via) allowedBy.nameMismatch.via = text(mismatch.via, 20);
  }
  return {
    Method: 'agent',
    Agent: {
      kind: text(a.kind, 20),
      clientId: text(a.clientId, 128),
      name: text(a.name),
      host: text(a.host, 253),
    },
    OnBehalfOf: { name: text(who.name), email: text(who.email, 254), userId: text(who.userId, 64) },
    AllowedBy: allowedBy,
  };
}

/**
 * Persist one signature: the signed pdf url, the signer's audit entry and, when
 * this was the last one, the completion flag.
 *
 * This used to be a read-modify-write from the snapshot taken at the top of
 * `signPdf`: the whole `AuditTrail` array was rebuilt from a document that had
 * been read seconds earlier and PUT back, and `IsCompleted` was computed from the
 * same stale copy. Two signatures landing together lost one entry, two "last"
 * signers both completed the document and both mailed a certificate, and a
 * decline that arrived in between was simply overwritten.
 *
 * So the write happens against a re-read taken immediately before it, is
 * conditional on the document not having moved since (`updatedAt`), and the
 * completion flip goes through `tryMarkCompleted`, which exactly one request can
 * win. A loser retries with fresh data; a signature that arrives after the
 * document was declined is refused instead of resurrecting it.
 *
 * An agent signature (lib/agentSign.js) also passes `agent`, recorded on the
 * entry, and `baseUrl`, the file it stamped: when the document's current file
 * is a different one by now, the write is refused with `baseChangedError` so
 * the caller can re-stamp instead of overwriting a co-signer's stamps.
 *
 * @returns {Promise<Object>} {isCompleted, wonCompletion, AuditTrail, DocumentHash}
 */
async function persistSignature({
  docId,
  url,
  signerId,
  className,
  ipAddress,
  sign,
  documentHash,
  agent,
  baseUrl,
}) {
  // `sign` arrives as a base64 image. It used to be written into the audit entry
  // verbatim, so every read of the document (the inbox, the reports export, a
  // signer's own `getdocument`) carried every signature image inline; a
  // three-signer document was megabytes of JSON. The image is stored once and
  // the trail records its url. The certificate generator accepts either, so
  // documents signed before this change still render.
  const signatureUrl = await storeSignatureImage(sign);
  const entry = {
    UserPtr: { __type: 'Pointer', className: className, objectId: signerId },
    SignedUrl: url,
    Activity: 'Signed',
    ipAddress: ipAddress,
    SignedOn: new Date(),
    Signature: signatureUrl,
    ...(agent ? agentAuditFields(agent) : {}),
  };

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const fresh = await readFresh('contracts_Document', docId);
    if (!fresh) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
    if (fresh.IsDeclined === true) {
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        'This document has been declined and can no longer be signed.'
      );
    }
    if (fresh.IsCompleted === true) {
      // Another request completed the document while this one was signing. If
      // this signer is already recorded there is nothing left to write, and the
      // certificate and completion mail belong to the request that won.
      if (completedContactIds(fresh.AuditTrail).has(signerId)) {
        return {
          isCompleted: true,
          wonCompletion: false,
          AuditTrail: fresh.AuditTrail || [],
          DocumentHash: fresh.DocumentHash,
        };
      }
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        'This document is already completed and can no longer be signed.'
      );
    }
    if (baseUrl && !sameFile(fresh.SignedUrl || fresh.URL, baseUrl)) throw baseChangedError();

    // One entry per contact, and never downgrade a contact that is already
    // Signed/Approved/Declined (see cloud/lib/auditTrail.js). Recomputed on the
    // trail we just read, so a concurrent signature is never dropped.
    const auditTrail = upsertAuditEntry(fresh.AuditTrail || [], entry).auditTrail;
    const isCompleted = isDocumentCompleted(fresh, auditTrail);
    // `IsCompleted` is written either way: the reports and the inbox read it as
    // a real boolean, and a document in progress has always carried `false`.
    const fields = { SignedUrl: url, AuditTrail: auditTrail, IsCompleted: isCompleted };
    // `DocumentBeforesave` stamps DocSentAt the first time a SignedUrl appears;
    // these writes are deliberately trigger-free, so do it here.
    const firstUrl = !fresh.SignedUrl;
    if (firstUrl && fresh.Signers?.length > 0 && !fresh.DocSentAt) {
      fields.DocSentAt = new Date();
    }
    if (isCompleted && documentHash) {
      fields.DocumentHash = documentHash;
    }

    const written = isCompleted
      ? await tryMarkCompleted(docId, fields, { seenUpdatedAt: fresh.updatedAt })
      : await updateWithVersion('contracts_Document', docId, fresh.updatedAt, fields);
    if (written) {
      if (firstUrl) {
        // The same trigger keeps the owner's document counter up to date.
        await setDocumentCount(fresh.ExtUserPtr?.objectId);
      }
      return {
        isCompleted,
        wonCompletion: isCompleted,
        AuditTrail: auditTrail,
        DocumentHash: isCompleted ? documentHash : undefined,
      };
    }
  }
  throw new Parse.Error(
    Parse.Error.OTHER_CAUSE,
    'This document is being updated by someone else. Please try again.'
  );
}

// `sendNotifyMail` is used to send notification mail of signer signed the document
async function sendNotifyMail(doc, signUser, publicUrl) {
  try {
    const TenantAppName = appName;

    const remainingSign = remainingSignerCount(doc, doc?.AuditTrail);
    if (remainingSign > 1 && doc?.NotifyOnSignatures) {
      const sender = doc.ExtUserPtr;
      const pdfName = doc.Name;
      const creatorName = doc.ExtUserPtr.Name;
      const creatorEmail = doc.ExtUserPtr.Email;
      const signerName = signUser.Name;
      const signerEmail = signUser.Email;
      const viewDocUrl = `${publicUrl}/recipientSignPdf/${doc.objectId}`;
      const subject = `Document "${pdfName}" has been signed by ${signerName}`;
      const body = renderMail({
        title: `Signed by ${signerName || signerEmail}`,
        preheader: `${pdfName} has been signed by ${signerName || signerEmail}`,
        greeting: creatorName ? `Hi ${creatorName},` : '',
        paragraphs: [
          `${strong(pdfName)} has been signed by ${strong(signerName || signerEmail)}` +
            (signerName && signerEmail ? ` (${escapeHtml(signerEmail)})` : '') +
            '. The remaining signers have been notified in turn.',
        ],
        cta: { url: viewDocUrl, label: 'View document' },
      });

      const params = {
        extUserId: sender.objectId,
        from: TenantAppName,
        recipient: creatorEmail,
        subject: subject,
        pdfName: pdfName,
        html: body,
      };
      await sendSystemMail({ params });
    }
  } catch (err) {
    console.log('err in sendnotifymail', err);
  }
}

// `sendCompletedMail` is used to send copy of completed document mail
async function sendCompletedMail(obj) {
  const url = obj.doc?.SignedUrl;
  const doc = obj.doc;
  const sender = obj.doc.ExtUserPtr;
  const pdfName = doc.Name;
  const TenantAppName = appName;
  const senderInfo = {
    senderName: doc?.SenderName || sender?.Name || '',
    senderMail: doc?.SenderMail || sender?.Email || '',
    organization: sender?.Company || '',
  };

  let signersMail;
  if (doc?.Signers?.length > 0) {
    const isOwnerExistsinSigners = doc?.Signers?.find(x => x.Email === sender.Email);
    signersMail = isOwnerExistsinSigners
      ? doc?.Signers?.map(x => x?.Email)?.join(',')
      : [...(doc?.Signers || []).map(x => x?.Email), sender.Email].join(',');
  } else {
    signersMail = sender.Email;
  }
  const recipient = signersMail;
  let subject = `Document "${pdfName}" has been signed by all parties`;
  let body = renderMail({
    title: 'Everyone has signed',
    preheader: `${pdfName} has been signed by all parties`,
    paragraphs: [
      `All parties have signed ${strong(pdfName)}. The signed document and its completion certificate are attached to this email.`,
    ],
    sender: senderInfo,
  });

  if (obj?.isCustomMail) {
    // Template resolution, most specific first: the tenant the owner belongs
    // to, then the owner's own `contracts_Users` row (a member's own
    // templates), then the built-in text above.
    //
    // The fallback branch used to read the custom subject/body off `tenant`,
    // which is falsy by construction inside `else`, so a tenant found only by
    // the fallback query mailed an empty subject and an empty body.
    let templates = sender?.TenantId;
    if (!templates?.CompletionSubject && !templates?.CompletionBody) {
      const userId = sender?.CreatedBy?.objectId || sender?.UserId?.objectId;
      if (userId) {
        try {
          const tenantQuery = new Parse.Query('partners_Tenant');
          tenantQuery.equalTo('UserId', {
            __type: 'Pointer',
            className: '_User',
            objectId: userId,
          });
          const tenantRes = await tenantQuery.first({ useMasterKey: true });
          if (tenantRes) templates = JSON.parse(JSON.stringify(tenantRes));
        } catch (err) {
          console.log('error in fetch tenant in signpdf', err.message);
        }
      }
    }
    if (!templates?.CompletionSubject && !templates?.CompletionBody) {
      templates = sender;
    }
    subject = templates?.CompletionSubject || subject;
    // A custom body is a fragment (plain text with paragraph breaks, or html);
    // it goes into the same shell as the built-in one after the merge below.
    const customBody = String(templates?.CompletionBody || '').replace(/\n/g, '<br/>');
    // Documents created without `TimeToCompleteDays` carry no `ExpiryDate`, and
    // dereferencing `.iso` on it threw inside the completion mail.
    const localExpireDate = formatExpiryDate(doc);

    const variables = {
      document_title: pdfName,
      note: doc?.Note,
      sender_name: doc?.SenderName || sender.Name,
      sender_mail: doc?.SenderMail || sender.Email,
      sender_phone: sender?.Phone || '',
      receiver_name: sender.Name,
      receiver_email: sender.Email,
      receiver_phone: sender?.Phone || '',
      expiry_date: localExpireDate,
      company_name: sender.Company,
    };
    const replaceVar = replaceMailVaribles(subject, customBody, variables);
    subject = replaceVar.subject;
    if (customBody) body = renderMail({ bodyHtml: replaceVar.body, sender: senderInfo });
  }
  const Bcc = doc?.Bcc?.length > 0 ? doc.Bcc.map(x => x.Email) : [];
  const Cc = doc?.Cc?.length > 0 ? doc.Cc.map(x => x.Email) : [];
  const updatedBcc = doc?.SenderMail ? [...Bcc, doc?.SenderMail] : Bcc;
  const formatId = doc?.ExtUserPtr?.DownloadFilenameFormat;
  const filename = pdfName?.length > 100 ? pdfName?.slice(0, 100) : pdfName;
  const docName = buildDownloadFilename(formatId, {
    docName: filename,
    email: doc?.ExtUserPtr?.Email,
    isSigned: true,
  });
  const params = {
    extUserId: sender.objectId,
    url: url,
    from: doc?.SenderName || TenantAppName,
    replyto: doc?.SenderMail || doc?.ExtUserPtr?.Email || '',
    recipient: recipient,
    subject: subject,
    pdfName: pdfName,
    html: body,
    bcc: updatedBcc?.length > 0 ? updatedBcc : '',
    cc: Cc?.length > 0 ? Cc : '',
    certificatePath: obj.certificatePath,
    filename: docName,
  };
  // The caller owns `certificatePath` and unlinks it in its own `finally`, so a
  // mail failure here never leaves the file behind and never hides the fact
  // that the signature itself was persisted.
  const res = await sendMailWithAttachment(params);
  if (res?.status !== 'success') {
    console.error('signPdf: completion mail was not accepted', res?.message || res?.status);
  }
  return res;
}

// `sendMailsaveCertifcate` is used send completion mail and update complete status of document
async function sendMailsaveCertifcate(doc, pfx, isCustomMail, filename) {
  const certificatePath = tempPath(null, `signed_certificate_${doc.objectId}.pdf`);
  try {
    const certificate = await GenerateCertificate(doc);
    const certificatePdf = await PDFDocument.load(certificate);
    const P12Buffer = fs.readFileSync(pfx.name);
    const p12 = new P12Signer(P12Buffer, { passphrase: pfx.passphrase || null });
    //  `pdflibAddPlaceholder` is used to add code of only digitial sign in certificate
    pdflibAddPlaceholder({
      pdfDoc: certificatePdf,
      reason: `Digitally signed by ${eSignName}.`,
      location: 'n/a',
      name: eSignName,
      contactInfo: eSigncontact,
      signatureLength: 16000,
    });
    const pdfWithPlaceholderBytes = await certificatePdf.save();
    const CertificateBuffer = Buffer.from(pdfWithPlaceholderBytes);
    //`new signPDF` create new instance of CertificateBuffer and p12Buffer
    const certificateOBJ = new SignPdf();
    // `signedCertificate` is used to sign certificate digitally
    const signedCertificate = await certificateOBJ.sign(CertificateBuffer, p12);

    fs.writeFileSync(certificatePath, signedCertificate);
    const file = await uploadFile('certificate.pdf', certificatePath);
    if (!file?.imageUrl) throw new Error('Certificate upload returned no url.');
    const body = { CertificateUrl: file.imageUrl };
    await axios.put(`${docUrl}/${doc.objectId}`, body, { headers });
    // used in API only
    if (doc.IsSendMail === false) {
      console.log("don't send mail");
    } else {
      // Awaited on purpose: an unawaited rejection here used to take the whole
      // process down (node kills the process on an unhandled rejection).
      await sendCompletedMail({ isCustomMail, doc, filename, certificatePath });
    }
    saveFileUsage(CertificateBuffer.length, file.imageUrl, doc?.CreatedBy?.objectId);
    return file.imageUrl;
  } finally {
    await unlinkFile(certificatePath);
  }
}

/**
 * Prepare the final pdf for the digital seal: flatten every form field so the
 * page can no longer be edited, then add the signature placeholder the p12
 * signer fills in.
 *
 * It does neither of the two things its old JSDoc claimed. The audit trail is
 * written by `persistSignature`, and the certificate is produced by
 * `sendMailsaveCertifcate`; look there when a trail or certificate is wrong.
 * The placeholder is not optional either: this runs only on the signature that
 * completes the document, and that pdf is always sealed.
 *
 * @param {Buffer|Uint8Array} PdfBuffer original pdf bytes.
 * @param {string} reason reason text recorded in the signature dictionary.
 * @returns {Promise<Buffer>} flattened pdf with a signature placeholder.
 */
async function processPdf(PdfBuffer, reason) {
  // No CC merge; operate directly on the original PDF
  const pdfDoc = await PDFDocument.load(PdfBuffer);
  const form = pdfDoc.getForm();
  // Updates the field appearances to ensure visual changes are reflected.
  form.updateFieldAppearances();
  // Flattens the form, converting all form fields into non-editable, static content
  form.flatten();
  // The vendored `./Placeholder.js` fork was byte-for-byte the library's own
  // implementation, so it is gone and this is the library call.
  pdflibAddPlaceholder({
    pdfDoc: pdfDoc,
    reason: `Digitally signed by ${eSignName} for ${reason}`,
    location: 'n/a',
    name: eSignName,
    contactInfo: eSigncontact,
    signatureLength: 16000,
  });
  const pdfWithPlaceholderBytes = await pdfDoc.save();
  return Buffer.from(pdfWithPlaceholderBytes);
}
/**
 * Refuse a signature the document can no longer accept.
 *
 * A completed document must never be re-signed: doing so overwrote SignedUrl,
 * DocumentHash and CertificateUrl of an already finished agreement, which
 * silently invalidates the certificate everyone was emailed. The same goes for
 * a declined or expired document, and for a signer who is already recorded as
 * done (a double submit from a retried request or a re-opened tab).
 *
 * @param {Object} docJson contracts_Document as JSON
 * @param {string} contactId the contact being signed for ('' for an owner self-sign)
 * @param {{kind: string}} actor resolved by resolveDocumentActor
 */
export function assertSignable(docJson, contactId, actor) {
  if (docJson?.IsCompleted === true) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'This document is already completed and can no longer be signed.'
    );
  }
  if (docJson?.IsDeclined === true) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'This document has been declined and can no longer be signed.'
    );
  }
  const expiryIso = docJson?.ExpiryDate?.iso || docJson?.ExpiryDate;
  const expiry = expiryIso ? new Date(expiryIso).getTime() : NaN;
  if (Number.isFinite(expiry) && expiry < Date.now()) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'This document has expired and can no longer be signed.'
    );
  }
  // An owner self-signing their own (not yet completed) document has no
  // contactId and is allowed to re-submit; everyone else gets one submission.
  if (contactId && completedContactIds(docJson?.AuditTrail).has(contactId)) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      actor?.kind === 'owner'
        ? 'That signer has already completed this document.'
        : 'You have already signed this document.'
    );
  }
}

/**
 *
 * @param docId Id of Document in which user is signing
 * @param pdfFile base64 of pdfFile which you want sign
 * @returns if success {status, data} else {status, message}
 */
async function PDF(req) {
  const docId = req.params.docId;
  // Every temp file this call creates; unlinked in the `finally` below.
  const tempFiles = [];
  const pfxname = tempPath(tempFiles, 'keystore.pfx');
  try {
    const userIP = req.headers['x-real-ip']; // client IPaddress
    const isCustomMail = req.params.isCustomCompletionMail || false;
    const sign = req.params.signature || '';
    const auditActivity = 'Signed';
    const publicUrl = req.headers.public_url;
    // An AI agent signing for its user (lib/agentSign.js) is a master call that
    // says so for the audit trail and names the file it stamped. A client can
    // send neither: both are ignored unless the caller holds the master key.
    const agent = req.master && req.params.agent ? req.params.agent : undefined;
    const baseUrl = req.master && typeof req.params.baseUrl === 'string' ? req.params.baseUrl : '';
    // below bode is used to get info of docId
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.include('ExtUserPtr,Signers,ExtUserPtr.TenantId,Bcc,Cc,CreatedBy');
    docQuery.equalTo('objectId', docId);
    docQuery.notEqualTo('IsArchive', true);
    const resDoc = await docQuery.first({ useMasterKey: true });
    if (!resDoc) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }

    // Signing is expensive (pdf-lib + a digital signature + mail), so cap it
    // per document and per client before doing any of that work.
    checkRateLimit('signPdf:doc', docId, 30);
    checkRateLimit('signPdf:ip', clientIp(req), 60);

    /**
     * Who is signing? Until now this function trusted `req.params.userId`: any
     * caller who knew a docId could post a pdf as any signer on it, and only
     * OTP documents demanded a session (and then merely "some" session). The
     * guard resolves master key / owner session / signer session / signing-link
     * token, and refuses anything else. `ownerMayActForContact` stays false: an
     * owner may only sign for a contact that really is on their document.
     */
    const actor = await resolveDocumentActor(req, resDoc, {
      contactId: req.params.userId,
      signingToken: req.params.signingToken,
      ownerMayActForContact: false,
    });
    // For a signer the resolved contact is the only one they may sign for, and
    // it fills in `userId` when a token-only caller did not send one.
    const reqUserId =
      actor.kind === 'signer' ? actor.contactId || req.params.userId : req.params.userId;
    if (actor.kind === 'signer' && !reqUserId) {
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        'Please open this document from your signing link.'
      );
    }

    const _resDoc = resDoc?.toJSON();
    assertSignable(_resDoc, reqUserId, actor);
    if (baseUrl) {
      // Checked against the stored row, not the query above: its afterFind
      // trigger presigns the urls. persistSignature checks again at the write.
      const stored = await readFresh('contracts_Document', docId, ['SignedUrl', 'URL']);
      if (!sameFile(stored?.SignedUrl || stored?.URL, baseUrl)) throw baseChangedError();
    }
    let signUser;
    let className;
    // `reqUserId` is send throught pdfrequest signing flow
    if (reqUserId) {
      // to get contracts_Contactbook details for currentuser from reqUserId
      const _contractUser = _resDoc.Signers?.find(x => x.objectId === reqUserId);
      if (_contractUser) {
        signUser = _contractUser;
        className = 'contracts_Contactbook';
      } else {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          'That signer is not on this document.'
        );
      }
    } else {
      className = 'contracts_Users';
      signUser = _resDoc.ExtUserPtr;
    }
    // Strict-order gating: when both `SendinOrder` and `SendInOrderStrict`
    // are enabled the document creator wants the signing flow locked to a
    // strict sequence: a signer/approver may only act once every previous
    // signer/approver placeholder has a Signed/Approved audit entry. We
    // skip this check entirely for the document owner (className=Users)
    // because owners never sign through this path.
    if (reqUserId && _resDoc?.SendinOrder === true && _resDoc?.SendInOrderStrict === true) {
      const placeholders = Array.isArray(_resDoc?.Placeholders)
        ? _resDoc.Placeholders.filter(p => p?.Role !== 'prefill')
        : [];
      const myIdx = findPlaceholderIndex(placeholders, reqUserId);
      if (myIdx > 0) {
        const pendingId = findPendingPriorSigner(placeholders, myIdx, _resDoc?.AuditTrail);
        if (pendingId) {
          throw new Parse.Error(
            Parse.Error.OPERATION_FORBIDDEN,
            'Strict signing order is enabled. Please wait for the previous signers to complete their action before signing.'
          );
        }
      }
    }
    const username = signUser.Name;
    const userEmail = signUser.Email;
    if (req.params.pdfFile) {
      //  `PdfBuffer` used to create buffer from pdf file
      let PdfBuffer = Buffer.from(req.params.pdfFile, 'base64');
      //  `P12Buffer` used to create buffer from p12 certificate
      let pfxFile = process.env.PFX_BASE64;
      let passphrase = process.env.PASS_PHRASE;
      if (_resDoc?.ExtUserPtr?.TenantId?.PfxFile?.base64) {
        pfxFile = _resDoc?.ExtUserPtr?.TenantId?.PfxFile?.base64;
        passphrase = _resDoc?.ExtUserPtr?.TenantId?.PfxFile?.password;
      }
      const pfx = { name: pfxname, passphrase: passphrase };
      const P12Buffer = Buffer.from(pfxFile, 'base64');
      fs.writeFileSync(pfxname, P12Buffer);
      const UserPtr = { __type: 'Pointer', className: className, objectId: signUser.objectId };
      const obj = { UserPtr: UserPtr, SignedUrl: '', Activity: auditActivity, ipAddress: userIP };
      // Preview of the trail this signature produces, to decide up front whether
      // the pdf has to be digitally sealed. Upserted (not appended) so a signer
      // who already has an entry cannot inflate the completion count.
      const updateAuditTrail = upsertAuditEntry(_resDoc.AuditTrail || [], obj).auditTrail;
      const isCompleted = isDocumentCompleted(_resDoc, updateAuditTrail);
      // below regex is used to replace all word with "_" except A to Z, a to z, numbers
      const docName = _resDoc?.Name?.replace(/[^a-zA-Z0-9._-]/g, '_')?.toLowerCase();
      const filename = docName?.length > 100 ? docName?.slice(0, 100) : docName;
      const name = `${filename}.pdf`;
      const signedFilePath = tempPath(tempFiles, `signed_${name}`);
      let pdfSize = PdfBuffer.length;
      let documentHash;
      if (isCompleted) {
        const signersName = _resDoc.Signers?.map(x => x.Name + ' <' + x.Email + '>');
        const reason =
          signersName && signersName.length > 0
            ? signersName?.join(', ')
            : username + ' <' + userEmail + '>';
        const p12Cert = new P12Signer(P12Buffer, { passphrase: passphrase || null });
        PdfBuffer = await processPdf(PdfBuffer, reason);
        //`new signPDF` create new instance of pdfBuffer and p12Buffer
        const OBJ = new SignPdf();
        // `signedDocs` is used to signpdf digitally
        const signedDocs = await OBJ.sign(PdfBuffer, p12Cert);

        //`saveUrl` is used to save signed pdf in exports folder
        fs.writeFileSync(signedFilePath, signedDocs);
        pdfSize = signedDocs.length;
        documentHash = generateDocumentHash(signedDocs);
        console.log(`✅ PDF digitally signed created: ${signedFilePath} \n`);
      } else {
        //`saveUrl` is used to save signed pdf in exports folder
        fs.writeFileSync(signedFilePath, PdfBuffer);
        pdfSize = PdfBuffer.length;
        console.log(`New Signed PDF created called: ${signedFilePath}`);
      }

      // `uploadFile` is used to upload pdf to aws s3 and get it's url
      const data = await uploadFile(`signed_${name}`, signedFilePath);

      if (data && data.imageUrl) {
        // Re-reads the document and writes conditionally, so this signature can
        // neither drop a concurrent one nor complete a document twice.
        const updatedDoc = await persistSignature({
          docId: req.params.docId,
          url: data.imageUrl,
          signerId: signUser.objectId,
          className: className,
          ipAddress: userIP,
          sign: sign,
          documentHash: isCompleted ? documentHash : undefined,
          agent,
          baseUrl,
        });
        // From here on the signature is persisted. Everything that follows is
        // notification work: it is awaited (an unawaited rejection kills the
        // process on node 18+) but a failure must not tell the signer their
        // signature was lost, so it comes back as a `warning` instead.
        let warning;
        {
          const fresh = { ..._resDoc, AuditTrail: updatedDoc.AuditTrail, SignedUrl: data.imageUrl, IsCompleted: updatedDoc.isCompleted };
          const signer = { name: signUser?.Name || '', email: (signUser?.Email || '').toLowerCase(), contactId: className === 'contracts_Contactbook' ? signUser?.objectId : undefined };
          emitInBackground('signed', fresh, { signer });
          if (updatedDoc.wonCompletion) emitInBackground('completed', { ...fresh, DocumentHash: documentHash || updatedDoc?.DocumentHash }, {});
        }
        // An agent signing its own user's part mails that user its own "signed
        // for you" notice (lib/agentSign.js); the generic "X has signed" mail to
        // the same person would only repeat it.
        if (agent?.AllowedBy?.via !== 'own_document') {
          await sendNotifyMail(_resDoc, signUser, publicUrl);
        }
        saveFileUsage(pdfSize, data.imageUrl, _resDoc?.CreatedBy?.objectId);
        const handoff = updatedDoc.isCompleted
          ? null
          : nextSignerHandoff(_resDoc, updatedDoc.AuditTrail, publicUrl);
        // Only the request that actually flipped IsCompleted generates the
        // certificate and mails everyone; a loser in that race has its signature
        // recorded and stays quiet.
        if (updatedDoc.wonCompletion) {
          const hashForDoc = documentHash || updatedDoc?.DocumentHash;
          const doc = { ..._resDoc, AuditTrail: updatedDoc.AuditTrail, SignedUrl: data.imageUrl };
          if (hashForDoc) {
            doc.DocumentHash = hashForDoc;
          }
          try {
            await sendMailsaveCertifcate(doc, pfx, isCustomMail, `signed_${name}`);
          } catch (err) {
            warning =
              'Your signature was saved, but the completion certificate or email could not be sent.';
            console.error(
              `signPdf: certificate/completion mail failed for ${docId}:`,
              err?.message,
              err?.stack
            );
            await saveDebugLog(docId, `certificate/completion mail failed: ${err?.message}`);
          }
          // "Send B when A completes": in the background, so a follow-up that
          // cannot be sent never costs this signer their response. Inside the
          // wonCompletion branch, so a signature race cannot send it twice.
          runChainInBackground({ ...doc, IsCompleted: true });
        }
        return {
          status: 'success',
          data: data.imageUrl,
          ...(warning ? { warning } : {}),
          ...(handoff || {}),
        };
      }
      throw new Parse.Error(
        Parse.Error.OTHER_CAUSE,
        'The signed document could not be stored. Please try again.'
      );
    } else {
      const error = new Error('Pdf file not present!');
      error.code = 400; // Set the error code (e.g., 400 for bad request)
      throw error;
    }
  } catch (err) {
    // A stale base is routine for an agent signature (it re-stamps and retries).
    if (!isBaseChangedError(err)) console.error('Err in signpdf', err?.message, err?.stack);
    // A refusal is not a document problem: do not let a stream of rejected
    // guests rewrite DebugginLog on someone else's document.
    if (!isRefusal(err)) {
      await saveDebugLog(docId, err?.message);
    }
    throw err;
  } finally {
    for (const file of tempFiles) {
      await unlinkFile(file);
    }
  }
}
export default PDF;
