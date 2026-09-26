import { useCallback, useRef, useState } from "react";
import type { EditorSnapshot } from "./types";

interface History {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
}

const LIMIT = 80;
/** Two edits with the same merge key inside this window collapse into one undo step. */
const MERGE_WINDOW_MS = 700;

export interface EditorHistory {
  snapshot: EditorSnapshot;
  /** Push a new state onto the undo stack. `mergeKey` coalesces rapid edits of one property. */
  commit: (next: EditorSnapshot | ((s: EditorSnapshot) => EditorSnapshot), mergeKey?: string) => void;
  /** Replace the state without touching the undo stack (used when loading). */
  reset: (next: EditorSnapshot) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Increments on every change, so autosave can tell "dirty since last save". */
  revision: number;
}

export function useEditorHistory(initial: EditorSnapshot): EditorHistory {
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });
  const [revision, setRevision] = useState(0);
  const lastMerge = useRef<{ key: string; at: number } | null>(null);

  const commit = useCallback(
    (next: EditorSnapshot | ((s: EditorSnapshot) => EditorSnapshot), mergeKey?: string) => {
      setHistory((h) => {
        const value = typeof next === "function" ? next(h.present) : next;
        if (value === h.present) return h;
        const now = Date.now();
        const merge =
          mergeKey !== undefined &&
          lastMerge.current?.key === mergeKey &&
          now - lastMerge.current.at < MERGE_WINDOW_MS &&
          h.past.length > 0;
        lastMerge.current = mergeKey === undefined ? null : { key: mergeKey, at: now };
        const past = merge ? h.past : [...h.past, h.present].slice(-LIMIT);
        return { past, present: value, future: [] };
      });
      setRevision((r) => r + 1);
    },
    []
  );

  const reset = useCallback((next: EditorSnapshot) => {
    lastMerge.current = null;
    setHistory({ past: [], present: next, future: [] });
    setRevision((r) => r + 1);
  }, []);

  const undo = useCallback(() => {
    lastMerge.current = null;
    setHistory((h) => {
      if (!h.past.length) return h;
      const previous = h.past[h.past.length - 1];
      return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future].slice(0, LIMIT) };
    });
    setRevision((r) => r + 1);
  }, []);

  const redo = useCallback(() => {
    lastMerge.current = null;
    setHistory((h) => {
      if (!h.future.length) return h;
      const next = h.future[0];
      return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: h.future.slice(1) };
    });
    setRevision((r) => r + 1);
  }, []);

  return {
    snapshot: history.present,
    commit,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    revision
  };
}
