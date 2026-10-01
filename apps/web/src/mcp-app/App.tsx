import { useCallback, useEffect, useRef, useState } from "react";
import { applyDocumentTheme, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { Button } from "@/components/ui/Button";
import { ApprovalCard, ApprovalView } from "./approval";
import { callTool } from "./bridge";
import { normalizeView } from "./normalize";
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
import type { Approval, ApprovalData, DocRow, DocumentData, HomeData, ListData, ViewData } from "./types";

/**
 * The DocuStamp app page. One page serves every way the host opens it; the
 * tool result says which (`structuredContent.view`):
 *
 *   home      the sidebar app (open_docustamp)
 *   panel     the panel beside a conversation (open_review_panel)
 *   document  one document (show_document): a card inline, the full view fullscreen
 *   list      a short list (show_documents): a card inline
 *   approval  the user's agent asks to sign a document someone else sent
 *             (sign_document): a card inline, the full view fullscreen
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

/**
 * How often a full-screen view re-reads its data while it is on screen.
 * ChatGPT keeps the sidebar app open as a tab while the conversation beside it
 * creates, sends and completes documents, so what it shows goes stale unless
 * the page asks again.
 */
const REFRESH_MS = 15_000;

/** Which live data a view shows: the key a refresh is fetched for, '' when it has none. */
function liveKeyOf(data: ViewData): string {
  if (data.view === "document") return `document:${data.document.objectId}`;
  if (data.view === "home" || data.view === "panel") return data.view;
  // A decided approval does not change again.
  if (data.view === "approval") return data.approval.status === "pending" ? `approval:${data.approval.id}` : "";
  return "";
}

/**
 * The tool result's `_meta` key for the single-use approval code. The host
 * keeps `_meta` from the model, so the code reaches this page only.
 */
const NONCE_KEY = "docustamp/approvalNonce";

/** The approval code from a tool result, or from ChatGPT's own copy of the result's `_meta`. */
function nonceOf(meta: Record<string, unknown> | undefined): string | null {
  const openai = (window as { openai?: { toolResponseMetadata?: Record<string, unknown> | null } }).openai;
  const value = meta?.[NONCE_KEY] ?? openai?.toolResponseMetadata?.[NONCE_KEY];
  return typeof value === "string" && value ? value : null;
}

/**
 * Keep what only the tool call that opened a view carries when that view is
 * fetched again: the "signed for you" banner, whether the card may approve,
 * and the link to DocuStamp.
 */
function carry(old: ViewData, next: ViewData): ViewData {
  if (old.view === "document" && next.view === "document" && old.document.objectId === next.document.objectId)
    return { ...next, banner: next.banner ?? old.banner };
  if (old.view === "approval" && next.view === "approval" && old.approval.id === next.approval.id)
    return { ...old, ...next, chatApproval: next.chatApproval ?? old.chatApproval, appUrl: next.appUrl ?? old.appUrl };
  return next;
}

function errorText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = (result.content || []).find((part) => part.type === "text")?.text || "";
  return text.replace(/^Error(?: \([^)]*\))?:\s*/, "") || "Something went wrong.";
}

export default function Root() {
  const [ext, setExt] = useState<OpenAIExtensions | null>(null);
  const [first, setFirst] = useState<Screen>({ kind: "loading", expect: "list" });
  const [stack, setStack] = useState<Screen[]>([]);
  const [mode, setMode] = useState<McpUiDisplayMode>("inline");
  const [refreshing, setRefreshing] = useState(false);
  const lastLoaded = useRef(0);
  // The approval code for the approval this page was opened on, in memory for
  // the life of the page (refreshes do not carry it). Sent only to app_decide_approval.
  const [approvalNonce, setApprovalNonce] = useState<{ approvalId: string; nonce: string } | null>(null);

  const { app, error } = useApp({
    appInfo: { name: "DocuStamp", version: "1.0.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    autoResize: true,
    onAppCreated: (created) => {
      setExt(new OpenAIExtensions(created));
      created.ontoolresult = (result) => {
        lastLoaded.current = Date.now();
        setStack([]);
        if (result.isError) {
          setFirst({ kind: "error", message: errorText(result) });
          return;
        }
        if (!result.structuredContent) return;
        const data = normalizeView(result.structuredContent as unknown as ViewData);
        if (data.view === "approval") {
          const approvalId = data.approval.id;
          const nonce = nonceOf(result._meta);
          // A result delivered again without the code keeps the one already held.
          setApprovalNonce((held) =>
            nonce ? { approvalId, nonce } : held?.approvalId === approvalId ? held : null
          );
        }
        setFirst({ kind: "view", data });
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
        lastLoaded.current = Date.now();
      } catch (err) {
        replaceTop({ kind: "error", message: (err as Error).message });
      }
    },
    [goFullscreen, push, replaceTop]
  );
  const openDocument = (doc: DocRow) =>
    app &&
    void open("document", async () =>
      normalizeView(await callTool<DocumentData>(app, "app_document", { documentId: doc.objectId }))
    );
  const openHome = () => app && void open("home", () => callTool<HomeData>(app, "app_home"));

  const top = stack.length ? stack[stack.length - 1] : first;
  const canGoBack = stack.length > 0;
  const inline = displayMode === "inline" && !canGoBack;

  // Only full-screen views refresh: cards in the chat are snapshots, and a
  // long conversation can hold many of them. A pending approval is the
  // exception: it updates in the chat when the user decides in DocuStamp.
  const liveKey =
    top.kind === "view" && (!inline || top.data.view === "approval") ? liveKeyOf(top.data) : "";

  const refresh = useCallback(async () => {
    if (!app || !liveKey) return;
    setRefreshing(true);
    try {
      let next: (old: ViewData) => ViewData;
      if (liveKey.startsWith("approval:")) {
        // app_approval never carries the approval code: the one held stays as it is.
        const { approval } = await callTool<{ approval: Approval }>(app, "app_approval", {
          approvalId: liveKey.slice("approval:".length)
        });
        // A decision already on screen is never undone by an answer that left before it.
        next = (old) =>
          old.view === "approval" && !(old.approval.status !== "pending" && approval.status === "pending")
            ? { ...old, approval }
            : old;
      } else if (liveKey.startsWith("document:")) {
        const doc = normalizeView(
          await callTool<DocumentData>(app, "app_document", { documentId: liveKey.slice("document:".length) })
        );
        next = (old) => carry(old, doc);
      } else {
        const home: ViewData = { ...(await callTool<HomeData>(app, "app_home")), view: liveKey as "home" | "panel" };
        next = () => home;
      }
      lastLoaded.current = Date.now();
      // Replace only the screens this was fetched for: the user may have moved on meanwhile.
      const apply = (screen: Screen): Screen =>
        screen.kind === "view" && liveKeyOf(screen.data) === liveKey ? { kind: "view", data: next(screen.data) } : screen;
      setStack((s) => s.map(apply));
      setFirst((f) => apply(f));
    } catch {
      // Keep showing what is there; the next tick tries again.
    } finally {
      setRefreshing(false);
    }
  }, [app, liveKey]);

  useEffect(() => {
    if (!liveKey) return;
    // Coming back to a screen (Back to the list) shows it fresh; a screen that
    // was just delivered by its tool call is not fetched a second time.
    if (Date.now() - lastLoaded.current > 3000) void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [liveKey, refresh]);

  if (error)
    return (
      <div className="p-4">
        <Banner tone="danger">Could not connect to the host: {error.message}</Banner>
      </div>
    );

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
  const updateTop = (next: ViewData) => {
    const merged = carry(data, next);
    if (stack.length) replaceTop({ kind: "view", data: merged });
    else setFirst({ kind: "view", data: merged });
  };
  // A decision shows on every screen of that approval: the card under the full view too.
  const updateApproval = (approval: Approval) => {
    const apply = (screen: Screen): Screen =>
      screen.kind === "view" && screen.data.view === "approval" && screen.data.approval.id === approval.id
        ? { kind: "view", data: { ...screen.data, approval } }
        : screen;
    setStack((s) => s.map(apply));
    setFirst((f) => apply(f));
  };

  if (data.view === "approval") {
    const approvalData = data as ApprovalData;
    const nonce = approvalNonce?.approvalId === approvalData.approval.id ? approvalNonce.nonce : null;
    return inline ? (
      <ApprovalCard
        ctx={ctx}
        data={approvalData}
        nonce={nonce}
        onChanged={updateApproval}
        onExpand={() => {
          void goFullscreen();
          push({ kind: "view", data });
        }}
      />
    ) : (
      <ApprovalView
        ctx={ctx}
        data={approvalData}
        nonce={nonce}
        onChanged={updateApproval}
        onBack={canGoBack ? back : undefined}
        onRefresh={approvalData.approval.status === "pending" ? () => void refresh() : undefined}
        refreshing={refreshing}
      />
    );
  }

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
      <DocumentView
        ctx={ctx}
        data={data}
        onBack={canGoBack ? back : undefined}
        onChanged={updateTop}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
      />
    );
  }
  if (data.view === "list")
    return <ListCard ctx={ctx} data={data as ListData} onOpen={openDocument} onOpenAll={openHome} />;
  if (data.view === "panel")
    return (
      <PanelView ctx={ctx} data={data} onOpen={openDocument} onRefresh={() => void refresh()} refreshing={refreshing} />
    );
  if (inline) return <HomeCard data={data} onOpen={() => void goFullscreen()} />;
  return (
    <HomeView ctx={ctx} data={data} onOpen={openDocument} onRefresh={() => void refresh()} refreshing={refreshing} />
  );
}
