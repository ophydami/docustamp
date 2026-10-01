/**
 * A minimal MCP Apps host for developing src/mcp-app/ without ChatGPT.
 *
 *   npm run dev, then open
 *   http://localhost:3001/dev/mcp-host/?mcp=http://localhost:8080/api/mcp&token=os_...&tool=open_docustamp
 *
 * Query parameters:
 *   mcp     the MCP endpoint (the server needs CORS_ORIGINS to include this page's origin)
 *   token   a personal API token (Settings > API and MCP)
 *   tool    the tool to call first (open_docustamp, open_review_panel, show_document, show_documents)
 *   args    its arguments as JSON, e.g. {"documentId":"abc"}
 *   mode    inline | fullscreen | panel (panel = a narrow fullscreen, like ChatGPT's side panel)
 *   theme   light | dark
 *
 * It calls the tool, reads the UI resource the tool points at, loads it into
 * a sandboxed iframe and bridges it to the server like a real host: tool
 * calls go through, display-mode requests resize the frame, and messages,
 * links and model-context updates are logged on the right.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const params = new URLSearchParams(location.search);
const mcpUrl = params.get("mcp") || "http://localhost:8080/api/mcp";
const token = params.get("token") || "";
const tool = params.get("tool") || "open_docustamp";
const args = JSON.parse(params.get("args") || "{}") as Record<string, unknown>;
let mode = (params.get("mode") || "inline") as "inline" | "fullscreen" | "panel";
const theme = (params.get("theme") || "light") as "light" | "dark";

const wrap = document.getElementById("frame-wrap")!;
const logEl = document.getElementById("log")!;
document.getElementById("info")!.textContent = `${tool} ${JSON.stringify(args)} · ${mode} · ${theme}`;
document.documentElement.style.colorScheme = theme;

function log(label: string, value?: unknown) {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${label}${value === undefined ? "" : ` ${JSON.stringify(value, null, 1).slice(0, 600)}`}`;
  logEl.prepend(line);
}

function applyMode() {
  wrap.className = mode;
}

async function main() {
  applyMode();
  const client = new Client({ name: "mcp-app-test-host", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  const { tools } = await client.listTools();
  const def = tools.find((t) => t.name === tool);
  const uri = (def?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (!uri) throw new Error(`${tool} has no UI resource`);
  log("tool", { name: tool, uri });

  const result = await client.callTool({ name: tool, arguments: args });
  log("tool result", { isError: result.isError, structuredContent: Object.keys(result.structuredContent || {}) });
  const resource = await client.readResource({ uri });
  const html = (resource.contents[0] as { text?: string }).text || "";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  iframe.title = "MCP app";
  wrap.replaceChildren(iframe);

  const hostContext = {
    theme,
    displayMode: mode === "panel" ? ("fullscreen" as const) : mode,
    availableDisplayModes: ["inline", "fullscreen"] as ("inline" | "fullscreen")[],
    locale: "en-US",
    platform: "web" as const,
    toolInfo: { tool: def! }
  };
  const bridge = new AppBridge(
    client,
    { name: "mcp-app-test-host", version: "1.0.0" },
    {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {} }
    },
    { hostContext }
  );
  bridge.oninitialized = async () => {
    log("app initialized");
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(result as Parameters<AppBridge["sendToolResult"]>[0]);
  };
  bridge.onsizechange = ({ height }) => {
    if (mode === "inline" && height) wrap.style.height = `${Math.ceil(height)}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode: wanted }) => {
    log("requestDisplayMode", wanted);
    mode = wanted === "fullscreen" ? "fullscreen" : "inline";
    wrap.style.height = "";
    applyMode();
    bridge.setHostContext({ ...hostContext, displayMode: mode === "fullscreen" ? "fullscreen" : "inline" });
    return { mode: wanted };
  };
  bridge.onopenlink = async ({ url }) => {
    log("openLink", url);
    return {};
  };
  bridge.onmessage = async (message) => {
    log("ui/message", message);
    return {};
  };
  bridge.onupdatemodelcontext = async (update) => {
    log("updateModelContext", update);
    return {};
  };
  bridge.onloggingmessage = (message) => log("app log", message);

  // Listen before the page loads: it sends ui/initialize as soon as its script
  // runs. The iframe's window proxy stays the same across the srcdoc navigation.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  log("bridge connected");
  iframe.srcdoc = html;
}

main().catch((err) => log("error", String(err?.stack || err)));
