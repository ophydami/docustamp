import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import { LANGUAGES, currentLang, setLanguage } from "@/lib/i18n";
import { Select } from "./Input";

/**
 * Full-width picker for Settings → Profile, next to Appearance. `onChange` lets
 * the profile form record the pick so Save writes it to `contracts_Users.Language`.
 */
export function LanguageSelect({
  className,
  id,
  onChange
}: {
  className?: string;
  id?: string;
  onChange?: (lang: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      className={className}
      aria-label={t("common.language.label")}
      value={currentLang()}
      onChange={(e) => {
        const lang = e.target.value;
        void setLanguage(lang);
        onChange?.(lang);
      }}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * Compact picker for places with no account behind them: the auth page footers
 * and the signer's top bar. The choice lives in localStorage only.
 */
export function LanguageMini({ className, tone = "default" }: { className?: string; tone?: "default" | "onDark" }) {
  const { t } = useTranslation();
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <Globe
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1.5 size-3.5",
          tone === "onDark" ? "text-white/60" : "text-muted-2"
        )}
        strokeWidth={1.6}
      />
      <select
        aria-label={t("common.language.label")}
        value={currentLang()}
        onChange={(e) => void setLanguage(e.target.value)}
        className={cn(
          "h-7 pl-6 pr-1.5 rounded-md bg-transparent border-0 appearance-none cursor-pointer",
          "text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          tone === "onDark" ? "text-white/70 hover:text-white" : "text-muted hover:text-ink"
        )}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} className="text-ink bg-surface">
            {l.name}
          </option>
        ))}
      </select>
    </span>
  );
}
