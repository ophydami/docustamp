import type { App } from "@modelcontextprotocol/ext-apps";
import type { OpenAIExtensions } from "@openai/mcp-extensions/app";

/**
 * Talking to DocuStamp from inside the host.
 *
 * Every call goes through the host (`tools/call`), which adds the user's own
 * connection, so the page never holds a token and can do nothing the
 * connection could not. App-only tools answer in `structuredContent`; the
 * ordinary tools (send_document, send_reminder...) answer with JSON text.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

function textOf(result: ToolResult): string {
  return (result.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** "Error (141): You have already signed" -> "You have already signed". */
function cleanError(text: string): string {
  return text.replace(/^Error(?: \([^)]*\))?:\s*/, "").trim() || "Something went wrong. Please try again.";
}

export async function callTool<T>(app: App, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(cleanError(textOf(result)));
  if (result.structuredContent) return result.structuredContent as T;
  const text = textOf(result);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Tell the model what the user just did in the app, without showing an
 * attachment in the composer (`audience: assistant`), so its next answer does
 * not contradict the screen ("I have not sent it yet").
 */
export async function tellModel(ext: OpenAIExtensions | null, text: string): Promise<void> {
  try {
    await ext?.modelContext?.update({
      content: [{ type: "text", text, annotations: { audience: ["assistant"] } }]
    });
  } catch {
    // Context is a nicety; the action itself already happened.
  }
}

/** Put a prompt in the conversation as if the user typed it (ChatGPT `ui/message`), else the MCP Apps one. */
export async function askAssistant(app: App, ext: OpenAIExtensions | null, text: string): Promise<void> {
  const content = [{ type: "text" as const, text }];
  if (ext?.message) {
    await ext.message.send({ role: "user", content });
    return;
  }
  await app.sendMessage({ role: "user", content });
}

/** Open a url in the user's browser, through the host (the sandbox cannot navigate). */
export async function openUrl(app: App, url: string | undefined): Promise<void> {
  if (!url) return;
  await app.openLink({ url });
}
