import crypto from 'node:crypto';
import { generateId } from '../../../Utils.js';
import {
  deleteContactsInBatch,
  deleteDataFiles,
  deleteDocumentDependents,
  deleteFileUrls,
  deleteInBatches,
  deleteScopedRows,
} from './deleteFileUrl.js';
import { MAX_ATTEMPTS } from './deleteUtils.js';
import { authoriseDeletionRequest, clearDeletionState } from '../../lib/deletionToken.js';
import { revokeOAuthGrantsForUser } from '../../lib/oauth.js';
import { hashOtp } from '../../lib/otp.js';
import { extUserForUser, resolveCaller } from '../../parsefunction/authGuard.js';

/** Fields on `contracts_Signature` that hold a stored image. */
const SIGNATURE_FILE_FIELDS = ['ImageURL', 'Initials', 'Stamp'];

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** @returns {Promise<number>} stored files removed with the account */
const deleteSessionsAndUser = async (userPointer, userId) => {
  const Session = Parse.Object.extend('_Session');
  const sessionQuery = new Parse.Query(Session);
  sessionQuery.equalTo('user', userPointer);
  const sessions = await sessionQuery.find({ useMasterKey: true });
  if (sessions?.length > 0) await Parse.Object.destroyAll(sessions, { useMasterKey: true });

  const userObj = await new Parse.Query(Parse.User).get(userId, { useMasterKey: true });
  if (!userObj) return 0;
  // Read the avatar before the row goes: nothing points at the file afterwards.
  const filesDeleted = await deleteFileUrls([userObj.get('ProfilePic')]);
  await userObj.destroy({ useMasterKey: true });
  return filesDeleted;
};

/**
 * Anonymise a `_User` row that cannot be destroyed because other people's
 * `contracts_Contactbook` rows still point at it.
 *
 * Scrambling the password was not enough: the row kept the person's real
 * username and email, so "forgot password" (they own the mailbox) resurrected
 * an account the product had told them was deleted. The identity is replaced
 * with a tombstone, the account is marked disabled, and every session goes.
 *
 * @param {string} userId `_User` objectId.
 * @returns {Promise<number>} stored files removed with the account.
 */
const anonymiseUser = async userId => {
  const user = await new Parse.Query(Parse.User).get(userId, { useMasterKey: true });
  if (!user) return 0;
  const filesDeleted = await deleteFileUrls([user.get('ProfilePic')]);
  const tombstone = `deleted-${generateId(16)}@deleted.invalid`;
  user.set('password', generateId(32));
  user.set('username', tombstone);
  user.set('email', tombstone);
  user.set('emailVerified', false);
  user.set('IsDisabled', true);
  user.set('AccountDeletedAt', new Date());
  user.unset('ProfilePic');
  user.unset('name');
  user.unset('phone');
  user.unset('authData');
  await user.save(null, { useMasterKey: true });

  // Revoke all existing sessions (forces logout everywhere)
  const sessionQuery = new Parse.Query('_Session');
  sessionQuery.equalTo('user', user);
  const sessions = await sessionQuery.find({ useMasterKey: true });
  if (sessions.length) {
    await Parse.Object.destroyAll(sessions, { useMasterKey: true });
  }
  return filesDeleted;
};
export async function deleteUser(userId, adminId, adminTenantId, isOrgAdmin, orgPtr) {
  const userPointer = { __type: 'Pointer', className: '_User', objectId: userId };
  try {
    // STEP 1: contracts_Users lookup
    const Users = Parse.Object.extend('contracts_Users');
    const userQuery = new Parse.Query(Users);
    userQuery.equalTo('UserId', userPointer);
    if (adminTenantId) {
      userQuery.equalTo('TenantId', adminTenantId);
      if (isOrgAdmin && orgPtr) {
        userQuery.equalTo('OrganizationId', orgPtr);
      }
    } else if (adminId) {
      userQuery.equalTo('CreatedBy', { __type: 'Pointer', className: '_User', objectId: adminId });
    }
    const userResult = await userQuery.first({ useMasterKey: true });
    if (!userResult) {
      const errorMessage = isOrgAdmin ? 'Unauthorized.' : 'User not found.';
      return { code: 400, message: errorMessage };
    }
    const tenantId = userResult.get('TenantId')?.id;
    const teamIds = userResult.get('TeamIds') || [];
    const organizationId = userResult.get('OrganizationId')?.id;
    const isAdmin = userResult?.get('UserRole') === 'contracts_Admin' ? true : false;
    if (isOrgAdmin && isAdmin) {
      const errorMessage = 'Unauthorized.';
      return { code: 400, message: errorMessage };
    }
    if (adminId && isAdmin) {
      const errorMessage = 'An error occurred while deleting your account.';
      return { code: 400, message: errorMessage };
    }

    // Everything below is scoped to THIS membership, never to the bare `_User`.
    // `userResult` is the `contracts_Users` row the caller was authorised
    // against (their own tenant), and documents/templates point at it through
    // `ExtUserPtr`, so it is the tenant boundary.
    const extUserPointer = {
      __type: 'Pointer',
      className: 'contracts_Users',
      objectId: userResult.id,
    };
    const tenantPtr = tenantId
      ? { __type: 'Pointer', className: 'partners_Tenant', objectId: tenantId }
      : null;

    // Stored images (avatars, signatures) are deleted alongside their rows;
    // a storage failure is logged and counted, never fatal.
    let filesDeleted = 0;

    // A `_User` can hold memberships in several tenants. The admin asking for
    // this delete only has authority over their own, so a shared account keeps
    // its login, its sessions and its other workspaces: we remove this
    // membership plus the data it owns here and report 409 (see the return
    // below) so the caller knows the account itself was not deleted.
    const membershipQuery = new Parse.Query(Users);
    membershipQuery.equalTo('UserId', userPointer);
    const membershipCount = await membershipQuery.count({ useMasterKey: true });
    const isMultiTenant = membershipCount > 1;

    // STEP 1b: what hangs off this membership's documents (their draft history
    // and the requests to sign them), while the documents still lead to it,
    // plus the requests to sign that this membership's own agent made.
    try {
      await deleteDocumentDependents(extUserPointer);
      await deleteScopedRows('contracts_SignApproval', { extUserPtr: extUserPointer });
    } catch (err) {
      console.error('Failed during draft history and approval cleanup:', err);
      const errorMessage = 'Failed during draft history and approval cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 2: contracts_Document & contracts_Template
    try {
      for (const className of ['contracts_Document', 'contracts_Template']) {
        await deleteInBatches(className, { extUserPtr: extUserPointer });
      }
    } catch (err) {
      console.error('Failed during contracts_Template cleanup:', err);
      const errorMessage = 'Failed during contracts_Template cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 3: delete Contacts created by user from contactbook class
    try {
      await deleteContactsInBatch('contracts_Contactbook', {
        createdBy: userPointer,
        tenantPtr,
      });
    } catch (err) {
      console.error('Failed during contactbook cleanup:', err);
      const errorMessage = 'Failed during contactbook cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 4: appToken
    try {
      // Account-level, not tenant-level: only safe to revoke when this was the
      // account's last membership.
      if (!isMultiTenant) {
        const AppToken = Parse.Object.extend('appToken');
        const query = new Parse.Query(AppToken);
        query.equalTo('UserId', userPointer);
        const tokens = await query.find({ useMasterKey: true });
        if (tokens?.length) await Parse.Object.destroyAll(tokens, { useMasterKey: true });
      }
    } catch (err) {
      console.error('Failed to delete appToken entries:', err);
      const errorMessage = 'Failed to delete appToken entries:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 4b: connected apps (OAuth grants) and webhooks. Both belong to the
    // `_User`, not to one tenant, so like the app tokens they only go with the
    // account's last membership. A connected app used to keep working against
    // whatever was left, and a webhook kept its url and secret. The personal API
    // token lives on the `contracts_Users` row and goes with it (STEP 11).
    try {
      if (!isMultiTenant) {
        const { revoked } = await revokeOAuthGrantsForUser(userId);
        const webhooks = await deleteScopedRows('contracts_Webhook', { createdBy: userPointer });
        console.log(`Revoked ${revoked} connected apps and deleted ${webhooks} webhooks`);
      }
    } catch (err) {
      console.error('Failed during connected app and webhook cleanup:', err);
      const errorMessage = 'Failed during connected app and webhook cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 5: partner_DataFiles
    try {
      await deleteDataFiles('partners_DataFiles', {
        userId: userPointer,
        tenantPtr,
        tenantField: 'TenantPtr',
      });
    } catch (err) {
      console.error('Failed during partners_DataFiles cleanup:', err);
      const errorMessage = 'Failed during partners_DataFiles cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    if (isAdmin) {
      // STEP 6: contracts_Organizations
      try {
        if (organizationId) {
          const Org = Parse.Object.extend('contracts_Organizations');
          const query = new Parse.Query(Org);
          const object = await query.get(organizationId, { useMasterKey: true });
          await object.destroy({ useMasterKey: true });
        }
      } catch (err) {
        console.error('Failed to delete contracts_Organizations entry:', err);
        const errorMessage = 'Failed to delete contracts_Organizations entry:' + err?.message;
        return { code: 400, message: errorMessage };
      }
      // STEP 7: Delete each entry in contracts_Teams by objectId from teamIds
      try {
        if (teamIds.length > 0) {
          const Teams = Parse.Object.extend('contracts_Teams');
          for (const team of teamIds) {
            try {
              const teamObj = await new Parse.Query(Teams).get(team.id, { useMasterKey: true });
              if (teamObj) await teamObj.destroy({ useMasterKey: true });
            } catch (teamErr) {
              console.error(`Failed to delete team with ID ${team.id}:`, teamErr);
              const errorMessage = `Failed to delete team with ID ${team.id}` + teamErr?.message;
              return { code: 400, message: errorMessage };
            }
          }
        }
      } catch (err) {
        console.error('Failed during contracts_Teams deletion loop:', err);
        const errorMessage = 'Failed during contracts_Teams deletion loop:' + err?.message;
        return { code: 400, message: errorMessage };
      }

      // STEP 8 : partners_Tenant cleanup
      try {
        if (tenantId) {
          const Tenant = Parse.Object.extend('partners_Tenant');
          const query = new Parse.Query(Tenant);
          const tenantObj = await query.get(tenantId, { useMasterKey: true });
          await tenantObj.destroy({ useMasterKey: true });
        }
      } catch (err) {
        const msg = `Failed during partners_Tenant ${'cleanup:'} `;
        console.error(msg, err);
        const errorMessage = msg + err?.message;
        return { code: 400, message: errorMessage };
      }

      // STEP 9: partners_TenantCredits cleanup
      try {
        if (tenantId) {
          const tenantCredits = Parse.Object.extend('partners_TenantCredits');
          const subsByTenant = new Parse.Query(tenantCredits);
          subsByTenant.equalTo('PartnersTenant', {
            __type: 'Pointer',
            className: 'partners_Tenant',
            objectId: tenantId,
          });
          const subs = await subsByTenant.find({ useMasterKey: true });
          await Parse.Object.destroyAll(subs, { useMasterKey: true });
        }
      } catch (err) {
        console.error('Failed during partners_TenantCredits cleanup:', err);
        const errorMessage = 'Failed during partners_TenantCredits cleanup:' + err?.message;
        return { code: 400, message: errorMessage };
      }
    }
    // STEP 10: contracts_Signature (rows *and* the images they point at)
    try {
      // Saved signatures belong to the account, not to one tenant.
      if (!isMultiTenant) {
        const Signature = Parse.Object.extend('contracts_Signature');
        const sigQuery = new Parse.Query(Signature);
        sigQuery.equalTo('UserId', userPointer);
        const sigResults = await sigQuery.find({ useMasterKey: true });
        if (sigResults?.length > 0) {
          // Destroying the rows used to orphan every signature, initials and
          // stamp image in storage; collect the URLs first.
          const urls = [];
          for (const row of sigResults) {
            for (const field of SIGNATURE_FILE_FIELDS) urls.push(row.get(field));
          }
          filesDeleted += await deleteFileUrls(urls);
          await Parse.Object.destroyAll(sigResults, { useMasterKey: true });
        }
      }
    } catch (err) {
      console.error('Failed during contracts_Signature cleanup:', err);
      const errorMessage = 'Failed during contracts_Signature cleanup:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 11: contracts_Users
    try {
      await userResult.destroy({ useMasterKey: true });
    } catch (err) {
      console.error('Failed to delete contracts_Users entry:', err);
      const errorMessage = 'Failed to delete contracts_Users entry:' + err?.message;
      return { code: 400, message: errorMessage };
    }

    // STEP 12: the `_User` login itself, LAST.
    //
    // It used to go at step 3, so any failure in steps 4 to 11 left the login
    // gone but the tenant, tokens and signature rows behind, and the flow could
    // not be resumed: the retry could no longer find the user. Everything above
    // tolerates an already-missing row, so a retry now works, and the login only
    // disappears once the data it owned is gone.
    //
    // The `_User` login is shared with the other tenants this account belongs
    // to, so neither destroying it nor anonymising it is ours to do there.
    try {
      if (!isMultiTenant) {
        // Check if any rows remain for this UserId
        const Contactbook = Parse.Object.extend('contracts_Contactbook');
        const remainingCount = await new Parse.Query(Contactbook)
          .equalTo('UserId', userPointer)
          .count({ useMasterKey: true });

        // If no record remains delete from _User class
        if (remainingCount === 0) {
          filesDeleted += await deleteSessionsAndUser(userPointer, userId);
        } else {
          filesDeleted += await anonymiseUser(userId);
        }
      }
    } catch (err) {
      console.error('Failed during _User cleanup:', err);
      const errorMessage = 'Failed during _User cleanup: ' + (err?.message || err);
      return { code: 400, message: errorMessage };
    }

    console.log(`Deleted ${filesDeleted} stored files for user ${userId}`);
    if (isMultiTenant) {
      return {
        code: 409,
        filesDeleted,
        message:
          'This account is also a member of another organisation, so the login itself was kept. ' +
          'Its membership and all of its data in this organisation have been removed.',
      };
    }
    // Deliberately precise. Every deletion query above is scoped to what this
    // account created (`ExtUserPtr` / `CreatedBy` / `UserId`), so documents
    // other people own in which this person signed keep their name, email, IP
    // and signature image in the audit trail and inside the signed pdf: those
    // are the other party's records of a completed agreement. Saying "all
    // associated data deleted" was the part that made a defensible retention
    // decision a false statement.
    return {
      code: 200,
      filesDeleted,
      message:
        'Your account, your documents and templates, your contacts, your saved signatures, ' +
        'your connected apps and your webhooks have been deleted. Documents other people sent you that you signed are their records ' +
        'of a completed agreement and are kept, including your name, email and signature on them.',
    };
  } catch (error) {
    console.error('User deletion process failed:', error);
    const errorMessage = `User deletion failed: ${error.message || error}`;
    return { code: 400, message: errorMessage };
  }
}

/**
 * 3. Verify the mailed code and delete the account.
 *
 * The route used to accept the `:userId` in the path plus a 6 digit code and
 * nothing else, with the attempt counter reset by every resend. It now needs
 * the signed link token (or a session for that same account) before it will
 * even admit the account exists, and the code is compared against a stored
 * hash, timing-safe, with the counter surviving resends.
 */
export const deleteUserPost = async (req, res) => {
  const authorised = await authoriseDeletionRequest(req);
  if (!authorised) return res.status(404).send('User not found.');
  const { extUser, userId } = authorised;
  const otp = req.body?.otp;

  try {
    if (extUser.get('UserRole') !== 'contracts_Admin') {
      const errorMessage =
        'This action is not permitted. Kindly contact your administrator to request account deletion.';
      // These used to be `res.send(...)` with no status, which Express answers
      // as 200: a client branching on the status code read a refused deletion
      // as a successful one.
      return res.status(403).send(errorMessage);
    }

    const extUsers = new Parse.Query('contracts_Users');
    extUsers.equalTo('TenantId', extUser.get('TenantId'));
    extUsers.notEqualTo('UserRole', 'contracts_Admin');
    const isTeamUsers = await extUsers.first({ useMasterKey: true });
    if (isTeamUsers) {
      const errorMessage = `To delete this account, start by removing all team users associated with it. Once all users are removed, you'll be able to permanently delete the account.`;
      return res.status(409).send(errorMessage);
    }

    // Only the hash of the code is ever stored (§#25), so there is nothing on
    // the row for another function to hand out.
    const savedHash = extUser.get('DeleteOTPHash');
    const expiry = extUser.get('DeleteOTPExpiry');
    const tries = Number(extUser.get('DeleteOTPTries') || 0);

    const countAttempt = async () => {
      extUser.set('DeleteOTPTries', tries + 1);
      await extUser.save(null, { useMasterKey: true }).catch(() => {});
    };

    if (tries >= MAX_ATTEMPTS) {
      return res
        .status(429)
        .send('Too many invalid attempts. Please start the deletion request again.');
    }
    if (!otp || typeof otp !== 'string') {
      await countAttempt();
      return res.status(400).send('OTP is required.');
    }
    if (!savedHash || typeof savedHash !== 'string') {
      return res.status(400).send('No OTP found. Please request a new OTP.');
    }
    if (expiry && Date.now() > new Date(expiry).getTime()) {
      return res.status(400).send('OTP has expired. Please request a new OTP.');
    }
    if (!timingSafeEqualHex(savedHash, hashOtp(userId, otp))) {
      await countAttempt();
      return res.status(400).send('Invalid OTP.');
    }

    // Correct code: burn the code and the link before anything is destroyed, so
    // the token cannot be replayed even if the deletion below fails partway.
    // A failure here used to be swallowed and the deletion went ahead anyway,
    // leaving the code valid on the row for the rest of its 10 minute window.
    try {
      clearDeletionState(extUser);
      await extUser.save(null, { useMasterKey: true });
    } catch (err) {
      console.log('err while clearing the deletion state: ', err?.response?.data || err);
      return res
        .status(500)
        .send('Could not start the deletion. Please request a new code and try again.');
    }

    const response = await deleteUser(userId);
    const code = response?.code || 500;
    const message = response?.message || 'An error occurred while deleting your account.';
    return res.status(code).send(message);
  } catch (error) {
    console.error('Account deletion error:', error);
    const errorMessage = error?.message || 'An error occurred while deleting your account.';
    return res.status(500).send(errorMessage);
  }
};

// 2. Handle Password Verification and Deletion
export const deleteUserByAdmin = async (req, res) => {
  const sessiontoken = req.headers.sessiontoken;
  const userId = req.params.userId;
  if (!sessiontoken) return res.status(400).json({ message: 'unauthorized.' });
  if (!userId || userId === ':userId') {
    return res.status(400).json({ message: 'Missing userId parameter.' });
  }
  try {
    // Resolved in process rather than with `axios.get(serverUrl + '/users/me')`:
    // the server no longer has to be able to reach its own public url to
    // authenticate a request it is already holding.
    const admin = await resolveCaller({ headers: req.headers });
    const adminId = admin?.id;

    if (!adminId) {
      return res.status(400).json({ message: 'Unauthorized.' });
    }
    // 1. Get the user
    const userQuery = new Parse.Query(Parse.User);
    userQuery.equalTo('objectId', userId);
    const user = await userQuery.first({ useMasterKey: true });
    if (!user) {
      const errorMessage = 'User not found.';
      return res.status(400).json({ message: errorMessage });
    }

    if (adminId === userId) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }
    // 2. ext user details
    const extUser = await extUserForUser(adminId);
    if (!extUser) {
      const errorMessage = 'User not found.';
      return res.status(400).json({ message: errorMessage });
    }
    const isAdmin =
      extUser?.get('UserRole') === 'contracts_Admin' ||
      extUser?.get('UserRole') === 'contracts_OrgAdmin'
        ? true
        : false;
    const isOrgAdmin = extUser?.get('UserRole') === 'contracts_OrgAdmin';
    const tenantId = extUser?.get('TenantId');
    const orgPtr = isOrgAdmin && extUser?.get('OrganizationId');
    if (!isAdmin) {
      return res.status(400).json({ message: 'Unauthorized.' });
    }
    const response = await deleteUser(userId, adminId, tenantId, isOrgAdmin, orgPtr);
    const code = response?.code || 400;
    const message = response?.message || 'An error occurred while deleting your account.';
    console.log('delete user ', code, message);
    return res.status(code).json({ message: message });
  } catch (error) {
    const code = error?.response?.data?.code || 400;
    const errorMessage =
      error?.response?.data?.error ||
      error?.message ||
      'An error occurred while deleting your account.';
    console.error(`Account deletion error:`, errorMessage);
    return res.status(code).json({ message: errorMessage });
  }
};
