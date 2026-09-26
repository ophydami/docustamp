import { useEffect } from "react";

type Handler = (e: KeyboardEvent) => void;

export interface HotkeyOptions {
  /**
   * "low": run after page-level bindings and only if none of them handled the
   * key (used by the global top bar so pages can override N/S/T).
   */
  priority?: "normal" | "low";
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/** Candidate keys for an event, most specific first. */
function candidates(e: KeyboardEvent): string[] {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const out: string[] = [];
  if (mod && e.shiftKey) out.push(`mod+shift+${key}`);
  if (mod) out.push(`mod+${key}`);
  if (!mod && e.shiftKey) out.push(`shift+${key}`);
  if (!mod && !e.shiftKey) out.push(key);
  // "?" is typed with shift on most layouts; let it match plainly.
  if (e.key === "?") out.push("?");
  // Shifted letters with no shift binding fall through to the plain key.
  if (!mod && e.shiftKey && /^[a-z]$/.test(key)) out.push(key);
  return out;
}

/**
 * Bind hotkeys while the component is mounted.
 * Keys: "n", "j", "k", "x", "enter", "escape", "mod+k", "mod+enter", "shift+x", "?", "mod+shift+s".
 * Plain-letter hotkeys are ignored while typing in a field; modifier combos are not.
 * A handled key is marked `defaultPrevented` so lower-priority listeners skip it.
 */
export function useHotkeys(map: Record<string, Handler>, deps: unknown[] = [], opts: HotkeyOptions = {}) {
  useEffect(() => {
    const run = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      let handler: Handler | undefined;
      for (const c of candidates(e)) {
        if (map[c]) {
          handler = map[c];
          break;
        }
      }
      if (!handler) return;
      if (!mod && isTyping(e)) return;
      e.preventDefault();
      handler(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (opts.priority === "low") {
        // Let same-tick page handlers run first.
        setTimeout(() => run(e), 0);
      } else {
        run(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
