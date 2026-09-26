/**
 * Charts for the reports screen. Pure CSS and SVG on purpose: no chart library,
 * one hue (the accent green), hairline gridlines, tabular numerals.
 * Every chart renders a screen-reader table alongside the bars.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { num, percent } from "@/lib/format";
import { Cap } from "@/components/ui";

export interface Datum {
  key: string;
  label: string;
  value: number;
  /** Full sentence shown on hover and used as the `title` fallback. */
  tooltip: string;
}

/** Card wrapper: title row, optional right-hand control, optional insight line. */
export function ChartCard({
  title,
  right,
  insight,
  children,
  className
}: {
  title: string;
  right?: ReactNode;
  insight?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-surface border border-line rounded-lg px-4 pt-3.5 pb-4 flex flex-col gap-3", className)}>
      <header className="flex items-center gap-3 min-h-7">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {right ? <div className="ml-auto flex items-center gap-1.5">{right}</div> : null}
      </header>
      {children}
      {insight ? <p className="text-[12px] text-muted leading-relaxed">{insight}</p> : null}
    </section>
  );
}

function Gridlines() {
  return (
    <div aria-hidden className="absolute inset-0 flex flex-col justify-between">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={cn("h-px w-full", i === 4 ? "bg-line-strong" : "bg-line-soft")} />
      ))}
    </div>
  );
}

/** Accessible equivalent of a chart, hidden visually. */
export function SrTable({ caption, unit, data }: { caption: string; unit: string; data: Datum[] }) {
  const { t } = useTranslation();
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{unit}</th>
          <th scope="col">{t("reports.charts.valueHeader")}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            <td>{num(d.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BarChart({
  data,
  caption,
  unit,
  height = 150,
  labelEvery
}: {
  data: Datum[];
  caption: string;
  unit: string;
  height?: number;
  /** Show every n-th x label. Defaults to a density that fits. */
  labelEvery?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const maxIndex = data.findIndex((d) => d.value === max && max > 0);
  const step = labelEvery ?? Math.max(1, Math.ceil(data.length / 12));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative pt-5">
        <div className="relative" style={{ height }}>
          <Gridlines />
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((d, i) => {
              const h = d.value === 0 ? 0 : Math.max(3, (d.value / max) * 100);
              const on = hover === d.key;
              return (
                <div
                  key={d.key}
                  className="flex-1 min-w-0 h-full flex items-end"
                  onMouseEnter={() => setHover(d.key)}
                  onMouseLeave={() => setHover((k) => (k === d.key ? null : k))}
                >
                  <div
                    title={d.tooltip}
                    className={cn(
                      "relative w-full rounded-t-[4px] transition-colors",
                      d.value === 0 ? "h-px bg-line-strong" : on ? "bg-accent-deep" : "bg-accent"
                    )}
                    style={d.value === 0 ? undefined : { height: `${h}%` }}
                  >
                    {i === maxIndex && !on ? (
                      <span className="num absolute -top-[17px] left-1/2 -translate-x-1/2 text-[10px] font-medium text-ink-2">
                        {num(d.value)}
                      </span>
                    ) : null}
                    {on ? (
                      <span className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-20 pointer-events-none whitespace-nowrap rounded-md bg-ink text-ground text-[11px] px-2 py-1 shadow-[var(--shadow-pop)]">
                        {d.tooltip}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div aria-hidden className="flex gap-[2px]">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 min-w-0 text-[10px] text-muted-2 text-center truncate">
            {i % step === 0 ? d.label : ""}
          </span>
        ))}
      </div>
      <SrTable caption={caption} unit={unit} data={data} />
    </div>
  );
}

export function FunnelChart({ stages, caption }: { stages: Datum[]; caption: string }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="flex flex-col gap-2.5">
      {stages.map((s) => {
        const on = hover === s.key;
        return (
          <div
            key={s.key}
            className="flex items-center gap-3"
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover((k) => (k === s.key ? null : k))}
          >
            <span className="w-[92px] sm:w-[120px] shrink-0 text-[12px] text-ink-2">{s.label}</span>
            <div className="flex-1 h-6 bg-line-soft rounded-md overflow-hidden" title={s.tooltip}>
              <div
                className={cn("h-full rounded-md transition-colors", on ? "bg-accent-deep" : "bg-accent")}
                style={{ width: `${Math.max(1, (s.value / max) * 100)}%` }}
              />
            </div>
            <span className="num w-[76px] sm:w-[104px] shrink-0 text-right text-[12px] text-ink">
              {num(s.value)}
              <span className="text-muted-2"> ({percent((s.value / max) * 100)})</span>
            </span>
          </div>
        );
      })}
      <SrTable caption={caption} unit={t("reports.charts.funnel.unit")} data={stages} />
    </div>
  );
}

/** Tiny completion bar used in the by-template table. */
export function MiniBar({ value, title }: { value: number; title: string }) {
  return (
    <span className="inline-flex items-center gap-2 w-full" title={title}>
      <span className="flex-1 h-1.5 rounded-full bg-line-soft overflow-hidden">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </span>
      <span className="num text-[12px] text-ink w-8 text-right">{percent(value)}</span>
    </span>
  );
}

/** Small key/value strip used above tables. */
export function ChartLegend({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="flex items-baseline gap-1.5">
          <Cap>{i.label}</Cap>
          <span className="num text-[13px] font-medium text-ink">{i.value}</span>
        </span>
      ))}
    </div>
  );
}
