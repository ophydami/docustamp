/**
 * "Sign in with DocuStamp" for MCP clients (cloud/lib/oauth.js,
 * cloud/routes/oauth.js, parsefunction/oauthFunctions.js): discovery, dynamic
 * client registration, the consent step, PKCE, refresh rotation, revocation,
 * scopes on the MCP endpoint, and the tool safety labels.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import {
  mcpResourceUrl,
  oauthIssuer,
  protectedResourceMetadataUrl,
  revokeOAuthGrantsForUser,
} from '../cloud/lib/oauth.js';
import { TOOL_ANNOTATIONS } from '../cloud/mcp/server.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true, maxRedirects: 0 });
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

async function makeAccount(prefix) {
  const email = uniqueEmail(prefix, 'example.test');
  const user = new Parse.User();
  user.set('username', email);
  user.set('password', 'pa55word!');
  user.set('email', email);
  await user.signUp();
  const signedIn = await Parse.User.logIn(email, 'pa55word!');
  const tenant = new Parse.Object('partners_Tenant');
  tenant.set('TenantName', 'Acme');
  tenant.set('UserId', signedIn.toPointer());
  await tenant.save(null, { useMasterKey: true });
  const extUser = new Parse.Object('contracts_Users');
  extUser.set('Name', 'Owner Person');
  extUser.set('Email', email);
  extUser.set('UserId', signedIn.toPointer());
  extUser.set('TenantId', tenant.toPointer());
  extUser.set('UserRole', 'contracts_Admin');
  await extUser.save(null, { useMasterKey: true });
  return signedIn;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function form(body) {
  return [
    new URLSearchParams(body).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  ];
}

async function register(body = {}) {
  return await http.post(`${BASE}/oauth/register`, {
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    ...body,
  });
}

async function authorize(
  clientId,
  { challenge, scope, state = 'st-123', redirectUri = CHATGPT_REDIRECT, resource } = {}
) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: resource ?? mcpResourceUrl(),
  });
  if (scope) params.set('scope', scope);
  return await http.get(`${BASE}/oauth/authorize?${params}`);
}

function requestIdFrom(location) {
  const url = new URL(location);
  expect(`${url.origin}${url.pathname}`).toBe(`${oauthIssuer()}/connect`);
  return url.searchParams.get('request');
}

async function token(body) {
  return await http.post(`${BASE}/oauth/token`, ...form(body));
}

async function mcp(accessToken, method, params = {}) {
  return await http.post(
    `${BASE}/mcp`,
    { jsonrpc: '2.0', id: 1, method, params },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    }
  );
}

describe('OAuth for MCP clients', () => {
  Parse.User.enableUnsafeCurrentUser();

  let user;
  let other;
  let clientId;

  /** The whole dance, as ChatGPT does it: authorize, allow, trade the code. */
  async function connect({ scope, as = user } = {}) {
    const { verifier, challenge } = pkce();
    const start = await authorize(clientId, { challenge, scope });
    expect(start.status).toBe(302, JSON.stringify(start.data));
    const requestId = requestIdFrom(start.headers.location);
    const { redirectUrl } = await Parse.Cloud.run(
      'oauthdecide',
      { requestId, approve: true },
      { sessionToken: as.getSessionToken() }
    );
    const code = new URL(redirectUrl).searchParams.get('code');
    const res = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      resource: mcpResourceUrl(),
    });
    expect(res.status).toBe(200, JSON.stringify(res.data));
    return { ...res.data, code, verifier };
  }

  beforeAll(async () => {
    user = await makeAccount('oauth.owner');
    other = await makeAccount('oauth.other');
    resetRateLimits();
    const res = await register();
    expect(res.status).toBe(201, JSON.stringify(res.data));
    clientId = res.data.client_id;
  });

  beforeEach(() => resetRateLimits());

  describe('discovery', () => {
    it('answers an unauthenticated MCP call with a 401 that points at the metadata', async () => {
      const res = await http.post(
        `${BASE}/mcp`,
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { headers: { 'Content-Type': 'application/json' } }
      );
      expect(res.status).toBe(401);
      const header = res.headers['www-authenticate'];
      expect(header).toContain(`resource_metadata="${protectedResourceMetadataUrl()}"`);
      // RFC 6750: no error code when no credential was sent.
      expect(header).not.toContain('error=');

      const bad = await mcp('dsat_' + 'x'.repeat(43), 'tools/list');
      expect(bad.status).toBe(401);
      expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it('serves the protected-resource metadata at the path-specific and bare urls', async () => {
      const path = new URL(protectedResourceMetadataUrl()).pathname;
      for (const url of [`${BASE}${path}`, `${BASE}/.well-known/oauth-protected-resource`]) {
        // eslint-disable-next-line no-await-in-loop -- two urls, same document
        const res = await http.get(url);
        expect(res.status).toBe(200, url);
        expect(res.data.resource).toBe(mcpResourceUrl());
        expect(res.data.authorization_servers).toEqual([oauthIssuer()]);
        expect(res.data.scopes_supported).toEqual(['documents:read', 'documents:write']);
      }
      expect(
        (await http.get(`${BASE}/.well-known/oauth-protected-resource/elsewhere`)).status
      ).toBe(404);
    });

    it('serves the authorization server metadata, also as openid-configuration', async () => {
      for (const name of ['oauth-authorization-server', 'openid-configuration']) {
        // eslint-disable-next-line no-await-in-loop -- two names, same document
        const res = await http.get(`${BASE}/.well-known/${name}`);
        expect(res.status).toBe(200);
        expect(res.data.issuer).toBe(oauthIssuer());
        expect(res.data.code_challenge_methods_supported).toEqual(['S256']);
        expect(res.data.token_endpoint_auth_methods_supported).toEqual(['none']);
        expect(res.data.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
        expect(res.data.token_endpoint).toMatch(/\/oauth\/token$/);
        expect(res.data.registration_endpoint).toMatch(/\/oauth\/register$/);
        expect(res.data.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
      }
    });
  });

  describe('client registration', () => {
    it('registers every client as a public one, without a secret', async () => {
      const res = await register({ token_endpoint_auth_method: 'client_secret_post' });
      expect(res.status).toBe(201);
      expect(res.data.client_id).toBeTruthy();
      expect(res.data.client_secret).toBeUndefined();
      expect(res.data.token_endpoint_auth_method).toBe('none');
      expect(res.data.redirect_uris).toEqual([CHATGPT_REDIRECT]);
    });

    it('accepts loopback http and app schemes, refuses plain http and script schemes', async () => {
      expect((await register({ redirect_uris: ['http://127.0.0.1:33418/callback'] })).status).toBe(
        201
      );
      expect((await register({ redirect_uris: ['vscode://vscode.mcp/callback'] })).status).toBe(
        201
      );
      for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'file:///etc/passwd']) {
        // eslint-disable-next-line no-await-in-loop -- one per uri
        const res = await register({ redirect_uris: [uri] });
        expect(res.status).toBe(400, uri);
      }
    });

    it('keeps the client tables away from the REST classes endpoint', async () => {
      for (const className of [
        'contracts_OAuthClient',
        'contracts_OAuthRequest',
        'contracts_OAuthGrant',
      ]) {
        const query = new Parse.Query(className);
        // eslint-disable-next-line no-await-in-loop -- one per class
        await expectAsync(query.find({ sessionToken: user.getSessionToken() })).toBeRejected();
      }
    });
  });

  describe('authorization', () => {
    it('sends the browser to the consent page and describes the request there', async () => {
      const { challenge } = pkce();
      const res = await authorize(clientId, { challenge });
      expect(res.status).toBe(302);
      const requestId = requestIdFrom(res.headers.location);
      const info = await Parse.Cloud.run(
        'oauthrequest',
        { requestId },
        { sessionToken: user.getSessionToken() }
      );
      expect(info.clientName).toBe('ChatGPT');
      expect(info.redirectHost).toBe('chatgpt.com');
      expect(info.scopes).toEqual(['documents:read', 'documents:write']);
      await expectAsync(Parse.Cloud.run('oauthrequest', { requestId })).toBeRejected();
    });

    it('refuses an unregistered redirect uri without redirecting', async () => {
      const { challenge } = pkce();
      const res = await authorize(clientId, { challenge, redirectUri: 'https://evil.example/cb' });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('reports an unknown resource or scope back to the client', async () => {
      const { challenge } = pkce();
      const wrongResource = await authorize(clientId, {
        challenge,
        resource: 'https://other.example/mcp',
      });
      expect(wrongResource.status).toBe(302);
      const back = new URL(wrongResource.headers.location);
      expect(`${back.origin}${back.pathname}`).toBe(CHATGPT_REDIRECT);
      expect(back.searchParams.get('error')).toBe('invalid_target');
      expect(back.searchParams.get('state')).toBe('st-123');

      const wrongScope = await authorize(clientId, { challenge, scope: 'admin' });
      expect(new URL(wrongScope.headers.location).searchParams.get('error')).toBe('invalid_scope');
    });

    it('returns access_denied when the user says no, and the request is then spent', async () => {
      const { challenge } = pkce();
      const res = await authorize(clientId, { challenge });
      const requestId = requestIdFrom(res.headers.location);
      const session = { sessionToken: user.getSessionToken() };
      const { redirectUrl } = await Parse.Cloud.run(
        'oauthdecide',
        { requestId, approve: false },
        session
      );
      const back = new URL(redirectUrl);
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.get('state')).toBe('st-123');
      expect(back.searchParams.get('code')).toBeNull();
      await expectAsync(
        Parse.Cloud.run('oauthdecide', { requestId, approve: true }, session)
      ).toBeRejected();
    });

    it('refuses a request whose consent window has passed', async () => {
      const { challenge } = pkce();
      const res = await authorize(clientId, { challenge });
      const requestId = requestIdFrom(res.headers.location);
      const row = await new Parse.Query('contracts_OAuthRequest')
        .equalTo('RequestId', requestId)
        .first({ useMasterKey: true });
      row.set('ExpiresAt', new Date(Date.now() - 1000));
      await row.save(null, { useMasterKey: true });
      await expectAsync(
        Parse.Cloud.run('oauthrequest', { requestId }, { sessionToken: user.getSessionToken() })
      ).toBeRejected();
    });
  });

  describe('tokens', () => {
    it('needs the right PKCE verifier, then issues a token pair bound to the user', async () => {
      const { verifier, challenge } = pkce();
      const start = await authorize(clientId, { challenge });
      const requestId = requestIdFrom(start.headers.location);
      const { redirectUrl } = await Parse.Cloud.run(
        'oauthdecide',
        { requestId, approve: true },
        { sessionToken: user.getSessionToken() }
      );
      const code = new URL(redirectUrl).searchParams.get('code');
      expect(new URL(redirectUrl).searchParams.get('state')).toBe('st-123');

      const wrong = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce().verifier,
        client_id: clientId,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.data.error).toBe('invalid_grant');

      const ok = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CHATGPT_REDIRECT,
      });
      expect(ok.status).toBe(200, JSON.stringify(ok.data));
      expect(ok.data.token_type).toBe('Bearer');
      expect(ok.data.access_token).toMatch(/^dsat_/);
      expect(ok.data.refresh_token).toMatch(/^dsrt_/);
      expect(ok.data.expires_in).toBe(3600);
      expect(ok.data.scope).toBe('documents:read documents:write');
      expect(ok.headers['cache-control']).toBe('no-store');

      const who = await mcp(ok.data.access_token, 'tools/call', { name: 'whoami', arguments: {} });
      expect(who.status).toBe(200);
      expect(JSON.parse(who.data.result.content[0].text).email).toBe(user.get('email'));
    });

    it('treats a replayed code as stolen and ends the connection it produced', async () => {
      const first = await connect();
      expect((await mcp(first.access_token, 'tools/list')).status).toBe(200);
      const replay = await token({
        grant_type: 'authorization_code',
        code: first.code,
        code_verifier: first.verifier,
        client_id: clientId,
      });
      expect(replay.status).toBe(400);
      expect(replay.data.error).toBe('invalid_grant');
      expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);
    });

    it('rotates refresh tokens and retires the old pair', async () => {
      const first = await connect();
      const refreshed = await token({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId,
      });
      expect(refreshed.status).toBe(200, JSON.stringify(refreshed.data));
      expect(refreshed.data.refresh_token).not.toBe(first.refresh_token);
      expect((await mcp(refreshed.data.access_token, 'tools/list')).status).toBe(200);
      expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);

      const again = await token({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId,
      });
      expect(again.status).toBe(400);
      expect(again.data.error).toBe('invalid_grant');
    });

    it('does not let another client use the refresh token', async () => {
      const first = await connect();
      const otherClient = (await register({ client_name: 'Someone else' })).data.client_id;
      const res = await token({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: otherClient,
      });
      expect(res.status).toBe(400);
    });

    it('revokes the whole connection from either token', async () => {
      const first = await connect();
      const res = await http.post(
        `${BASE}/oauth/revoke`,
        ...form({ token: first.refresh_token, client_id: clientId })
      );
      expect(res.status).toBe(200);
      expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);
    });

    it('only works on the MCP endpoint, not the REST API', async () => {
      const first = await connect();
      const res = await http.get(`${BASE}/v1/documents`, {
        headers: { Authorization: `Bearer ${first.access_token}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('scopes and safety labels', () => {
    it('labels every tool and says which scope it needs', async () => {
      const { access_token: accessToken } = await connect();
      const res = await mcp(accessToken, 'tools/list');
      const tools = res.data.result.tools;
      expect(tools.length).toBe(Object.keys(TOOL_ANNOTATIONS).length);
      for (const tool of tools) {
        expect(typeof tool.annotations?.readOnlyHint).toBe('boolean', tool.name);
        expect(typeof tool.annotations?.destructiveHint).toBe('boolean', tool.name);
        expect(tool._meta?.securitySchemes?.[0]?.scopes).toEqual(
          [tool.annotations.readOnlyHint ? 'documents:read' : 'documents:write'],
          tool.name
        );
      }
      const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
      expect(byName.send_document.annotations).toEqual(
        jasmine.objectContaining({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        })
      );
      expect(byName.list_documents.annotations.readOnlyHint).toBeTrue();
      expect(byName.delete_draft.annotations.destructiveHint).toBeTrue();
    });

    it('gives a read-only connection only the tools that change nothing', async () => {
      const { access_token: accessToken, scope } = await connect({ scope: 'documents:read' });
      expect(scope).toBe('documents:read');
      const tools = (await mcp(accessToken, 'tools/list')).data.result.tools;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every(tool => tool.annotations.readOnlyHint)).toBeTrue();
      const names = tools.map(tool => tool.name);
      expect(names).toContain('list_documents');
      expect(names).not.toContain('send_document');

      const call = await mcp(accessToken, 'tools/call', {
        name: 'void_document',
        arguments: { documentId: 'x' },
      });
      const failed = call.data.error || call.data.result?.isError;
      expect(failed).toBeTruthy();
    });
  });

  describe('connected apps', () => {
    it('lists the connections of the signed-in user only, and disconnects them', async () => {
      const mine = await connect();
      const theirs = await connect({ as: other });
      const session = { sessionToken: user.getSessionToken() };
      const { grants } = await Parse.Cloud.run('listoauthgrants', {}, session);
      expect(grants.length).toBeGreaterThan(0);
      expect(grants[0]).toEqual(
        jasmine.objectContaining({ clientName: 'ChatGPT', redirectHost: 'chatgpt.com' })
      );
      expect(Object.keys(grants[0]).some(key => /hash/i.test(key))).toBeFalse();

      const otherGrants = (
        await Parse.Cloud.run('listoauthgrants', {}, { sessionToken: other.getSessionToken() })
      ).grants;
      // Somebody else's connection cannot be disconnected from this account.
      const notMine = await Parse.Cloud.run(
        'revokeoauthgrant',
        { grantId: otherGrants[0].id },
        session
      );
      expect(notMine.revoked).toBeFalse();
      expect((await mcp(theirs.access_token, 'tools/list')).status).toBe(200);

      for (const grant of grants) {
        // eslint-disable-next-line no-await-in-loop -- a handful of rows
        await Parse.Cloud.run('revokeoauthgrant', { grantId: grant.id }, session);
      }
      expect((await mcp(mine.access_token, 'tools/list')).status).toBe(401);
      expect((await Parse.Cloud.run('listoauthgrants', {}, session)).grants).toEqual([]);
    });

    it('ends every connection when an account is cut off', async () => {
      const first = await connect({ as: other });
      const { revoked } = await revokeOAuthGrantsForUser(other.id);
      expect(revoked).toBeGreaterThan(0);
      expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);
    });
  });
});
