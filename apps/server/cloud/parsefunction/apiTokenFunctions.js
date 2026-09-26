import { createApiToken, getApiTokenInfo, revokeApiToken } from '../lib/apiTokens.js';

/**
 * Personal API token management for the settings page.
 *   generateapitoken  → { token, prefix, createdAt }   (token shown once)
 *   revokeapitoken    → { revoked }
 *   getapitoken       → { token: { prefix, createdAt, lastUsedAt } | null }
 */

export async function generateApiToken(request) {
  return await createApiToken(request?.user);
}

export async function revokeApiTokenFn(request) {
  return await revokeApiToken(request?.user);
}

export async function getApiToken(request) {
  return await getApiTokenInfo(request?.user);
}
