import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Move, PenLine, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SignerField } from "../types";
import { cssFontColor, fieldDatePattern, fieldLabel, formatToday, isFilled, IMAGE_TYPES } from "../widgets";

export interface FieldBoxProps {
  field: SignerField;
  /** css px per PDF point for this page. */
  scale: number;
  active: boolean;
  invalid?: boolean;
  dateFormat: string;
  onFocus: (key: number) => void;
  onChange: (key: number, response: string | number[] | undefined) => void;
  /** Signature-ish fields ask the page to open the adopt sheet. */
  onRequestSignature: (field: SignerField) => void;
  onRequestImage: (field: SignerField) => void;
  /** Page size in PDF points, used to keep a dragged field on the page. */
  bounds?: { w: number; h: number };
  /** Only fields the signer added this session can be moved, resized or removed. */
  onMove?: (key: number, x: number, y: number) => void;
  onResize?: (key: number, w: number, h: number) => void;
  onDelete?: (key: number) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Pointer drag helper shared by the move handle and the resize grip. Deltas are
 * screen px converted back into PDF points by dividing by the page scale (§7.4).
 */
function trackPointer(e: React.PointerEvent, onDelta: (dx: number, dy: number) => void, onEnd?: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  const move = (ev: PointerEvent) => onDelta(ev.clientX - startX, ev.clientY - startY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * One placed widget drawn over the page. Geometry is `pdfPoint * scale` (§7.4):
 * the stored coordinates are already in PDF points from the page top-left, so
 * no container-scale division is needed here, only multiplication.
 */
export function FieldBox(props: FieldBoxProps) {
  const { field: f, scale, active } = props;
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusable = el.querySelector<HTMLElement>("input, textarea, select, button");
    window.setTimeout(() => focusable?.focus({ preventScroll: true }), 220);
  }, [active]);

  const style: React.CSSProperties = {
    left: f.x * scale,
    top: f.y * scale,
    width: Math.max(8, f.w * scale),
    height: Math.max(8, f.h * scale)
  };

  if (!f.mine) return <OthersField field={f} style={style} scale={scale} dateFormat={props.dateFormat} />;

  const filled = isFilled(f);
  const fontPx = Math.max(7, f.fontSize * scale);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute rounded-[3px] transition-all",
        active
          ? "border-2 border-accent bg-accent-soft/70 shadow-[0_0_0_3px_rgb(20_71_230/0.14)] z-20"
          : filled
            ? "border border-accent-line bg-accent-tint/60 z-10"
            : "border border-accent bg-accent-soft/45 z-10",
        props.invalid && !active && "border-danger bg-danger-soft/50"
      )}
      style={style}
      data-field={f.key}
    >
      {active && !f.added ? (
        <span className="absolute -left-px top-0 -translate-x-full h-full px-1.5 flex items-center rounded-l-[3px] bg-accent text-on-accent text-[10px] font-semibold tracking-wide uppercase whitespace-nowrap">
          {f.type === "signature" || f.type === "initials" ? t("signer.field.badge.sign") : t("signer.field.badge.fill")}
        </span>
      ) : null}
      <FieldControl {...props} fontPx={fontPx} />
      {f.added ? <AddedFieldHandles {...props} /> : null}
    </div>
  );
}

/**
 * Move, remove and resize grips, on fields the signer placed themselves. They
 * stay available until the document is signed, matching the old app where a
 * widget whose `key` is not in `assignedWidgetId` is freely editable.
 */
function AddedFieldHandles({ field: f, scale, bounds, onMove, onResize, onDelete }: FieldBoxProps) {
  const { t } = useTranslation();
  const maxW = bounds?.w ?? f.x + f.w;
  const maxH = bounds?.h ?? f.y + f.h;
  return (
    <>
      <button
        type="button"
        aria-label={t("signer.a11y.moveField", { label: fieldLabel(f) })}
        title={t("signer.field.dragToMove")}
        className="absolute -top-2.5 -left-2.5 size-5 rounded-full bg-accent text-on-accent flex items-center justify-center cursor-grab active:cursor-grabbing shadow-sm z-30"
        onPointerDown={(e) =>
          onMove &&
          trackPointer(e, (dx, dy) =>
            onMove(
              f.key,
              clamp(f.x + dx / scale, 0, Math.max(0, maxW - f.w)),
              clamp(f.y + dy / scale, 0, Math.max(0, maxH - f.h))
            )
          )
        }
      >
        <Move className="size-3" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label={t("signer.a11y.removeField", { label: fieldLabel(f) })}
        title={t("signer.field.removeThisField")}
        className="absolute -top-2.5 -right-2.5 size-5 rounded-full bg-surface border border-line text-danger flex items-center justify-center shadow-sm z-30 hover:bg-danger-soft"
        onClick={() => onDelete?.(f.key)}
      >
        <Trash2 className="size-3" strokeWidth={1.8} />
      </button>
      <span
        role="presentation"
        title={t("signer.field.dragToResize")}
        className="absolute -bottom-1 -right-1 size-3 rounded-[2px] border border-accent bg-surface cursor-se-resize z-30"
        onPointerDown={(e) =>
          onResize &&
          trackPointer(e, (dx, dy) =>
            onResize(
              f.key,
              clamp(f.w + dx / scale, 12, Math.max(12, maxW - f.x)),
              clamp(f.h + dy / scale, 8, Math.max(8, maxH - f.y))
            )
          )
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Other signers' fields
 * ------------------------------------------------------------------ */

function OthersField({
  field: f,
  style,
  scale,
  dateFormat
}: {
  field: SignerField;
  style: React.CSSProperties;
  scale: number;
  dateFormat: string;
}) {
  const value = typeof f.response === "string" ? f.response : undefined;
  if (value && IMAGE_TYPES.has(f.type)) {
    return (
      <div className="absolute" style={style} aria-hidden>
        <img src={value} alt="" className="w-full h-full object-contain pointer-events-none select-none" />
      </div>
    );
  }
  if (value) {
    const text = f.type === "date" && value === "today" ? formatToday(fieldDatePattern(f, dateFormat)) : value;
    return (
      <div
        className="absolute overflow-hidden whitespace-pre-wrap leading-tight pointer-events-none"
        style={{ ...style, fontSize: Math.max(7, f.fontSize * scale), color: cssFontColor(f.fontColor) }}
        aria-hidden
      >
        {text}
      </div>
    );
  }
  // Pending: a faint marker so the signer understands the page is shared.
  return (
    <div
      className="absolute rounded-[3px] border border-dashed border-line-strong bg-[rgb(28_27_24/0.02)] pointer-events-none overflow-hidden"
      style={style}
      aria-hidden
    >
      <span
        className="absolute left-1 top-0.5 text-[9px] font-medium truncate max-w-[95%]"
        style={{ color: f.color, opacity: 0.75 }}
      >
        {f.signerName}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * My field, by type
 * ------------------------------------------------------------------ */

function FieldControl({
  field: f,
  scale,
  dateFormat,
  onFocus,
  onChange,
  onRequestSignature,
  onRequestImage,
  fontPx
}: FieldBoxProps & { fontPx: number }) {
  const { t } = useTranslation();
  const commonText = "w-full h-full bg-transparent border-0 outline-none px-1 leading-tight";
  const textStyle: React.CSSProperties = { fontSize: fontPx, color: cssFontColor(f.fontColor) };
  const value = typeof f.response === "string" ? f.response : "";

  if (IMAGE_TYPES.has(f.type)) {
    const isSig = f.type === "signature" || f.type === "initials" || f.type === "draw";
    return (
      <button
        type="button"
        className="w-full h-full flex items-center justify-center gap-1 px-1"
        onClick={() => {
          onFocus(f.key);
          if (isSig || f.type === "stamp") onRequestSignature(f);
          else onRequestImage(f);
        }}
        aria-label={t("signer.a11y.widgetField", { label: fieldLabel(f) })}
      >
        {value ? (
          <img src={value} alt="" className="max-w-full max-h-full object-contain pointer-events-none" />
        ) : (
          <span className="inline-flex items-center gap-1 text-accent font-semibold truncate" style={{ fontSize: Math.min(12, Math.max(8, fontPx)) }}>
            {isSig ? <PenLine className="size-3 shrink-0" strokeWidth={1.8} /> : <ImagePlus className="size-3 shrink-0" strokeWidth={1.8} />}
            {fieldLabel(f)}
          </span>
        )}
      </button>
    );
  }

  if (f.type === "checkbox") {
    const chosen = new Set(Array.isArray(f.response) ? f.response : Array.isArray(f.defaultValue) ? f.defaultValue : []);
    const values = f.values.length ? f.values : [""];
    return (
      <div
        className={cn("w-full h-full flex gap-1 px-0.5 py-0.5 overflow-hidden", f.layout === "horizontal" ? "flex-row items-center" : "flex-col")}
      >
        {values.map((label, i) => (
          <label key={`${label}-${i}`} className="flex items-center gap-1 cursor-pointer min-w-0" style={{ fontSize: fontPx }}>
            <input
              type="checkbox"
              className="accent-[#1447e6] shrink-0"
              style={{ width: fontPx, height: fontPx }}
              disabled={f.readOnly}
              checked={chosen.has(i)}
              onFocus={() => onFocus(f.key)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(i);
                else next.delete(i);
                onChange(f.key, Array.from(next).sort((a, b) => a - b));
              }}
            />
            {!f.hideLabel && label ? <span className="truncate" style={{ color: cssFontColor(f.fontColor) }}>{label}</span> : null}
          </label>
        ))}
      </div>
    );
  }

  if (f.type === "radio button") {
    const values = f.values.length ? f.values : [""];
    return (
      <div
        className={cn("w-full h-full flex gap-1 px-0.5 py-0.5 overflow-hidden", f.layout === "horizontal" ? "flex-row items-center" : "flex-col")}
      >
        {values.map((label, i) => (
          <label key={`${label}-${i}`} className="flex items-center gap-1 cursor-pointer min-w-0" style={{ fontSize: fontPx }}>
            <input
              type="radio"
              name={`radio-${f.key}`}
              className="accent-[#1447e6] shrink-0"
              style={{ width: fontPx, height: fontPx }}
              disabled={f.readOnly}
              checked={value === label}
              onFocus={() => onFocus(f.key)}
              onChange={() => onChange(f.key, label)}
            />
            {!f.hideLabel && label ? <span className="truncate" style={{ color: cssFontColor(f.fontColor) }}>{label}</span> : null}
          </label>
        ))}
      </div>
    );
  }

  if (f.type === "dropdown") {
    return (
      <select
        className={cn(commonText, "cursor-pointer")}
        style={textStyle}
        disabled={f.readOnly}
        value={value}
        onFocus={() => onFocus(f.key)}
        onChange={(e) => onChange(f.key, e.target.value || undefined)}
        aria-label={f.name ?? t("signer.field.dropdown")}
      >
        <option value="">{t("common.actions.select")}</option>
        {f.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  if (f.type === "cells") {
    const chars = Array.from({ length: f.cellCount }, (_, i) => value[i] ?? "");
    return (
      <div className="w-full h-full flex items-stretch">
        {chars.map((ch, i) => (
          <input
            key={i}
            className="flex-1 min-w-0 text-center bg-transparent border-r border-accent-line last:border-r-0 outline-none focus:bg-accent-soft"
            style={textStyle}
            maxLength={1}
            value={ch}
            readOnly={f.readOnly}
            inputMode={f.validation?.type === "number" || f.validation?.type === "ssn" ? "numeric" : undefined}
            onFocus={() => onFocus(f.key)}
            onChange={(e) => {
              const next = [...chars];
              next[i] = e.target.value.slice(-1);
              onChange(f.key, next.join("").trimEnd() || undefined);
              if (e.target.value) (e.target.nextElementSibling as HTMLInputElement | null)?.focus();
            }}
            aria-label={t("signer.a11y.character", { position: i + 1 })}
          />
        ))}
      </div>
    );
  }

  if (f.type === "date") {
    const pattern = fieldDatePattern(f, dateFormat);
    const shown = value === "today" || !value ? formatToday(pattern) : value;
    if (f.readOnly) {
      return (
        <span className="w-full h-full flex items-center px-1 truncate" style={textStyle}>
          {shown}
        </span>
      );
    }
    return (
      <input
        className={commonText}
        style={textStyle}
        value={shown}
        placeholder={pattern}
        onFocus={() => onFocus(f.key)}
        onChange={(e) => onChange(f.key, e.target.value || undefined)}
        aria-label={t("signer.field.dateSigned")}
      />
    );
  }

  const multiline = f.h * scale > fontPx * 2.2;
  const inputMode = f.validation?.type === "number" ? "decimal" : f.type === "email" ? "email" : undefined;

  if (multiline && (f.type === "text input" || f.type === "text")) {
    return (
      <textarea
        className={cn(commonText, "resize-none py-0.5 scroll-thin")}
        style={textStyle}
        value={value}
        readOnly={f.readOnly}
        placeholder={f.hint ?? fieldLabel(f)}
        onFocus={() => onFocus(f.key)}
        onChange={(e) => onChange(f.key, e.target.value || undefined)}
        aria-label={f.name ?? fieldLabel(f)}
      />
    );
  }

  return (
    <input
      className={commonText}
      style={textStyle}
      value={value}
      readOnly={f.readOnly}
      inputMode={inputMode}
      placeholder={f.hint ?? fieldLabel(f)}
      onFocus={() => onFocus(f.key)}
      onChange={(e) => onChange(f.key, e.target.value || undefined)}
      aria-label={f.name ?? fieldLabel(f)}
    />
  );
}
