import crypto from 'node:crypto';
import { EMAIL_RE, normaliseEmail } from './email.js';
import { userPointer } from './context.js';

/**
 * Contact book access for API callers. Mirrors `savecontact` (shadow `_User`,
 * ACL for owner + contact) but runs with the master key on behalf of a
 * `Caller`, since API and MCP requests carry no session.
 */

// Re-exported so `lib/documents.js` and the contact writers keep one import
// site; the definition lives in `lib/email.js`.
export { normaliseEmail };

/** Longest search term any list endpoint will compile into a regular expression. */
export const MAX_SEARCH_LENGTH = 80;

/** Every character that means something to a regular expression, made literal. */
export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A caller's search string, ready for `Parse.Query.matches`.
 *
 * `matches` compiles the string as a regular expression inside the database, so
 * an unescaped term is both a way to search for things the caller never meant
 * and a way to burn database CPU with a backtracking pattern such as `(a+)+$`.
 * The term is trimmed, capped and made literal.
 *
 * @param {string} value raw search input.
 * @returns {string} an escaped pattern, or '' when there is nothing to search for.
 */
export function searchPattern(value) {
  const term = String(value ?? '')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
  return term ? escapeRegExp(term) : '';
}

export function assertEmail(email, label = 'email') {
  if (!EMAIL_RE.test(email || '')) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Invalid ${label}: "${email || ''}".`);
  }
}

export function contactJson(obj) {
  const c = obj?.toJSON ? obj.toJSON() : obj || {};
  return {
    objectId: c.objectId,
    name: c.Name || '',
    email: (c.Email || '').toLowerCase(),
    phone: c.Phone || undefined,
    company: c.Company || undefined,
    jobTitle: c.JobTitle || undefined,
    createdAt: c.createdAt,
  };
}

export async function findContactByEmail(caller, email) {
  const query = new Parse.Query('contracts_Contactbook');
  query.equalTo('CreatedBy', userPointer(caller));
  query.notEqualTo('IsDeleted', true);
  query.equalTo('Email', normaliseEmail(email));
  // Deterministic: if duplicates exist, every caller resolves to the same row.
  query.ascending('createdAt');
  return await query.first({ useMasterKey: true });
}

/**
 * The password a contact's shadow `_User` gets.
 *
 * It used to be the contact's own email address, which meant anyone who knew a
 * signer's address could log in as them (an unthrottled
 * `Parse.User.logIn`), read every document that signer had been sent, and claim
 * the account through `sessionForExistingUser`. These accounts never have a
 * password typed into them: they get sessions from signing links, from the OTP
 * flow, or through `loginAs`. So the value is 256 bits from the CSPRNG that is
 * never stored anywhere else, never returned and never mailed - effectively a
 * password nobody, including us, can present.
 *
 * @returns {string}
 */
export function randomShadowPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Find or create the `_User` behind a contact. Shared with `savecontact`,
 * `editContact` and the `contracts_Contactbook` afterSave trigger so the
 * password rule lives in exactly one place.
 *
 * @param {string} name
 * @param {string} email lowercased address, also used as the username
 * @param {string} [phone]
 * @returns {Promise<Parse.User>}
 */
export async function shadowUserFor(name, email, phone) {
  const query = new Parse.Query(Parse.User);
  query.equalTo('username', email);
  const existing = await query.first({ useMasterKey: true });
  if (existing) return existing;
  const user = new Parse.User();
  user.set('name', name);
  user.set('username', email);
  user.set('email', email);
  user.set('password', randomShadowPassword());
  if (phone) user.set('phone', phone);
  try {
    return await user.save(null, { useMasterKey: true });
  } catch (err) {
    if (err?.code === Parse.Error.USERNAME_TAKEN || err?.code === Parse.Error.EMAIL_TAKEN) {
      const again = await new Parse.Query(Parse.User)
        .equalTo('username', email)
        .first({ useMasterKey: true });
      if (again) return again;
    }
    throw err;
  }
}

/**
 * The ACL every contact row gets: the owner and the contact's own shadow user,
 * both read and write, nothing public.
 *
 * The contact is the signer's record of themselves as well as the owner's, which
 * is why the shadow user gets write: `editcontact` and the signer's own profile
 * edits go through it. Four copies of these six lines used to exist
 * (`ensureContact`, `savecontact`, `editcontact` and the afterSave trigger) and
 * they had already drifted on whether the owner was granted at all.
 *
 * @param {string} ownerUserId the `_User` who owns the address book.
 * @param {string} shadowUserId the `_User` behind the contact.
 * @returns {Parse.ACL}
 */
export function contactAcl(ownerUserId, shadowUserId) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  for (const id of [ownerUserId, shadowUserId]) {
    if (!id) continue;
    acl.setReadAccess(id, true);
    acl.setWriteAccess(id, true);
  }
  return acl;
}

/**
 * The oldest live contact for an address, and how many rows share it.
 *
 * `ensureContact` is a check-then-create, so two overlapping calls (a retried
 * `update_draft`, two recipients added at once) can both decide the contact does
 * not exist yet. Resolving to the oldest row every time is what keeps
 * `Signers[i]` and `Placeholders[i].signerObjId` pointing at the same contact
 * when that happens.
 */
async function liveContactsFor(caller, email) {
  const query = new Parse.Query('contracts_Contactbook');
  query.equalTo('CreatedBy', userPointer(caller));
  query.notEqualTo('IsDeleted', true);
  query.equalTo('Email', normaliseEmail(email));
  query.ascending('createdAt');
  query.limit(20);
  return await query.find({ useMasterKey: true });
}

/**
 * Find or create a contact for the caller.
 *
 * A row created by a concurrent call is reconciled rather than left as a
 * duplicate: the oldest row wins and the loser is marked deleted, so the pointer
 * every document stores is stable. The duplicate-key path is handled too, for
 * the day the unique index on (CreatedBy, Email) exists.
 *
 * @returns {Promise<{objectId: string, name: string, email: string, created: boolean}>}
 */
export async function ensureContact(caller, input) {
  const email = normaliseEmail(input?.email);
  assertEmail(email);
  const name = String(input?.name || '').trim() || email.split('@')[0];
  const existing = await findContactByEmail(caller, email);
  if (existing) return { ...contactJson(existing), created: false };

  const shadow = await shadowUserFor(name, email, input?.phone);
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', name);
  contact.set('Email', email);
  contact.set('UserRole', 'contracts_Guest');
  contact.set('IsDeleted', false);
  if (input?.phone) contact.set('Phone', String(input.phone));
  if (input?.company) contact.set('Company', String(input.company));
  if (input?.jobTitle) contact.set('JobTitle', String(input.jobTitle));
  if (caller.tenantId) {
    contact.set('TenantId', {
      __type: 'Pointer',
      className: 'partners_Tenant',
      objectId: caller.tenantId,
    });
  }
  contact.set('CreatedBy', userPointer(caller));
  contact.set('UserId', { __type: 'Pointer', className: '_User', objectId: shadow.id });
  contact.setACL(contactAcl(caller.userId, shadow.id));
  let saved;
  try {
    saved = await contact.save(null, { useMasterKey: true });
  } catch (err) {
    // A unique index on (CreatedBy, Email) rejects the loser of a race; the
    // winner's row is the answer, exactly like shadowUserFor does for a taken
    // username.
    if (err?.code === Parse.Error.DUPLICATE_VALUE) {
      const again = await findContactByEmail(caller, email);
      if (again) return { ...contactJson(again), created: false };
    }
    throw err;
  }
  // No index yet: reconcile by hand so both callers end up on the same row.
  const rows = await liveContactsFor(caller, email);
  const winner = rows[0];
  if (winner && winner.id !== saved.id) {
    const loser = new Parse.Object('contracts_Contactbook');
    loser.id = saved.id;
    loser.set('IsDeleted', true);
    try {
      await loser.save(null, { useMasterKey: true });
    } catch (err) {
      console.log('contacts: could not retire a duplicate contact', err?.message);
    }
    return { ...contactJson(winner), created: false };
  }
  return { ...contactJson(saved), created: true };
}

export async function listContacts(caller, { search = '', limit = 50, skip = 0 } = {}) {
  const query = new Parse.Query('contracts_Contactbook');
  query.equalTo('CreatedBy', userPointer(caller));
  query.notEqualTo('IsDeleted', true);
  const term = searchPattern(search);
  if (term) {
    const byName = new Parse.Query('contracts_Contactbook').matches('Name', term, 'i');
    const byEmail = new Parse.Query('contracts_Contactbook').matches('Email', term, 'i');
    const or = Parse.Query.or(byName, byEmail);
    or.equalTo('CreatedBy', userPointer(caller));
    or.notEqualTo('IsDeleted', true);
    or.limit(Math.min(Math.max(1, Number(limit) || 50), 200));
    or.skip(Math.max(0, Number(skip) || 0));
    or.descending('createdAt');
    const rows = await or.find({ useMasterKey: true });
    return rows.map(contactJson);
  }
  query.limit(Math.min(Math.max(1, Number(limit) || 50), 200));
  query.skip(Math.max(0, Number(skip) || 0));
  query.descending('createdAt');
  const rows = await query.find({ useMasterKey: true });
  return rows.map(contactJson);
}

/**
 * Change a contact's details. Only the keys given change; the email stays unless
 * a new one is given. Goes through the same path as the web app's edit
 * (`editcontact`), which re-links the shadow user on an address change.
 */
export async function updateContact(caller, contactId, changes = {}) {
  const { default: editContact } = await import('../parsefunction/editContact.js');
  const row = await new Parse.Query('contracts_Contactbook')
    .get(String(contactId || ''), { useMasterKey: true })
    .catch(() => null);
  const owner = row?.get('CreatedBy')?.id;
  if (!row || row.get('IsDeleted') === true || owner !== caller.userId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Contact not found.');
  }
  const params = {
    contactId: row.id,
    email: changes.email !== undefined ? changes.email : row.get('Email'),
    name: changes.name !== undefined ? changes.name : row.get('Name'),
  };
  for (const key of ['phone', 'company', 'jobTitle']) {
    if (changes[key] !== undefined) params[key] = changes[key] === null ? '' : String(changes[key]);
  }
  await editContact({ params, user: caller.user, headers: {} });
  const fresh = await new Parse.Query('contracts_Contactbook').get(row.id, { useMasterKey: true });
  return { ...contactJson(fresh), updated: true };
}

/**
 * Soft-delete a contact (the web app's delete: `IsDeleted: true`). Documents
 * that already name the contact keep working; the address just stops being
 * offered, and `add_contact` with the same email creates a fresh row.
 */
export async function deleteContact(caller, contactId) {
  const row = await new Parse.Query('contracts_Contactbook')
    .get(String(contactId || ''), { useMasterKey: true })
    .catch(() => null);
  const owner = row?.get('CreatedBy')?.id;
  if (!row || owner !== caller.userId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Contact not found.');
  }
  if (row.get('IsDeleted') === true) {
    return { ...contactJson(row), deleted: true, alreadyDeleted: true };
  }
  row.set('IsDeleted', true);
  await row.save(null, { useMasterKey: true });
  return { ...contactJson(row), deleted: true };
}
