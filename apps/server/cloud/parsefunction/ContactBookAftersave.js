import { contactAcl, normaliseEmail, shadowUserFor } from '../lib/contacts.js';

/**
 * Give a freshly inserted `contracts_Contactbook` row its shadow `_User` and its
 * ACL.
 *
 * Most contacts are written through `savecontact`, `editcontact` or
 * `cloud/lib/contacts.ensureContact`, which already do both. This trigger is the
 * backstop for the rows that are not: a bulk import and any
 * direct class write.
 *
 * The owner grant used to depend on `request.user`, so a master-key insert (the
 * CSV import, the API and MCP paths, a migration) that already carried `UserId`
 * fell through the whole `if` and the row kept whatever ACL it was saved with,
 * which for a row saved with none means world readable and world writable. The
 * owner now comes from `CreatedBy` when there is no session, exactly as the
 * document and template triggers resolve theirs.
 */
async function ContactbookAftersave(request) {
  if (request.original) return;

  const object = request.object;
  // The owner of the address book: the caller when there is a session, and
  // otherwise the pointer the row was written with.
  const createdBy = object.get('CreatedBy');
  const ownerId = request.user?.id || createdBy?.id || createdBy?.objectId || '';

  const linked = object.get('UserId');
  if (linked) {
    const shadowId = linked.id || linked.objectId || '';
    const wanted = contactAcl(ownerId, shadowId);
    // Most rows arrive from a writer that already set exactly this ACL
    // (`ensureContact`, `savecontact`), so comparing first keeps contact
    // creation at one write instead of two.
    if (JSON.stringify(object.getACL()?.toJSON() || {}) !== JSON.stringify(wanted.toJSON())) {
      object.setACL(wanted);
      try {
        await object.save(null, { useMasterKey: true });
      } catch (err) {
        console.error(
          `ContactbookAftersave: could not set the ACL of contact ${object.id}`,
          err?.message || err
        );
      }
    }
    return;
  }

  const name = object.get('Name');
  // Lowercased and de-spaced through the one shared normaliser. Parse-server is
  // not started with convertEmailToLowercase, its uniqueness check is
  // case-insensitive but `logIn`, `setPasswordResetToken` and the signup
  // pre-check all match case-sensitively, so a row stored as "Bob@Acme.com"
  // produced an account that could never be signed into, signed up for or reset.
  // The contact row is corrected too, so the address it shows and the address
  // behind it are the same string.
  const email = normaliseEmail(object.get('Email'));
  const phone = object.get('Phone');
  if (!email) return;
  if (email !== object.get('Email')) object.set('Email', email);
  try {
    // `shadowUserFor` returns the existing `_User` for this address when there is
    // one, and otherwise creates it with a random password that is never stored
    // (it used to be the address itself). It handles USERNAME_TAKEN and
    // EMAIL_TAKEN and rethrows everything else.
    const user = await shadowUserFor(name, email, phone);
    if (user) {
      object.set('UserId', { __type: 'Pointer', className: '_User', objectId: user.id });
      object.setACL(contactAcl(ownerId, user.id));
    }
    await object.save(null, { useMasterKey: true });
  } catch (err) {
    // An afterSave cannot fail the write that already happened, so the loud log
    // is the only signal: a contact left without `UserId` is a signer who will
    // never be granted access to their own document.
    console.error(
      `ContactbookAftersave: could not attach a user to contact ${object.id}`,
      err?.message || err
    );
  }
}
export default ContactbookAftersave;
