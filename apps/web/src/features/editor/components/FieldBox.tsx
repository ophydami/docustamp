import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "@/lib/cn";
import { textColorFor } from "../constants";
import { isRequired, optionValues, typeLabelKey } from "../widgets";
import type { EditorField, SignerRow } from "../types";

export type DragMode = "move" | "nw" | "ne" | "sw" | "se";

const UNASSIGNED = "#b5412e";

export interface FieldBoxProps {
  field: EditorField;
  signer: SignerRow | undefined;
  /** css px per PDF point */
  scale: number;
  selected: boolean;
  preview: boolean;
  onPointerDown: (e: React.PointerEvent, field: EditorField, mode: DragMode) => void;
}

/** Content the signer would see: the hint, the default value, or the option list. */
function previewText(field: EditorField, t: TFunction): string {
  const o = field.widget.options;
  const type = field.widget.type;
  if (type === "date") return typeof o.validation?.format === "string" ? o.validation.format : t("editor.widgets.date.label");
  if (type === "dropdown")
    return typeof o.defaultValue === "string" && o.defaultValue ? o.defaultValue : t("editor.field.selectPlaceholder");
  if (type === "radio button" || type === "checkbox") return optionValues(field.widget).join(", ");
  if (typeof o.defaultValue === "string" && o.defaultValue) return o.defaultValue;
  if (typeof o.hint === "string" && o.hint) return o.hint;
  return t(typeLabelKey(type));
}

function Handle({ pos, color, onDown }: { pos: DragMode; color: string; onDown: (e: React.PointerEvent) => void }) {
  const corner: Record<string, string> = {
    nw: "-top-1 -left-1 cursor-nwse-resize",
    ne: "-top-1 -right-1 cursor-nesw-resize",
    sw: "-bottom-1 -left-1 cursor-nesw-resize",
    se: "-bottom-1 -right-1 cursor-nwse-resize"
  };
  return (
    <span
      onPointerDown={onDown}
      className={cn("absolute size-2 rounded-[2px] border border-white", corner[pos])}
      style={{ background: color }}
    />
  );
}

export const FieldBox = memo(function FieldBox({
  field,
  signer,
  scale,
  selected,
  preview,
  onPointerDown
}: FieldBoxProps) {
  const { t } = useTranslation();
  const assigned = Boolean(signer);
  const color = assigned ? (signer?.color && signer.color !== "transparent" ? signer.color : "#8a857b") : UNASSIGNED;
  const ink = assigned ? textColorFor(color) : UNASSIGNED;
  const w = field.widget;
  const owner = signer
    ? signer.isPrefill
      ? t("editor.field.owner.prefill")
      : signer.name || signer.role
    : t("editor.field.owner.unassigned");
  const label = t("editor.field.label", { type: t(typeLabelKey(w.type)), owner });

  return (
    <div
      data-field-id={field.id}
      role={preview ? undefined : "button"}
      tabIndex={preview ? undefined : -1}
      aria-label={label}
      onPointerDown={preview ? undefined : (e) => onPointerDown(e, field, "move")}
      className={cn(
        "absolute box-border flex items-center overflow-hidden select-none",
        preview ? "cursor-default" : "cursor-move",
        selected && "z-30"
      )}
      style={{
        left: w.xPosition * scale,
        top: w.yPosition * scale,
        width: Math.max(w.Width * scale, 6),
        height: Math.max(w.Height * scale, 6),
        border: `1.5px ${assigned ? "solid" : "dashed"} ${color}`,
        borderRadius: 3,
        background: `${color}14`,
        zIndex: selected ? 30 : (w.zIndex ?? 5),
        boxShadow: selected ? `0 0 0 3px ${color}33` : undefined
      }}
    >
      <span
        className="px-1 text-[10px] leading-none font-medium truncate w-full"
        style={{ color: ink, fontSize: Math.min(11, Math.max(8, w.Height * scale * 0.5)) }}
      >
        {preview ? previewText(field, t) : label}
      </span>

      {selected && !preview ? (
        <>
          {isRequired(w) ? (
            <span
              className="absolute -top-[17px] left-0 h-4 px-1 rounded-[3px] text-[9px] font-semibold leading-4 text-white whitespace-nowrap"
              style={{ background: color }}
            >
              {t("editor.field.required")}
            </span>
          ) : null}
          {(["nw", "ne", "sw", "se"] as const).map((h) => (
            <Handle key={h} pos={h} color={color} onDown={(e) => onPointerDown(e, field, h)} />
          ))}
        </>
      ) : null}
    </div>
  );
});
