import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number | string;
  countTone?: "accent" | "muted";
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  right?: ReactNode;
  className?: string;
}

/** Underline tabs with optional counts, like the Inbox filter row. */
export function Tabs<T extends string>({ items, value, onChange, right, className }: TabsProps<T>) {
  return (
    <div className={cn("border-b border-line", className)}>
      {/* The strip scrolls sideways below 1024px instead of squeezing the tabs. */}
      <div className="flex items-end gap-5 max-lg:overflow-x-auto max-lg:scroll-thin">
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            className={cn(
              "text-[13px] pb-2.5 -mb-px border-b-2 whitespace-nowrap shrink-0",
              on ? "text-ink border-ink font-medium" : "text-muted border-transparent hover:text-ink"
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className={cn("num ml-1", t.countTone === "accent" ? "text-accent" : "text-muted-2")}>{t.count}</span>
            ) : null}
          </button>
        );
      })}
      {right ? <div className="ml-auto pb-2 flex gap-1.5 shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}

export interface ChipProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  dot?: string;
  className?: string;
}

/** Filter chip: 28px, hairline; active = ink. */
export function Chip({ active, onClick, children, dot, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium border whitespace-nowrap",
        active ? "bg-ink text-ground border-ink" : "bg-surface text-ink-2 border-line hover:border-line-strong",
        className
      )}
    >
      {dot ? <span className="size-1.5 rounded-full" style={{ background: dot }} /> : null}
      {children}
    </button>
  );
}
