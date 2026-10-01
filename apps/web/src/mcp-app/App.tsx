import { useCallback, useEffect, useState } from "react";
import { applyDocumentTheme, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { Button } from "@/components/ui/Button";
import { callTool } from "./bridge";
import { Banner, RowsSkeleton } from "./ui";
import {
  DocumentCard,
  DocumentSkeleton,
  DocumentView,
  HomeCard,
  HomeSkeleton,
  HomeView,
  ListCard,
  PanelView,
  type ViewContext
} from "./views";
import type { DocRow, DocumentData, HomeData, ListData, ViewData } from "./types";

/**
 * The DocuStamp app page. One page serves every way the host opens it; the
 * tool result says which (`structuredContent.view`):
 *
 *   home      the sidebar app (open_docustamp)
 *   panel     the panel beside a conversation (open_review_panel)
 *   document  one document (show_document): a card inline, the full view fullscreen
 *   list      a short list (show_documents): a card inline
 *
 * Moving around (opening a document, going back) is local navigation on top
 * of that first view, fed by the app-only tools. The handlers are attached in
 * `onAppCreated`, before the handshake, so the first result is rendered as
 * delivered instead of being fetched a second time.
 *
 * From the host it takes light or dark only: the look is DocuStamp's own
 * (see app.css).
 */

type Screen =
  | { kind: "view"; data: ViewData }
  | { kind: "loading"; expect: "home" | "document" | "list" }
  | { kind: "error"; message: string };

function errorText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = (result.content || []).find((part) => part.type === "text")?.text || "";
  return text.replace(/^Error(?: \([^)]*\))?:\s*/, "") || "Something went wrong.";
}

export default function Root() {
  const [ext, setExt] = useState<OpenAIExtensions | null>(null);
  const [first, setFirst] = useState<Screen>({ kind: "loading", expect: "list" });
  const [stack, setStack] = useState<Screen[]>([]);
  const [mode, setMode] = useState<McpUiDisplayMode>("inline");

  const { app, error } = useApp({
    appInfo: { name: "DocuStamp", version: "1.0.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    autoResize: true,
    onAppCreated: (created) => {
      setExt(new OpenAIExtensions(created));
      created.ontoolresult = (result) => {
        setStack([]);
        if (result.isError) setFirst({ kind: "error", message: errorText(result) });
        else if (result.structuredContent)
          setFirst({ kind: "view", data: result.structuredContent as unknown as ViewData });
      };
      created.onhostcontextchanged = (changed) => {
        if (changed.theme) applyDocumentTheme(changed.theme);
        if (!changed.displayMode) return;
        setMode(changed.displayMode);
        // Back to a card: drop whatever was opened on top of it.
        if (changed.displayMode === "inline") setStack([]);
      };
    }
  });

  const hostContext = app?.getHostContext();
  useEffect(() => {
    if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  }, [hostContext?.theme]);

  const displayMode = hostContext?.displayMode ?? mode;
  const ctx: ViewContext | null = app ? { app, ext, locale: hostContext?.locale } : null;

  const push = useCallback((screen: Screen) => setStack((s) => [...s, screen]), []);
  const replaceTop = useCallback((screen: Screen) => setStack((s) => (s.length ? [...s.slice(0, -1), screen] : s)), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const goFullscreen = useCallback(async () => {
    if (!app || displayMode === "fullscreen") return;
    try {
      await app.requestDisplayMode({ mode: "fullscreen" });
    } catch {
      // The host may refuse; the view still opens where it is.
    }
  }, [app, displayMode]);

  const open = useCallback(
    async (expect: "home" | "document", load: () => Promise<ViewData>) => {
      await goFullscreen();
      push({ kind: "loading", expect });
      try {
        replaceTop({ kind: "view", data: await load() });
      } catch (err) {
        replaceTop({ kind: "error", message: (err as Error).message });
      }
    },
    [goFullscreen, push, replaceTop]
  );
  const openDocument = (doc: DocRow) =>
    app && void open("document", () => callTool<DocumentData>(app, "app_document", { documentId: doc.objectId }));
  const openHome = () => app && void open("home", () => callTool<HomeData>(app, "app_home"));

  if (error)
    return (
      <div className="p-4">
        <Banner tone="danger">Could not connect to the host: {error.message}</Banner>
      </div>
    );

  const top = stack.length ? stack[stack.length - 1] : first;
  const canGoBack = stack.length > 0;
  const inline = displayMode === "inline" && !canGoBack;

  if (!ctx || top.kind === "loading") {
    const expect = top.kind === "loading" ? top.expect : "list";
    if (expect === "document") return <DocumentSkeleton />;
    if (expect === "home" && !inline) return <HomeSkeleton />;
    return <RowsSkeleton rows={2} />;
  }
  if (top.kind === "error")
    return (
      <div className="flex flex-col gap-3 p-4">
        <Banner tone="danger">{top.message}</Banner>
        {canGoBack ? (
          <Button size="sm" className="self-start" onClick={back}>
            Back
          </Button>
        ) : null}
      </div>
    );

  const data = top.data;
  const updateTop = (next: ViewData) =>
    stack.length ? replaceTop({ kind: "view", data: next }) : setFirst({ kind: "view", data: next });

  if (data.view === "document") {
    return inline ? (
      <DocumentCard
        ctx={ctx}
        data={data}
        onChanged={updateTop}
        onExpand={() => {
          void goFullscreen();
          push({ kind: "view", data });
        }}
      />
    ) : (
      <DocumentView ctx={ctx} data={data} onBack={canGoBack ? back : undefined} onChanged={updateTop} />
    );
  }
  if (data.view === "list")
    return <ListCard ctx={ctx} data={data as ListData} onOpen={openDocument} onOpenAll={openHome} />;
  if (data.view === "panel") return <PanelView ctx={ctx} data={data} onOpen={openDocument} />;
  if (inline) return <HomeCard data={data} onOpen={() => void goFullscreen()} />;
  return <HomeView ctx={ctx} data={data} onOpen={openDocument} />;
}
