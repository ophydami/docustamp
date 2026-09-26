import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui";

/** One card of a settings form: serif heading, optional note, body. */
export function SectionCard({
  title,
  note,
  aside,
  children,
  className,
  bodyClassName
}: {
  title?: ReactNode;
  note?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("shadow-[var(--shadow-card)]", className)}>
      {title ? (
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line-soft">
          <div className="flex flex-col gap-1">
            <h2 className="font-serif text-[18px] font-medium leading-tight">{title}</h2>
            {note ? <p className="text-[12px] text-muted">{note}</p> : null}
          </div>
          {aside}
        </div>
      ) : null}
      <div className={cn("px-5 py-4 flex flex-col gap-4", bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Two columns on wide forms, one on narrow. */
export function Grid2({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4", className)}>{children}</div>;
}

/** A toggle row: label + description on the left, control on the right. */
export function ToggleRow({
  label,
  description,
  control,
  disabled
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-6", disabled && "opacity-60")}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {description ? <span className="text-[12px] text-muted leading-relaxed">{description}</span> : null}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

/** Read-only key/value line, used where the server does not accept writes. */
export function ReadOnlyRow({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <span className="text-[12px] font-semibold text-ink-2">{label}</span>
      <span className={cn("text-[13px] text-muted text-right break-all", mono && "font-mono text-[12px]")}>{value}</span>
    </div>
  );
}

/** Explains that a control is disabled because this server has no field for it. */
export function NotAvailableNote({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-start gap-1.5 text-[11px] text-muted-2 leading-relaxed">
      <Info className="size-3 mt-[2px] shrink-0" strokeWidth={1.6} />
      <span>{children ?? t("settings.parts.notAvailable")}</span>
    </span>
  );
}

export function SectionLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-2 py-10">
      <Loader2 className="size-4 animate-spin" strokeWidth={1.6} />
      {t("common.state.loading")}
    </div>
  );
}

export function SectionError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Card className="px-5 py-4 border-danger-line bg-danger-soft">
      <p className="text-[13px] text-danger font-medium">{t("settings.parts.loadError")}</p>
      <p className="text-[12px] text-danger/80 mt-1">{msg}</p>
      {onRetry ? (
        <button type="button" className="text-[12px] font-semibold text-danger underline mt-2" onClick={onRetry}>
          {t("common.actions.tryAgain")}
        </button>
      ) : null}
    </Card>
  );
}

/** Max-width column that every form section sits in. */
export function FormColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-[520px] flex flex-col gap-4", className)}>{children}</div>;
}
