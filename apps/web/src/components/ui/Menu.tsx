import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  kbd?: string;
  icon?: ReactNode;
}

export interface MenuProps {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; "aria-expanded": boolean }) => ReactNode;
  items: (MenuItem | "separator")[];
  align?: "left" | "right";
  className?: string;
}

/** Gap between the trigger and the panel, and the margin kept from the window edge. */
const GAP = 4;
const EDGE = 8;

/**
 * Minimal click-to-open menu. Closes on outside click, Esc, scroll or resize.
 *
 * The panel is rendered in a portal at fixed window coordinates rather than
 * absolutely inside the trigger's container: every table on the app sits in a
 * card with `overflow-hidden` (and a horizontal scroller at narrow widths), so
 * the menu of the last visible rows used to be cut off at the card's edge. It
 * opens below the trigger and flips above it when there is not enough room.
 */
export function Menu({ trigger, items, align = "right", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setStyle(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // Scrolling any ancestor moves the trigger away from a fixed panel, so close
    // rather than chase it; the capture flag catches scrollers inside the page.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // The panel is rendered hidden first so its real height is known before it
  // is placed; then it is pinned to the trigger and shown.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = ref.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const height = panel.offsetHeight;
    const width = panel.offsetWidth;
    const roomBelow = window.innerHeight - anchor.bottom - EDGE;
    const flipUp = height + GAP > roomBelow && anchor.top - EDGE > roomBelow;
    const next: CSSProperties = {};
    if (flipUp) next.bottom = Math.max(EDGE, window.innerHeight - anchor.top + GAP);
    else next.top = Math.max(EDGE, anchor.bottom + GAP);
    if (align === "right") {
      next.right = Math.max(EDGE, window.innerWidth - anchor.right);
    } else {
      next.left = Math.min(Math.max(EDGE, anchor.left), Math.max(EDGE, window.innerWidth - width - EDGE));
    }
    setStyle(next);
  }, [open, align]);

  return (
    <div ref={ref} className={cn("relative inline-block", className)}>
      {trigger({
        onClick: (e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        },
        "aria-expanded": open
      })}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              style={style ?? { top: 0, left: 0, visibility: "hidden" }}
              className="fixed z-[55] min-w-44 bg-surface border border-line rounded-lg shadow-[var(--shadow-pop)] py-1"
            >
              {items.map((it, i) =>
                it === "separator" ? (
                  <div key={i} className="my-1 h-px bg-line-soft" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    disabled={it.disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      close();
                      it.onSelect?.();
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 h-8 text-left text-[13px] hover:bg-line-soft disabled:opacity-50",
                      it.danger && "text-danger"
                    )}
                  >
                    {it.icon}
                    <span className="flex-1">{it.label}</span>
                    {it.kbd ? <span className="font-mono text-[10px] text-muted-2">{it.kbd}</span> : null}
                  </button>
                )
              )}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
