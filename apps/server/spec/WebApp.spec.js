/**
 * The single-container site (cloud/lib/webApp.js): the built web app at the
 * root, the API under /api and, for the server's own loopback calls, without
 * the prefix too. Driven against a stand-in API so it runs without Parse.
 */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSite, resolveWebRoot } from '../cloud/lib/webApp.js';
import { requestedFileUrl } from '../cloud/lib/fileUrls.js';

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';

describe('single-container site', () => {
  let webRoot;
  let server;
  let base;

  beforeAll(async () => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docustamp-web-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), INDEX);
    fs.writeFileSync(path.join(webRoot, 'favicon.svg'), '<svg></svg>');
    fs.mkdirSync(path.join(webRoot, 'assets'));
    fs.writeFileSync(path.join(webRoot, 'assets', 'app-abc123.js'), 'console.log(1);'.repeat(200));

    const api = express();
    api.set('trust proxy', 1);
    api.get('/app/health', (req, res) => res.json({ status: 'ok', path: req.originalUrl }));
    api.all('/mcp', (req, res) => res.json({ route: 'mcp' }));
    api.get('/v1/documents', (req, res) => res.json({ route: 'v1' }));
    api.get('/', (req, res) => res.send('docustamp-server is running !!!'));

    const site = createSite(api, webRoot, { parseMount: '/app' });
    server = http.createServer(site);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  const get = (p, headers = {}) => fetch(base + p, { headers });

  it('serves the app shell at / with the security headers and no caching', async () => {
    const res = await get('/', { accept: 'text/html' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('falls back to the app shell for client-side routes', async () => {
    for (const route of [
      '/documents',
      '/sign/abc/def',
      '/login/eyJhIjoxfQ',
      '/settings/branding',
    ]) {
      const res = await get(route, { accept: 'text/html,application/xhtml+xml' });
      expect(res.status).withContext(route).toBe(200);
      expect(await res.text())
        .withContext(route)
        .toContain('<div id="root">');
    }
  });

  it('serves hashed assets compressed and cached for a year', async () => {
    const res = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('answers a missing asset with 404, never the app shell', async () => {
    const res = await get('/assets/gone-123.js', { accept: '*/*' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it('routes /api/... to the API', async () => {
    const health = await get('/api/app/health');
    expect(await health.json()).toEqual({ status: 'ok', path: '/api/app/health' });
    const root = await get('/api/');
    expect(await root.text()).toContain('docustamp-server is running');
    const mcp = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    expect(await mcp.json()).toEqual({ route: 'mcp' });
  });

  it('keeps the unprefixed API paths for loopback calls, even for browsers', async () => {
    const health = await get('/app/health', { accept: 'text/html' });
    expect(await health.json()).toEqual({ status: 'ok', path: '/app/health' });
    const v1 = await get('/v1/documents', { accept: 'text/html' });
    expect(await v1.json()).toEqual({ route: 'v1' });
  });

  it('does not answer non-page requests with the app shell', async () => {
    const json = await get('/nowhere', { accept: 'application/json' });
    expect(json.status).toBe(404);
    const post = await fetch(`${base}/documents`, { method: 'POST' });
    expect(post.status).toBe(404);
  });

  it('adds HSTS only to requests that arrived over HTTPS', async () => {
    const plain = await get('/');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const secure = await get('/', { 'x-forwarded-proto': 'https' });
    expect(secure.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});

describe('resolveWebRoot', () => {
  it('is null unless the folder holds a built index.html', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docustamp-noweb-'));
    expect(resolveWebRoot(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
    expect(resolveWebRoot(dir)).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('requestedFileUrl', () => {
  const base = { origin: 'https://sign.example.com', prefix: '/api' };

  it('puts back the prefix a reverse proxy stripped', () => {
    expect(requestedFileUrl('/app/files/docustamp/a.pdf?token=t', base)).toBe(
      'https://sign.example.com/api/app/files/docustamp/a.pdf?token=t'
    );
  });

  it('keeps the path as is when this process served the prefix itself', () => {
    expect(requestedFileUrl('/api/app/files/docustamp/a.pdf?token=t', base)).toBe(
      'https://sign.example.com/api/app/files/docustamp/a.pdf?token=t'
    );
  });

  it('works without a prefix', () => {
    expect(
      requestedFileUrl('/app/files/x.pdf', { origin: 'http://localhost:8080', prefix: '' })
    ).toBe('http://localhost:8080/app/files/x.pdf');
  });
});
