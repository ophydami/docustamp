import { createHash } from 'node:crypto';
import { isDocumentOwner } from './acl.js';
import { assertOwner, documentStatus, loadDoc } from './documents.js';
import { listDraftVersions } from './drafts.js';
import { openSummary, recentOpens } from './documentOpens.js';
import { API_URL_TTL, bytesFromInput, resolveFileUrl } from './files.js';
import {
  agentRecord,
  certificateBlocks,
  toDate,
} from '../parsefunction/pdf/GenerateCertificate.js';

/**
 * Audit trail, version history and certificate data for a document, as JSON,
 * plus how often each signer opened it, plus a check of a downloaded copy
 * against the stored hash. These are the
 * facts the web app shows on the document page and prints on the completion
 * certificate; an agent used to need a browser session to answer "who did
 * what, and when" or "is this file the one that was signed".
 */

const ENTRY_TIME_KEYS = ['SignedOn', 'ViewedOn', 'DeclinedOn', 'ApprovedOn', 'createdAt'];

function iso(value) {
  return toDate(value)?.toISOString() || undefined;
}

/** The participant an audit entry points at, by the document's own records. */
function whoFor(entry, d) {
  const ptr = entry?.UserPtr || {};
  const id = ptr.objectId || '';
  if (ptr.className === 'contracts_Users' || (id && id === d?.ExtUserPtr?.objectId)) {
    return {
      kind: 'sender',
      name: d?.SenderName || d?.ExtUserPtr?.Name || '',
      email: (d?.SenderMail || d?.ExtUserPtr?.Email || '').toLowerCase(),
    };
  }
  const contact =
    (d?.Signers || []).find(s => s?.objectId === id) ||
    (d?.Placeholders || []).find(g => (g?.signerObjId || g?.signerPtr?.objectId) === id)?.signerPtr;
  const group = (d?.Placeholders || []).find(
    g => (g?.signerObjId || g?.signerPtr?.objectId) === id
  );
  // The included pointer itself (AuditTrail.UserPtr) carries Name/Email when fetched.
  const name = contact?.Name || ptr.Name || group?.Name || '';
  const email = (contact?.Email || ptr.Email || group?.email || '').toLowerCase();
  return {
    kind: 'signer',
    name,
    email,
    contactId: id || undefined,
    role: group?.Role || undefined,
  };
}

/**
 * How a signature was made: `method: 'agent'` plus which app signed, for whom
 * and who allowed it (lib/agentSign.js records these on the entry), or
 * `method: 'person'` with none of the agent keys, so a reader that predates
 * agent signing sees the shape it always did. Takes an audit entry or a
 * certificate block; both carry the same `Method`/`Agent`/`OnBehalfOf`/
 * `AllowedBy` keys.
 */
function methodJson(source) {
  const record = agentRecord(source);
  if (!record) return { method: 'person' };
  const { Agent: agent, OnBehalfOf: behalf, AllowedBy: allowed } = record;
  return {
    method: 'agent',
    agent: { kind: agent.kind, name: agent.name, host: agent.host },
    onBehalfOf: { name: behalf.name, email: behalf.email },
    allowedBy: {
      via: allowed.via,
      name: allowed.name,
      email: allowed.email,
      at: allowed.at || undefined,
      signingEnabledAt: allowed.signingEnabledAt,
      approvalId: allowed.approvalId,
      // The document named someone else for this party and the user confirmed
      // they sign for it (lib/signerName.js): {printed, expected, confirmed, via?}.
      ...(allowed.nameMismatch ? { nameMismatch: allowed.nameMismatch } : {}),
    },
  };
}

/**
 * One audit entry as get_audit_trail returns it.
 * @param {Object} entry an AuditTrail entry
 * @param {Object} d the document as JSON (names the participant)
 */
export function entryJson(entry, d) {
  const when = ENTRY_TIME_KEYS.map(k => iso(entry?.[k])).find(Boolean);
  const out = {
    activity: entry?.Activity || (entry?.SignedOn || entry?.Signature ? 'Signed' : 'Unknown'),
    at: when,
    who: whoFor(entry, d),
    ip: entry?.ipAddress || undefined,
    ...methodJson(entry),
  };
  if (entry?.SignedOn && entry?.ViewedOn) out.viewedAt = iso(entry.ViewedOn);
  if (entry?.Signature) out.signatureImage = true;
  return out;
}

/**
 * @param {import('./context.js').Caller} caller
 * @param {string} docId
 * @returns {Promise<Object>} entries (oldest first), versions, certificate (completed documents)
 */
export async function getAuditTrail(caller, docId, { versionsLimit = 50 } = {}) {
  const obj = await loadDoc(docId);
  const d = JSON.parse(JSON.stringify(obj));
  assertOwner(d, caller);
  const status = documentStatus(d);

  const entries = (Array.isArray(d.AuditTrail) ? d.AuditTrail : [])
    .map(e => entryJson(e, d))
    .sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0));

  // Lifecycle facts that live on the row rather than in the trail.
  const lifecycle = {
    createdAt: d.createdAt,
    sentAt: d?.DocSentAt?.iso || undefined,
    expiresAt: d?.ExpiryDate?.iso || undefined,
    completedAt: d?.IsCompleted ? d?.updatedAt : undefined,
    declined: d?.IsDeclined
      ? {
          at: d?.updatedAt,
          reason: d?.DeclineReason || '',
          by: d?.DeclineBy
            ? {
                name: d.DeclineBy.name || d.DeclineBy.Name || '',
                email: (d.DeclineBy.email || d.DeclineBy.Email || '').toLowerCase(),
              }
            : undefined,
        }
      : undefined,
  };

  let versions = [];
  let versionsError;
  try {
    versions = await listDraftVersions(caller, docId, { limit: versionsLimit });
  } catch (err) {
    versionsError = err?.message || String(err);
  }

  // How often each signer opened their link (lib/documentOpens.js): the audit
  // entries only say *that* they did.
  let opens = { ...openSummary(d), recent: [] };
  try {
    opens.recent = await recentOpens(d.objectId, { limit: 20 });
  } catch (err) {
    opens = { ...opens, error: err?.message || String(err) };
  }

  let certificate;
  if (d?.IsCompleted) {
    const blocks = certificateBlocks(d);
    certificate = {
      documentHash: d?.DocumentHash || undefined,
      hashAlgorithm: d?.DocumentHash ? 'sha256' : undefined,
      completedAt: lifecycle.completedAt,
      originatorIp: d?.OriginIp || undefined,
      otp: d?.IsEnableOTP === true,
      signers: blocks.map((b, i) => ({
        order: i + 1,
        role: b.role,
        name: b.Name || '',
        email: (b.Email || '').toLowerCase(),
        ip: b.ipAddress || undefined,
        viewedAt: b.ViewedOn || undefined,
        opens: b.OpenCount || undefined,
        signedAt: b.SignedOn || undefined,
        ...methodJson(b),
      })),
      url: d?.CertificateUrl
        ? await resolveFileUrl(d.CertificateUrl, { ttl: API_URL_TTL })
        : undefined,
    };
  }

  return {
    objectId: d.objectId,
    name: d.Name,
    status,
    lifecycle,
    entries,
    opens,
    versions,
    ...(versionsError ? { versionsError } : {}),
    certificate,
    urls: {
      signed: d.SignedUrl ? await resolveFileUrl(d.SignedUrl, { ttl: API_URL_TTL }) : undefined,
      app: caller.publicUrl ? `${caller.publicUrl}/documents/${d.objectId}` : undefined,
    },
  };
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when the bytes carry a PDF digital signature dictionary. */
export function looksSealed(bytes) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  return /\/ByteRange\s*\[/.test(head) && /\/Contents\s*</.test(head);
}

/**
 * Check a copy of a PDF against the hash recorded when the document completed.
 *
 * With `documentId` the copy is checked against that document. Without one the
 * hash is looked up across the caller's own completed documents, which is what
 * "I was handed this file, which agreement is it?" needs.
 *
 * @param {import('./context.js').Caller} caller
 * @param {{documentId?: string, fileBase64?: string, url?: string}} input
 */
export async function verifyDocumentCopy(caller, input = {}) {
  const bytes = await bytesFromInput(input);
  const hash = sha256Hex(bytes);
  const sealed = looksSealed(bytes);

  if (input.documentId) {
    const obj = await loadDoc(input.documentId, { includeAudit: false });
    const d = JSON.parse(JSON.stringify(obj));
    assertOwner(d, caller);
    const stored = d?.DocumentHash || '';
    const completed = d?.IsCompleted === true;
    return {
      documentId: d.objectId,
      name: d.Name,
      status: documentStatus(d),
      hash,
      storedHash: stored || undefined,
      matches: Boolean(stored) && stored === hash,
      sealed,
      verdict: !completed
        ? 'not_completed'
        : !stored
          ? 'no_stored_hash'
          : stored === hash
            ? 'authentic'
            : 'different',
      explanation: !completed
        ? 'This document is not completed yet, so there is no final signed copy to compare against.'
        : !stored
          ? 'This document completed before hashes were recorded; compare the file with the signed copy url instead.'
          : stored === hash
            ? 'The file is byte-for-byte the signed copy recorded at completion.'
            : 'The file differs from the signed copy recorded at completion: it was changed after signing, or it is a different export (the original or an unsealed intermediate copy).',
    };
  }

  const query = new Parse.Query('contracts_Document');
  query.equalTo('DocumentHash', hash);
  query.notEqualTo('IsArchive', true);
  query.include('ExtUserPtr');
  query.limit(10);
  const rows = await query.find({ useMasterKey: true });
  const mine = rows
    .map(r => JSON.parse(JSON.stringify(r)))
    .filter(d => isDocumentOwner(d, caller.userId));
  return {
    hash,
    sealed,
    matches: mine.length > 0,
    verdict: mine.length ? 'authentic' : 'unknown',
    documents: mine.map(d => ({ objectId: d.objectId, name: d.Name, status: documentStatus(d) })),
    explanation: mine.length
      ? 'The file is the signed copy recorded at completion of the document(s) listed.'
      : 'No completed document of yours recorded this hash. The file may be altered, an original or intermediate copy, or belong to another account.',
  };
}
