import crypto from 'node:crypto';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { appName } from '../../Utils.js';
import { conditionalUpdate } from './atomic.js';
import { configuredPublicOrigin } from './publicUrl.js';

/**
 * "Sign in with DocuStamp" for MCP clients: an OAuth 2.1 authorization server
 * for the MCP endpoint, so ChatGPT, Claude and other hosts can connect an
 * account without the user pasting a personal API token.
 *
 * The protocol plumbing (parameter checks, PKCE verification, error shapes) is
 * the MCP SDK's own handlers, mounted in cloud/routes/oauth.js. This file is
 * what they call into: client storage, the consent step, and the tokens.
 *
 * Flow:
 *   1. the client registers itself (dynamic client registration, public
 *      clients only: PKCE is the proof, there is no client secret),
 *   2. GET /oauth/authorize stores a pending request and sends the browser to
 *      the web app's consent page, /connect?request=<id>,
 *   3. the signed-in user allows or denies there (cloud functions in
 *      parsefunction/oauthFunctions.js); allowing mints a one-time code,
 *   4. POST /oauth/token trades the code (+ PKCE verifier) for an access token
 *      and a refresh token, both bound to that user and that client.
 *
 * Storage, all master-key only (the REST `classes/` endpoint must not expose
 * any of it). Tokens and codes are kept as sha256 hashes, like API tokens:
 *   contracts_OAuthClient   one row per registered client
 *   contracts_OAuthRequest  one row per authorization request (and its code)
 *   contracts_OAuthGrant    one row per connection: what Settings lists and
 *                           what "Disconnect" deletes
 *
 * Access tokens only work on the MCP endpoint (they are minted for it, see
 * `mcpResourceUrl`); the REST API keeps using personal API tokens.
 */

export const OAUTH_CLIENT_CLASS = 'contracts_OAuthClient';
export const OAUTH_REQUEST_CLASS = 'contracts_OAuthRequest';
export const OAUTH_GRANT_CLASS = 'contracts_OAuthGrant';

export const SCOPE_READ = 'documents:read';
export const SCOPE_WRITE = 'documents:write';
export const SCOPES_SUPPORTED = Object.freeze([SCOPE_READ, SCOPE_WRITE]);

export const ACCESS_TOKEN_PREFIX = 'dsat_';
const REFRESH_TOKEN_PREFIX = 'dsrt_';
const ACCESS_TOKEN_RE = /^dsat_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_RE = /^dsrt_[A-Za-z0-9_-]{43}$/;

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the consent page stays valid after the client sent the user to it. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long the client has to trade a code once the user allowed access. */
const CODE_TTL_MS = 5 * 60 * 1000;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'about:',
  'blob:',
]);

/** The registration fields that are kept; anything else a client sends is dropped. */
const CLIENT_FIELDS = Object.freeze([
  'client_id',
  'client_id_issued_at',
  'client_name',
  'client_uri',
  'logo_uri',
  'redirect_uris',
  'scope',
  'software_id',
  'software_version',
]);

const LOCKED_CLP = Object.freeze({
  get: {},
  find: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

// ---------------------------------------------------------------- config

/**
 * Whether this deployment acts as an OAuth server at all.
 *
 * Needs a configured public origin on https (loopback http is allowed for
 * development): the issuer goes into every token response and discovery
 * document, so it cannot be guessed from a Host header. OAUTH_ENABLED=false
 * turns it off.
 */
export function oauthEnabled() {
  if (/^(0|false|off|no)$/i.test(process.env.OAUTH_ENABLED?.trim() || '')) return false;
  const issuer = oauthIssuer();
  if (!issuer) return false;
  const url = new URL(issuer);
  return url.protocol === 'https:' || LOOPBACK.test(url.hostname);
}

/** The issuer: the public origin of this deployment, e.g. https://sign.example.com. */
export function oauthIssuer() {
  return configuredPublicOrigin();
}

/**
 * The path in front of the API routes on the public origin: `/api` when
 * SERVER_URL is https://sign.example.com/api/app, '' when the API is served at
 * the root. Same derivation as the /files/ check in index.js.
 */
export function apiPathPrefix() {
  const raw = process.env.SERVER_URL?.trim();
  if (!raw) return '';
  try {
    const pathname = new URL(raw).pathname.replace(/\/+$/, '');
    const mount = (process.env.PARSE_MOUNT || '/app').replace(/\/+$/, '');
    const prefix =
      mount && pathname.endsWith(mount)
        ? pathname.slice(0, -mount.length)
        : pathname.slice(0, pathname.lastIndexOf('/'));
    return prefix.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** The MCP endpoint as clients reach it, which is also the OAuth resource id. */
export function mcpResourceUrl() {
  return `${oauthIssuer()}${apiPathPrefix()}/mcp`;
}

/** RFC 9728: the protected-resource metadata url for the MCP endpoint. */
export function protectedResourceMetadataUrl() {
  const resource = new URL(mcpResourceUrl());
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [...SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
    resource_name: appName,
  };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata() {
  const base = `${oauthIssuer()}${apiPathPrefix()}/oauth`;
  return {
    issuer: oauthIssuer(),
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES_SUPPORTED],
  };
}

// ---------------------------------------------------------------- helpers

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function sameResource(value) {
  if (!value) return true;
  const href = (value instanceof URL ? value.href : String(value)).replace(/\/+$/, '');
  return href === mcpResourceUrl() || href === oauthIssuer();
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return value?.iso || null;
}

const schemaReady = new Set();
async function ensureLockedClass(className, define) {
  if (schemaReady.has(className)) return;
  const schema = new Parse.Schema(className);
  let existing = null;
  try {
    existing = await schema.get();
  } catch {
    // not there yet
  }
  if (!existing) {
    define(schema);
    schema.setCLP(LOCKED_CLP);
    try {
      await schema.save();
    } catch (err) {
      if (!/already exists/i.test(err?.message || '')) throw err;
    }
  }
  schemaReady.add(className);
}

/**
 * Create the three classes, locked, before the first write. The migration
 * (databases/migrations/20260930120000-create_oauth_classes.cjs) does the
 * same; this covers a server that has not run it yet, because a class that a
 * master-key save creates on its own gets public permissions.
 */
export async function ensureOAuthSchema() {
  await ensureLockedClass(OAUTH_CLIENT_CLASS, schema => {
    schema.addString('ClientId');
    schema.addString('ClientName');
    schema.addArray('RedirectUris');
    schema.addObject('Info');
  });
  await ensureLockedClass(OAUTH_REQUEST_CLASS, schema => {
    schema.addString('RequestId');
    schema.addString('ClientId');
    schema.addString('ClientName');
    schema.addString('RedirectUri');
    schema.addString('CodeChallenge');
    schema.addString('State');
    schema.addArray('Scopes');
    schema.addString('Resource');
    schema.addString('Status');
    schema.addDate('ExpiresAt');
    schema.addString('CodeHash');
    schema.addDate('CodeExpiresAt');
    schema.addPointer('User', '_User');
    schema.addPointer('ExtUserPtr', 'contracts_Users');
  });
  await ensureLockedClass(OAUTH_GRANT_CLASS, schema => {
    schema.addString('ClientId');
    schema.addString('ClientName');
    schema.addString('RedirectHost');
    schema.addPointer('User', '_User');
    schema.addPointer('ExtUserPtr', 'contracts_Users');
    schema.addArray('Scopes');
    schema.addString('Resource');
    schema.addString('RequestId');
    schema.addString('AccessTokenHash');
    schema.addDate('AccessExpiresAt');
    schema.addString('RefreshTokenHash');
    schema.addDate('RefreshExpiresAt');
    schema.addDate('LastUsedAt');
  });
}

// ---------------------------------------------------------------- clients

/**
 * Registered redirect uris: https anywhere, http only on loopback (native apps
 * on a local port, RFC 8252), or a private-use scheme such as `vscode:` or
 * `com.example.app:`. Never a scheme that runs or reads something locally.
 */
function checkRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidClientMetadataError(`redirect_uri is not a valid url: ${value}`);
  }
  if (url.hash) throw new InvalidClientMetadataError('redirect_uri must not have a fragment');
  if (FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol)) {
    throw new InvalidClientMetadataError(`redirect_uri scheme ${url.protocol} is not allowed`);
  }
  if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) {
    throw new InvalidClientMetadataError('redirect_uri must use https (http only on localhost)');
  }
}

function cleanClientName(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- strip control characters from a display name
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_CLIENT_NAME);
}

function clientFromRow(row) {
  const info = row.get('Info');
  if (!info || typeof info !== 'object') return undefined;
  return { ...info, client_id: row.get('ClientId') };
}

export const clientsStore = {
  async getClient(clientId) {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 200) return undefined;
    await ensureOAuthSchema();
    const query = new Parse.Query(OAUTH_CLIENT_CLASS);
    query.equalTo('ClientId', clientId);
    const row = await query.first({ useMasterKey: true });
    return row ? clientFromRow(row) : undefined;
  },

  /**
   * Every client is registered as a public one: whatever auth method it asked
   * for, it gets `none` and no secret. The SDK compares client secrets in plain
   * text and expires them after 30 days, and PKCE already binds the code to the
   * client that started the flow.
   */
  async registerClient(info) {
    const rest = {};
    for (const key of CLIENT_FIELDS) if (info?.[key] !== undefined) rest[key] = info[key];
    const redirectUris = Array.isArray(rest.redirect_uris) ? rest.redirect_uris : [];
    if (!redirectUris.length) {
      throw new InvalidClientMetadataError('redirect_uris is required');
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      throw new InvalidClientMetadataError(`at most ${MAX_REDIRECT_URIS} redirect_uris`);
    }
    redirectUris.forEach(checkRedirectUri);
    const clientName = cleanClientName(rest.client_name);
    const clean = {
      ...rest,
      client_name: clientName || undefined,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    await ensureOAuthSchema();
    const row = new Parse.Object(OAUTH_CLIENT_CLASS);
    row.set('ClientId', clean.client_id);
    row.set('ClientName', clientName);
    row.set('RedirectUris', redirectUris);
    row.set('Info', JSON.parse(JSON.stringify(clean)));
    await row.save(null, { useMasterKey: true });
    return clean;
  },
};

// ---------------------------------------------------------------- authorization requests

function requestedScopes(scopes) {
  const list = (scopes || []).filter(Boolean);
  if (!list.length) return [...SCOPES_SUPPORTED];
  const unknown = list.filter(scope => !SCOPES_SUPPORTED.includes(scope));
  if (unknown.length) throw new InvalidScopeError(`Unknown scope: ${unknown.join(' ')}`);
  // documents:write implies reading: a connection that may send a document
  // has to be able to look at it first.
  if (list.includes(SCOPE_WRITE) && !list.includes(SCOPE_READ)) list.unshift(SCOPE_READ);
  return [...new Set(list)];
}

/** Where the browser goes to approve a request: the web app's consent page. */
export function consentPageUrl(requestId) {
  return `${oauthIssuer()}/connect?request=${encodeURIComponent(requestId)}`;
}

/**
 * SDK `authorize`: the client and redirect uri are already checked. Store the
 * request and hand the browser to the consent page.
 */
async function authorize(client, params, res) {
  const scopes = requestedScopes(params.scopes);
  if (!sameResource(params.resource)) {
    throw new InvalidTargetError(
      `Unknown resource. This server issues tokens for ${mcpResourceUrl()}.`
    );
  }
  await ensureOAuthSchema();
  const requestId = randomToken(24);
  const row = new Parse.Object(OAUTH_REQUEST_CLASS);
  row.set('RequestId', requestId);
  row.set('ClientId', client.client_id);
  row.set('ClientName', cleanClientName(client.client_name));
  row.set('RedirectUri', params.redirectUri);
  row.set('CodeChallenge', params.codeChallenge);
  if (params.state) row.set('State', String(params.state).slice(0, 1000));
  row.set('Scopes', scopes);
  row.set('Resource', mcpResourceUrl());
  row.set('Status', 'pending');
  row.set('ExpiresAt', new Date(Date.now() + REQUEST_TTL_MS));
  await row.save(null, { useMasterKey: true });
  res.redirect(302, consentPageUrl(requestId));
}

async function pendingRequest(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) return null;
  await ensureOAuthSchema();
  const query = new Parse.Query(OAUTH_REQUEST_CLASS);
  query.equalTo('RequestId', requestId);
  const row = await query.first({ useMasterKey: true });
  if (!row || row.get('Status') !== 'pending') return null;
  if (!(row.get('ExpiresAt') > new Date())) return null;
  return row;
}

function hostOf(uri) {
  try {
    const url = new URL(uri);
    return url.host || url.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

const EXPIRED_MESSAGE =
  'This connection request has expired or was already used. Start again from the app you are connecting.';

/**
 * What the consent page shows: which app, where it sends the user back to,
 * and what it asks for. The redirect host is the part a client cannot fake.
 */
export async function describeAuthorizationRequest(requestId) {
  const row = await pendingRequest(requestId);
  if (!row) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, EXPIRED_MESSAGE);
  return {
    clientName: row.get('ClientName') || '',
    redirectHost: hostOf(row.get('RedirectUri')),
    scopes: row.get('Scopes') || [],
    expiresAt: iso(row.get('ExpiresAt')),
  };
}

function redirectWith(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.href;
}

/**
 * The user's answer on the consent page. Allowing mints the one-time code;
 * either way the page navigates to the returned `redirectUrl`.
 *
 * @param {import('./context.js').Caller} caller the signed-in user
 * @param {string} requestId
 * @param {boolean} approve
 * @returns {Promise<{redirectUrl: string}>}
 */
export async function decideAuthorizationRequest(caller, requestId, approve) {
  const row = await pendingRequest(requestId);
  if (!row) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, EXPIRED_MESSAGE);
  const redirectUri = row.get('RedirectUri');
  const state = row.get('State');
  if (!approve) {
    const won = await conditionalUpdate(
      OAUTH_REQUEST_CLASS,
      row.id,
      { Status: 'pending' },
      {
        Status: 'denied',
      }
    );
    if (!won) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, EXPIRED_MESSAGE);
    return {
      redirectUrl: redirectWith(redirectUri, {
        error: 'access_denied',
        error_description: 'The user did not allow access.',
        state,
      }),
    };
  }
  const code = randomToken(32);
  const won = await conditionalUpdate(
    OAUTH_REQUEST_CLASS,
    row.id,
    { Status: 'pending' },
    {
      Status: 'approved',
      CodeHash: hashSecret(code),
      CodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      User: { __type: 'Pointer', className: '_User', objectId: caller.userId },
      ExtUserPtr: { __type: 'Pointer', className: 'contracts_Users', objectId: caller.extUserId },
    }
  );
  if (!won) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, EXPIRED_MESSAGE);
  return { redirectUrl: redirectWith(redirectUri, { code, state }) };
}

// ---------------------------------------------------------------- codes and tokens

async function approvedRequestForCode(client, code) {
  if (typeof code !== 'string' || !code || code.length > 200) return null;
  await ensureOAuthSchema();
  const query = new Parse.Query(OAUTH_REQUEST_CLASS);
  query.equalTo('CodeHash', hashSecret(code));
  query.equalTo('ClientId', client.client_id);
  return await query.first({ useMasterKey: true });
}

/**
 * A code presented after it was already traded was intercepted or replayed:
 * whatever the first exchange produced goes too (OAuth 2.1 section 4.1.3).
 * Checked here as well as in the exchange, because the SDK asks for the PKCE
 * challenge first and a refused challenge never reaches the exchange.
 */
async function refuseReplayedCode(row) {
  const grants = new Parse.Query(OAUTH_GRANT_CLASS);
  grants.equalTo('RequestId', row.get('RequestId'));
  await destroyGrants(grants);
  throw new InvalidGrantError('Authorization code was already used');
}

async function challengeForAuthorizationCode(client, code) {
  const row = await approvedRequestForCode(client, code);
  if (row?.get('Status') === 'used') await refuseReplayedCode(row);
  if (!row || row.get('Status') !== 'approved' || !(row.get('CodeExpiresAt') > new Date())) {
    throw new InvalidGrantError('Invalid or expired authorization code');
  }
  return row.get('CodeChallenge');
}

function tokenResponse(accessToken, refreshToken, scopes) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

function freshTokens() {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  return {
    accessToken,
    refreshToken,
    fields: {
      AccessTokenHash: hashSecret(accessToken),
      AccessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000),
      RefreshTokenHash: hashSecret(refreshToken),
      RefreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  };
}

async function destroyGrants(query) {
  const rows = await query.find({ useMasterKey: true });
  if (rows.length) await Parse.Object.destroyAll(rows, { useMasterKey: true });
  return rows.length;
}

async function exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
  const row = await approvedRequestForCode(client, code);
  if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
  if (row.get('Status') === 'used') await refuseReplayedCode(row);
  if (row.get('Status') !== 'approved' || !(row.get('CodeExpiresAt') > new Date())) {
    throw new InvalidGrantError('Invalid or expired authorization code');
  }
  if (redirectUri !== undefined && redirectUri !== row.get('RedirectUri')) {
    throw new InvalidGrantError('redirect_uri does not match the authorization request');
  }
  if (!sameResource(resource)) {
    throw new InvalidTargetError(
      `Unknown resource. This server issues tokens for ${mcpResourceUrl()}.`
    );
  }
  const won = await conditionalUpdate(
    OAUTH_REQUEST_CLASS,
    row.id,
    { Status: 'approved' },
    {
      Status: 'used',
    }
  );
  if (!won) throw new InvalidGrantError('Authorization code was already used');

  const scopes = row.get('Scopes') || [...SCOPES_SUPPORTED];
  const { accessToken, refreshToken, fields } = freshTokens();
  const grant = new Parse.Object(OAUTH_GRANT_CLASS);
  grant.set('ClientId', client.client_id);
  grant.set('ClientName', row.get('ClientName') || cleanClientName(client.client_name));
  grant.set('RedirectHost', hostOf(row.get('RedirectUri')));
  grant.set('User', row.get('User'));
  grant.set('ExtUserPtr', row.get('ExtUserPtr'));
  grant.set('Scopes', scopes);
  grant.set('Resource', row.get('Resource') || mcpResourceUrl());
  grant.set('RequestId', row.get('RequestId'));
  for (const [key, value] of Object.entries(fields)) grant.set(key, value);
  await grant.save(null, { useMasterKey: true });
  return tokenResponse(accessToken, refreshToken, scopes);
}

async function extUserIsDisabled(extUserPointer) {
  if (!extUserPointer?.id) return true;
  const row = await new Parse.Query('contracts_Users')
    .get(extUserPointer.id, { useMasterKey: true })
    .catch(() => null);
  return !row || row.get('IsDisabled') === true;
}

/**
 * Refresh tokens rotate: every use returns a new pair and the old refresh
 * token stops working. The swap is a compare-and-set on the hash, so two
 * overlapping refreshes with the same token cannot both succeed.
 */
async function exchangeRefreshToken(client, refreshToken, scopes, resource) {
  if (!REFRESH_TOKEN_RE.test(String(refreshToken || ''))) {
    throw new InvalidGrantError('Invalid refresh token');
  }
  await ensureOAuthSchema();
  const oldHash = hashSecret(refreshToken);
  const query = new Parse.Query(OAUTH_GRANT_CLASS);
  query.equalTo('RefreshTokenHash', oldHash);
  query.equalTo('ClientId', client.client_id);
  const grant = await query.first({ useMasterKey: true });
  if (!grant || !(grant.get('RefreshExpiresAt') > new Date())) {
    throw new InvalidGrantError('Invalid or expired refresh token');
  }
  if (!sameResource(resource)) {
    throw new InvalidTargetError(
      `Unknown resource. This server issues tokens for ${mcpResourceUrl()}.`
    );
  }
  if (await extUserIsDisabled(grant.get('ExtUserPtr'))) {
    await grant.destroy({ useMasterKey: true }).catch(() => undefined);
    throw new InvalidGrantError('This account can no longer be used');
  }
  const granted = grant.get('Scopes') || [];
  let next = granted;
  if (scopes?.length) {
    const extra = scopes.filter(scope => !granted.includes(scope));
    if (extra.length) throw new InvalidScopeError(`Scope was not granted: ${extra.join(' ')}`);
    next = scopes;
  }
  const { accessToken, refreshToken: newRefresh, fields } = freshTokens();
  const won = await conditionalUpdate(
    OAUTH_GRANT_CLASS,
    grant.id,
    { RefreshTokenHash: oldHash },
    {
      ...fields,
      Scopes: next,
    }
  );
  if (!won) throw new InvalidGrantError('Invalid or expired refresh token');
  return tokenResponse(accessToken, newRefresh, next);
}

/**
 * RFC 7009. Either token ends the whole connection; an unknown token is not an
 * error (the client cannot tell the difference anyway).
 */
async function revokeToken(client, request) {
  const token = String(request?.token || '');
  if (!token || token.length > 200) return;
  await ensureOAuthSchema();
  const hash = hashSecret(token);
  const byAccess = new Parse.Query(OAUTH_GRANT_CLASS).equalTo('AccessTokenHash', hash);
  const byRefresh = new Parse.Query(OAUTH_GRANT_CLASS).equalTo('RefreshTokenHash', hash);
  const query = Parse.Query.or(byAccess, byRefresh);
  query.equalTo('ClientId', client.client_id);
  await destroyGrants(query);
}

export function looksLikeOAuthAccessToken(raw) {
  return typeof raw === 'string' && ACCESS_TOKEN_RE.test(raw.trim());
}

/**
 * Resolve an access token for the MCP endpoint.
 * @returns {Promise<{user: Parse.User, extUser: Parse.Object, scopes: string[], clientId: string, touch: Function} | null>}
 */
export async function resolveOAuthAccessToken(raw) {
  if (!looksLikeOAuthAccessToken(raw)) return null;
  await ensureOAuthSchema();
  const query = new Parse.Query(OAUTH_GRANT_CLASS);
  query.equalTo('AccessTokenHash', hashSecret(raw.trim()));
  query.greaterThan('AccessExpiresAt', new Date());
  query.include('User');
  query.include('ExtUserPtr');
  query.include('ExtUserPtr.TenantId');
  const grant = await query.first({ useMasterKey: true });
  if (!grant) return null;
  if (!sameResource(grant.get('Resource'))) return null;
  const user = grant.get('User');
  const extUser = grant.get('ExtUserPtr');
  if (!user?.id || !extUser?.id || !user.get('username')) return null;
  return {
    user,
    extUser,
    scopes: grant.get('Scopes') || [],
    clientId: grant.get('ClientId'),
    touch: () => touchGrant(grant),
  };
}

async function touchGrant(grant) {
  try {
    const last = grant.get('LastUsedAt');
    if (last instanceof Date && Date.now() - last.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    const update = new Parse.Object(OAUTH_GRANT_CLASS);
    update.id = grant.id;
    update.set('LastUsedAt', new Date());
    await update.save(null, { useMasterKey: true });
  } catch (err) {
    console.log('oauth: could not record last use', err?.message);
  }
}

async function verifyAccessToken(token) {
  const resolved = await resolveOAuthAccessToken(token);
  if (!resolved) throw new InvalidTokenError('Invalid or expired access token');
  return {
    token,
    clientId: resolved.clientId,
    scopes: resolved.scopes,
    resource: new URL(mcpResourceUrl()),
    extra: { userId: resolved.user.id },
  };
}

/** The `OAuthServerProvider` the SDK handlers in cloud/routes/oauth.js drive. */
export const oauthProvider = {
  get clientsStore() {
    return clientsStore;
  },
  authorize,
  challengeForAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  verifyAccessToken,
  revokeToken,
};

// ---------------------------------------------------------------- connected apps (settings)

function userQuery(userId) {
  const query = new Parse.Query(OAUTH_GRANT_CLASS);
  query.equalTo('User', { __type: 'Pointer', className: '_User', objectId: userId });
  return query;
}

/** The apps connected to this account, newest first. Never includes a hash. */
export async function listOAuthGrants(userId) {
  if (!userId) return [];
  await ensureOAuthSchema();
  const query = userQuery(userId);
  query.descending('createdAt');
  query.limit(100);
  const rows = await query.find({ useMasterKey: true });
  return rows
    .filter(row => row.get('RefreshExpiresAt') > new Date())
    .map(row => ({
      id: row.id,
      clientName: row.get('ClientName') || '',
      redirectHost: row.get('RedirectHost') || '',
      scopes: row.get('Scopes') || [],
      createdAt: iso(row.createdAt),
      lastUsedAt: iso(row.get('LastUsedAt')),
    }));
}

/** Disconnect one app. Only the account that connected it can. */
export async function revokeOAuthGrant(userId, grantId) {
  if (!userId || typeof grantId !== 'string' || !grantId) return { revoked: false };
  await ensureOAuthSchema();
  const query = userQuery(userId);
  query.equalTo('objectId', grantId);
  return { revoked: (await destroyGrants(query)) > 0 };
}

/**
 * Every connection of one account, for the paths that cut an account off: an
 * admin resetting a member's password or suspending them.
 */
export async function revokeOAuthGrantsForUser(userId) {
  if (!userId) return { revoked: 0 };
  await ensureOAuthSchema();
  return { revoked: await destroyGrants(userQuery(userId).limit(1000)) };
}
