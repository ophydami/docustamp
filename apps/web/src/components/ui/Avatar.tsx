import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

export type AvatarTone = "accent" | "success" | "ink" | "neutral" | "danger";

const tones: Record<AvatarTone, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success-ink",
  ink: "bg-ink text-ground",
  neutral: "bg-surface-3 text-ink-2",
  danger: "bg-danger-soft text-danger"
};

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string | null;
  email?: string | null;
  tone?: AvatarTone;
  size?: number;
}

export function Avatar({ name, email, tone = "neutral", size = 24, className, style, ...rest }: AvatarProps) {
  return (
    <span
      title={name || email || undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold tracking-[-0.03em] border-2 border-surface shrink-0 overflow-hidden",
        tones[tone],
        className
      )}
      {...rest}
      style={{ ...style, width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
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
  // Overlap by about a quarter of the face so two initials stay readable.
  const overlap = Math.round(size * 0.22);
  return (
    <span className={cn("inline-flex", className)}>
      {shown.map((p, i) => (
        <Avatar key={i} {...p} size={size} style={i > 0 ? { marginLeft: -overlap } : undefined} />
      ))}
      {rest > 0 ? (
        <Avatar name={`+${rest}`} tone="neutral" size={size} style={{ marginLeft: -overlap }} />
      ) : null}
    </span>
  );
}
