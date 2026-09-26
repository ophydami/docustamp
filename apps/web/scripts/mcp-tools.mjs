#!/usr/bin/env node
/**
 * Keeps the MCP tool list shown on Settings > API in step with the server.
 *
 * The names are registered in apps/server/cloud/mcp/server.js and were
 * hand-copied into the settings page, where they would drift the first time a
 * tool is renamed. The MCP endpoint does expose them through `tools/list`, but
 * only to a caller holding a personal API token, which the settings page does
 * not have (a generated token is shown once and never stored), so the list is
 * generated at development time instead of fetched at runtime.
 *
 *   node scripts/mcp-tools.mjs           check src/features/settings/mcpTools.ts
 *   node scripts/mcp-tools.mjs --write   regenerate it
 *
 * Exits 1 when the generated file is out of step. When the server package is
 * not on disk (the web app can be built on its own) the check exits 0.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_FILE = join(WEB, "..", "server", "cloud", "mcp", "server.js");
const OUT_FILE = join(WEB, "src", "features", "settings", "mcpTools.ts");
const RELATIVE_SERVER = "apps/server/cloud/mcp/server.js";

/** Every `server.registerTool('name', ...)` in registration order. */
function toolNames(source) {
  const names = [];
  const re = /registerTool\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

function render(names) {
  return `/**
 * The MCP tools this server exposes, in registration order.
 *
 * GENERATED FILE - do not edit by hand. The registry is
 * ${RELATIVE_SERVER}; run \`npm run mcp:tools\` after
 * adding, renaming or removing a tool there. \`npm run mcp:check\` fails when
 * this list and the server disagree.
 */
export const MCP_TOOL_NAMES: readonly string[] = [
${names.map((n) => `  "${n}"`).join(",\n")}
];
`;
}

if (!existsSync(SERVER_FILE)) {
  console.log(`mcp-tools: ${RELATIVE_SERVER} is not on disk, skipping.`);
  process.exit(0);
}

const names = toolNames(readFileSync(SERVER_FILE, "utf8"));
if (!names.length) {
  console.error(`mcp-tools: no registerTool() calls found in ${RELATIVE_SERVER}.`);
  process.exit(1);
}

const wanted = render(names);
const write = process.argv.includes("--write");

if (write) {
  writeFileSync(OUT_FILE, wanted);
  console.log(`mcp-tools: wrote ${names.length} tool names to src/features/settings/mcpTools.ts`);
  process.exit(0);
}

const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
if (current === wanted) {
  console.log(`mcp-tools: ${names.length} tool names match ${RELATIVE_SERVER}`);
  process.exit(0);
}

const listed = [...current.matchAll(/^ {2}"([A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
const missing = names.filter((n) => !listed.includes(n));
const extra = listed.filter((n) => !names.includes(n));
console.error("mcp-tools: src/features/settings/mcpTools.ts is out of step with the server.");
if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
if (extra.length) console.error(`  no longer registered: ${extra.join(", ")}`);
if (!missing.length && !extra.length) console.error("  same names, different order or formatting");
console.error("  run: npm run mcp:tools");
process.exit(1);
