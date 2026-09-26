/**
 * Who owns a document or template, and who may read it.
 *
 * Both questions used to be answered in several places at once. Ownership was
 * four copies of the same two-line predicate (`lib/documents.assertOwner`, the
 * REST and MCP remind handlers, `authGuard`'s own `isOwner`, `recreateDocument`)
 * and the participant ACL rebuild was two copies of the same forty lines, one in
 * `DocumentAftersave` and one in `TemplateAfterSave`, which had already drifted
 * apart: only the document copy had been made null-safe.
 *
 * This module has no imports on purpose. `lib/documents.js` reaches into
 * `parsefunction/GetTemplate.js`, which reaches back into `parsefunction/authGuard.js`,
 * so anything both of those need has to sit below all of them or the cycle comes
 * back.
 */

/**
 * True when `userId` is the account that created `docJson`.
 *
 * Both pointers count: `CreatedBy` is the `_User` and `ExtUserPtr.UserId` is the
 * same account reached through its `contracts_Users` profile. Rows written by
 * different entry points populate different ones, so a predicate that reads only
 * one of them refuses the real owner on documents created by the other path.
 *
 * @param {Object} docJson plain JSON of a contracts_Document / contracts_Template.
 * @param {string} userId `_User` objectId.
 * @returns {boolean}
 */
export function isDocumentOwner(docJson, userId) {
  if (!userId) return false;
  return (
    docJson?.CreatedBy?.objectId === userId || docJson?.ExtUserPtr?.UserId?.objectId === userId
  );
}

/**
 * A stable key of a row's signer pointers, for change detection in an afterSave.
 *
 * A master-key save (the MCP / REST draft tools, duplicate, linkcontacttodoc)
 * carries no `request.user`, so "rebuild when a user saved it" missed exactly the
 * writes that swap recipients: the row kept the previous signers' ACL and the
 * real signer was refused right after a successful OTP login.
 *
 * @param {Parse.Object} obj either side of a save.
 * @returns {string}
 */
export function signerIdsOf(obj) {
  const signers = obj?.get?.('Signers');
  if (!Array.isArray(signers)) return '';
  return signers
    .map(s => (typeof s?.id === 'string' ? s.id : s?.objectId || ''))
    .filter(Boolean)
    .sort()
    .join(',');
}

/** The `_User` who owns a row: `CreatedBy`, or the ext user's account. */
export function ownerUserIdOf(docJson) {
  return docJson?.CreatedBy?.objectId || docJson?.ExtUserPtr?.UserId?.objectId || '';
}

/**
 * The ACL a document or template should carry: owner read+write, every signer
 * with a linked `_User` read, nothing public.
 *
 * Signers get READ only. They need to open the row, but a signer (or anyone
 * holding a signer's shadow account) with WRITE could rewrite URL / SignedUrl /
 * IsCompleted / AuditTrail / Placeholders straight through the class REST API.
 * Every server-side write on a signer's behalf (signPdf, triggerevent,
 * declinedoc, linkcontacttodoc, saveplaceholders) uses the master key, so
 * nothing needs the grant.
 *
 * Both filters are load-bearing: a `Signers` array with a hole in it, or a
 * contact that has no `UserId` yet (`createBatchContact` imports rows without
 * one, and `ContactBookAftersave` only backfills on success), used to throw
 * inside the trigger's log-only catch, so the whole rebuild was skipped and the
 * row silently kept the previous permissions.
 *
 * @param {Object} res plain JSON of the row, with `Signers` included.
 * @returns {Parse.ACL}
 */
export function participantAcl(res) {
  const signers = Array.isArray(res?.Signers) ? res.Signers.filter(Boolean) : [];
  const userIds = signers.map(item => item?.UserId?.objectId).filter(Boolean);
  const owner = ownerUserIdOf(res);
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  if (owner) {
    acl.setReadAccess(owner, true);
    acl.setWriteAccess(owner, true);
  }
  for (const id of userIds) acl.setReadAccess(id, true);
  return acl;
}

/**
 * Rebuild the ACL of one `contracts_Document` / `contracts_Template` row.
 *
 * Called from both afterSave triggers. Nothing here ever saves the object that
 * came out of the query: both classes have an afterFind trigger that swaps URL /
 * SignedUrl / CertificateUrl for presigned links good for a couple of minutes,
 * so saving a queried object persists a credential-bearing, already-expiring url
 * as the canonical value. The id goes onto a bare object and only the ACL is
 * written.
 *
 * Never throws: an afterSave cannot fail the write that already happened, so a
 * failure is logged and the row keeps whatever it had.
 *
 * @param {'contracts_Document'|'contracts_Template'} className
 * @param {string} objId
 * @param {{includeSigners?: boolean}} [opts] `false` grants the owner only
 *   (a row with no signers), which is what `updateSelfDoc` used to do.
 */
export async function rebuildParticipantAcl(className, objId, { includeSigners = true } = {}) {
  if (!objId) return;
  try {
    const query = new Parse.Query(className);
    if (includeSigners) query.include('Signers');
    query.include('CreatedBy');
    query.include('ExtUserPtr.TenantId');
    const current = await query.get(objId, { useMasterKey: true });
    const res = JSON.parse(JSON.stringify(current));
    // Locked either way. Without an owner nobody but the master key can reach
    // it, which is the safe end of the trade: no ACL at all means world readable
    // and world writable.
    if (!ownerUserIdOf(res)) {
      console.log(`${className} ${objId} has no owner to build an ACL from`);
    }
    const update = new Parse.Object(className);
    update.id = objId;
    update.setACL(participantAcl(includeSigners ? res : { ...res, Signers: [] }));
    // Awaited: an unawaited save here made an ACL failure an unhandled rejection
    // and the row silently kept the wrong permissions.
    await update.save(null, { useMasterKey: true });
  } catch (err) {
    console.log(`could not save the ACL of ${className} ${objId}: `, err?.message || err);
  }
}
