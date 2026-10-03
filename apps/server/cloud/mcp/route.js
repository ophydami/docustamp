import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveApiToken, tokenFromHeaders } from '../lib/apiTokens.js';
import { loadCaller } from '../lib/context.js';
import { checkRateLimit, clientIp, RATE_LIMIT_CODE } from '../parsefunction/authGuard.js';
import {
  bodyTooLarge,
  httpStatusFor,
  MAX_API_BODY_BYTES,
  safeErrorMessage,
} from '../api/shared.js';
import { publicOriginFor } from '../lib/publicUrl.js';
import {
  oauthEnabled,
  protectedResourceMetadataUrl,
  resolveOAuthAccessToken,
} from '../lib/oauth.js';
import { buildMcpServer } from './server.js';

/**
 * Stateless Streamable-HTTP MCP endpoint, mounted at `/mcp` (reached as
 * `https://<host>/api/mcp`).
 *
 * Every POST carries `Authorization: Bearer <token>`; the token is resolved to a
 * caller, a throw-away McpServer + transport is built for that request and torn
 * down when the response ends. No session ids, nothing kept between requests, so
 * it works the same from a terminal, a script or Claude Code:
 *
 *   claude mcp add --transport http docustamp https://sign.example.com/api/mcp \
 *     --header "Authorization: Bearer os_..."
 *
 * The token is either a personal API token (`os_`) or an OAuth access token
 * (`dsat_`) that an MCP client such as ChatGPT obtained through "Sign in with
 * DocuStamp" (cloud/lib/oauth.js). A request without one gets a 401 whose
 * `WWW-Authenticate` header points at the protected-resource metadata, which is
 * how those clients discover the sign-in flow.
 */

/**
 * Two buckets, both in-memory per Node process (so a multi-instance deployment
 * effectively multiplies them; see docs/AI_AND_MCP.md §3).
 *
 * The per-IP bucket is the pre-auth speed bump and has to sit *above* the
 * per-token budget, or the documented 120 req/min per token is unreachable and
 * several colleagues behind one office IP share one small bucket.
 */
const PER_TOKEN_PER_MIN = 120;
const PER_IP_PER_MIN = 240;

/**
 * @param {import('express').Request} req
 * @param {{allowOAuth?: boolean}} [opts] OAuth access tokens are minted for the
 *   MCP endpoint only (their scopes are enforced per tool in ./server.js), so
 *   only `mcpHandler` passes `allowOAuth`; the REST API keeps to API tokens.
 */
export async function authenticateApiRequest(req, { allowOAuth = false } = {}) {
  const raw = tokenFromHeaders(req.headers || {});
  if (!raw) return { error: 'missing_token' };
  checkRateLimit('api-ip', `ip:${clientIp(req)}`, PER_IP_PER_MIN);
  let resolved;
  try {
    resolved =
      (allowOAuth && oauthEnabled() && (await resolveOAuthAccessToken(raw))) ||
      (await resolveApiToken(raw));
  } catch (err) {
    // A token whose user row has gone (deleted account, half-removed pointer)
    // throws OBJECT_NOT_FOUND in here. That is an authentication failure, not a
    // missing document: it must not surface as 404 or 500 (§G2-43).
    if (err?.code === RATE_LIMIT_CODE) throw err;
    console.log('api auth: token could not be resolved', err?.message || err);
    return { error: 'invalid_token' };
  }
  if (!resolved) return { error: 'invalid_token' };
  checkRateLimit('api-token', `u:${resolved.user.id}`, PER_TOKEN_PER_MIN);
  resolved.touch();
  try {
    const caller = await loadCaller(resolved.user, {
      extUser: resolved.extUser,
      publicUrl: publicOrigin(req),
    });
    // Where the request came from, for the audit entry of a signature an
    // agent makes (lib/agentSign.js passes it on as x-real-ip).
    const ip = clientIp(req);
    caller.ip = ip === 'unknown' ? '' : ip;
    // A token (an app the user connected, or their API key), not a person in
    // the web app: the account's rules for its AI apply (lib/agentRules.js).
    caller.viaToken = true;
    // Undefined for an API token, which carries everything the account can do.
    if (resolved.scopes) {
      caller.scopes = resolved.scopes;
      // An app the user connected (ChatGPT, Claude...) rather than a token the
      // user holds: it never gets signing links (./server.js labelTools), and it
      // signs only through sign_document, for this user, once the user turned
      // on "Can sign for me" (documents:sign). The redirect host is what the
      // audit trail shows next to the self-declared client name.
      caller.oauth = {
        clientId: resolved.clientId,
        clientName: resolved.clientName || '',
        redirectHost: resolved.redirectHost || '',
        signingEnabledAt: resolved.signingEnabledAt || null,
      };
    }
    return { caller };
  } catch (err) {
    // A disabled account is a real answer (403), not a bad token.
    if (err?.code === RATE_LIMIT_CODE || err?.code === Parse.Error.OPERATION_FORBIDDEN) throw err;
    console.log('api auth: caller could not be loaded', err?.message || err);
    return { error: 'invalid_token' };
  }
}

function publicOrigin(req) {
  const header = req.headers?.public_url;
  if (header) return String(header);
  // No header when the request did not come through index.js (unit tests, or a
  // future direct mount): fall back to the configured origin, never to a raw
  // Host header.
  return publicOriginFor(req);
}

function unauthorized(res, reason) {
  // RFC 6750: no error code when no credential was sent at all. RFC 9728: the
  // resource_metadata parameter is what starts an MCP client's OAuth discovery.
  const params = ['realm="docustamp"'];
  if (oauthEnabled()) params.push(`resource_metadata="${protectedResourceMetadataUrl()}"`);
  if (reason !== 'missing_token') params.push('error="invalid_token"');
  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  return res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message:
        reason === 'missing_token'
          ? 'Missing API token. Send "Authorization: Bearer <token>"; create one under Settings > API & MCP.'
          : 'Invalid, expired or revoked token.',
    },
    id: null,
  });
}

export async function mcpHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'This MCP endpoint is stateless: use POST only (no SSE stream, no sessions).',
      },
      id: null,
    });
  }
  // Refuse an oversized body before any token lookup. A 50 MB PDF arrives as
  // ~67 MB of base64, which is what MAX_API_BODY_BYTES leaves room for.
  if (bodyTooLarge(req)) {
    return res.status(413).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Request body is too large: this endpoint accepts up to ${Math.floor(MAX_API_BODY_BYTES / (1024 * 1024))} MB.`,
      },
      id: null,
    });
  }
  let auth;
  try {
    auth = await authenticateApiRequest(req, { allowOAuth: true });
  } catch (err) {
    const status = httpStatusFor(err);
    return res
      .status(status)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: safeErrorMessage(err) }, id: null });
  }
  if (auth.error) return unauthorized(res, auth.error);

  const server = buildMcpServer(auth.caller);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.log('mcp: request failed', err?.message || err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}
