/**
 * Rendering a written document to PDF.
 *
 * One cloud function (server `cloud/parsefunction/renderTextPdf.js`):
 *   rendertextpdf   { title?, content } → { pdfBase64, pageCount, bytes }
 * The server does not keep the PDF: the caller uploads the bytes through the
 * usual `Parse.File` path when the draft is saved.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cloud, CloudError } from "@/lib/parse";
import type { Content } from "./model";

interface RenderResult {
  pdfBase64: string;
  pageCount: number;
  bytes: number;
}

/** `Uint8Array.fromBase64` is not in every browser yet, so this goes through atob. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function renderTextPdf(
  title: string,
  content: Content,
  opts: { signal?: AbortSignal } = {}
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const result = await cloud<RenderResult>("rendertextpdf", { title, content }, { signal: opts.signal });
  if (!result || typeof result.pdfBase64 !== "string") throw new CloudError("rendertextpdf returned no PDF");
  return {
    bytes: decodeBase64(result.pdfBase64),
    pageCount: typeof result.pageCount === "number" ? result.pageCount : 0
  };
}

export interface RenderedPdf {
  /** The last successful render; kept while the next one runs. */
  bytes: Uint8Array | null;
  pageCount: number;
  rendering: boolean;
  error: string | null;
  /** The content has changed since `bytes` was rendered. */
  stale: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Debounced live render. Every change to the title or content marks the
 * result stale at once, waits `delay` ms of quiet, then renders; a render
 * that is still running when the next change lands is aborted.
 */
export function useRenderedPdf(
  title: string,
  content: Content | null,
  opts: { delay?: number; enabled?: boolean } = {}
): RenderedPdf {
  const { delay = 700, enabled = true } = opts;
  // One string stands for "what would be rendered", so a parent that hands
  // over a fresh but equal object does not trigger a render.
  const key = useMemo(() => (content ? JSON.stringify({ title, content }) : null), [title, content]);
  const [state, setState] = useState<Omit<RenderedPdf, "stale">>({
    bytes: null,
    pageCount: 0,
    rendering: false,
    error: null
  });
  const renderedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || key === null || !content || key === renderedKey.current) return;
    const controller = new AbortController();
    // Set once the timer fires: a keystroke that is superseded before then has
    // nothing to undo, and the cleanup must not touch state for it. Every
    // keystroke re-runs this effect, and an extra render per key is what let a
    // burst of typing trip React's nested-update guard.
    let started = false;
    const timer = window.setTimeout(async () => {
      started = true;
      setState((s) => ({ ...s, rendering: true, error: null }));
      try {
        const { bytes, pageCount } = await renderTextPdf(title, content, { signal: controller.signal });
        if (controller.signal.aborted) return;
        renderedKey.current = key;
        setState({ bytes, pageCount, rendering: false, error: null });
      } catch (err) {
        // A superseded render was aborted on purpose; its failure is not news.
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, rendering: false, error: errorMessage(err) }));
      }
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (started) setState((s) => (s.rendering ? { ...s, rendering: false } : s));
    };
    // `title` and `content` are what `key` was built from, so the key covers
    // them; listing them too would restart a render whenever the parent hands
    // over a fresh but equal object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, delay]);

  // Derived, not stored: storing it meant a state update on every keystroke.
  return { ...state, stale: key !== null && key !== renderedKey.current };
}
