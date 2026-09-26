import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Countdown in whole seconds, used to rate-limit "resend code". The server
 * also rate limits OTP sends (5 per address per 10 minutes), so this cooldown
 * is a client-side courtesy that keeps users from hitting that limit.
 */
export function useCooldown(seconds = 45) {
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clear();
    setLeft(seconds);
    timer.current = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          clear();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  }, [clear, seconds]);

  useEffect(() => clear, [clear]);

  return { left, start, active: left > 0 };
}
