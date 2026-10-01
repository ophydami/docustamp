/**
 * The DocuStamp app for MCP Apps hosts (cloud/mcp/app.js): the UI resource,
 * the ChatGPT entrypoints, the views' data and the app-only tools.
 */
import axios from 'axios';
import { APP_RESOURCE_URI } from '../cloud/mcp/app.js';
import { resetRateLimits } from '../cloud/parsefunction/authGuard.js';
import { uniqueEmail } from './support/env.js';

const BASE = 'http://localhost:30001';
const http = axios.create({ validateStatus: () => true });

describe('MCP app views', () => {
  Parse.User.enableUnsafeCurrentUser();

  let token;
  let rpcId = 0;

  async function rpc(method, params = {}) {
    rpcId += 1;
    const res = await http.post(
      `${BASE}/mcp`,
      { jsonrpc: '2.0', id: rpcId, method, params },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      }
    );
    expect(res.status).toBe(200, JSON.stringify(res.data));
    expect(res.data.error).toBeUndefined(JSON.stringify(res.data.error));
    return res.data.result;
  }

  beforeAll(async () => {
    const email = uniqueEmail('mcp.app', 'example.test');
    const user = new Parse.User();
    user.set('username', email);
    user.set('password', 'pa55word!');
    user.set('email', email);
    await user.signUp();
    const signedIn = await Parse.User.logIn(email, 'pa55word!');
    const tenant = new Parse.Object('partners_Tenant');
    tenant.set('TenantName', 'Ophy Labs');
    tenant.set('UserId', signedIn.toPointer());
    await tenant.save(null, { useMasterKey: true });
    const extUser = new Parse.Object('contracts_Users');
    extUser.set('Name', 'App Person');
    extUser.set('Email', email);
    extUser.set('UserId', signedIn.toPointer());
    extUser.set('TenantId', tenant.toPointer());
    extUser.set('UserRole', 'contracts_Admin');
    await extUser.save(null, { useMasterKey: true });
    const res = await Parse.Cloud.run(
      'generateapitoken',
      {},
      { sessionToken: signedIn.getSessionToken() }
    );
    token = res.token;
  });

  beforeEach(() => resetRateLimits());

  it('names itself with an icon the host can show in its sidebar', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '1' },
    });
    expect(result.serverInfo.title).toBe('DocuStamp');
    expect(result.serverInfo.icons[0].mimeType).toBe('image/svg+xml');
    expect(result.serverInfo.icons[0].src).toMatch(/^data:image\/svg\+xml,/);
  });

  it('registers one MCP Apps page, with no outside network access', async () => {
    const { resources } = await rpc('resources/list');
    const entry = resources.find(r => r.uri === APP_RESOURCE_URI);
    expect(entry).toBeDefined();
    expect(entry.mimeType).toBe('text/html;profile=mcp-app');

    const { contents } = await rpc('resources/read', { uri: APP_RESOURCE_URI });
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0].text).toMatch(/<html/i);
    expect(contents[0]._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    expect(contents[0]._meta['openai/ui'].availableDisplayModes).toEqual(['inline', 'fullscreen']);
  });

  it('points the entrypoints and cards at the page, and hides the data tools from the model', async () => {
    const { tools } = await rpc('tools/list');
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));

    expect(byName.open_docustamp._meta.ui.resourceUri).toBe(APP_RESOURCE_URI);
    expect(byName.open_docustamp._meta['openai/ui'].entrypoints).toEqual([{ type: 'global' }]);
    expect(byName.open_review_panel._meta['openai/ui'].entrypoints).toEqual([{ type: 'thread' }]);
    // ChatGPT asks for a thread entrypoint title that differs from the plugin name.
    expect(byName.open_review_panel.title).not.toBe(byName.open_docustamp.title);
    expect(byName.show_document._meta.ui.resourceUri).toBe(APP_RESOURCE_URI);
    expect(byName.show_documents._meta.ui.resourceUri).toBe(APP_RESOURCE_URI);
    for (const name of ['app_home', 'app_document', 'app_page']) {
      expect(byName[name]._meta.ui.visibility).toEqual(['app'], name);
    }
    for (const name of ['open_docustamp', 'open_review_panel', 'show_document', 'show_documents']) {
      expect(byName[name].annotations.readOnlyHint).toBeTrue();
    }
  });

  it('gives the home view its three lists and a one-line summary for the model', async () => {
    const result = await rpc('tools/call', { name: 'open_docustamp', arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent;
    expect(data.view).toBe('home');
    expect(data.canWrite).toBeTrue();
    expect(data.waiting).toEqual([]);
    expect(data.drafts).toEqual([]);
    expect(data.completed).toEqual([]);
    expect(result.content[0].text).toMatch(/0 documents waiting on signers/);

    const panel = await rpc('tools/call', { name: 'open_review_panel', arguments: {} });
    expect(panel.structuredContent.view).toBe('panel');
  });

  it('answers the list card and refuses a document that is not there', async () => {
    const list = await rpc('tools/call', {
      name: 'show_documents',
      arguments: { filter: 'draft' },
    });
    expect(list.structuredContent).toEqual(
      jasmine.objectContaining({ view: 'list', filter: 'draft', items: [], more: false })
    );

    const missing = await rpc('tools/call', {
      name: 'show_document',
      arguments: { documentId: 'nope000000' },
    });
    expect(missing.isError).toBeTrue();
    const page = await rpc('tools/call', {
      name: 'app_page',
      arguments: { documentId: 'nope000000' },
    });
    expect(page.isError).toBeTrue();
  });
});
