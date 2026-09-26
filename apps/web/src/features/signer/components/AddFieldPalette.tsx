import { CalendarDays, PenLine, Plus, Signature, SquareCheck, TextCursorInput, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Cap } from "@/components/ui";
import { ADDABLE_TYPES } from "../addField";
import { widgetLabel } from "../widgets";
import type { WidgetType } from "../types";

const ICONS: Partial<Record<WidgetType, ReactNode>> = {
  signature: <PenLine className="size-3.5" strokeWidth={1.6} />,
  initials: <Signature className="size-3.5" strokeWidth={1.6} />,
  date: <CalendarDays className="size-3.5" strokeWidth={1.6} />,
  text: <TextCursorInput className="size-3.5" strokeWidth={1.6} />,
  checkbox: <SquareCheck className="size-3.5" strokeWidth={1.6} />
};

export interface AddFieldPaletteProps {
  /** Places a field of the default size at the centre of the current page. */
  onAdd: (type: WidgetType) => void;
  /** Shown so the signer knows where the field will land. */
  page: number;
}

/** Desktop: a compact palette in the right rail, under "Your fields". */
export function AddFieldPalette({ onAdd, page }: AddFieldPaletteProps) {
  const { t } = useTranslation();
  return (
    <div className="p-5 border-b border-line">
      <Cap className="text-muted-2">{t("signer.addField.title")}</Cap>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{t("signer.addField.paletteHint", { page })}</p>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        {ADDABLE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onAdd(type)}
            className="h-8 px-2 flex items-center gap-1.5 rounded-md border border-line bg-surface text-[12px] text-ink-2 hover:border-accent hover:text-accent transition-colors"
          >
            <span className="shrink-0 text-muted-2">{ICONS[type]}</span>
            <span className="truncate">{widgetLabel(type)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export interface AddFieldSheetProps extends AddFieldPaletteProps {
  open: boolean;
  onClose: () => void;
}

/** Phone: a bottom sheet opened from the "Add field" button in the action bar. */
export function AddFieldSheet({ open, onClose, onAdd, page }: AddFieldSheetProps) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label={t("common.actions.close")}
        className="absolute inset-0 bg-scrim"
        onClick={onClose}
      />
      <div className="relative rounded-t-xl bg-surface border-t border-line px-4 pt-4 pb-6">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-ink">{t("signer.addField.title")}</p>
            <p className="text-[12px] text-muted">{t("signer.addField.sheetHint", { page })}</p>
          </div>
          <button
            type="button"
            aria-label={t("common.actions.close")}
            onClick={onClose}
            className="size-11 -mr-2 flex items-center justify-center text-muted"
          >
            <X className="size-4.5" strokeWidth={1.6} />
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {ADDABLE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                onAdd(type);
                onClose();
              }}
              className="min-h-11 px-3 flex items-center gap-2.5 rounded-md border border-line bg-surface text-[14px] text-ink-2 active:bg-accent-soft"
            >
              <span className="shrink-0 text-muted-2">{ICONS[type]}</span>
              {widgetLabel(type)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The phone action-bar trigger. */
export function AddFieldButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-[46px] shrink-0 px-3 rounded-md border border-line bg-surface flex items-center gap-1.5 text-[13px] font-medium text-ink-2",
        className
      )}
    >
      <Plus className="size-4" strokeWidth={1.8} />
      {t("signer.actions.addField")}
    </button>
  );
}
