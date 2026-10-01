import express from 'express';
import cors from 'cors';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { checkRateLimit, RATE_LIMIT_CODE } from '../parsefunction/authGuard.js';
import {
  authorizationServerMetadata,
  mcpResourceUrl,
  oauthEnabled,
  oauthProvider,
  protectedResourceMetadata,
} from '../lib/oauth.js';

/**
 * The OAuth endpoints for the MCP endpoint (cloud/lib/oauth.js explains the
 * flow). Mounted at the root of the API app, so with the usual `/api` prefix:
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server           RFC 8414
 *   GET  /.well-known/openid-configuration                 same document, for
 *                                                          clients that only try OIDC
 *   POST /api/oauth/register    dynamic client registration (RFC 7591)
 *   GET  /api/oauth/authorize   starts a flow, redirects to the consent page
 *   POST /api/oauth/token       code + PKCE verifier, or refresh token
 *   POST /api/oauth/revoke      RFC 7009
 *
 * The /.well-known documents have to sit at the origin root, which is why
 * cloud/lib/webApp.js routes that prefix to the API instead of the web app.
 *
 * Everything answers 404 when OAuth is off (no https public origin, or
 * OAUTH_ENABLED=false). The SDK handlers bring their own express-rate-limit;
 * that is switched off in favour of the same in-process limiter the other
 * custom routes use, which the spec suite can reset.
 */

const RATE_LIMITS = {
  discovery: Number(process.env.OAUTH_DISCOVERY_RATE_LIMIT || 120),
  register: Number(process.env.OAUTH_REGISTER_RATE_LIMIT || 20),
  authorize: Number(process.env.OAUTH_AUTHORIZE_RATE_LIMIT || 60),
  token: Number(process.env.OAUTH_TOKEN_RATE_LIMIT || 120),
};

function limit(bucket) {
  return function (req, res, next) {
    const key = req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';
    try {
      checkRateLimit(`oauth:${bucket}`, String(key), RATE_LIMITS[bucket]);
      next();
    } catch (err) {
      if (err?.code === RATE_LIMIT_CODE) {
        res.set('Retry-After', '60');
        return res.status(429).json({
          error: 'too_many_requests',
          error_description: 'Too many requests. Please try again in a minute.',
        });
      }
      next(err);
    }
  };
}

function enabled(req, res, next) {
  if (oauthEnabled()) return next();
  return res
    .status(404)
    .json({ error: 'not_found', error_description: 'OAuth is not enabled on this server.' });
}

function sendJson(build) {
  return function (req, res) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(build());
  };
}

export const router = express.Router();

// Discovery documents: readable from any origin, like the SDK's own metadata handler.
const discovery = express.Router();
discovery.use(cors());
discovery.use(enabled, limit('discovery'));
discovery.get('/oauth-authorization-server', sendJson(authorizationServerMetadata));
discovery.get('/openid-configuration', sendJson(authorizationServerMetadata));
// RFC 9728 puts the resource path after the well-known name; a bare
// /.well-known/oauth-protected-resource is what older clients ask for.
discovery.get(/^\/oauth-protected-resource(\/.*)?$/, (req, res, next) => {
  const suffix = req.params[0] || '';
  if (suffix && suffix.replace(/\/+$/, '') !== new URL(mcpResourceUrl()).pathname) return next();
  return sendJson(protectedResourceMetadata)(req, res);
});
router.use('/.well-known', discovery);

const handlerOptions = { provider: oauthProvider, rateLimit: false };
router.use(
  '/oauth/register',
  enabled,
  limit('register'),
  clientRegistrationHandler({
    clientsStore: oauthProvider.clientsStore,
    clientSecretExpirySeconds: 0,
    rateLimit: false,
  })
);
router.use('/oauth/authorize', enabled, limit('authorize'), authorizationHandler(handlerOptions));
router.use('/oauth/token', enabled, limit('token'), tokenHandler(handlerOptions));
router.use('/oauth/revoke', enabled, limit('token'), revocationHandler(handlerOptions));
