/**
 * The self-signed identity a fresh install signs with when PFX_BASE64 is unset
 * (cloud/lib/signingIdentity.js). It has to be readable by the same p12 signer
 * the signing path uses, or the first signature on a new install fails.
 */
import axios from 'axios';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import {
  IDENTITY_CLASS,
  createSelfSignedIdentity,
  ensureSigningIdentity,
} from '../cloud/lib/signingIdentity.js';

const TEST_SERVER = 'http://localhost:30001/test';

describe('createSelfSignedIdentity', () => {
  let identity;
  beforeAll(() => {
    identity = createSelfSignedIdentity('Spec Document Signing');
  });

  it('produces a pkcs#12 that node-forge opens with its passphrase', () => {
    const der = forge.util.decode64(identity.pfxBase64);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), identity.passphrase);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    const cert = certBags[0].cert;
    expect(cert.subject.getField('CN').value).toBe('Spec Document Signing');
    expect(cert.validity.notAfter.getTime()).toBe(identity.notAfter.getTime());
    expect(identity.notAfter.getFullYear() - new Date().getFullYear()).toBeGreaterThanOrEqual(9);
  });

  it('signs a pdf through the same P12Signer the signing path uses', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    pdflibAddPlaceholder({
      pdfDoc: pdf,
      reason: 'Spec',
      location: 'n/a',
      name: 'Spec',
      contactInfo: 'n/a',
      signatureLength: 16000,
    });
    const signer = new P12Signer(Buffer.from(identity.pfxBase64, 'base64'), {
      passphrase: identity.passphrase,
    });
    const signed = await new SignPdf().sign(Buffer.from(await pdf.save()), signer);
    expect(signed.includes('/ByteRange')).toBeTrue();
  });

  it('never repeats a passphrase or a key', () => {
    const other = createSelfSignedIdentity('Spec Document Signing');
    expect(other.passphrase).not.toBe(identity.passphrase);
    expect(other.fingerprint).not.toBe(identity.fingerprint);
  });
});

describe('ensureSigningIdentity', () => {
  let savedPfx;
  let savedPass;
  beforeAll(() => {
    savedPfx = process.env.PFX_BASE64;
    savedPass = process.env.PASS_PHRASE;
  });
  afterAll(() => {
    if (savedPfx === undefined) delete process.env.PFX_BASE64;
    else process.env.PFX_BASE64 = savedPfx;
    if (savedPass === undefined) delete process.env.PASS_PHRASE;
    else process.env.PASS_PHRASE = savedPass;
  });

  it('leaves an operator-supplied certificate alone', async () => {
    process.env.PFX_BASE64 = 'operator-supplied';
    expect(await ensureSigningIdentity()).toBe('env');
    expect(process.env.PFX_BASE64).toBe('operator-supplied');
  });

  it('creates one identity on first boot and reuses it on every later boot', async () => {
    delete process.env.PFX_BASE64;
    delete process.env.PASS_PHRASE;
    const first = await ensureSigningIdentity();
    const pfx = process.env.PFX_BASE64;
    const pass = process.env.PASS_PHRASE;
    expect(['created', 'stored']).toContain(first);
    expect(pfx).toBeTruthy();
    expect(pass).toBeTruthy();

    delete process.env.PFX_BASE64;
    delete process.env.PASS_PHRASE;
    expect(await ensureSigningIdentity()).toBe('stored');
    expect(process.env.PFX_BASE64).toBe(pfx);
    expect(process.env.PASS_PHRASE).toBe(pass);
  });

  it('keeps the private key out of reach of the REST api', async () => {
    const headers = { 'X-Parse-Application-Id': 'test', 'X-Parse-Javascript-Key': 'test' };
    const res = await axios
      .get(`${TEST_SERVER}/classes/${IDENTITY_CLASS}`, { headers, validateStatus: () => true })
      .catch(err => err.response);
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.data)).not.toContain('PfxBase64');
  });
});
