#!/usr/bin/env node
/**
 * Writes docs/MCP_TOOLS.md, the per-tool reference for the MCP server, from the
 * live tool list.
 *
 * The tools, their safety labels (TOOL_ANNOTATIONS in cloud/mcp/server.js),
 * their OAuth scopes and their input schemas all live in code; the reference
 * that platforms reviewing a connector ask for (read / write / sensitive per
 * tool, inputs, scopes) used to exist only there. This builds the same McpServer
 * the endpoint builds, connects an in-memory MCP client to it and renders what
 * `tools/list` answers, so the document cannot say anything the server does not.
 *
 * No database is touched: building the server only registers tools. `Parse` is
 * set from parse/node because modules reference it at import time.
 *
 *   node scripts/mcp-reference.mjs           check docs/MCP_TOOLS.md
 *   node scripts/mcp-reference.mjs --write   regenerate it
 *
 * Exits 1 when the file is out of step (npm run mcp:docs:check, run by server-ci).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(SERVER, '..', '..', 'docs', 'MCP_TOOLS.md');
const RELATIVE_OUT = 'docs/MCP_TOOLS.md';

// The product name is part of many descriptions; a self-hoster's APP_NAME must
// not make the committed file drift.
process.env.APP_NAME = 'DocuStamp';
const require = createRequire(import.meta.url);
globalThis.Parse = require('parse/node');

const { buildMcpServer, MCP_SERVER_INFO } = await import('../cloud/mcp/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const BASE_CALLER = Object.freeze({
  userId: 'reference',
  id: 'reference',
  name: 'Reference',
  email: 'reference@example.com',
  publicUrl: 'https://sign.example.com',
});

/** What `tools/list` answers for a caller shaped like the endpoint's. */
async function listTools(caller) {
  const server = buildMcpServer(caller);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'mcp-reference', version: '1.0.0' });
  await client.connect(clientSide);
  const tools = [];
  let cursor;
  do {
    // Pages follow each other's cursor, so they cannot be fetched in parallel.
    // eslint-disable-next-line no-await-in-loop
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  await server.close();
  return tools;
}

function oauthCaller(scopes) {
  return {
    ...BASE_CALLER,
    scopes,
    oauth: { clientId: 'reference', clientName: 'Reference', redirectHost: 'example.com' },
  };
}

/** read | write | sensitive, from the tool's own labels. */
function classOf(tool) {
  const a = tool.annotations || {};
  if (a.destructiveHint === true) return 'sensitive';
  if (a.readOnlyHint === true) return 'read';
  return 'write';
}

function scopeOf(tool) {
  const scheme = (tool._meta?.securitySchemes || []).find(s => s?.type === 'oauth2');
  return scheme?.scopes?.[0] || '';
}

/** Called by the DocuStamp app's own screens, not offered to the model. */
function isAppOnly(tool) {
  const visibility = tool._meta?.ui?.visibility;
  return Array.isArray(visibility) && visibility.length > 0 && !visibility.includes('model');
}

/** One line, safe inside a markdown table cell. */
function cell(value) {
  return String(value ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** A short type for one JSON Schema property. */
function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map(v => JSON.stringify(v)).join(' \\| ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alternatives = schema.anyOf || schema.oneOf;
  if (Array.isArray(alternatives)) {
    return [...new Set(alternatives.map(typeOf))].join(' or ');
  }
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
  if (type === 'array') return `array of ${typeOf(schema.items)}`;
  if (type === 'object') {
    const keys = Object.keys(schema.properties || {});
    if (keys.length) return `object {${keys.join(', ')}}`;
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      return `map of ${typeOf(schema.additionalProperties)}`;
    }
    return 'object';
  }
  if (type === 'integer' || type === 'number') {
    // zod's .int() also emits the safe-integer range, which says nothing.
    const real = value => value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER;
    const bounds = [];
    if (real(schema.minimum)) bounds.push(`min ${schema.minimum}`);
    if (real(schema.maximum)) bounds.push(`max ${schema.maximum}`);
    return bounds.length ? `${type} (${bounds.join(', ')})` : type;
  }
  if (type === 'string') {
    const bounds = [];
    if (schema.minLength !== undefined) bounds.push(`min ${schema.minLength}`);
    if (schema.maxLength !== undefined) bounds.push(`max ${schema.maxLength}`);
    return bounds.length ? `string (${bounds.join(', ')} chars)` : 'string';
  }
  return type || 'any';
}

/** The object schema a property holds directly or per array item, if any. */
function nestedObject(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const alternatives = schema.anyOf || schema.oneOf;
  if (Array.isArray(alternatives)) {
    for (const alt of alternatives) {
      const found = nestedObject(alt);
      if (found) return found;
    }
    return null;
  }
  if (schema.type === 'array') {
    const inner = nestedObject(schema.items);
    return inner ? { ...inner, path: `[]${inner.path}` } : null;
  }
  if (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length) {
    return { schema, path: '' };
  }
  return null;
}

/**
 * One row per input, then one per key of an object input (or of each item of
 * an array of objects), two levels deep, so the keys' own descriptions show.
 */
function inputRows(properties, requiredList, prefix = '', depth = 0) {
  const required = new Set(requiredList || []);
  const rows = [];
  for (const [name, property] of Object.entries(properties || {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    rows.push(
      `| \`${path}\` | ${cell(typeOf(property))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(property?.description)} |`
    );
    const nested = depth < 2 ? nestedObject(property) : null;
    if (nested) {
      rows.push(
        ...inputRows(nested.schema.properties, nested.schema.required, `${path}${nested.path}`, depth + 1)
      );
    }
  }
  return rows;
}

function inputsTable(tool) {
  const schema = tool.inputSchema || {};
  if (!Object.keys(schema.properties || {}).length) return 'No inputs.';
  const rows = inputRows(schema.properties, schema.required);
  return ['| Input | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function countBy(tools, cls) {
  return tools.filter(t => classOf(t) === cls).length;
}

function render({ all, readOnly, connected }) {
  const readOnlyNames = new Set(readOnly.map(t => t.name));
  const connectedNames = new Set(connected.map(t => t.name));
  const modelTools = all.filter(t => !isAppOnly(t));
  const appTools = all.filter(isAppOnly);

  const access = tool => {
    if (readOnlyNames.has(tool.name)) return 'all';
    if (connectedNames.has(tool.name)) return 'read and write';
    return 'API tokens only';
  };

  const summaryRows = list =>
    list.map(t => `| [\`${t.name}\`](#${t.name}) | ${classOf(t)} | ${scopeOf(t)} | ${access(t)} |`);

  const section = t =>
    [
      `### ${t.name}`,
      '',
      `**${cell(t.title || t.name)}.** Class: **${classOf(t)}**. Scope: \`${scopeOf(t)}\`. Connections: ${access(t)}.`,
      `Labels: readOnlyHint ${t.annotations?.readOnlyHint === true}, destructiveHint ${t.annotations?.destructiveHint === true}, openWorldHint ${t.annotations?.openWorldHint === true}.`,
      '',
      String(t.description || '').trim(),
      '',
      inputsTable(t),
      '',
    ].join('\n');

  return `# ${MCP_SERVER_INFO.title || 'DocuStamp'} MCP tools

<!--
  GENERATED FILE: do not edit by hand. Built from the live tool list of
  apps/server/cloud/mcp/server.js and cloud/mcp/app.js by
  apps/server/scripts/mcp-reference.mjs. Run \`npm run mcp:docs\` in apps/server
  after changing a tool; \`npm run mcp:docs:check\` (run by server-ci) fails when
  this file is out of step.
-->

The reference for every tool the MCP server offers: what it does, its safety
class, the OAuth scope it needs and its inputs. The narrative guide (flows,
signing, approvals, the REST API) is [AI_AND_MCP.md](AI_AND_MCP.md).

Server \`${MCP_SERVER_INFO.name}\` version ${MCP_SERVER_INFO.version}: ${modelTools.length} tools
(${countBy(modelTools, 'read')} read, ${countBy(modelTools, 'write')} write, ${countBy(modelTools, 'sensitive')} sensitive),
plus ${appTools.length} that only the ${MCP_SERVER_INFO.title || 'DocuStamp'} app screens call.

## Connecting

- **Endpoint:** \`https://<your host>/api/mcp\`, Streamable HTTP, stateless: POST
  only, no sessions. Every request carries \`Authorization: Bearer <token>\`.
- **Signing in (OAuth 2.1):** a request without a token gets a 401 whose
  \`WWW-Authenticate\` header points at
  \`/.well-known/oauth-protected-resource/api/mcp\`; the authorization server
  metadata is at \`/.well-known/oauth-authorization-server\`. Clients register
  themselves (dynamic client registration at \`/api/oauth/register\`), are public
  clients (no client secret, token endpoint auth \`none\`) and must use PKCE with
  \`S256\`. Redirect urls must be https, or http on a loopback address. The user
  approves on the consent page; access tokens (\`dsat_\`) last one hour, refresh
  tokens (\`dsrt_\`) 30 days and rotate on every use. Revoking at
  \`/api/oauth/revoke\`, or disconnecting under Settings > API and MCP, stops the
  connection on its next call.
- **Personal API tokens:** created under Settings > API and MCP (\`os_...\`),
  sent as \`Authorization: Bearer\` or \`x-api-token\`. A token is the user's own
  key: it carries every tool and no scopes.

## Scopes

| Scope | Allows |
| --- | --- |
| \`documents:read\` | Every **read** tool: list, look at and download documents, drafts, templates, contacts and the audit trail. |
| \`documents:write\` | Adds every **write** and **sensitive** tool: create and edit drafts, send, remind, void, manage templates, contacts, folders and webhooks. Includes \`documents:read\`. |
| \`documents:sign\` | Lets \`sign_document\` sign the user's own part, and \`signForMe\` on \`send_document\` and \`quick_send\` sign it as the document goes out. Checked on every call, not in the tool list: those tools are offered with \`documents:write\` and refuse to sign without it. Never granted because an app asked: only the user turns it on ("Can sign for me" on the consent page or under Settings > API and MCP), and only with a verified email. |

An app that asks for nothing in particular gets \`documents:read\` and
\`documents:write\`. On the consent page the user can choose **Read only**
instead: the connection then gets \`documents:read\` alone and never sees a tool
that changes anything (the "Connections" column below). Connected apps never
receive signing links: \`get_signing_links\` is offered to API tokens only, and
link fields are removed from every result an OAuth connection gets.

## Classes

Every tool carries MCP annotations, and its class follows from them:

| Class | Annotations | Meaning |
| --- | --- | --- |
| **read** | \`readOnlyHint: true\` | Looks only. Changes no data, account state or permissions. |
| **write** | \`readOnlyHint: false\`, \`destructiveHint: false\` | Changes the user's own data (drafts, templates, contacts, folders) and reaches nobody else. |
| **sensitive** | \`destructiveHint: true\` | Reaches other people (emails signers, posts to a webhook url) or cannot be undone (signing, voiding, deleting). Hosts should confirm every use. |

A tool that both reads and writes is labelled as a write. Drafts are never sent
by a write tool: \`create_document\` and \`create_document_from_template\` only make
drafts, and sending is always a sensitive call (\`send_document\`,
\`quick_send\`). \`openWorldHint: true\` marks tools that may fetch a PDF from a
public url or reach an outside address.

## Errors

A tool that fails returns a normal MCP result with \`isError: true\` and one text
part, \`Error (<code>): <message>\`, where the message is a plain sentence meant to
be shown to the user or acted on (for example "Document has already been
declined."). Internal and provider failures are replaced with "Internal error."
so no server detail leaks. Inputs that do not match the schema are refused by the
MCP layer before the tool runs. Transport-level failures are JSON-RPC errors:
401 (missing, expired or revoked token, with \`WWW-Authenticate\`), 405 (not a
POST), 413 (body over the limit, 72 MB by default) and 429 (rate limit).

## Limits

- 120 requests a minute per token, and 240 a minute per client IP before the
  token is checked.
- 10 AI calls a minute per account (\`analyze_document\`, \`quick_send\`,
  \`ai_layout_draft\`, \`review_document\`), whatever the entry point.
- Counters are kept per server process.

## Statuses

- Documents: \`draft\`, \`in_progress\`, \`completed\`, \`declined\`, \`voided\`,
  \`expired\`. Each signer: \`pending\`, \`signed\`, \`declined\`, \`voided\`.
- Documents sent to the user (\`list_inbox\`): \`needs_you\` (their turn),
  \`waiting\`, \`completed\`.
- Signing approvals (\`get_approval\`): \`pending\`, \`signed\`, \`declined\`,
  \`failed\`, \`expired\`.

## Summary

"Connections" says which OAuth connections are offered the tool: \`all\`
(read-only ones too), \`read and write\`, or \`API tokens only\`.

| Tool | Class | Scope | Connections |
| --- | --- | --- | --- |
${summaryRows(modelTools).join('\n')}

## Tools

${modelTools.map(section).join('\n')}
## App-only tools

Called by the ${MCP_SERVER_INFO.title || 'DocuStamp'} app screens shown inside hosts that support MCP
Apps (\`_meta.ui.visibility: ["app"]\`), not offered to the model.

| Tool | Class | Scope | Connections |
| --- | --- | --- | --- |
${summaryRows(appTools).join('\n')}

${appTools.map(section).join('\n')}`.replace(/\n+$/, '\n');
}

const [all, readOnly, connected] = await Promise.all([
  listTools({ ...BASE_CALLER }),
  listTools(oauthCaller(['documents:read'])),
  listTools(oauthCaller(['documents:read', 'documents:write'])),
]);
if (!all.length) {
  console.error('mcp-reference: the server registered no tools.');
  process.exit(1);
}

const wanted = render({ all, readOnly, connected });

if (process.argv.includes('--write')) {
  writeFileSync(OUT_FILE, wanted);
  console.log(`mcp-reference: wrote ${all.length} tools to ${RELATIVE_OUT}`);
  process.exit(0);
}

const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
if (current === wanted) {
  console.log(`mcp-reference: ${RELATIVE_OUT} matches the ${all.length} registered tools`);
  process.exit(0);
}

const documented = new Set([...current.matchAll(/^### ([a-z0-9_]+)$/gm)].map(m => m[1]));
const registered = new Set(all.map(t => t.name));
const missing = [...registered].filter(n => !documented.has(n));
const extra = [...documented].filter(n => !registered.has(n));
console.error(`mcp-reference: ${RELATIVE_OUT} is out of step with the server.`);
if (missing.length) console.error(`  not documented: ${missing.join(', ')}`);
if (extra.length) console.error(`  no longer registered: ${extra.join(', ')}`);
if (!missing.length && !extra.length) console.error('  same tools, different labels, inputs or text');
console.error('  run: npm run mcp:docs (in apps/server)');
process.exit(1);
