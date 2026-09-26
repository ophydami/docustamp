import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import i18next from "i18next";
import { toast } from "@/components/ui";

export interface SaveBarState {
  dirty: boolean;
  saving: boolean;
  save: () => void;
  discard: () => void;
}

export interface SaveBarContextValue {
  setState: (s: SaveBarState | null) => void;
}

/** Connects the mounted section to the Save / Discard bar in the page header. */
export const SaveBarContext = createContext<SaveBarContextValue | null>(null);

/** Used by SettingsPage to own the bar state. */
export function useSaveBarHost() {
  const [state, setState] = useState<SaveBarState | null>(null);
  const value = useMemo<SaveBarContextValue>(() => ({ setState }), []);
  return { state, value };
}

export interface SectionFormOptions<T extends object> {
  /** Server state. `null` or `undefined` while loading. */
  initial: T | null | undefined;
  save: (values: T) => Promise<void>;
  /** Toast title on a successful save. Callers pass an already translated string. */
  successTitle?: string;
  /** Toast title used when the save throws. Callers pass an already translated string. */
  errorTitle?: string;
}

export interface SectionForm<T extends object> {
  values: T | null;
  set: (patch: Partial<T>) => void;
  dirty: boolean;
  saving: boolean;
  save: () => void;
  discard: () => void;
}

/**
 * Draft state for one settings section, registered with the header save bar.
 * The draft resets whenever the server value changes and nothing is unsaved,
 * so a background refetch never eats what someone is typing.
 */
export function useSectionForm<T extends object>(opts: SectionFormOptions<T>): SectionForm<T> {
  const { initial, save, successTitle, errorTitle } = opts;
  const initKey = JSON.stringify(initial ?? null);

  const [draft, setDraft] = useState<T | null>(initial ?? null);
  const [baseKey, setBaseKey] = useState(initKey);
  const [saving, setSaving] = useState(false);

  const dirty = draft !== null && JSON.stringify(draft) !== baseKey;
  if (initKey !== baseKey && !dirty) {
    setBaseKey(initKey);
    setDraft(initial ?? null);
  }

  const set = useCallback((patch: Partial<T>) => {
    setDraft((d) => (d === null ? d : { ...d, ...patch }));
  }, []);

  const discard = useCallback(() => {
    setDraft(JSON.parse(baseKey) as T | null);
  }, [baseKey]);

  const saveRef = useRef(save);
  const doSave = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await saveRef.current(draft);
      setBaseKey(JSON.stringify(draft));
      toast.success(successTitle ?? i18next.t("settings.form.saved"));
    } catch (err) {
      toast.error(errorTitle ?? i18next.t("settings.form.saveFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, successTitle, errorTitle]);

  // Keep the latest handlers reachable from the stable callbacks below.
  const latest = useRef({ save: doSave, discard });
  useEffect(() => {
    saveRef.current = save;
    latest.current = { save: doSave, discard };
  });

  const ctx = useContext(SaveBarContext);
  useEffect(() => {
    ctx?.setState({
      dirty,
      saving,
      save: () => void latest.current.save(),
      discard: () => latest.current.discard()
    });
  }, [ctx, dirty, saving]);
  useEffect(() => {
    return () => ctx?.setState(null);
  }, [ctx]);

  return { values: draft, set, dirty, saving, save: () => void doSave(), discard };
}
