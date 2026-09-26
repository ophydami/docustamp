import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-surface border border-line rounded-lg", className)} {...rest} />;
}

/** Uppercase 11px tracking label. */
export function Cap({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium", className)}
      {...rest}
    />
  );
}

export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("font-serif text-[26px] font-medium leading-tight", className)}>{children}</h1>;
}

/** Small KPI tile: label, big number, footnote. */
export function Stat({
  label,
  value,
  note,
  tone = "default",
  className
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: "default" | "accent";
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "px-4 py-3.5 flex flex-col gap-1.5",
        tone === "accent" && "border-accent-line bg-accent-tint",
        className
      )}
    >
      <span className="text-[12px] text-ink-2">{label}</span>
      <span className={cn("num text-[26px] font-semibold leading-none", tone === "accent" && "text-accent")}>
        {value}
      </span>
      {note ? <span className="text-[11px] text-muted-2">{note}</span> : null}
    </Card>
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
      <span className="font-serif text-[20px]">{title}</span>
      {body ? <span className="text-[13px] text-muted max-w-md">{body}</span> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
