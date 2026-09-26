import forge from 'node-forge';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appName } from '../../Utils.js';

/**
 * The key pair PDF signatures are made with.
 *
 * PFX_BASE64 / PASS_PHRASE win whenever they are set. Without them a fresh
 * self-hosted install used to fail on the first signature, because the signing
 * code had no certificate to read and generating one by hand is the step most
 * operators give up on. Now the server creates a self-signed identity on first
 * boot, keeps it in the master-key-only `platform_SigningIdentity` class so every
 * restart signs with the same key, and hands it to the signing code through the
 * same two environment variables it already reads (PDF.js and
 * generateCertificatebydocId.js read them per request, not at import time).
 *
 * A self-signed certificate makes signed PDFs tamper-evident, but PDF readers do
 * not show it as trusted. An operator who needs that supplies a certificate from
 * a certificate authority through PFX_BASE64 instead.
 */

export const IDENTITY_CLASS = 'platform_SigningIdentity';
const LOCKED_CLP = { get: {}, find: {}, count: {}, create: {}, update: {}, delete: {}, addField: {} };
const VALID_YEARS = 10;

/**
 * A new self-signed document-signing identity as a PKCS#12 bundle.
 *
 * The bundle uses PBE-SHA1-3DES with a SHA-1 MAC because node-forge, which
 * @signpdf/signer-p12 parses it with, cannot read the newer OpenSSL 3 defaults.
 *
 * @param {string} commonName subject and issuer CN.
 * @returns {{ pfxBase64: string, passphrase: string, subject: string, notAfter: Date, fingerprint: string }}
 */
export function createSelfSignedIdentity(commonName) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(privateKey);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  // A positive serial: a leading 0x01 byte keeps the high bit clear.
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`;
  // Whole seconds: X.509 times carry no milliseconds, so the returned notAfter
  // matches the certificate exactly.
  const notBefore = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + VALID_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: appName },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());

  const passphrase = randomBytes(24).toString('base64url');
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, {
    algorithm: '3des',
    friendlyName: commonName,
  });
  const der = forge.asn1.toDer(p12).getBytes();
  const fingerprint = forge.md.sha256
    .create()
    .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
    .digest()
    .toHex();
  return {
    pfxBase64: forge.util.encode64(der),
    passphrase,
    subject: commonName,
    notAfter,
    fingerprint,
  };
}

async function ensureIdentitySchema() {
  const schema = new Parse.Schema(IDENTITY_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (existing) {
    const clp = existing.classLevelPermissions || {};
    const locked = Object.keys(LOCKED_CLP).every(op => Object.keys(clp[op] || {}).length === 0);
    if (!locked) {
      schema.setCLP(LOCKED_CLP);
      await schema.update();
    }
    return;
  }
  schema.addString('PfxBase64');
  schema.addString('Passphrase');
  schema.addString('Subject');
  schema.addString('Fingerprint');
  schema.addDate('NotAfter');
  schema.setCLP(LOCKED_CLP);
  try {
    await schema.save();
  } catch (err) {
    if (!/already exists/i.test(err?.message || '')) throw err;
  }
}

/**
 * Make sure process.env carries a signing identity, creating and storing one on
 * first boot when the operator configured none. Runs before the boot gate opens,
 * so no signature can be attempted without it.
 *
 * @returns {Promise<'env' | 'stored' | 'created'>} where the identity came from.
 */
export async function ensureSigningIdentity() {
  if (process.env.PFX_BASE64?.trim()) return 'env';

  await ensureIdentitySchema();
  // Oldest first, so that even if two processes raced on an empty database every
  // later boot settles on the same identity.
  const query = new Parse.Query(IDENTITY_CLASS);
  query.ascending('createdAt');
  let row = await query.first({ useMasterKey: true });
  let source = 'stored';
  if (!row) {
    const identity = createSelfSignedIdentity(`${appName} Document Signing`);
    row = new Parse.Object(IDENTITY_CLASS);
    row.set('PfxBase64', identity.pfxBase64);
    row.set('Passphrase', identity.passphrase);
    row.set('Subject', identity.subject);
    row.set('Fingerprint', identity.fingerprint);
    row.set('NotAfter', identity.notAfter);
    await row.save(null, { useMasterKey: true });
    source = 'created';
    console.log(
      `[signing] No PFX_BASE64 configured: created a self-signed signing certificate ` +
        `"${identity.subject}" (sha256 ${identity.fingerprint}) and stored it in ${IDENTITY_CLASS}. ` +
        'Set PFX_BASE64 and PASS_PHRASE to sign with a certificate from a certificate authority instead.'
    );
  }
  process.env.PFX_BASE64 = row.get('PfxBase64');
  process.env.PASS_PHRASE = row.get('Passphrase');
  return source;
}
