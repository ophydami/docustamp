import { loadCaller } from '../lib/context.js';
import {
  decideAuthorizationRequest,
  describeAuthorizationRequest,
  listOAuthGrants,
  oauthEnabled,
  revokeOAuthGrant,
} from '../lib/oauth.js';
import { checkRateLimit } from './authGuard.js';

/**
 * The web app's side of "Sign in with DocuStamp" (cloud/lib/oauth.js).
 *
 *   oauthrequest     { requestId } -> { clientName, redirectHost, scopes, expiresAt }
 *                    what the consent page (/connect) shows
 *   oauthdecide      { requestId, approve } -> { redirectUrl }
 *                    allow or deny; the page then navigates to redirectUrl
 *   listoauthgrants  -> { grants: [{ id, clientName, redirectHost, scopes, createdAt, lastUsedAt }] }
 *   revokeoauthgrant { grantId } -> { revoked }
 *
 * All four need a signed-in user. The consent page is reached through
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

export async function oauthDecide(request) {
  requireUser(request);
  requireEnabled();
  // loadCaller refuses a suspended account, so it cannot connect new apps.
  const caller = await loadCaller(request.user, { publicUrl: request.headers?.public_url });
  return await decideAuthorizationRequest(
    caller,
    request.params?.requestId,
    request.params?.approve === true
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
