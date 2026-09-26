import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const base =
  "w-full bg-surface border border-line rounded-md text-[13px] text-ink placeholder:text-muted-2 " +
  "focus:outline-none focus:border-accent focus:shadow-[var(--shadow-focus)] disabled:bg-ground disabled:text-muted";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  left?: ReactNode;
  right?: ReactNode;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, left, right, invalid, ...rest },
  ref
) {
  if (!left && !right) {
    return (
      <input
        ref={ref}
        className={cn(base, "h-9 px-3", invalid && "border-danger focus:border-danger", className)}
        {...rest}
      />
    );
  }
  return (
    <div className={cn("relative flex items-center", className)}>
      {left ? <span className="absolute left-3 text-muted-2 pointer-events-none">{left}</span> : null}
      <input
        ref={ref}
        className={cn(base, "h-9 px-3", left && "pl-9", right && "pr-9", invalid && "border-danger")}
        {...rest}
      />
      {right ? <span className="absolute right-3 text-muted-2">{right}</span> : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(base, "px-3 py-2 leading-relaxed min-h-20", className)} {...rest} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(base, "h-9 px-3 pr-8 appearance-none bg-no-repeat", className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%238A857B' stroke-width='1.6'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")",
          backgroundPosition: "right 10px center"
        }}
        {...rest}
      >
        {children}
      </select>
    );
  }
);

export function Field({
  label,
  hint,
  error,
  children,
  className,
  right
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      {label || right ? (
        <span className="flex items-center justify-between text-[12px] font-semibold text-ink-2">
          <span>{label}</span>
          {right}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-2">{hint}</span>
      ) : null}
    </label>
  );
}
