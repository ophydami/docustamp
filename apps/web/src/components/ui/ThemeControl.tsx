import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { THEME_OPTIONS, useTheme } from "@/lib/theme";

/** Three-segment System / Light / Dark picker, used in Settings → Profile. */
export function ThemeSegment({ className }: { className?: string }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);

  return (
    <div
      role="radiogroup"
      aria-label={t("common.theme.label")}
      className={cn("inline-flex items-center gap-1 p-1 rounded-md bg-ground border border-line", className)}
    >
      {THEME_OPTIONS.map((o) => {
        const on = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setTheme(o.value)}
            className={cn(
              "h-7 px-3 rounded-[6px] text-[12px] font-medium transition-colors",
              on ? "bg-surface text-ink shadow-[var(--shadow-raise)]" : "text-muted hover:text-ink"
            )}
          >
            {t(o.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Icon-only quick flip between light and dark. Picking a side here leaves
 * "system" behind on purpose: it is an explicit choice.
 */
export function ThemeToggleButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const dark = useTheme((s) => s.resolved) === "dark";
  const toggle = useTheme((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? t("common.theme.toLight") : t("common.theme.toDark")}
      title={dark ? t("common.theme.toLight") : t("common.theme.toDark")}
      className={cn(
        "size-7 shrink-0 inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-line-soft",
        className
      )}
    >
      {dark ? <Sun className="size-4" strokeWidth={1.6} /> : <Moon className="size-4" strokeWidth={1.6} />}
    </button>
  );
}
