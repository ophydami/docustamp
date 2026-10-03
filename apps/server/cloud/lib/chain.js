import { assertRecipientsAllowed } from './agentRules.js';
import { conditionalUpdate } from './atomic.js';
import { loadCaller } from './context.js';
import { createDocumentFromTemplate } from './documents.js';
import { configuredPublicOrigin } from './publicUrl.js';
import { PREFILL_ROLE } from './widgets.js';
import { emitInBackground } from './webhooks.js';

/**
 * Document chaining: when a document that carries a `Chain` column completes,
 * create a follow-up document from the chained template and send it.
 *
 * The trigger is the `wonCompletion` branch of `signPdf` (cloud/parsefunction/
 * pdf/PDF.js), which runs exactly once per document, so the follow-up cannot be
 * sent twice by a signature race. The run is fire-and-forget there: a follow-up
 * that cannot be sent must never cost the signer their signature. The outcome
 * (either way) is recorded on the completed document as `ChainResult` and
 * emitted as the `chained` webhook event; the follow-up itself points back with
 * `ChainedFrom` and goes out through the ordinary send path, so it mails,
 * reminds and webhooks like any other sent document.
 *
 * A chain an AI set up (`viaAgent`, see documents.normaliseChain) is checked
 * against the account's "only send to" rule when it fires, with the rules of
 * that moment, not the ones in force when it was set: a follow-up to an address
 * the AI may no longer send to is recorded as `blocked`, with the reason, and
 * nothing is created or sent. A chain a person set up is never limited.
 */

/**
 * The completed document's signers, in placeholder order, as recipients for the
 * follow-up. Used when the chain does not name recipients of its own.
 */
function inheritedRecipients(docJson) {
  const groups = (docJson?.Placeholders || []).filter(g => g?.Role !== PREFILL_ROLE);
  const out = [];
  for (const g of groups) {
    const contactId = g?.signerObjId || g?.signerPtr?.objectId || '';
    const contact = (docJson?.Signers || []).find(s => s?.objectId === contactId);
    const email = String(contact?.Email || g?.email || '').toLowerCase();
    if (!email) continue;
    out.push({
      name: contact?.Name || g?.Name || '',
      email,
      ...(contact?.Phone ? { phone: String(contact.Phone) } : {}),
    });
  }
  return out;
}

/**
 * A `Caller` for the document's owner, outside any request. The ext row is the
 * one the document was created under, so the follow-up lands in the same
 * tenant; `publicUrl` comes from the deployment config, exactly like the
 * reminder job's mails.
 */
async function ownerCaller(docJson) {
  const userId = docJson?.CreatedBy?.objectId;
  if (!userId) throw new Error('the completed document has no owner');
  const user = await new Parse.Query('_User').get(userId, { useMasterKey: true });
  const extId = docJson?.ExtUserPtr?.objectId;
  const extUser = extId
    ? await new Parse.Query('contracts_Users')
        .include(['TenantId', 'TeamIds'])
        .get(extId, { useMasterKey: true })
        .catch(() => null)
    : null;
  return await loadCaller(user, {
    extUser: extUser || undefined,
    publicUrl: configuredPublicOrigin(),
  });
}

/**
 * Create and send the follow-up for one completed document. Awaitable (tests);
 * the signing path uses `runChainInBackground`.
 *
 * @param {Object} docJson the completed document, plain JSON with Placeholders,
 *   Signers, CreatedBy and ExtUserPtr (the shape `signPdf` already holds).
 * @returns {Promise<Object|null>} the recorded ChainResult, or null when the
 *   document has no chain. `status` is 'sent', 'failed', or 'blocked' (an AI's
 *   chain to an address the account's rules do not let it send to).
 */
export async function runChainOnComplete(docJson) {
  const chain = docJson?.Chain;
  if (!chain?.templateId) return null;
  const at = new Date().toISOString();
  let result;
  try {
    const caller = await ownerCaller(docJson);
    const recipients = chain.recipients?.length ? chain.recipients : inheritedRecipients(docJson);
    if (!recipients.length) {
      throw new Error('the completed document has no signers to carry over to the follow-up');
    }
    const blocked = chain.viaAgent === true ? await rulesBlock(caller, recipients) : '';
    if (blocked) {
      result = { status: 'blocked', error: blocked, at };
    } else {
      const created = await createDocumentFromTemplate(caller, chain.templateId, {
        recipients,
        name: chain.name,
        note: chain.note,
        message: chain.message,
        send: true,
        origin: 'chain',
        chainedFrom: docJson.objectId,
      });
      result = { status: 'sent', documentId: created.objectId, at };
    }
  } catch (err) {
    console.error(
      `chain: the follow-up for ${docJson?.objectId} could not be sent:`,
      err?.message
    );
    result = { status: 'failed', error: String(err?.message || err).slice(0, 500), at };
  }
  try {
    // Trigger-free on purpose, like every other post-completion write: the
    // afterSave pipeline (versions, reminders) has no business running for a
    // status stamp on a completed document.
    await conditionalUpdate('contracts_Document', docJson.objectId, {}, { ChainResult: result });
  } catch (err) {
    console.log('chain: could not record the chain result', err?.message);
  }
  emitInBackground('chained', docJson, { chain: result });
  return result;
}

/**
 * Why the account's rules stop an AI's chain from mailing these recipients, or
 * '' when they do not. Checked as the AI that set the chain up would be (the
 * owner, as a token caller), with the rules in force now.
 */
async function rulesBlock(caller, recipients) {
  try {
    await assertRecipientsAllowed(
      { ...caller, viaToken: true },
      recipients.map(r => r.email)
    );
    return '';
  } catch (err) {
    if (err?.code !== Parse.Error.OPERATION_FORBIDDEN) throw err;
    return String(err.message || err).slice(0, 500);
  }
}

/** Fire and forget: a chain failure never reaches the signer's response. */
export function runChainInBackground(docJson) {
  Promise.resolve()
    .then(() => runChainOnComplete(docJson))
    .catch(err => console.log('chain: run failed', err?.message || err));
}
