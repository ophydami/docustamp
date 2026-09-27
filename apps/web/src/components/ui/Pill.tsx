import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type PillTone = "accent" | "success" | "warn" | "danger" | "neutral" | "ink" | "violet";

const tones: Record<PillTone, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success-ink",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-surface-3 text-ink-2",
  ink: "bg-ink text-ground",
  violet: "bg-violet-soft text-violet"
};

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  dot?: boolean;
}

/** Status pill. Soft tinted background, 11px medium. Status is a tint, never a solid. */
export function Pill({ tone = "neutral", dot, className, children, ...rest }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-5 px-[7px] rounded-full text-[11px] font-medium whitespace-nowrap",
        tones[tone],
        className
      )}
      {...rest}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
