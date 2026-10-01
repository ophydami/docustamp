import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import axios from 'axios';
import { extUserPointer, userPointer } from './context.js';
import { summariseDocument } from './documents.js';
import { normaliseEmail } from './email.js';
import { assertFetchableUrl } from './files.js';

/**
 * Outbound webhooks. A user registers a url (and gets a secret once); every
 * document event for documents they own is POSTed there as JSON, signed with
 * HMAC-SHA256 of the body, with up to three attempts. Delivery is best-effort
 * and never blocks or fails the action that caused the event.
 *
 * Events: sent, viewed, signed, completed, declined, voided, reminder, chained.
 * Payload: { id, event, createdAt, document (the get_document summary, no
 * signing links), signer? (for viewed/signed/declined), reason?, chain? (for
 * chained: the ChainResult - status sent/failed, documentId of the follow-up) }.
 *
 * One event goes the other way: `received` is delivered to the webhooks of the
 * person a document was sent TO, when it becomes their turn to sign (see
 * `emitUserEvent` and requestMail.js `announceReceived`). Its `document` is what
 * that person's inbox shows (`receivedDocumentJson`), never the owner's summary.
 *
 * Headers: X-DocuStamp-Event, X-DocuStamp-Delivery (payload id),
 * X-DocuStamp-Signature: sha256=<hex hmac of the raw body>.
 */

export const WEBHOOK_CLASS = 'contracts_Webhook';
export const WEBHOOK_EVENTS = Object.freeze([
  'sent',
  'viewed',
  'signed',
  'completed',
  'declined',
  'voided',
  'reminder',
  'chained',
  'received',
]);
const MAX_WEBHOOKS_PER_USER = 10;
const DELIVERY_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [0, 2000, 8000];

const LOCKED_CLP = Object.freeze({
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

let schemaReady = false;
export async function ensureWebhookSchema() {
  if (schemaReady) return;
  const schema = new Parse.Schema(WEBHOOK_CLASS);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (existing) {
    schemaReady = true;
    return;
  }
  schema.addString('Url');
  schema.addString('Secret');
  schema.addArray('Events');
  schema.addString('Description');
  schema.addBoolean('Active');
  schema.addPointer('CreatedBy', '_User');
  schema.addPointer('ExtUserPtr', 'contracts_Users');
  schema.addDate('LastDeliveryAt');
  schema.addNumber('LastStatus');
  schema.addString('LastError');
  schema.addNumber('Failures');
  schema.setCLP(LOCKED_CLP);
  try {
    await schema.save();
  } catch (err) {
    if (!/already exists/i.test(err?.message || '')) throw err;
  }
  schemaReady = true;
}

function webhookJson(row, { secret = false } = {}) {
  const j = row?.toJSON ? row.toJSON() : row;
  return {
    webhookId: j.objectId,
    url: j.Url,
    events: j.Events || [],
    description: j.Description || undefined,
    active: j.Active !== false,
    createdAt: j.createdAt,
    lastDeliveryAt: j.LastDeliveryAt?.iso || j.LastDeliveryAt || undefined,
    lastStatus: j.LastStatus ?? undefined,
    lastError: j.LastError || undefined,
    failures: j.Failures || 0,
    ...(secret ? { secret: j.Secret } : {}),
  };
}

function normaliseEvents(events) {
  const list = Array.isArray(events) && events.length ? events : ['*'];
  const out = [];
  for (const e of list) {
    const name = String(e || '').trim().toLowerCase();
    if (name === '*' || name === 'all') return ['*'];
    if (!WEBHOOK_EVENTS.includes(name)) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `Unknown event "${e}". Events: ${WEBHOOK_EVENTS.join(', ')} (or "*").`
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

async function mine(caller) {
  await ensureWebhookSchema();
  const q = new Parse.Query(WEBHOOK_CLASS);
  q.equalTo('CreatedBy', userPointer(caller));
  q.ascending('createdAt');
  q.limit(100);
  return await q.find({ useMasterKey: true });
}

export async function registerWebhook(caller, { url, events, secret, description } = {}) {
  const target = await assertFetchableUrl(String(url || ''));
  if (!/^https:/i.test(target) && process.env.ALLOW_HTTP_WEBHOOKS !== 'true') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Webhook urls must be https.');
  }
  const wanted = normaliseEvents(events);
  const rows = await mine(caller);
  if (rows.length >= MAX_WEBHOOKS_PER_USER) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `At most ${MAX_WEBHOOKS_PER_USER} webhooks per account; delete one first.`
    );
  }
  const existing = rows.find(r => r.get('Url') === target);
  const row = existing || new Parse.Object(WEBHOOK_CLASS);
  const sec =
    (typeof secret === 'string' && secret.trim().slice(0, 200)) ||
    row.get('Secret') ||
    randomBytes(24).toString('hex');
  row.set('Url', target);
  row.set('Secret', sec);
  row.set('Events', wanted);
  row.set('Active', true);
  if (description !== undefined) row.set('Description', String(description || '').slice(0, 200));
  row.set('CreatedBy', userPointer(caller));
  row.set('ExtUserPtr', extUserPointer(caller));
  if (!existing) row.set('Failures', 0);
  const saved = await row.save(null, { useMasterKey: true });
  return {
    ...webhookJson(saved, { secret: true }),
    created: !existing,
    note: 'Keep the secret: every delivery carries X-DocuStamp-Signature: sha256=HMAC_SHA256(secret, raw body). It is only shown here and in list_webhooks { showSecrets: true }.',
  };
}

export async function listWebhooks(caller, { showSecrets = false } = {}) {
  const rows = await mine(caller);
  return rows.map(r => webhookJson(r, { secret: showSecrets === true }));
}

export async function deleteWebhook(caller, webhookId) {
  await ensureWebhookSchema();
  const row = await new Parse.Query(WEBHOOK_CLASS)
    .get(String(webhookId || ''), { useMasterKey: true })
    .catch(() => null);
  if (!row || row.get('CreatedBy')?.id !== caller.userId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Webhook not found.');
  }
  await row.destroy({ useMasterKey: true });
  return { webhookId: row.id, deleted: true };
}

/* ------------------------------------------------------------------ delivery */

let transport = async (url, body, headers) =>
  await axios.post(url, body, {
    headers,
    timeout: DELIVERY_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
    maxContentLength: 64 * 1024,
  });
/** Test seam: replace the HTTP call deliveries go through. */
export function setWebhookTransport(fn) {
  transport = fn || null;
}

export function signPayload(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function deliverOnce(row, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DocuStamp-Webhook/1.0',
    'X-DocuStamp-Event': payload.event,
    'X-DocuStamp-Delivery': payload.id,
    'X-DocuStamp-Signature': signPayload(row.get('Secret') || '', body),
  };
  let lastError = '';
  let status = 0;
  for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const res = await transport(row.get('Url'), body, headers);
      status = Number(res?.status) || 0;
      if (status >= 200 && status < 300) {
        lastError = '';
        break;
      }
      lastError = `HTTP ${status}`;
    } catch (err) {
      status = 0;
      lastError = err?.code || err?.message || 'request failed';
    }
    if (i === RETRY_DELAYS_MS.length - 1) break;
  }
  const ok = status >= 200 && status < 300;
  try {
    const update = new Parse.Object(WEBHOOK_CLASS);
    update.id = row.id;
    update.set('LastDeliveryAt', new Date());
    update.set('LastStatus', status);
    update.set('LastError', ok ? '' : String(lastError).slice(0, 200));
    update.set('Failures', ok ? 0 : (Number(row.get('Failures')) || 0) + 1);
    await update.save(null, { useMasterKey: true });
  } catch (err) {
    console.log('webhooks: could not record delivery state', err?.message);
  }
  return { webhookId: row.id, ok, status, error: ok ? undefined : lastError };
}

/** The active webhooks of one `_User` that subscribe to `event` (or to "*"). */
async function hooksFor(userId, event) {
  await ensureWebhookSchema();
  const q = new Parse.Query(WEBHOOK_CLASS);
  q.equalTo('CreatedBy', { __type: 'Pointer', className: '_User', objectId: userId });
  q.notEqualTo('Active', false);
  q.limit(MAX_WEBHOOKS_PER_USER);
  return (await q.find({ useMasterKey: true })).filter(r => {
    const events = r.get('Events') || [];
    return events.includes('*') || events.includes(event);
  });
}

/**
 * Send one event to every matching webhook of the document's owner.
 * Awaitable (tests), but callers in request paths use `emitInBackground`.
 *
 * @param {string} event one of WEBHOOK_EVENTS
 * @param {Object} docJson the document (plain JSON, with Placeholders/Signers/AuditTrail when available)
 * @param {Object} [extra] signer / reason / anything event-specific
 */
export async function emitDocumentEvent(event, docJson, extra = {}) {
  if (!transport) return [];
  const ownerId = docJson?.CreatedBy?.objectId || docJson?.ExtUserPtr?.UserId?.objectId || docJson?.CreatedBy?.id;
  if (!ownerId) return [];
  const rows = await hooksFor(ownerId, event);
  if (!rows.length) return [];
  let document;
  try {
    document = summariseDocument(docJson, null, { links: false });
  } catch {
    document = { objectId: docJson?.objectId, name: docJson?.Name };
  }
  const payload = {
    id: randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    document,
    ...extra,
  };
  const results = [];
  for (const row of rows) results.push(await deliverOnce(row, payload));
  return results;
}

/** Fire and forget, with the rejection swallowed: an action never fails over a webhook. */
export function emitInBackground(event, docJson, extra = {}) {
  Promise.resolve()
    .then(() => emitDocumentEvent(event, docJson, extra))
    .catch(err => console.log(`webhooks: ${event} delivery failed`, err?.message || err));
}

function isoOf(value) {
  if (!value) return undefined;
  const raw = typeof value === 'string' || value instanceof Date ? value : value.iso;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

/**
 * A document as the person it was sent to may see it: the fields of a
 * `list_inbox` item, with the sender named the way the request mail names them.
 * No signing link or token, no other signer's address, no note, no settings.
 *
 * @param {Object} d plain document JSON with ExtUserPtr (and CreatedBy) included.
 * @param {{myRole?: string}} [opts] the recipient's own role on it.
 */
export function receivedDocumentJson(d, { myRole } = {}) {
  const ext = d?.ExtUserPtr?.__type === 'Pointer' ? null : d?.ExtUserPtr;
  const user = d?.CreatedBy?.__type === 'Pointer' ? null : d?.CreatedBy;
  return {
    id: d?.objectId,
    title: d?.Name || '',
    sender: {
      name: d?.SenderName || ext?.Name || user?.name || '',
      company: ext?.Company || '',
      email: normaliseEmail(d?.SenderMail || ext?.Email || user?.email || ''),
    },
    sentAt: isoOf(d?.DocSentAt),
    expiresAt: isoOf(d?.ExpiryDate),
    myRole: myRole || undefined,
  };
}

/**
 * Send one event to the webhooks of a person who is not the document's owner
 * (today: `received`, to the recipient whose turn it now is). Same signing,
 * retries and transport as `emitDocumentEvent`, but the `document` in the
 * payload is `receivedDocumentJson`, never the owner's summary. Awaitable;
 * request paths call it from a background chain (requestMail.js
 * `announceReceived`).
 *
 * @param {string} event one of WEBHOOK_EVENTS
 * @param {string} userId the `_User` whose own webhooks receive it
 * @param {Object} docJson the document (plain JSON, ExtUserPtr included)
 * @param {{myRole?: string}} [extra] `myRole` goes on the document; anything
 *   else lands at the top level of the payload, as with `emitDocumentEvent`
 */
export async function emitUserEvent(event, userId, docJson, extra = {}) {
  if (!transport || !userId) return [];
  const rows = await hooksFor(userId, event);
  if (!rows.length) return [];
  const { myRole, ...rest } = extra || {};
  const payload = {
    id: randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    document: receivedDocumentJson(docJson, { myRole }),
    ...rest,
  };
  const results = [];
  for (const row of rows) results.push(await deliverOnce(row, payload));
  return results;
}

/** A ping to one webhook, to check the endpoint and the signature from the other side. */
export async function testWebhook(caller, webhookId) {
  await ensureWebhookSchema();
  const row = await new Parse.Query(WEBHOOK_CLASS)
    .get(String(webhookId || ''), { useMasterKey: true })
    .catch(() => null);
  if (!row || row.get('CreatedBy')?.id !== caller.userId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Webhook not found.');
  }
  const payload = {
    id: randomUUID(),
    event: 'ping',
    createdAt: new Date().toISOString(),
    document: null,
    message: 'Test delivery from register_webhook / test_webhook.',
  };
  return await deliverOnce(row, payload);
}
