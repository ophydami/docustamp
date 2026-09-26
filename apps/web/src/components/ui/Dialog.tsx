import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

/** Centered modal over a dimmed ground. Esc and backdrop click close it. */
export function Dialog({ open, onClose, title, description, children, footer, width = 560, className }: DialogProps) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn("bg-surface border border-line rounded-xl shadow-[var(--shadow-pop)] flex flex-col max-h-full", className)}
        style={{ width, maxWidth: "100%" }}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 px-7 pt-6">
            <div className="flex flex-col gap-1">
              {title ? <h2 className="font-serif text-[24px] font-medium leading-tight">{title}</h2> : null}
              {description ? <p className="text-[13px] text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.actions.close")}
              className="text-muted-2 hover:text-ink -mr-2 -mt-1 p-1"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="px-7 py-5 overflow-auto scroll-thin">{children}</div>
        {footer ? <div className="flex justify-end gap-2 px-7 pb-6">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}
