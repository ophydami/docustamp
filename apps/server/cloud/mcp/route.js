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
import { buildMcpServer } from './server.js';

/**
 * Stateless Streamable-HTTP MCP endpoint, mounted at `/mcp` (reached as
 * `https://<host>/api/mcp`).
 *
 * Every POST carries `Authorization: Bearer os_...`; the token is resolved to a
 * caller, a throw-away McpServer + transport is built for that request and torn
 * down when the response ends. No session ids, nothing kept between requests, so
 * it works the same from a terminal, a script or Claude Code:
 *
 *   claude mcp add --transport http docustamp https://sign.example.com/api/mcp \
 *     --header "Authorization: Bearer os_..."
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

export async function authenticateApiRequest(req) {
  const raw = tokenFromHeaders(req.headers || {});
  if (!raw) return { error: 'missing_token' };
  checkRateLimit('api-ip', `ip:${clientIp(req)}`, PER_IP_PER_MIN);
  let resolved;
  try {
    resolved = await resolveApiToken(raw);
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
  res.setHeader('WWW-Authenticate', 'Bearer realm="docustamp", error="invalid_token"');
  return res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message:
        reason === 'missing_token'
          ? 'Missing API token. Send "Authorization: Bearer <token>"; create one under Settings > API & MCP.'
          : 'Invalid or revoked API token.',
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
    auth = await authenticateApiRequest(req);
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
