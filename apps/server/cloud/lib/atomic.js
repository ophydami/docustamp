/**
 * Compare-and-set writes for the document flows.
 *
 * Declining, completing and placeholder binding all used to be
 * read-then-write-the-whole-thing: the caller loaded a document, decided
 * something from that snapshot, and saved fields (or whole arrays) built from
 * it. Two requests that overlapped both "won":
 *  - two last signers both flipped `IsCompleted` and both mailed a certificate,
 *  - a decline landing during a signature produced a document that was declined
 *    *and* completed,
 *  - two `AuditTrail` writes from the same second silently dropped one entry,
 *  - two `linkcontacttodoc` calls rewrote `Placeholders`/`Signers` from stale
 *    snapshots and clobbered each other.
 *
 * The primitive here is a query-scoped update through the parse-server
 * `DatabaseController`: the row is only written when it still matches `where`,
 * so "is this document still undeclared?" and "write the decline" happen in one
 * atomic step. `false` means the row moved under us (someone else got there
 * first, or the version we read is stale) and the caller decides what to do.
 *
 * These writes deliberately bypass Parse triggers: they are the last step of a
 * flow that has already done its validation, and the afterSave/afterFind pair on
 * contracts_Document is exactly what makes the read-modify-write dance unsafe
 * (afterFind swaps in presigned urls that must never be written back). Callers
 * that need trigger side effects have to do them explicitly.
 */

const DOC_CLASS = 'contracts_Document';

/** How many times an optimistic writer should re-read and retry before giving up. */
export const MAX_WRITE_ATTEMPTS = 3;

function database() {
  const db = Parse?.Server?.database;
  if (!db || typeof db.update !== 'function') {
    throw new Parse.Error(
      Parse.Error.OTHER_CAUSE,
      'The database controller is not available for conditional writes.'
    );
  }
  return db;
}

/** REST-encode a field map: Date -> {__type:'Date'}, Parse.Object -> pointer, etc. */
function encodeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    out[key] = value === null ? null : Parse._encode(value);
  }
  return out;
}

/** An `updatedAt` the query layer understands (it accepts a Date or an iso string). */
function versionValue(seenUpdatedAt) {
  if (seenUpdatedAt instanceof Date) return seenUpdatedAt.toISOString();
  if (typeof seenUpdatedAt === 'string' && seenUpdatedAt) return seenUpdatedAt;
  if (seenUpdatedAt?.iso) return seenUpdatedAt.iso;
  return '';
}

/**
 * Read one row straight from the database, with no ACL and no triggers.
 *
 * Used as the "immediately before the write" re-read: a normal Parse query runs
 * the afterFind trigger, which presigns SignedUrl/URL/CertificateUrl and rewrites
 * prefill images, none of which may be persisted.
 *
 * @param {string} className Parse class.
 * @param {string} objectId row id.
 * @param {string[]} [keys] optional projection.
 * @returns {Promise<Object|null>} REST-format object (`updatedAt` is an iso string) or null.
 */
export async function readFresh(className, objectId, keys) {
  if (!objectId) return null;
  const options = { limit: 1 };
  if (Array.isArray(keys) && keys.length > 0) options.keys = keys;
  const rows = await database().find(className, { objectId }, options);
  return rows?.[0] || null;
}

/**
 * Update a row only while it still matches `where`.
 *
 * @param {string} className Parse class.
 * @param {string} objectId row id.
 * @param {Object} where extra REST-format conditions, ANDed with the objectId.
 * @param {Object} fields fields to write (plain values; Dates and pointers are fine).
 * @returns {Promise<boolean>} true when exactly that row was updated, false when it no longer matched.
 */
export async function conditionalUpdate(className, objectId, where = {}, fields = {}) {
  if (!objectId) return false;
  const db = database();
  // `updatedAt` is bumped by hand: RestWrite normally does it, and a row that
  // silently keeps its old `updatedAt` would break every optimistic reader.
  // Always strictly after the version the caller saw, even when the read and
  // the write land in the same millisecond, so a stale snapshot can never match.
  const seen = where?.updatedAt ? new Date(where.updatedAt).getTime() : 0;
  const stamp = new Date(Math.max(Date.now(), Number.isFinite(seen) ? seen + 1 : 0));
  const payload = encodeFields({ ...fields, updatedAt: stamp });
  const query = { ...where, objectId };
  // Teaches the schema about any field this class has never stored before;
  // without it a raw pointer write lands in a column the schema calls untyped
  // and comes back empty on the next read.
  await db.validateObject(className, payload, query, {}, false);
  try {
    await db.update(className, query, payload, {}, false);
    return true;
  } catch (err) {
    if (err?.code === Parse.Error.OBJECT_NOT_FOUND) return false;
    throw err;
  }
}

/**
 * Optimistic lock: write only if the row has not changed since it was read.
 *
 * @param {string} className Parse class.
 * @param {string} objectId row id.
 * @param {string|Date} seenUpdatedAt the `updatedAt` of the snapshot the caller worked from.
 * @param {Object} fields fields to write.
 * @returns {Promise<boolean>} false when someone else wrote first; re-read and retry.
 */
export async function updateWithVersion(className, objectId, seenUpdatedAt, fields = {}) {
  const version = versionValue(seenUpdatedAt);
  if (!version) {
    throw new Parse.Error(
      Parse.Error.OTHER_CAUSE,
      'A conditional update needs the updatedAt of the row that was read.'
    );
  }
  return conditionalUpdate(className, objectId, { updatedAt: version }, fields);
}

/**
 * Flip a document to declined, but only from a state that may still decline.
 *
 * @param {string} docId document id.
 * @param {Object} [fields] extra fields (DeclineReason, DeclineBy, ...).
 * @param {{seenUpdatedAt?: string|Date}} [opts] adds an optimistic-lock condition.
 * @returns {Promise<boolean>} false when the document was already declined or completed.
 */
export async function tryMarkDeclined(docId, fields = {}, opts = {}) {
  const where = { IsDeclined: { $ne: true }, IsCompleted: { $ne: true } };
  const version = versionValue(opts.seenUpdatedAt);
  if (version) where.updatedAt = version;
  return conditionalUpdate(DOC_CLASS, docId, where, { IsDeclined: true, ...fields });
}

/**
 * Flip a document to completed, but only from a state that may still complete.
 *
 * Exactly one concurrent request gets `true`, which is what makes "generate the
 * certificate and mail everyone" a once-per-document job.
 *
 * @param {string} docId document id.
 * @param {Object} [fields] the rest of the completing write (SignedUrl, AuditTrail, ...).
 * @param {{seenUpdatedAt?: string|Date}} [opts] adds an optimistic-lock condition.
 * @returns {Promise<boolean>} false when the document was already completed or was declined.
 */
export async function tryMarkCompleted(docId, fields = {}, opts = {}) {
  const where = { IsCompleted: { $ne: true }, IsDeclined: { $ne: true } };
  const version = versionValue(opts.seenUpdatedAt);
  if (version) where.updatedAt = version;
  return conditionalUpdate(DOC_CLASS, docId, where, { IsCompleted: true, ...fields });
}
