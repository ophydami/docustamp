#!/usr/bin/env node
/**
 * Builds the DocuStamp app for ChatGPT and other MCP Apps hosts
 * (src/mcp-app/) into one self-contained page, dist/mcp-app.html.
 *
 * Hosts load the page from the MCP server as a single HTML string
 * (apps/server/cloud/mcp/app.js reads this file) into a sandbox whose CSP
 * blocks outside scripts and stylesheets, so the script and the CSS are
 * inlined into src/mcp-app/index.html instead of being separate files.
 *
 * Runs after `vite build` (which empties dist/), as part of `npm run build`.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(WEB, "dist", "mcp-app.html");

const output = await build({
  configFile: false,
  root: WEB,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(WEB, "src") } },
  // Library mode leaves process.env.NODE_ENV alone; React needs it settled.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    cssCodeSplit: false,
    // The embedded fonts (src/mcp-app/fonts.css) go into the CSS as data urls.
    assetsInlineLimit: 1024 * 1024,
    lib: {
      entry: join(WEB, "src", "mcp-app", "main.tsx"),
      formats: ["iife"],
      name: "DocuStampApp",
      fileName: () => "mcp-app.js"
    },
    rolldownOptions: { output: { codeSplitting: false } }
  }
});

const items = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
const scripts = items.filter((item) => item.type === "chunk");
const styles = items.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"));
const other = items.filter((item) => item.type === "asset" && !item.fileName.endsWith(".css"));
if (scripts.length !== 1) throw new Error(`expected one script, got ${scripts.length}`);
if (other.length) throw new Error(`unexpected assets: ${other.map((a) => a.fileName).join(", ")}`);

const js = scripts[0].code.replace(/<\/script/gi, "<\\/script");
const css = styles
  .map((asset) => String(asset.source))
  .join("\n")
  .replace(/<\/style/gi, "<\\/style");
const template = await readFile(join(WEB, "src", "mcp-app", "index.html"), "utf8");
const html = template
  .replace("<!-- APP_STYLE -->", () => `<style>${css}</style>`)
  .replace("<!-- APP_SCRIPT -->", () => `<script>${js}</script>`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`mcp-app: wrote dist/mcp-app.html (${Math.round(html.length / 1024)} KB)`);
