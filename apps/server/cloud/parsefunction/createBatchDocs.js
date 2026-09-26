import axios from 'axios';
import { appName, cloudServerUrl, generateId, serverAppId } from '../../Utils.js';
import { setDocumentCount } from '../../utils/CountUtils.js';
import { documentFields, normaliseSettings, settingsFromDoc } from '../lib/documents.js';
import { assertStoredFileUrl } from '../lib/files.js';
import { sendSignatureRequestMails } from '../lib/requestMail.js';
import { extUserForUser, mapWithConcurrency } from './authGuard.js';

import sendSystemMail from './sendSystemMail.js';

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const serverUrl = cloudServerUrl; //process.env.SERVER_URL;
const appId = serverAppId;

function str(value, max = 0) {
  const out = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? out.slice(0, max) : out;
}

async function sendOwnerSummaryEmail({
  extUserId,
  ownerEmail,
  ownerName,
  total,
  created,
  failed,
  failedList,
  mailFailed,
}) {
  try {
    const subject = `Bulk send finished: ${failed} of ${total} failed to create`;

    const failureHtml = failedList?.length
      ? `<ul>${failedList
          .slice(0, 50)
          .map(f => `<li>#${f.index + 1}: ${String(f.error).slice(0, 200)}</li>`)
          .join('')}</ul>
         ${failedList.length > 50 ? `<p>…and ${failedList.length - 50} more.</p>` : ''}`
      : `<p>No failures.</p>`;

    const mailHtml = mailFailed?.length
      ? `<h4>Documents created but not emailed</h4>
         <ul>${mailFailed
           .slice(0, 50)
           .map(f => `<li>${f.email}: ${String(f.reason).slice(0, 200)}</li>`)
           .join('')}</ul>`
      : '';

    const html = `
      <p>Hi ${ownerName || ''},</p>
      <p>Your bulk send processing is complete.</p>
      <p><b>Total requested:</b> ${total}<br/>
         <b>Created:</b> ${created}<br/>
         <b>Failed to create:</b> ${failed}</p>
      <h4>Failure details</h4>
      ${failureHtml}
      ${mailHtml}
    `;

    const params = {
      isbulksend: true,
      // Lets sendSystemMail brand the summary with the tenant's sender name and footer.
      extUserId,
      recipient: ownerEmail,
      subject,
      // A system summary: the app's name, not the owner's address, as the display name.
      from: appName,
      replyto: ownerEmail,
      html,
    };

    await sendSystemMail({ params });
  } catch (e) {
    console.log('batchdoc Failed to send owner summary email:', e?.message || e);
  }
}

async function deductcount(docsCount, extUserId) {
  try {
    if (extUserId) {
      setDocumentCount(extUserId, docsCount);
    }
  } catch (err) {
    console.log('batchdoc deductcount error: ', err);
  }
}

const BATCH_LIMIT = 50; // Parse batch limit (safe)
const BATCH_CONCURRENCY = 5; // /batch calls in flight at the same time
const DOC_MAIL_CONCURRENCY = 5; // documents being mailed at the same time

/** Every contracts_Contactbook id a row points at, from either shape. */
function contactIdsOf(x) {
  const ids = new Set();
  for (const p of x?.Placeholders || []) {
    const id = p?.signerObjId || p?.signerPtr?.objectId;
    if (id) ids.add(id);
  }
  for (const s of x?.Signers || []) {
    if (s?.objectId) ids.add(s.objectId);
  }
  return [...ids];
}

/**
 * Read the contacts the batch points at, once, with the master key.
 *
 * The ACL used to be built from `CreatedBy` pointers sitting in the request body,
 * so a caller could hand write access to anyone. The signers' user ids now come
 * from the contact rows themselves.
 * @returns {Promise<Map<string, Object>>} contact objectId -> contact JSON
 */
async function loadContacts(documents) {
  const ids = [...new Set(documents.flatMap(contactIdsOf))];
  if (!ids.length) return new Map();
  const query = new Parse.Query('contracts_Contactbook');
  query.containedIn('objectId', ids);
  query.limit(1000);
  const rows = await query.find({ useMasterKey: true }).catch(() => []);
  return new Map(rows.map(row => [row.id, row.toJSON()]));
}

// Maps one incoming document onto a Parse /batch create request. A malformed row
// throws here and is recorded as a single failure instead of aborting the run.
//
// Ownership is never read from the request body: `CreatedBy`, `ExtUserPtr`, the
// `ACL` and the sender identity all come from the authenticated caller, and the
// mail template falls back to the caller's own tenant. Anything the body says
// about those fields is ignored.
function isPrefill(placeholder) {
  return placeholder?.Role === 'prefill';
}

/** A placeholder is bound when a real contact sits behind it. */
function isBound(placeholder) {
  return Boolean(placeholder?.signerPtr?.objectId || placeholder?.signerObjId);
}

function buildDocumentRequest(x, Ip, type, owner, batchKey) {
  const Signers = x.Signers;
  const all = Array.isArray(x?.Placeholders) ? x.Placeholders : [];
  const recipients = all.filter(p => !isPrefill(p) && isBound(p));
  if (!recipients.length) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'This row has no recipient.');
  }
  // What gets stored: the prefill groups (the values the sender filled in before
  // sending: amounts, dates, stamped images) plus the roles this row actually
  // binds, in their original order.
  //
  // Prefill groups used to be filtered out before the body was built, so every
  // value the sender had completed was silently dropped and came back blank in
  // every signed PDF of the run. Unbound roles used to be kept, with
  // `signerPtr: {}` and `signerObjId: ''`; completion counts every non-prefill
  // placeholder, so a two-role template bulk-sent to 50 contacts produced 50
  // documents that could never reach IsCompleted: no certificate, no completion
  // mail, "in progress" forever.
  const placeholders = all.filter(p => isPrefill(p) || isBound(p));
  const allSigner = recipients
    .map(item => Signers?.find(e => item?.signerPtr?.objectId === e?.objectId) || item?.signerPtr)
    .filter(signer => signer && Object.keys(signer).length > 0);
  const date = new Date();
  const isoDate = date.toISOString();

  // Owner first, then the shadow user of every contact on the row, read from the
  // contact rows rather than from the payload.
  //
  // DocumentAftersave rebuilds this a moment later, so it is belt and braces
  // rather than the real grant, but it has to agree with what the trigger does or
  // the row is briefly wrong: signers get READ only, because a signer with WRITE
  // could rewrite URL / SignedUrl / IsCompleted / AuditTrail straight through the
  // class API. It used to name each signer's `CreatedBy` (the sender again)
  // instead of their user, which was the inverse of the trigger and added nothing.
  const Acl = { [owner.userId]: { read: true, write: true } };
  for (const id of contactIdsOf(x)) {
    const contact = owner.contacts.get(id);
    const contactUserId = contact?.UserId?.objectId;
    if (contactUserId) Acl[contactUserId] = { read: true };
  }

  // The composed request mail travels on the row (the send flow writes the merge
  // template the user typed); with none, the caller's tenant default is used.
  const mailBody =
    str(x?.RequestBody) || str(x?.ExtUserPtr?.TenantId?.RequestBody) || owner.requestBody;
  const mailSubject =
    str(x?.RequestSubject) || str(x?.ExtUserPtr?.TenantId?.RequestSubject) || owner.requestSubject;
  const EmailEditorType = owner.emailEditorType;
  const senderName = str(x?.SenderName, 200) || owner.senderName;

  // One writer decides what a new `contracts_Document` carries
  // (cloud/lib/documents.js). This function is the adapter that maps one bulk
  // row onto it; what it adds on top is what only a bulk send has: the row is
  // inserted already sent, it carries the batch key that makes a retry
  // idempotent, and it names the tenant's mail template. Ownership never comes
  // from the row: `CreatedBy`, `ExtUserPtr`, the ACL and the sender identity all
  // come from the authenticated caller.
  //
  // `SendInOrderStrict` is normalised against `SendinOrder` by the shared
  // settings pass. It used to be copied through verbatim, so a row that carried
  // `SendInOrderStrict: true` with sequential sending off blocked every signer on
  // a rule the sender had turned off.
  const body = documentFields(owner, {
    name: x.Name,
    url: x.URL,
    note: x.Note,
    description: x.Description,
    settings: normaliseSettings({
      ...settingsFromDoc(x),
      redirectUrl: x?.RedirectUrl,
      // Only when the row says so, as this path has always done.
      notifyOnSignatures: x?.NotifyOnSignatures === true,
    }),
    placeholders: placeholders.map(y =>
      y?.signerPtr?.objectId
        ? {
            ...y,
            signerPtr: {
              __type: 'Pointer',
              className: 'contracts_Contactbook',
              objectId: y.signerPtr.objectId,
            },
            signerObjId: y.signerObjId,
            email: y?.signerPtr?.Email || y?.email || '',
          }
        : { ...y, signerPtr: {}, signerObjId: '', email: y.email || '' }
    ),
    signers: allSigner?.map(y => ({
      __type: 'Pointer',
      className: 'contracts_Contactbook',
      objectId: y.objectId,
    })),
    // The follow-up chain, keys picked rather than copied verbatim. Not
    // validated here (bulk rows are fire-and-forget); the runner re-resolves
    // the template against the owner at completion time and records a failed
    // ChainResult when it is gone.
    chain: x?.Chain?.templateId
      ? {
          templateId: String(x.Chain.templateId),
          ...(x.Chain.templateName ? { templateName: String(x.Chain.templateName).slice(0, 250) } : {}),
          ...(x.Chain.name ? { name: String(x.Chain.name).slice(0, 250) } : {}),
        }
      : undefined,
    // Bulk rows go out the moment they are created.
    signedUrl: x.URL || x.SignedUrl,
    sentToOthers: true,
    docSentAt: { __type: 'Date', iso: isoDate },
    isTourEnabled: x?.IsTourEnabled === true,
    acl: Acl,
    originIp: Ip,
    senderName,
    senderMail: owner.email,
    emailEditorType: EmailEditorType,
    message: { subject: mailSubject, body: mailBody },
    signatureType: x?.SignatureType,
    penColors: x?.PenColors,
    template: x?.objectId
      ? { __type: 'Pointer', className: 'contracts_Template', objectId: x.objectId }
      : undefined,
    ...(type === 'bulksend' ? { bulkSendToken: generateId(10) } : {}),
    // Deterministic per row: `<batch id>-<row index>`. It is what makes a failed
    // /batch call recoverable and what makes a caller-supplied `batchId`
    // idempotent across a retry.
    batchKey,
  });
  return { method: 'POST', path: '/app/classes/contracts_Document', body };
}

// Reads the message out of a Parse /batch row, an axios error or a thrown error.
function errorMessage(err, fallback) {
  const nested = err?.response?.data?.error || err?.error?.error || err?.error;
  const msg = nested || err?.message || err;
  return (typeof msg === 'string' && msg) || fallback;
}

/**
 * Read back the documents that were just created, with everything the request
 * mail needs. The mail is rendered from the persisted row, not from the request
 * payload, so what is emailed is what was actually stored.
 */
async function loadCreatedDocuments(objectIds) {
  if (!objectIds.length) return new Map();
  const query = new Parse.Query('contracts_Document');
  query.containedIn('objectId', objectIds);
  query.include('ExtUserPtr,ExtUserPtr.TenantId,Signers,Placeholders.signerPtr,CreatedBy');
  query.limit(objectIds.length);
  const rows = await query.find({ useMasterKey: true }).catch(err => {
    console.log('batchdoc could not read the created documents: ', err?.message || err);
    return [];
  });
  return new Map(rows.map(row => [row.id, row.toJSON()]));
}

/**
 * The rows of this batch that already exist, by `BatchKey`.
 *
 * Two things need this. A `/batch` call that fails *after* Parse committed the
 * writes (socket reset, response timeout, a 502 from a proxy) used to mark every
 * row of the chunk as a creation failure without ever asking what had actually
 * landed: the documents existed, already stamped `SignedUrl`, `SentToOthers` and
 * `DocSentAt`, but no signer was mailed and the owner was told they had failed,
 * so the obvious re-upload created a second live signing link for each recipient
 * and charged the quota twice. And when the caller passes its own `batchId`, the
 * same lookup makes the whole call idempotent: a retry finds the rows it already
 * created instead of duplicating them.
 *
 * @param {string[]} keys `BatchKey` values to look for.
 * @returns {Promise<Map<string, {objectId: string, createdAt: string}>>}
 */
async function findRowsByBatchKey(keys) {
  const found = new Map();
  for (const group of chunkArray(keys, BATCH_LIMIT)) {
    const query = new Parse.Query('contracts_Document');
    query.containedIn('BatchKey', group);
    query.limit(group.length);
    query.select('BatchKey');
    const rows = await query.find({ useMasterKey: true }).catch(err => {
      console.log('batchdoc could not look up batch keys: ', err?.message || err);
      return [];
    });
    for (const row of rows) {
      found.set(row.get('BatchKey'), { objectId: row.id, createdAt: row.get('createdAt') });
    }
  }
  return found;
}

/** `batchId` from the caller, or a fresh one. Only what can safely go in a key. */
function batchIdFor(raw) {
  const clean = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return clean || generateId(12);
}

async function startBulkSendInBackground(
  userId,
  Documents,
  Ip,
  parseConfig,
  type,
  publicUrl,
  user,
  batchId,
  resuming
) {
  const documents = Array.isArray(Documents) ? Documents : [];
  const total = documents.length;

  // The sender is the caller, never the payload.
  const resExt = await extUserForUser(user);
  if (!resExt) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');

  const _resExt = JSON.parse(JSON.stringify(resExt));

  if (total === 0) {
    return { total: 0, created: 0, failed: 0, results: [], mailFailed: [] };
  }

  const tenant = resExt.get('TenantId');
  if (tenant && !tenant.get('RequestSubject') && !tenant.get('TenantName')) {
    await tenant.fetch({ useMasterKey: true }).catch(() => null);
  }
  const owner = {
    userId,
    extUserId: resExt.id,
    email: str(resExt.get('Email')),
    name: str(resExt.get('Name')),
    senderName: resExt.get('UseNameAsSender') === true ? str(resExt.get('Name')) : '',
    requestBody: str(tenant?.get?.('RequestBody')),
    requestSubject: str(tenant?.get?.('RequestSubject')),
    emailEditorType: str(tenant?.get?.('EmailEditorType')),
    contacts: await loadContacts(documents),
  };

  // One slot per incoming row, so results always line up with the request order.
  const rows = new Array(total);
  const pending = [];
  const urlCaller = { userId, extUserId: resExt.id, tenantId: tenant?.id || '' };
  const batchKeyFor = index => `${batchId}-${index}`;
  // A retry of the same batchId must not create the run a second time. Only a
  // caller-supplied id can be a retry; a freshly generated one has no history.
  const already = resuming
    ? await findRowsByBatchKey(documents.map((_, index) => batchKeyFor(index)))
    : new Map();
  for (const [index, x] of documents.entries()) {
    const existing = already.get(batchKeyFor(index));
    if (existing) {
      rows[index] = { index, objectId: existing.objectId, createdAt: existing.createdAt };
      continue;
    }
    try {
      // Only files this deployment stores may become a signing request; an
      // external url is copied into our storage, a foreign stored file refused.
      const storedUrl = await assertStoredFileUrl(x?.URL || x?.SignedUrl, urlCaller);
      const row = { ...x, URL: storedUrl, SignedUrl: storedUrl };
      pending.push({
        index,
        key: batchKeyFor(index),
        request: buildDocumentRequest(row, Ip, type, owner, batchKeyFor(index)),
      });
    } catch (err) {
      rows[index] = { index, error: errorMessage(err, 'Could not read this row.') };
    }
  }

  // Create in /batch chunks, several chunks at a time. A chunk that fails outright
  // only fails its own rows.
  const chunks = chunkArray(pending, BATCH_LIMIT);
  // `throwOnError` keeps the contract this function has always had: both
  // callbacks below record their own failures per row, so anything that escapes
  // one of them is a bug the run must not paper over by reporting `created: N`.
  const concurrently = (items, limit, fn) =>
    mapWithConcurrency(items, limit, fn, { throwOnError: true });
  await concurrently(chunks, BATCH_CONCURRENCY, async chunk => {
    try {
      const response = await axios.post(
        'batch',
        { requests: chunk.map(item => item.request) },
        parseConfig
      );
      const data = Array.isArray(response?.data) ? response.data : [];
      chunk.forEach((item, i) => {
        const objectId = data[i]?.success?.objectId;
        if (objectId) {
          rows[item.index] = { index: item.index, objectId, createdAt: data[i].success.createdAt };
        } else {
          rows[item.index] = {
            index: item.index,
            error: errorMessage(data[i], 'The document was not created.'),
          };
        }
      });
    } catch (err) {
      const message = errorMessage(err, 'The batch request failed.');
      // The transport failed, which says nothing about whether Parse committed
      // the writes. Ask before calling them failures.
      const landed = await findRowsByBatchKey(chunk.map(item => item.key));
      chunk.forEach(item => {
        const found = landed.get(item.key);
        rows[item.index] = found
          ? { index: item.index, objectId: found.objectId, createdAt: found.createdAt }
          : { index: item.index, error: message };
      });
    }
  });

  const createdRows = rows.filter(row => row?.objectId);
  const failedList = rows.filter(row => row?.error);
  const created = createdRows.length;
  const failed = failedList.length;

  if (created > 0) {
    deductcount(created, resExt.id);
  }

  // The request mail is sent in process. It used to be posted back to this same
  // server as an anonymous `sendmailv3` call over HTTP loopback, which meant a
  // bulk send of more than 30 documents ran into the anonymous rate limit and
  // silently mailed nobody for the rest of the batch.
  const persisted = await loadCreatedDocuments(createdRows.map(row => row.objectId));
  const mailFailed = [];
  await concurrently(createdRows, DOC_MAIL_CONCURRENCY, async row => {
    const doc = persisted.get(row.objectId);
    if (!doc) {
      row.mailFailed = [{ email: '', reason: 'The created document could not be read back.' }];
      mailFailed.push({ index: row.index, email: '', reason: row.mailFailed[0].reason });
      return;
    }
    try {
      // `sendSignatureRequestMails` mails only the first signer when the document
      // is signed in order, and everyone otherwise.
      const res = await sendSignatureRequestMails({ doc, publicUrl });
      if (res.failed.length) {
        row.mailFailed = res.failed;
        for (const f of res.failed) {
          mailFailed.push({ index: row.index, email: f.email, reason: f.reason });
        }
      }
    } catch (err) {
      const reason = errorMessage(err, 'The request mail could not be sent.');
      console.log('batchdoc sendmail error: ', reason);
      row.mailFailed = [{ email: '', reason }];
      mailFailed.push({ index: row.index, email: '', reason });
    }
  });

  if (failed > 0 || mailFailed.length > 0) {
    await sendOwnerSummaryEmail({
      extUserId: _resExt?.objectId,
      ownerEmail: _resExt?.Email,
      ownerName: _resExt?.Name,
      total,
      created,
      failed,
      failedList,
      mailFailed,
    });
  }

  return {
    total,
    created,
    failed,
    // Documents that exist but whose recipient was not emailed. The row keeps its
    // `objectId`, because the document really was created.
    mailFailed,
    results: rows.map(row =>
      row?.objectId
        ? {
            index: row.index,
            objectId: row.objectId,
            ...(row.mailFailed ? { mailFailed: row.mailFailed } : {}),
          }
        : row
    ),
  };
}

export default async function createBatchDocs(request) {
  const strDocuments = request.params.Documents;
  const sessionToken = request.headers?.sessiontoken;
  const type = request.headers?.type || 'quicksend';

  const Ip = request?.headers?.['x-real-ip'] || '';
  // Access the host from the headers
  const publicUrl = request.headers.public_url;
  const parseConfig = {
    baseURL: serverUrl,
    headers: {
      'X-Parse-Application-Id': appId,
      'X-Parse-Session-Token': sessionToken,
      'Content-Type': 'application/json',
    },
  };
  try {
    if (!request?.user) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
    }
    const userId = request.user.id;

    // `Documents` is a stringified JSON array, but an array is accepted too.
    let Documents;
    try {
      Documents = Array.isArray(strDocuments) ? strDocuments : JSON.parse(strDocuments || '[]');
    } catch {
      throw new Parse.Error(Parse.Error.INVALID_JSON, 'Documents is not valid JSON.');
    }
    if (!Array.isArray(Documents)) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, 'Documents must be an array.');
    }

    // quicksend
    const resuming = typeof request.params?.batchId === 'string' && !!request.params.batchId;
    const batchId = batchIdFor(request.params?.batchId);
    const result = await startBulkSendInBackground(
      userId,
      Documents,
      Ip,
      parseConfig,
      type,
      publicUrl,
      request.user,
      batchId,
      resuming
    );
    // Handed back so a caller that timed out can retry with the same id and get
    // the documents it already created instead of a second copy of the run.
    return { ...result, batchId };
  } catch (err) {
    console.log('createbatchdoc error: ', err);
    const code = err?.code || 400;
    const msg = err?.message || 'Something went wrong.';
    throw new Parse.Error(code, msg);
  }
}
