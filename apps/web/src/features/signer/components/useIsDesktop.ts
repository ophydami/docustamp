import { useEffect, useState } from "react";

/** True at the signer's desktop breakpoint (the design switches layout at 900px). */
export function useIsDesktop(minWidth = 900): boolean {
  const [is, setIs] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(`(min-width: ${minWidth}px)`).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const on = () => setIs(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [minWidth]);
  return is;
}
