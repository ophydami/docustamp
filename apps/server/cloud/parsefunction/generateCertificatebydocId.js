import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import GenerateCertificate from './pdf/GenerateCertificate.js';
import { appName, supportEmail } from '../../Utils.js';
// The hardened upload both certificate paths share: it logs the real failure,
// cleans up the temp file and returns nothing rather than half a result. This
// file used to keep its own copy that swallowed the error and returned
// `undefined`, which the caller then dereferenced as `file.imageUrl`.
import { unlinkFile, uploadFile } from '../lib/upload.js';
import { checkRateLimit, clientIp, isDocumentParticipant, resolveCaller } from './authGuard.js';
dotenv.config({ quiet: true });
const eSignName = appName;
const eSigncontact = supportEmail || 'n/a';

export default async function generateCertificatebydocId(req) {
  const docId = req.params.docId;
  // const userId = req.headers.userid;

  if (!docId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'please provide parameter.');
  }
  // Unique per invocation. It used to be `./exports/certificate_<docId>.pdf`,
  // one path for every caller: two requests that both passed the CertificateUrl
  // guard wrote, read and unlinked the same file, so one uploaded the other's
  // half-written bytes (and it raced `signPdf`'s own certificate path too).
  const certificatePath = path.join(os.tmpdir(), `docustamp_certificate_${randomUUID()}.pdf`);
  try {
    const getDocument = new Parse.Query('contracts_Document');
    getDocument.include(
      'ExtUserPtr,Signers,AuditTrail.UserPtr,Placeholders,ExtUserPtr.TenantId,ExtUserPtr.UserId'
    );
    const docRes = await getDocument.get(docId, { useMasterKey: true });

    // Read-only path: the certificate already exists. The public "signing
    // complete" page (old `/success`, new `/sign/:docId/done`) reaches this
    // with no session at all, and `signPdf` writes `CertificateUrl` as soon as
    // the last signature lands, so this is the branch those pages take.
    // Scoped by docId, completed-only, and it neither generates nor writes.
    if (docRes?.get('CertificateUrl')) {
      // Cheap, but still a public read: cap it per client so a docId cannot be
      // used to hammer the lookup.
      if (!req.master) checkRateLimit('generatecertificate:read', clientIp(req), 60);
      return { CertificateUrl: docRes.get('CertificateUrl') };
    }
    if (!docRes?.get('IsCompleted')) {
      if (!req.master) checkRateLimit('generatecertificate:read', clientIp(req), 60);
      return { CertificateUrl: '' };
    }

    // Generating is expensive (render + PKCS#12 sign + upload) and it writes
    // back to the document, so it needs a caller who belongs to the document.
    if (!req.master) {
      const caller = await resolveCaller(req);
      if (!caller) {
        throw new Parse.Error(
          Parse.Error.INVALID_SESSION_TOKEN,
          'Generating a certificate requires an authenticated user.'
        );
      }
      if (!isDocumentParticipant(docRes, caller)) {
        throw new Parse.Error(
          Parse.Error.OPERATION_FORBIDDEN,
          'You do not have access to this document.'
        );
      }
      checkRateLimit('generatecertificate', `u:${caller.id}`, 10);
    }

    if (docRes && docRes?.get('IsCompleted') && !docRes?.get('CertificateUrl')) {
      const _docRes = JSON.parse(JSON.stringify(docRes));
      // Defaulted to `[]`: a completed document with no AuditTrail (an import,
      // or one finished through the API) made `[...filteredaudit]` throw, and
      // the catch below reported it as "Cannot read properties of undefined".
      const filteredaudit = Array.isArray(_docRes?.AuditTrail)
        ? _docRes.AuditTrail.filter(x => x?.UserPtr?.objectId)
        : [];
      // The last entry that carries a signing time. `signPdf` writes entries
      // with no SignedOn, so this can legitimately be undefined; the document's
      // own updatedAt is then the best "completed at" available.
      const lastObj = [...filteredaudit]
        .reverse()
        .find(obj => Object.prototype.hasOwnProperty.call(obj, 'SignedOn') && obj.SignedOn);
      const completedAt = lastObj?.SignedOn || docRes.updatedAt || _docRes?.updatedAt;
      const doc = { ..._docRes, completedAt: completedAt };
      const certificate = await GenerateCertificate(doc);
      const certificatePdf = await PDFDocument.load(certificate);
      //  `P12Buffer` used to create buffer from p12 certificate. Built here, not
      //  at the top of the function, so a missing PFX_BASE64 cannot turn every
      //  read-only certificate lookup into a 141.
      const P12Buffer = Buffer.from(process.env.PFX_BASE64 || '', 'base64');
      const p12 = new P12Signer(P12Buffer, { passphrase: process.env.PASS_PHRASE || null });
      //  `pdflibAddPlaceholder` is used to add code of only digital sign in certificate
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

      //below is used to save signed certificate in exports folder
      fs.writeFileSync(certificatePath, signedCertificate);
      const file = await uploadFile('certificate.pdf', certificatePath);
      if (!file?.imageUrl) {
        throw new Parse.Error(
          Parse.Error.OTHER_CAUSE,
          'The completion certificate could not be stored. Please try again.'
        );
      }
      // Guarded write-back: only claim `CertificateUrl` while it is still
      // unset. Generating takes seconds, so a second caller that passed the
      // same guard may have finished first; if it did, its certificate is the
      // one everyone else already has a url for, so discard ours and return it.
      const winner = await claimCertificateUrl(doc.objectId, file.imageUrl);
      await unlinkFile(certificatePath);
      return { CertificateUrl: winner };
    } else {
      return { CertificateUrl: '' };
    }
  } catch (error) {
    console.error('Error fetching or processing document:', error);
    const code = error?.code || 400;
    const message = error?.message || 'Something went wrong.';
    await unlinkFile(certificatePath);
    throw new Parse.Error(code, message);
  }
}

/**
 * Write `CertificateUrl` only if the document does not already have one.
 * @param {string} docId contracts_Document objectId.
 * @param {string} url the certificate just uploaded.
 * @returns {Promise<string>} the url that is now stored on the document.
 */
async function claimCertificateUrl(docId, url) {
  const query = new Parse.Query('contracts_Document');
  query.doesNotExist('CertificateUrl');
  query.equalTo('objectId', docId);
  const unclaimed = await query.first({ useMasterKey: true });
  if (!unclaimed) {
    const current = await new Parse.Query('contracts_Document')
      .get(docId, { useMasterKey: true })
      .catch(() => null);
    const existing = current?.get('CertificateUrl');
    if (existing) return existing;
  }
  const updateDoc = new Parse.Object('contracts_Document');
  updateDoc.id = docId;
  updateDoc.set('CertificateUrl', url);
  await updateDoc.save(null, { useMasterKey: true });
  return url;
}
