import fs from 'node:fs';
import { downloadPdf, sendMail } from '../lib/mailTransport.js';
import { safeMailHeaders } from './sendSystemMail.js';
import { withTenantBranding } from './tenantBranding.js';

/**
 * Completion and forwarded-document mail: the same message as `sendSystemMail`
 * plus the signed pdf, and optionally the signing certificate.
 *
 * The pdf used to be streamed to `test_<0..4999>.pdf` in the working directory
 * and read back after a 100 ms timer, so two concurrent sends could collide on
 * the name, a failed download was still mailed (the resolved string `'error'` is
 * truthy) and the file survived a crash. It is now fetched into memory and the
 * send is refused when the fetch fails.
 *
 * The certificate has to be named explicitly, as `certificatePath` (a local file
 * the caller owns and cleans up, which is what `signPdf` passes) or as
 * `certificateUrl` (a stored certificate, which is what `forwarddoc` passes).
 * There is no `./exports/certificate.pdf` fallback any more: it was one shared
 * path for the whole process, so a forward could attach whatever certificate the
 * last signature happened to leave behind.
 *
 * @param {Object} params mail params; `url` is the pdf to attach.
 * @returns {Promise<{status: 'success'|'error', reason?: string, provider: string}>}
 */
export default async function sendMailWithAttachment(params) {
  // Same tenant branding as `sendmailv3`; see tenantBranding.js.
  const branded = await withTenantBranding(params || {});
  const attachments = [];

  if (branded.url) {
    const pdf = await downloadPdf(branded.url);
    if (pdf.status !== 'success') {
      console.log('sendMailWithAttachment: document download failed', pdf.reason);
      return { status: 'error', reason: pdf.reason, message: pdf.reason, provider: 'none' };
    }
    const pdfName = branded.pdfName ? `${branded.pdfName}.pdf` : '';
    attachments.push({
      filename: branded.filename || pdfName || 'exported.pdf',
      content: pdf.buffer,
    });

    const certificate = await readCertificate(branded);
    if (certificate) attachments.push(certificate);
  }

  return await sendMail(safeMailHeaders({ ...branded, attachments }));
}

/** The certificate attachment, or null when there is none to attach. */
async function readCertificate({ certificatePath, certificateUrl }) {
  if (certificatePath) {
    try {
      if (!fs.existsSync(certificatePath)) return null;
      return { filename: 'certificate.pdf', content: fs.readFileSync(certificatePath) };
    } catch (err) {
      // A missing certificate is worth less than the mail: send without it.
      console.log('sendMailWithAttachment: could not read the certificate', err?.message || err);
      return null;
    }
  }
  if (certificateUrl) {
    const cert = await downloadPdf(certificateUrl);
    if (cert.status === 'success') return { filename: 'certificate.pdf', content: cert.buffer };
    console.log('sendMailWithAttachment: certificate download failed', cert.reason);
  }
  return null;
}
