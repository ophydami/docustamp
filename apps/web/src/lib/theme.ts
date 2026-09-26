import { useEffect } from "react";
import { create } from "zustand";

export type ThemeSetting = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStored(): ThemeSetting {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Private mode or blocked storage: fall back to following the system.
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  return setting === "system" ? systemTheme() : setting;
}

/**
 * Writes the setting onto <html>. "system" removes the attribute so the
 * `prefers-color-scheme` block in index.css takes over; "light"/"dark" stamp it
 * so the explicit choice wins in both directions.
 */
function apply(setting: ThemeSetting) {
  const root = document.documentElement;
  if (setting === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", setting);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolveTheme(setting) === "dark" ? "#121210" : "#0F6E56");
}

interface ThemeState {
  /** What the user picked. */
  theme: ThemeSetting;
  /** What is actually painted right now. */
  resolved: ResolvedTheme;
  setTheme: (t: ThemeSetting) => void;
  /** Flips between light and dark, resolving "system" first. */
  toggle: () => void;
}

const stored = readStored();

export const useTheme = create<ThemeState>((set, get) => ({
  theme: stored,
  resolved: resolveTheme(stored),
  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Nothing to do: the choice still applies for this session.
    }
    apply(theme);
    set({ theme, resolved: resolveTheme(theme) });
  },
  toggle: () => get().setTheme(resolveTheme(get().theme) === "dark" ? "light" : "dark")
}));

/**
 * Applies the stored setting once and keeps "system" in step with the OS.
 * Call it from a component that is always mounted (main.tsx does).
 */
export function useThemeSync() {
  const theme = useTheme((s) => s.theme);
  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => useTheme.setState({ resolved: systemTheme() });
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
}

/** Values plus the key of their label, resolved at render so a language switch repaints. */
export const THEME_OPTIONS: Array<{ value: ThemeSetting; labelKey: string }> = [
  { value: "system", labelKey: "common.theme.system" },
  { value: "light", labelKey: "common.theme.light" },
  { value: "dark", labelKey: "common.theme.dark" }
];
