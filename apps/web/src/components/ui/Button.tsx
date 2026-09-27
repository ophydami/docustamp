import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd } from "./Kbd";

export type ButtonVariant = "primary" | "dark" | "default" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** Keyboard hint rendered at the right edge, e.g. "N" or "⌘↵". */
  kbd?: string;
  block?: boolean;
}

/*
  Control room buttons: the main action is ink, not a colour. "primary" and
  "dark" are the same ink button (primary is kept so call sites read by intent).
  Blue is reserved for selection, focus and what needs you. Destructive actions
  are a red tint, never a solid red.
*/
const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink border-ink text-ground hover:bg-ink/85 hover:border-transparent",
  dark: "bg-ink border-ink text-ground hover:bg-ink/85 hover:border-transparent",
  default: "bg-surface border-line text-ink hover:bg-surface-2 hover:border-line-strong",
  ghost: "bg-transparent border-transparent text-ink-2 hover:bg-surface-3 hover:text-ink",
  danger: "bg-danger-soft border-transparent text-danger font-semibold hover:bg-danger-line"
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-[26px] px-[9px] text-[11.5px] gap-1.5 rounded-md",
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[12.5px] gap-1.5 rounded-md",
  lg: "h-10 px-3.5 text-[13px] gap-2 rounded-md"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", loading, icon, iconRight, kbd, block, className, children, disabled, ...rest },
  ref
) {
  const kbdTone =
    variant === "primary" || variant === "dark" ? "border-kbd-ink-line bg-transparent text-kbd-ink-ink" : undefined;
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap border font-medium transition-colors select-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        block && "w-full",
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {iconRight}
      {kbd ? <Kbd className={cn("ml-1", kbdTone)}>{kbd}</Kbd> : null}
    </button>
  );
});
