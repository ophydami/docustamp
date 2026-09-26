import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Cap, Input, Kbd } from "@/components/ui";
import { cn } from "@/lib/cn";
import { GROUP_LABEL_KEYS, PREFILL_COLOR, WIDGETS } from "../constants";
import { signerLabel } from "../model";
import type { SignerRow, WidgetType } from "../types";

export interface PaletteProps {
  signers: SignerRow[];
  activeSignerId: number | null;
  onActiveSigner: (id: number) => void;
  onEditRoles?: () => void;
  armedType: WidgetType | null;
  onArm: (type: WidgetType | null) => void;
  disabled: boolean;
}

export function Palette({
  signers,
  activeSignerId,
  onActiveSigner,
  onEditRoles,
  armedType,
  onArm,
  disabled
}: PaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const active = signers.find((s) => s.id === activeSignerId);

  // Rebuilt whenever `t` changes so the labels and the search follow the language.
  const tiles = useMemo(
    () => WIDGETS.map((w) => ({ ...w, label: t(w.labelKey), keywords: w.keywordsKey ? t(w.keywordsKey) : "" })),
    [t]
  );

  const visible = useMemo(() => {
    const allowPrefillOnly = active?.isPrefill === true;
    const q = query.trim().toLowerCase();
    return tiles.filter((w) => {
      if (w.prefillOnly && !allowPrefillOnly) return false;
      if (!q) return true;
      return w.label.toLowerCase().includes(q) || w.type.includes(q) || w.keywords.toLowerCase().includes(q);
    });
  }, [active, query, tiles]);

  const groups: Array<"signature" | "autofill" | "input"> = ["signature", "autofill", "input"];

  return (
    <aside className="w-[264px] shrink-0 bg-surface border-r border-line flex flex-col min-h-0">
      <div className="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-2">
        <Cap>{t("editor.palette.placingFor")}</Cap>
        <div className="flex items-center gap-2">
          <span
            className="swatch size-2.5 rounded-full shrink-0 border border-ink/15"
            style={{ ["--swatch" as string]: active && active.color !== PREFILL_COLOR ? active.color : "var(--color-faint)", background: "var(--swatch-on)" }}
          />
          <select
            aria-label={t("editor.palette.signerSelect")}
            className="flex-1 h-8 bg-surface border border-line rounded-md text-[13px] px-2 focus:outline-none focus:border-accent"
            value={activeSignerId ?? ""}
            onChange={(e) => onActiveSigner(Number(e.target.value))}
            disabled={disabled}
          >
            {signers.map((s) => (
              <option key={s.id} value={s.id}>
                {signerLabel(s, t)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {signers.map((s) => (
              <button
                key={s.id}
                type="button"
                title={signerLabel(s, t)}
                aria-label={t("editor.palette.placeFieldsFor", { name: signerLabel(s, t) })}
                onClick={() => onActiveSigner(s.id)}
                className={cn(
                  "swatch size-3 rounded-full border transition-transform",
                  s.id === activeSignerId ? "ring-2 ring-offset-1 ring-offset-surface ring-ink scale-110 border-transparent" : "border-ink/15"
                )}
                style={{ ["--swatch" as string]: s.color !== PREFILL_COLOR ? s.color : "var(--color-faint)", background: "var(--swatch-on)" }}
              />
            ))}
          </div>
          {onEditRoles ? (
            <button type="button" onClick={onEditRoles} className="text-[12px] text-accent hover:text-accent-deep">
              {t("editor.palette.editRoles")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="px-4 py-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("editor.palette.searchPlaceholder")}
          aria-label={t("editor.palette.searchPlaceholder")}
          left={<Search className="size-3.5" strokeWidth={1.6} />}
          className="h-8"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-4 pb-3 flex flex-col gap-4">
        {groups.map((g) => {
          const items = visible.filter((w) => w.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="flex flex-col gap-2">
              <Cap>{t(GROUP_LABEL_KEYS[g])}</Cap>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((w) => {
                  const Icon = w.icon;
                  const armed = armedType === w.type;
                  return (
                    <button
                      key={w.type}
                      type="button"
                      draggable={!disabled}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-docustamp-widget", w.type);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => onArm(armed ? null : w.type)}
                      disabled={disabled}
                      title={t("editor.palette.tileTitle", { label: w.label })}
                      className={cn(
                        "h-[34px] px-2 flex items-center gap-1.5 border rounded-md text-[12px] text-left",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        armed ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:bg-surface-2 hover:border-line-strong"
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" strokeWidth={1.6} />
                      <span className="truncate">{w.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!visible.length ? <p className="text-[12px] text-muted-2">{t("editor.palette.noMatches")}</p> : null}
      </div>

      <div className="px-4 py-3 border-t border-line text-[11px] text-muted-2 leading-relaxed">
        {t("editor.palette.hint.intro")} <Kbd>S</Kbd> {t("editor.palette.hint.signature")}, <Kbd>D</Kbd>{" "}
        {t("editor.palette.hint.date")}, <Kbd>T</Kbd> {t("editor.palette.hint.text")}.
      </div>
    </aside>
  );
}
