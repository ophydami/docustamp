import { cn } from "@/lib/cn";

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, label, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-accent" : "bg-line-strong",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-knob transition-all",
          checked ? "left-[16px]" : "left-[2px]"
        )}
      />
    </button>
  );
}

export interface CheckboxProps {
  checked: boolean | "mixed";
  onChange?: (v: boolean) => void;
  className?: string;
  label?: string;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, className, label, disabled }: CheckboxProps) {
  const on = checked === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!on);
      }}
      className={cn(
        "inline-flex items-center justify-center size-3.5 rounded border transition-colors shrink-0",
        on || checked === "mixed" ? "bg-accent border-accent" : "bg-surface border-faint hover:border-muted-2",
        className
      )}
    >
      {on ? (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--color-on-accent)" strokeWidth="2.5">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
      ) : checked === "mixed" ? (
        <span className="block w-2 h-[2px] bg-on-accent" />
      ) : null}
    </button>
  );
}
