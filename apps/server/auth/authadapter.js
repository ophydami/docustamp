import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

/**
 * Third-party SSO login.
 *
 * This adapter hands the caller's access token to an OAuth userinfo endpoint and
 * mints a Parse session when that host says the token belongs to the claimed
 * address, so whoever owns the endpoint can log in as any user of this
 * deployment. It therefore has no default: with SSO_API_URL unset the adapter is
 * not registered at all (see index.js), rather than silently trusting
 * the upstream project's hosted SSO service, which is what a self-hosted fork used to do.
 *
 *   SSO_API_URL   base url of the OAuth provider, e.g. https://sso.example.com/api
 */
export const ssoApiUrl = process.env.SSO_API_URL?.trim().replace(/\/+$/, '') || '';

/** True when SSO_API_URL names a usable https(s) endpoint. */
export const ssoEnabled = (() => {
  if (!ssoApiUrl) return false;
  try {
    return /^https?:$/.test(new URL(ssoApiUrl).protocol);
  } catch {
    console.error('[sso] SSO_API_URL is not a valid url; the sso auth adapter is disabled');
    return false;
  }
})();

export const SSOAuth = {
  // Returns a promise that fulfills if this user mail is valid.
  validateAuthData: async authData => {
    if (!ssoEnabled) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'SSO auth is invalid for this user.');
    }
    let response;
    try {
      response = await axios.get(ssoApiUrl + '/oauth/userinfo', {
        headers: {
          Authorization: `Bearer ${authData.access_token}`,
        },
      });
    } catch (error) {
      // Never log the error object itself: axios attaches the request config,
      // whose Authorization header carries a live bearer token, and these logs
      // are written to disk.
      console.error(
        '[sso] userinfo call failed:',
        error?.response?.status || error?.code || 'no response',
        error?.message
      );
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'SSO auth is invalid for this user.');
    }
    if (
      response.data &&
      response.data.id &&
      response.data.email?.toLowerCase()?.replace(/\s/g, '') === authData.id
    ) {
      return;
    }
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'SSO auth is invalid for this user.');
  },

  // Returns a promise that fulfills if this app id is valid.
  validateAppId: () => {
    return Promise.resolve();
  },
};
