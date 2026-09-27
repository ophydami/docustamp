import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-surface border border-line rounded-xl", className)} {...rest} />;
}

/** Section label: Geist Mono, 10.5px, uppercase, wide tracking. */
export function Cap({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("label-mono", className)} {...rest} />;
}

export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("font-semibold text-[20px] leading-tight tracking-[-.015em]", className)}>{children}</h1>;
}

/**
 * KPI: label, a Geist Mono number, footnote. On its own it is a card; inside a
 * KpiStrip the cells share one card and are split by hairlines.
 */
export function Stat({
  label,
  value,
  note,
  dot,
  tone = "default",
  className
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  /** Colour of the dot before the footnote, e.g. "bg-success". */
  dot?: string;
  tone?: "default" | "accent";
  className?: string;
}) {
  return (
    <div className={cn("bg-surface px-3.5 pt-3 pb-[11px] min-w-0 flex flex-col", className)}>
      <span className="text-[12px] text-muted truncate">{label}</span>
      <span
        className={cn(
          "num text-[22px] font-medium tracking-[-0.02em] leading-[1.1] mt-1",
          tone === "accent" && "text-accent"
        )}
      >
        {value}
      </span>
      {note || dot ? (
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted mt-[5px] min-w-0">
          {dot ? <span className={cn("size-1.5 rounded-full shrink-0", dot)} /> : null}
          <span className="truncate">{note}</span>
        </span>
      ) : null}
    </div>
  );
}

/** One hairline card holding several Stat cells; the 1px gaps are the dividers. */
export function KpiStrip({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("grid gap-px bg-line border border-line rounded-xl overflow-hidden", className)}
      {...rest}
    />
  );
}

export function EmptyState({
  title,
  body,
  action,
  className
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center gap-2 py-16 px-6", className)}>
      <span className="font-semibold text-[16px] tracking-[-.015em]">{title}</span>
      {body ? <span className="text-[13px] text-muted max-w-md">{body}</span> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
