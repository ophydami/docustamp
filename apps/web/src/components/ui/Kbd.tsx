import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Keyboard key hint. Mono, hairline border with a 2px bottom. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] leading-none border border-line-strong border-b-2 rounded px-[5px] py-[2px] text-muted bg-surface",
        className
      )}
      {...rest}
    />
  );
}
