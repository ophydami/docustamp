/** CSS-grid table with an optional sortable header, matching the app's list density. */
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: string;
  width: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
}

export function DataTable<T>({
  columns,
  rows,
  getKey,
  defaultSort,
  onRowClick,
  className
}: {
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  onRowClick?: (row: T) => void;
  className?: string;
}) {
  const [sort, setSort] = useState(defaultSort);
  const template = columns.map((c) => c.width).join(" ");
  // Below this the table scrolls sideways instead of squeezing its flexible columns to nothing.
  // Fixed px tracks count as written; anything flexible (fr, minmax) gets a 160px floor.
  const minWidth = columns.reduce((sum, c) => sum + (/^\d+px$/.test(c.width) ? parseInt(c.width, 10) : 160), 0) + 28;

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue?.(a) ?? 0;
      const bv = col.sortValue?.(b) ?? 0;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sort, columns]);

  return (
    <div className={cn("border border-line rounded-xl overflow-hidden bg-surface", className)}>
      <div className="overflow-x-auto scroll-thin">
      <div style={{ minWidth }}>
      <div
        role="row"
        className="grid items-center h-[34px] px-3.5 bg-surface-2 border-b border-line"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((c) => {
          const active = sort?.key === c.key;
          const content = (
            <span className="text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium inline-flex items-center gap-1">
              {c.header}
              {active ? (
                sort?.dir === "asc" ? (
                  <ArrowUp className="size-3" strokeWidth={1.6} />
                ) : (
                  <ArrowDown className="size-3" strokeWidth={1.6} />
                )
              ) : null}
            </span>
          );
          return (
            <div key={c.key} role="columnheader" className={cn("min-w-0", c.align === "right" && "text-right")}>
              {c.sortValue ? (
                <button
                  type="button"
                  className="hover:text-ink"
                  onClick={() =>
                    setSort((s) =>
                      s?.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: "desc" }
                    )
                  }
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </div>
          );
        })}
      </div>
      {sorted.map((row) => (
        <div
          key={getKey(row)}
          role="row"
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          className={cn(
            "grid items-center min-h-[46px] px-3.5 border-b border-line-soft last:border-b-0 text-[13px]",
            onRowClick && "cursor-pointer hover:bg-surface-2"
          )}
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((c) => (
            <div key={c.key} role="cell" className={cn("min-w-0 pr-3 last:pr-0", c.align === "right" && "text-right")}>
              {c.render(row)}
            </div>
          ))}
        </div>
      ))}
      </div>
      </div>
    </div>
  );
}
