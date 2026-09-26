import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

export type AvatarTone = "accent" | "ink" | "neutral" | "danger";

const tones: Record<AvatarTone, string> = {
  accent: "bg-accent-soft text-accent",
  ink: "bg-ink text-ground",
  neutral: "bg-paper text-muted",
  danger: "bg-danger-soft text-danger"
};

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string | null;
  email?: string | null;
  tone?: AvatarTone;
  size?: number;
}

export function Avatar({ name, email, tone = "accent", size = 24, className, ...rest }: AvatarProps) {
  return (
    <span
      title={name || email || undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold border-2 border-surface shrink-0",
        tones[tone],
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      {...rest}
    >
      {initials(name, email ?? undefined)}
    </span>
  );
}

export interface AvatarStackProps {
  people: Array<{ name?: string | null; email?: string | null; tone?: AvatarTone }>;
  max?: number;
  size?: number;
  className?: string;
}

/** Overlapping avatar stack with a "+N" tail. */
export function AvatarStack({ people, max = 3, size = 24, className }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={cn("inline-flex", className)}>
      {shown.map((p, i) => (
        <Avatar key={i} {...p} size={size} className={i > 0 ? "-ml-[7px]" : undefined} />
      ))}
      {rest > 0 ? (
        <Avatar name={`+${rest}`} tone="neutral" size={size} className="-ml-[7px]" />
      ) : null}
    </span>
  );
}
