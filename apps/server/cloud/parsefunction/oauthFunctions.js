import { loadCaller } from '../lib/context.js';
import {
  decideAuthorizationRequest,
  describeAuthorizationRequest,
  listOAuthGrants,
  oauthEnabled,
  revokeOAuthGrant,
  setOAuthGrantSigning,
} from '../lib/oauth.js';
import { checkRateLimit } from './authGuard.js';

/**
 * The web app's side of "Sign in with DocuStamp" (cloud/lib/oauth.js).
 *
 *   oauthrequest     { requestId } -> { clientName, redirectHost, scopes, signRequested, expiresAt }
 *                    what the consent page (/connect) shows
 *   oauthdecide      { requestId, approve, allowSigning?, readOnly? } -> { redirectUrl }
 *                    allow or deny; the page then navigates to redirectUrl.
 *                    allowSigning ("Can sign for me") only counts once the
 *                    user's email is verified. readOnly ("Read only") grants
 *                    documents:read alone and outranks allowSigning
 *   listoauthgrants  -> { grants: [{ id, clientName, redirectHost, scopes, readOnly,
 *                        canSign, signingEnabledAt, createdAt, lastUsedAt }] }
 *   revokeoauthgrant { grantId } -> { revoked }
 *   setoauthgrantsigning { id, enabled } -> { id, canSign, signingEnabledAt }
 *                    the "Can sign for me" switch; turning it on needs a
 *                    verified email and a connection that is not read-only
 *
 * All of them need a signed-in user. The consent page is reached through
 * RequireAuth, so a user who is not signed in logs in first and comes back.
 */

const PER_USER_PER_MIN = 30;

function requireUser(request) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  checkRateLimit('oauth-consent', `u:${request.user.id}`, PER_USER_PER_MIN);
}

function requireEnabled() {
  if (!oauthEnabled()) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'Connecting apps is not enabled on this server.'
    );
  }
}

export async function oauthRequest(request) {
  requireUser(request);
  requireEnabled();
  return await describeAuthorizationRequest(request.params?.requestId);
}

/**
 * The caller with a freshly read `_User`: whether the email is verified decides
 * what signing may be turned on, and the session's copy of the user can predate
 * the verification.
 */
async function freshCaller(request) {
  const user = await new Parse.Query(Parse.User).get(request.user.id, { useMasterKey: true });
  // loadCaller refuses a suspended account, so it cannot connect new apps.
  return await loadCaller(user, { publicUrl: request.headers?.public_url });
}

export async function oauthDecide(request) {
  requireUser(request);
  requireEnabled();
  const caller = await freshCaller(request);
  return await decideAuthorizationRequest(
    caller,
    request.params?.requestId,
    request.params?.approve === true,
    {
      allowSigning: request.params?.allowSigning === true,
      readOnly: request.params?.readOnly === true,
    }
  );
}

export async function listOAuthGrantsFn(request) {
  requireUser(request);
  return { grants: await listOAuthGrants(request.user.id) };
}

export async function revokeOAuthGrantFn(request) {
  requireUser(request);
  return await revokeOAuthGrant(request.user.id, request.params?.grantId);
}

export async function setOAuthGrantSigningFn(request) {
  requireUser(request);
  const caller = await freshCaller(request);
  return await setOAuthGrantSigning(caller, request.params?.id, request.params?.enabled === true);
}
