import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired once the last box is filled, with the complete code. */
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  label?: string;
}

/**
 * Digit boxes for the emailed sign-in code. Auto-advances on entry, steps back
 * on backspace, and accepts a pasted code into any box. The server's codes are
 * 6 digits (hashed server side in `defaultdata_Otp`, 10 minute expiry).
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  autoFocus,
  label
}: CodeInputProps) {
  const { t } = useTranslation();
  const boxLabel = label ?? t("auth.code.label");
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.padEnd(length, " ").slice(0, length).split("");

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const commit = (next: string) => {
    onChange(next);
    if (next.length === length && !next.includes(" ")) onComplete?.(next);
  };

  const setDigit = (index: number, digit: string) => {
    const chars = value.padEnd(length, " ").slice(0, length).split("");
    chars[index] = digit || " ";
    const next = chars.join("").replace(/\s+$/, "");
    commit(next.trimEnd());
    if (digit && index < length - 1) refs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index]?.trim() && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
      setDigit(index - 1, "");
    } else if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < length - 1) {
      e.preventDefault();
      refs.current[index + 1]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    e.preventDefault();
    commit(pasted);
    refs.current[Math.min(pasted.length, length - 1)]?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-ink-2">{boxLabel}</span>
      <div className="flex gap-2">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={digit.trim()}
            onChange={(e) => setDigit(i, e.target.value.replace(/\D/g, "").slice(-1))}
            onKeyDown={onKeyDown(i)}
            onPaste={onPaste}
            onFocus={(e) => e.target.select()}
            disabled={disabled}
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            maxLength={1}
            aria-label={t("auth.code.digitAria", { label: boxLabel, index: i + 1 })}
            className={cn(
              "size-12 rounded-md border bg-surface text-center font-mono text-[18px] text-ink",
              "focus:outline-none focus:border-accent focus:shadow-[var(--shadow-focus)]",
              "disabled:bg-ground disabled:text-muted",
              invalid ? "border-danger" : "border-line"
            )}
          />
        ))}
      </div>
    </div>
  );
}
