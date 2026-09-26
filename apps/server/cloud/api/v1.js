import express from 'express';
import { describeAi } from '../ai/client.js';
import { ensureContact, listContacts } from '../lib/contacts.js';
import {
  createDocument,
  createDocumentFromTemplate,
  findByIdempotencyKey,
  getDocument,
  listDocuments,
  listTemplates,
  sendDocument,
  signingLinks,
} from '../lib/documents.js';
import {
  aiLayoutDraft,
  deleteDocument,
  duplicateDocument,
  getDraft,
  getDraftVersion,
  listDeletedDocuments,
  listDraftVersions,
  removeDraftFields,
  restoreDeletedDocument,
  restoreDraftVersion,
  reviewDraft,
  setDraftFields,
  snapshotDraft,
  undoDraftChange,
  updateDraft,
  updateDraftField,
} from '../lib/drafts.js';
import { bytesFromInput, uploadPdfBytes, uploadPdfBytesDetailed } from '../lib/files.js';
import { authenticateApiRequest } from '../mcp/route.js';
import { checkAiRateLimit } from '../parsefunction/aiFunctions.js';
import {
  analyzeFlow,
  bodyTooLarge,
  httpStatusFor,
  MAX_API_BODY,
  MAX_API_BODY_BYTES,
  pageInfoFor,
  pickCreateDocumentInput,
  quickSendFlow,
  remindDocument,
  requireAiEnabled,
  safeErrorMessage,
  withIdempotency,
} from './shared.js';

/**
 * REST API v1, token-authenticated (`Authorization: Bearer os_...`), mounted at
 * `/v1` (reached as `https://<host>/api/v1/...`). Thin wrappers over
 * the same library the MCP tools use; JSON in, JSON out.
 */

export const v1 = express.Router();

function route(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) res.json(data);
    } catch (err) {
      const status = httpStatusFor(err);
      if (status >= 500) console.log('api v1 error:', err);
      // Never hand a provider or internal message to a token holder (§G2-08).
      res.status(status).json({ error: safeErrorMessage(err), code: err?.code });
    }
  };
}

// A ceiling of our own on request bodies, checked before the token is looked up.
// The outer app parses JSON at 100 MB for the legacy endpoints; these routes
// need a 50 MB PDF (~67 MB base64) and nothing beyond that.
v1.use(express.json({ limit: MAX_API_BODY }));
v1.use((req, res, next) => {
  if (bodyTooLarge(req)) {
    return res.status(413).json({
      error: `Request body is too large: the API accepts up to ${Math.floor(MAX_API_BODY_BYTES / (1024 * 1024))} MB.`,
    });
  }
  next();
});

v1.use(async (req, res, next) => {
  try {
    const auth = await authenticateApiRequest(req);
    if (auth.error) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="docustamp"');
      return res.status(401).json({
        error:
          auth.error === 'missing_token'
            ? 'Missing API token. Send "Authorization: Bearer <token>"; create one under Settings > API & MCP.'
            : 'Invalid or revoked API token.',
      });
    }
    req.caller = auth.caller;
    next();
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: safeErrorMessage(err) });
  }
});

/** `Idempotency-Key: <string>` on the mutating routes; absent means "no replay". */
function idempotencyKey(req) {
  const header = req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key'];
  return typeof header === 'string' ? header : '';
}

v1.get(
  '/me',
  route(async req => ({
    name: req.caller.name,
    email: req.caller.email,
    company: req.caller.company || undefined,
    ai: describeAi(),
  }))
);

v1.post(
  '/files',
  route(async req => {
    const bytes = await bytesFromInput(req.body || {});
    // The detailed variant, so a PDF whose AcroForm could not be flattened is
    // reported instead of silently uploaded: its live form fields sit under the
    // signing widgets and capture the signer's clicks.
    const stored = await uploadPdfBytesDetailed(bytes, req.body?.fileName);
    return {
      url: stored.url,
      bytes: bytes.length,
      flattened: stored.flattened,
      ...(stored.flattened
        ? {}
        : {
            warnings: [
              `The existing form fields in this PDF could not be flattened (${stored.flattenError}); signers may see interactive fields under the signature boxes.`,
            ],
          }),
    };
  })
);

v1.post(
  '/documents/analyze',
  route(async req => await analyzeFlow(req.caller, req.body || {}))
);

v1.post(
  '/documents/quick-send',
  route(async req => {
    const key = idempotencyKey(req);
    return await withIdempotency(req.caller, 'quick-send', key, async () =>
      quickSendFlow(req.caller, { ...(req.body || {}), idempotencyKey: key }, 'api')
    );
  })
);

v1.post(
  '/documents',
  route(async req => {
    // Only the documented keys, so REST and the MCP twin accept the same input.
    const input = pickCreateDocumentInput(req.body || {});
    const key = idempotencyKey(req);
    return await withIdempotency(req.caller, 'create', key, async () => {
      // `withIdempotency` only remembers this process's own in-flight and recent
      // calls; the key is also stored on the document, so a retry after a
      // restart (or against another instance) replays the first document rather
      // than creating a second signable copy.
      const replayed = await findByIdempotencyKey(req.caller, key);
      if (replayed) return { ...replayed, mail: null, idempotentReplay: true };
      return await createDocument(req.caller, {
        ...input,
        idempotencyKey: key,
        pageInfo: await pageInfoFor({ ...input, pageCount: req.body?.pageCount }),
        origin: 'api',
      });
    });
  })
);

v1.get(
  '/documents',
  route(async req => ({
    documents: await listDocuments(req.caller, {
      status: req.query.status || 'all',
      search: req.query.search || '',
      limit: req.query.limit,
      skip: req.query.skip,
    }),
  }))
);

// Before `/documents/:id` so "deleted" is not taken for an id.
v1.get(
  '/documents/deleted',
  route(async req => ({
    documents: await listDeletedDocuments(req.caller, { limit: req.query.limit }),
  }))
);

v1.get(
  '/documents/:id',
  route(async req => await getDocument(req.caller, req.params.id, { links: true }))
);

v1.post(
  '/documents/:id/send',
  route(
    async req =>
      await sendDocument(req.caller, req.params.id, { resend: req.body?.resend === true })
  )
);

v1.get(
  '/documents/:id/signing-links',
  route(async req => ({ links: await signingLinks(req.caller, req.params.id) }))
);

v1.post(
  '/documents/:id/remind',
  route(async req => await remindDocument(req.caller, req.params.id))
);

/* ------------------------------------------------------------------ drafts */

v1.get(
  '/documents/:id/draft',
  route(
    async req =>
      await getDraft(req.caller, req.params.id, {
        pages: req.query.pages === 'true' || req.query.pages === '1',
      })
  )
);

v1.get(
  '/documents/:id/review',
  route(async req => await reviewDraft(req.caller, req.params.id))
);

v1.patch(
  '/documents/:id',
  route(async req => {
    const { fileBase64, fileName, ...rest } = req.body || {};
    const input = { ...rest };
    if (fileBase64)
      input.url = await uploadPdfBytes(await bytesFromInput({ fileBase64 }), fileName);
    return await updateDraft(req.caller, req.params.id, input, { origin: 'api' });
  })
);

/**
 * `fields` has to be an array, spelled exactly that way. In replace mode an
 * absent or misspelled value would otherwise be read as "clear the draft" and
 * silently delete every widget (§G2-23); the MCP twin requires an array too.
 */
function fieldsFrom(req) {
  const fields = req.body?.fields;
  if (!Array.isArray(fields)) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'Send {"fields": [...]} as a JSON array. Use an empty array to clear the draft.'
    );
  }
  return fields;
}

v1.put(
  '/documents/:id/fields',
  route(
    async req =>
      await setDraftFields(req.caller, req.params.id, fieldsFrom(req), {
        mode: 'replace',
        // `fieldsFrom` has already refused anything that is not an array, so an
        // explicit `[]` here really is "clear the draft" and not a dropped key.
        clearAll: true,
        origin: 'api',
      })
  )
);

v1.post(
  '/documents/:id/fields',
  route(
    async req =>
      await setDraftFields(req.caller, req.params.id, fieldsFrom(req), {
        mode: 'append',
        origin: 'api',
      })
  )
);

v1.patch(
  '/documents/:id/fields/:key',
  route(
    async req =>
      await updateDraftField(req.caller, req.params.id, req.params.key, req.body || {}, {
        origin: 'api',
      })
  )
);

v1.delete(
  '/documents/:id/fields',
  route(async req => {
    const q = req.query || {};
    const body = req.body || {};
    const selector = {
      keys: body.keys ?? (q.keys ? String(q.keys).split(',') : undefined),
      recipient: body.recipient ?? q.recipient,
      type: body.type ?? q.type,
      page: body.page ?? (q.page ? Number(q.page) : undefined),
      all: body.all === true || q.all === 'true',
    };
    return await removeDraftFields(req.caller, req.params.id, selector, { origin: 'api' });
  })
);

v1.delete(
  '/documents/:id/fields/:key',
  route(
    async req =>
      await removeDraftFields(
        req.caller,
        req.params.id,
        { keys: [req.params.key] },
        { origin: 'api' }
      )
  )
);

v1.post(
  '/documents/:id/ai-layout',
  route(async req => {
    requireAiEnabled();
    checkAiRateLimit(req.caller.userId);
    const { instructions, recipients, mode } = req.body || {};
    return await aiLayoutDraft(req.caller, req.params.id, {
      instructions,
      recipients,
      mode,
      origin: 'api',
    });
  })
);

v1.get(
  '/documents/:id/versions',
  route(async req => ({
    versions: await listDraftVersions(req.caller, req.params.id, { limit: req.query.limit }),
  }))
);

v1.post(
  '/documents/:id/versions',
  route(
    async req =>
      await snapshotDraft(req.caller, req.params.id, { label: req.body?.label, origin: 'api' })
  )
);

v1.get(
  '/documents/:id/versions/:version',
  route(async req => await getDraftVersion(req.caller, req.params.id, req.params.version))
);

v1.post(
  '/documents/:id/versions/:version/restore',
  route(
    async req =>
      await restoreDraftVersion(req.caller, req.params.id, req.params.version, { origin: 'api' })
  )
);

v1.post(
  '/documents/:id/undo',
  route(async req => await undoDraftChange(req.caller, req.params.id, { origin: 'api' }))
);

v1.post(
  '/documents/:id/duplicate',
  route(
    async req =>
      await duplicateDocument(req.caller, req.params.id, { name: req.body?.name, origin: 'api' })
  )
);

v1.delete(
  '/documents/:id',
  route(
    async req =>
      await deleteDocument(req.caller, req.params.id, {
        force: req.body?.force === true || req.query.force === 'true',
      })
  )
);

v1.post(
  '/documents/:id/restore',
  route(async req => await restoreDeletedDocument(req.caller, req.params.id))
);

v1.get(
  '/contacts',
  route(async req => ({
    contacts: await listContacts(req.caller, {
      search: req.query.search || '',
      limit: req.query.limit,
      skip: req.query.skip,
    }),
  }))
);

v1.post(
  '/contacts',
  route(async req => await ensureContact(req.caller, req.body || {}))
);

v1.get(
  '/templates',
  route(async req => ({
    templates: await listTemplates(req.caller, {
      search: req.query.search || '',
      limit: req.query.limit,
      skip: req.query.skip,
    }),
  }))
);

v1.post(
  '/templates/:id/documents',
  route(
    async req =>
      await createDocumentFromTemplate(req.caller, req.params.id, {
        ...(req.body || {}),
        origin: 'api',
      })
  )
);

v1.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));
