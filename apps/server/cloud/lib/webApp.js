import fs from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express from 'express';

/**
 * Serving the web app from this process (the single-container setup).
 *
 * The Docker image builds apps/web into ./web next to index.js. When that
 * folder is there, the server answers the whole site on one port:
 *
 *   /api/...     the API, exactly as it looks behind a reverse proxy that
 *                strips /api (the Parse mount at /api/app, /api/mcp, /api/v1...)
 *   /assets/...  the built files, cached for a year (their names carry a hash)
 *   any other page a browser asks for: index.html, so client-side routes work
 *
 * The API also stays reachable without the prefix, because the server's own
 * loopback calls (cloudServerUrl, parse-dbtool) use http://localhost:PORT/app.
 * Without the folder (development, the test suite) the API is served on its own
 * as before.
 */

/** Where the built web app lives, or null when this process serves the API only. */
export function resolveWebRoot(configured = process.env.WEB_ROOT) {
  const root = configured?.trim() || path.join(process.cwd(), 'web');
  return fs.existsSync(path.join(root, 'index.html')) ? root : null;
}

/**
 * Paths that belong to the API even without the /api prefix: the Parse mount
 * and the plain Express routes in cloud/routes/customApp.js. They never fall
 * back to index.html. `/.well-known` is here because the OAuth discovery
 * documents (cloud/routes/oauth.js) must live at the origin root.
 */
function apiPathPattern(parseMount) {
  const mount = (parseMount || '/app').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(${mount}|/public|/docxtopdf|/decryptpdf|/delete-account|/deleteuser|/mcp|/v1|/oauth|/\\.well-known)(/|$)`
  );
}

/**
 * Baseline response headers for every route, the web app and the API alike.
 * They used to live in the Caddyfile, which hosting platforms without Caddy in
 * front never saw.
 */
export function securityHeaders(req, res, next) {
  // Never let a browser guess a content type: /files/ serves user documents.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Keep document ids and signing tokens out of the Referer of outbound links.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only this origin may frame the app: signing is what clickjacking targets.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HTTPS only, for a year, once the request is known to have arrived over it
  // (req.secure honours X-Forwarded-Proto through `trust proxy`).
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** The built files plus the index.html fallback for client-side routes. */
export function webHandler(webRoot, { parseMount } = {}) {
  const apiPath = apiPathPattern(parseMount);
  const indexHtml = path.join(webRoot, 'index.html');
  const staticFiles = express.static(webRoot, {
    index: false,
    setHeaders(res, filePath) {
      const immutable = filePath.startsWith(path.join(webRoot, 'assets') + path.sep);
      res.setHeader(
        'Cache-Control',
        // Everything else must be revalidated, or a deploy leaves returning
        // tabs running old JavaScript.
        immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
      );
    },
  });
  const compress = compression();

  return function serveWeb(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (apiPath.test(req.path)) return next();
    compress(req, res, () =>
      staticFiles(req, res, () => {
        // A missing build file is a 404, never the app shell served as script.
        if (req.path.startsWith('/assets/')) return res.status(404).end();
        // Only pages fall back to the app; API clients and images do not.
        if (!req.accepts('html')) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexHtml);
      })
    );
  };
}

/**
 * The whole site: the web app at the root and the API under /api, both on the
 * one Express app the rest of the server is built around.
 *
 * @param {import('express').Express} api the API app from index.js
 * @param {string} webRoot the folder holding the built index.html
 */
export function createSite(api, webRoot, { parseMount } = {}) {
  const site = express();
  site.disable('x-powered-by');
  // req.secure and req.ip on this outer app must trust the same proxies as the API.
  site.set('trust proxy', api.get('trust proxy'));
  site.use(securityHeaders);
  site.use('/api', api);
  site.use(webHandler(webRoot, { parseMount }));
  site.use(api);
  return site;
}
