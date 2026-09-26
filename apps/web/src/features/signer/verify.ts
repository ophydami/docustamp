/**
 * Signed-PDF verification, entirely in the browser.
 *
 * The old client did this with pdf-lib + pkijs + asn1js and made no backend
 * calls (docs/BACKEND_API.md §11.37). None of those three are installed here,
 * so this is a self-contained implementation: a minimal DER reader, a scan for
 * the PDF signature dictionaries, SHA-256 over the signed byte ranges via
 * WebCrypto, and an RSA verification of the signed attributes.
 *
 * What it proves: the bytes covered by /ByteRange have not changed since they
 * were signed, and the signature was produced by the private key matching the
 * embedded certificate. What it does not prove: that the certificate chains to
 * a trusted root (there is no trust store in the browser to check against).
 */

import i18next from "i18next";

/* ------------------------------------------------------------------ *
 * Minimal DER
 * ------------------------------------------------------------------ */

export interface Der {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset one past the last content byte. */
  end: number;
  /** Offset of the tag byte, so we can re-serialise a node. */
  tagStart: number;
  children: Der[];
}

const CONSTRUCTED = 0x20;

function readNodes(b: Uint8Array, from: number, to: number, depth = 0): Der[] {
  const out: Der[] = [];
  let i = from;
  while (i < to - 1) {
    const tagStart = i;
    const tag = b[i++];
    let len = b[i++];
    if (len === undefined) break;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || i + n > to) break; // indefinite or absurd length
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + b[i++];
    }
    const start = i;
    const end = start + len;
    if (end > to) break;
    const node: Der = { tag, start, end, tagStart, children: [] };
    const constructed = (tag & CONSTRUCTED) !== 0;
    // Context-specific primitives can still wrap DER (implicit tagging).
    if (constructed && depth < 24) node.children = readNodes(b, start, end, depth + 1);
    out.push(node);
    i = end;
  }
  return out;
}

export function parseDer(bytes: Uint8Array): Der[] {
  return readNodes(bytes, 0, bytes.length);
}

function oidOf(b: Uint8Array, node: Der): string {
  const parts: number[] = [];
  let value = 0;
  for (let i = node.start; i < node.end; i++) {
    const byte = b[i];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  if (!parts.length) return "";
  const first = parts[0];
  return [Math.floor(first / 40), first % 40, ...parts.slice(1)].join(".");
}

function textOf(b: Uint8Array, node: Der): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(node.start, node.end)).replace(/\0/g, "");
}

function intOf(b: Uint8Array, node: Der): string {
  let hex = "";
  for (let i = node.start; i < node.end; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex.replace(/^00/, "") || "0";
}

/** ASN.1 UTCTime / GeneralizedTime to a Date. */
function timeOf(b: Uint8Array, node: Der): Date | null {
  const s = textOf(b, node).trim();
  const m = s.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/);
  if (!m) return null;
  let year = Number(m[1]);
  if (m[1].length === 2) year += year >= 50 ? 1900 : 2000;
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0")));
  return Number.isNaN(d.getTime()) ? null : d;
}

const OID_NAMES: Record<string, string> = {
  "2.5.4.3": "Common name",
  "2.5.4.4": "Surname",
  "2.5.4.5": "Serial number",
  "2.5.4.6": "Country",
  "2.5.4.7": "Locality",
  "2.5.4.8": "State",
  "2.5.4.9": "Street",
  "2.5.4.10": "Organization",
  "2.5.4.11": "Organizational unit",
  "2.5.4.12": "Title",
  "2.5.4.17": "Postal code",
  "1.2.840.113549.1.9.1": "Email"
};

const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_RSA = "1.2.840.113549.1.1.1";
const OID_ECDSA = "1.2.840.10045.2.1";

const DIGEST_BY_OID: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
  "1.3.14.3.2.26": "SHA-1"
};

/* ------------------------------------------------------------------ *
 * Certificate reading
 * ------------------------------------------------------------------ */

export interface CertInfo {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  serialNumber: string;
  notBefore: Date | null;
  notAfter: Date | null;
  keyAlgorithm: string;
  /** DER of SubjectPublicKeyInfo, for WebCrypto import. */
  spki: Uint8Array;
}

function readName(b: Uint8Array, name: Der): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rdn of name.children) {
    for (const pair of rdn.children) {
      const [oidNode, valueNode] = pair.children;
      if (!oidNode || !valueNode) continue;
      const oid = oidOf(b, oidNode);
      out[OID_NAMES[oid] ?? oid] = textOf(b, valueNode);
    }
  }
  return out;
}

function readCertificate(b: Uint8Array, cert: Der): CertInfo | null {
  const tbs = cert.children[0];
  if (!tbs) return null;
  // Skip the optional [0] EXPLICIT version wrapper.
  const f = tbs.children;
  let i = f[0] && f[0].tag === 0xa0 ? 1 : 0;
  const serial = f[i++];
  i++; // signature algorithm
  const issuer = f[i++];
  const validity = f[i++];
  const subject = f[i++];
  const spkiNode = f[i++];
  if (!serial || !issuer || !validity || !subject || !spkiNode) return null;

  const algOid = spkiNode.children[0]?.children[0] ? oidOf(b, spkiNode.children[0].children[0]) : "";
  return {
    serialNumber: intOf(b, serial),
    issuer: readName(b, issuer),
    subject: readName(b, subject),
    notBefore: validity.children[0] ? timeOf(b, validity.children[0]) : null,
    notAfter: validity.children[1] ? timeOf(b, validity.children[1]) : null,
    keyAlgorithm: algOid === OID_RSA ? "RSA" : algOid === OID_ECDSA ? "ECDSA" : algOid,
    spki: b.slice(spkiNode.tagStart, spkiNode.end)
  };
}

/* ------------------------------------------------------------------ *
 * PDF signature dictionaries
 * ------------------------------------------------------------------ */

export interface PdfSignatureBlock {
  byteRange: number[];
  /** The PKCS#7 blob from /Contents. */
  contents: Uint8Array;
  /** Bytes actually covered by the signature. */
  signedBytes: Uint8Array;
  /** True when /ByteRange spans the whole file, i.e. nothing was appended after signing. */
  coversWholeFile: boolean;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const even = clean.length % 2 ? clean.slice(0, -1) : clean;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.substr(i * 2, 2), 16);
  return out;
}

/**
 * Scans the raw PDF for `/ByteRange [...]` and the `/Contents <...>` that
 * belongs with it. Reading the bytes directly avoids pulling in a PDF parser
 * and is exactly what the signature covers anyway.
 */
export function findSignatureBlocks(bytes: Uint8Array): PdfSignatureBlock[] {
  const latin = new TextDecoder("latin1").decode(bytes);
  const out: PdfSignatureBlock[] = [];
  const re = /\/ByteRange\s*\[\s*([\d\s]+?)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const byteRange = m[1].trim().split(/\s+/).map(Number);
    if (byteRange.length < 4 || byteRange.some((n) => !Number.isFinite(n))) continue;

    // /Contents lives in the same signature dictionary as /ByteRange, usually
    // right after it, and it is long: the server reserves 16000 hex characters
    // for it (`processPdf` in PDF.js), so a fixed window around /ByteRange
    // misses the closing ">" and every sealed PDF read as "unsigned". Start at
    // the dictionary's own "<<" instead (a hex string cannot contain "<<", so
    // the nearest one before /ByteRange opens this dictionary whichever order
    // the two keys come in) and take the first /Contents from there, as long as
    // no other /ByteRange sits in between, which would make it a later
    // signature's.
    const dictStart = Math.max(0, latin.lastIndexOf("<<", m.index));
    const contentsRe = /\/Contents\s*<([0-9a-fA-F\s]*)>/g;
    contentsRe.lastIndex = dictStart;
    const cm = contentsRe.exec(latin);
    if (!cm || !cm[1].trim()) continue;
    if (cm.index > m.index && latin.slice(m.index + m[0].length, cm.index).includes("/ByteRange")) continue;

    const signedLength = byteRange.reduce((sum, n, i) => (i % 2 === 1 ? sum + n : sum), 0);
    if (signedLength <= 0) continue;
    const signed = new Uint8Array(signedLength);
    let offset = 0;
    let ok = true;
    for (let i = 0; i + 1 < byteRange.length; i += 2) {
      const from = byteRange[i];
      const len = byteRange[i + 1];
      if (from < 0 || len < 0 || from + len > bytes.length) {
        ok = false;
        break;
      }
      signed.set(bytes.subarray(from, from + len), offset);
      offset += len;
    }
    if (!ok) continue;

    const last = byteRange[byteRange.length - 2] + byteRange[byteRange.length - 1];
    out.push({
      byteRange,
      contents: hexToBytes(cm[1]),
      signedBytes: signed,
      // Trailing whitespace after %%EOF is normal, so allow a small slack.
      coversWholeFile: bytes.length - last <= 6
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The verification itself
 * ------------------------------------------------------------------ */

export interface SignatureResult {
  index: number;
  /** Overall verdict for this signature. */
  status: "valid" | "invalid" | "unknown";
  /** Human-readable reason, always set. */
  detail: string;
  signerName?: string;
  signerEmail?: string;
  organization?: string;
  issuerName?: string;
  serialNumber?: string;
  signingTime?: Date | null;
  certificateValidFrom?: Date | null;
  certificateValidTo?: Date | null;
  certificateExpired?: boolean;
  digestAlgorithm?: string;
  /** The SHA-256 we computed over the signed bytes, hex. */
  documentDigest?: string;
  /** The digest the signature claims, hex. */
  claimedDigest?: string;
  digestMatches?: boolean;
  cryptoVerified?: boolean;
  coversWholeFile: boolean;
}

export interface VerifyResult {
  fileName: string;
  byteLength: number;
  /** sha256 of the entire file, which is what `contracts_Document.DocumentHash` holds. */
  fileHash: string;
  signatures: SignatureResult[];
  status: "valid" | "invalid" | "unsigned" | "unknown";
  summary: string;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(alg: string, data: Uint8Array): Promise<string> {
  const view = data.slice(0);
  return toHex(await crypto.subtle.digest(alg, view.buffer as ArrayBuffer));
}

interface SignedDataParts {
  certificates: CertInfo[];
  digestAlgorithm: string;
  messageDigest?: Uint8Array;
  signingTime?: Date | null;
  signature?: Uint8Array;
  /** The exact bytes the signature was computed over, already re-tagged as SET. */
  signedAttrsDer?: Uint8Array;
}

function readSignedData(b: Uint8Array): SignedDataParts | null {
  const top = parseDer(b)[0];
  if (!top) return null;
  const contentTypeNode = top.children[0];
  if (contentTypeNode && oidOf(b, contentTypeNode) !== OID_SIGNED_DATA) return null;
  const signedData = top.children[1]?.children[0];
  if (!signedData) return null;

  const certificates: CertInfo[] = [];
  let signerInfos: Der | undefined;
  for (const child of signedData.children) {
    if (child.tag === 0xa0) {
      for (const c of child.children) {
        const info = readCertificate(b, c);
        if (info) certificates.push(info);
      }
    }
    if (child.tag === 0x31) signerInfos = child; // SET OF SignerInfo (the last SET wins)
  }
  const signer = signerInfos?.children[0];
  if (!signer) return { certificates, digestAlgorithm: "SHA-256" };

  let digestAlgorithm = "SHA-256";
  let messageDigest: Uint8Array | undefined;
  let signingTime: Date | null | undefined;
  let signature: Uint8Array | undefined;
  let signedAttrsDer: Uint8Array | undefined;

  for (const node of signer.children) {
    if (node.tag === 0x30 && node.children[0]?.tag === 0x06) {
      const oid = oidOf(b, node.children[0]);
      if (DIGEST_BY_OID[oid]) digestAlgorithm = DIGEST_BY_OID[oid];
    }
    if (node.tag === 0xa0) {
      // signedAttrs, implicitly tagged. The signature covers the DER with the
      // implicit tag replaced by a universal SET OF (0x31).
      const copy = b.slice(node.tagStart, node.end);
      copy[0] = 0x31;
      signedAttrsDer = copy;
      for (const attr of node.children) {
        const oid = attr.children[0] ? oidOf(b, attr.children[0]) : "";
        const value = attr.children[1]?.children[0];
        if (!value) continue;
        if (oid === OID_MESSAGE_DIGEST) messageDigest = b.slice(value.start, value.end);
        if (oid === OID_SIGNING_TIME) signingTime = timeOf(b, value);
      }
    }
    if (node.tag === 0x04) signature = b.slice(node.start, node.end);
  }
  return { certificates, digestAlgorithm, messageDigest, signingTime, signature, signedAttrsDer };
}

async function verifyRsa(cert: CertInfo, alg: string, signature: Uint8Array, signed: Uint8Array): Promise<boolean> {
  if (cert.keyAlgorithm !== "RSA") return false;
  const spki = cert.spki.slice(0);
  const key = await crypto.subtle.importKey(
    "spki",
    spki.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: alg },
    false,
    ["verify"]
  );
  const sig = signature.slice(0);
  const data = signed.slice(0);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
}

/** Runs every check we can run in the browser and returns a per-signature report. */
export async function verifyPdf(file: File): Promise<VerifyResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const fileHash = await digest("SHA-256", bytes);
  const blocks = findSignatureBlocks(bytes);

  if (!blocks.length) {
    return {
      fileName: file.name,
      byteLength: bytes.length,
      fileHash,
      signatures: [],
      status: "unsigned",
      summary: i18next.t("signer.verify.summary.unsigned")
    };
  }

  const signatures: SignatureResult[] = [];
  for (const [index, block] of blocks.entries()) {
    const result: SignatureResult = {
      index,
      status: "unknown",
      detail: "",
      coversWholeFile: block.coversWholeFile
    };
    try {
      const parts = readSignedData(block.contents);
      if (!parts) {
        result.status = "unknown";
        result.detail = i18next.t("signer.verify.detail.notDecoded");
        signatures.push(result);
        continue;
      }
      const cert = parts.certificates[0];
      if (cert) {
        result.signerName = cert.subject["Common name"] ?? cert.subject["Organization"];
        result.signerEmail = cert.subject["Email"];
        result.organization = cert.subject["Organization"];
        result.issuerName = cert.issuer["Common name"] ?? cert.issuer["Organization"];
        result.serialNumber = cert.serialNumber;
        result.certificateValidFrom = cert.notBefore;
        result.certificateValidTo = cert.notAfter;
        result.certificateExpired = !!cert.notAfter && cert.notAfter.getTime() < Date.now();
      }
      result.signingTime = parts.signingTime ?? null;
      result.digestAlgorithm = parts.digestAlgorithm;

      const computed = await digest(parts.digestAlgorithm, block.signedBytes);
      result.documentDigest = computed;
      if (parts.messageDigest) {
        result.claimedDigest = bytesToHex(parts.messageDigest);
        result.digestMatches = result.claimedDigest.toLowerCase() === computed.toLowerCase();
      }

      if (cert && parts.signature && parts.signedAttrsDer) {
        result.cryptoVerified = await verifyRsa(cert, parts.digestAlgorithm, parts.signature, parts.signedAttrsDer).catch(
          () => false
        );
      }

      if (result.digestMatches === false) {
        result.status = "invalid";
        result.detail = i18next.t("signer.verify.detail.altered");
      } else if (result.cryptoVerified) {
        result.status = "valid";
        result.detail = block.coversWholeFile
          ? i18next.t("signer.verify.detail.intact")
          : i18next.t("signer.verify.detail.intactAppended");
      } else if (result.digestMatches) {
        result.status = "unknown";
        result.detail = i18next.t("signer.verify.detail.keyUnchecked");
      } else {
        result.status = "unknown";
        result.detail = i18next.t("signer.verify.detail.unchecked");
      }
    } catch (e) {
      result.status = "unknown";
      result.detail = e instanceof Error ? e.message : i18next.t("signer.verify.detail.notRead");
    }
    signatures.push(result);
  }

  const anyInvalid = signatures.some((s) => s.status === "invalid");
  const allValid = signatures.length > 0 && signatures.every((s) => s.status === "valid");
  return {
    fileName: file.name,
    byteLength: bytes.length,
    fileHash,
    signatures,
    status: anyInvalid ? "invalid" : allValid ? "valid" : "unknown",
    summary: anyInvalid
      ? i18next.t("signer.verify.summary.invalid")
      : allValid
        ? i18next.t("signer.verify.summary.valid", { count: signatures.length })
        : i18next.t("signer.verify.summary.unknown")
  };
}
