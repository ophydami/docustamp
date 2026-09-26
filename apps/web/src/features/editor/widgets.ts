import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_FONT_SIZE,
  DEFAULT_OPTION_VALUES,
  OPTION_ROW_HEIGHT,
  WIDGET_BY_TYPE
} from "./constants";
import type { EditorField, SignerRow, Widget, WidgetOptions, WidgetType } from "./types";

const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** `randomId(8)` in the old app: an integer with `digits` digits, stored as a Number. */
export function randomKey(digits = 8): number {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits - 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min + 1));
}

/** `generateId(6)`: the alphanumeric slug inside `options.name`. */
export function generateSlug(len = 6): string {
  let out = "";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += ALPHANUM[buf[i] % ALPHANUM.length];
  return out;
}

/** Machine name for a new widget: `${type}-${generateId(6)}-${count}` (§7.3). */
export function widgetName(type: WidgetType, count: number): string {
  return `${type}-${generateSlug(6)}-${count}`;
}

/** Types whose value is picked from a list the sender maintains. */
function isListType(type: WidgetType): boolean {
  return type === "dropdown" || type === "radio button" || type === "checkbox";
}

/**
 * `addWidgetOptions(type, signer, placeholder)` from the old app: every widget starts
 * with `{ name, status: "required" }` and gains the per-type keys in §7.3.
 *
 * One deliberate difference: the old app creates dropdown/radio/checkbox with no
 * `values` and forces the sender through a modal before the widget is usable. This
 * editor seeds `["Option-1", "Option-2"]` instead so the field works the moment it
 * lands, and the properties panel edits the list. The stored shape is identical.
 */
export function defaultOptions(type: WidgetType, count: number, signer?: SignerRow): WidgetOptions {
  const base: WidgetOptions = { name: widgetName(type, count), status: "required" };
  switch (type) {
    case "checkbox":
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: [],
        layout: "vertical",
        isReadOnly: false,
        isHideLabel: false,
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "radio button":
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: "",
        layout: "vertical",
        isReadOnly: false,
        isHideLabel: false,
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "dropdown":
      return {
        ...base,
        values: [...DEFAULT_OPTION_VALUES],
        defaultValue: "",
        isReadOnly: false,
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "text input":
      return { ...base, isReadOnly: false, fontSize: DEFAULT_FONT_SIZE, fontColor: "black" };
    case "cells":
      return {
        ...base,
        cellCount: 5,
        defaultValue: "",
        validation: { type: "", pattern: "" },
        isReadOnly: false,
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "name":
      return { ...base, defaultValue: signer?.name ?? "", fontSize: DEFAULT_FONT_SIZE, fontColor: "black" };
    case "company":
    case "job title":
      return { ...base, defaultValue: "", fontSize: DEFAULT_FONT_SIZE, fontColor: "black" };
    case "email":
      return {
        ...base,
        validation: { type: "email", pattern: "" },
        defaultValue: signer?.email ?? "",
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "date":
      return {
        ...base,
        response: "",
        isReadOnly: false,
        validation: { type: "date-format", format: DEFAULT_DATE_FORMAT },
        fontSize: DEFAULT_FONT_SIZE,
        fontColor: "black"
      };
    case "text":
      return { ...base, defaultValue: "", fontSize: DEFAULT_FONT_SIZE, fontColor: "black" };
    case "signature":
    case "initials":
      return { ...base, rotation: 0 };
    default:
      return base;
  }
}

/** Height a checkbox/radio group needs for `n` options: base height plus 15pt per extra row (§7.3). */
export function heightForOptions(type: WidgetType, count: number): number {
  const spec = WIDGET_BY_TYPE[type];
  if (type !== "checkbox" && type !== "radio button") return spec.height;
  return spec.height + Math.max(0, count - 1) * OPTION_ROW_HEIGHT;
}

export interface CreateWidgetInput {
  type: WidgetType;
  page: number;
  /** Top-left in PDF points. */
  x: number;
  y: number;
  /** Container scale (rendered px per PDF point) at placement time. */
  scale: number;
  zIndex: number;
  /** How many widgets of this type this signer already has, for the `name` suffix. */
  count: number;
  signer?: SignerRow;
}

export function createField(input: CreateWidgetInput): EditorField {
  const spec = WIDGET_BY_TYPE[input.type];
  const options = defaultOptions(input.type, input.count, input.signer);
  const values = Array.isArray(options.values) ? options.values : [];
  const widget: Widget = {
    key: randomKey(8),
    type: input.type,
    xPosition: round2(input.x),
    yPosition: round2(input.y),
    // The old app writes isStamp as a real boolean on every widget, not just stamps.
    isStamp: input.type === "stamp" || input.type === "image",
    scale: input.scale,
    zIndex: input.zIndex,
    IsResize: false,
    options,
    Width: spec.width,
    Height: isListType(input.type) && values.length ? heightForOptions(input.type, values.length) : spec.height
  };
  return { id: fieldId(input.signer?.id ?? null, widget.key), signerId: input.signer?.id ?? null, page: input.page, widget };
}

/** Stable client-side id. Widget keys are unique per document, the signer prefix keeps it readable. */
export function fieldId(signerId: number | null, key: number): string {
  return `${signerId ?? "none"}-${key}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A copy with a fresh key and a fresh machine name, exactly as PlaceholderCopy does. */
export function duplicateField(field: EditorField, opts: { page?: number; x?: number; y?: number }): EditorField {
  const key = randomKey(8);
  const widget: Widget = {
    ...field.widget,
    key,
    xPosition: round2(opts.x ?? field.widget.xPosition),
    yPosition: round2(opts.y ?? field.widget.yPosition),
    options: { ...field.widget.options, name: `${field.widget.type}${randomKey(2)}` }
  };
  return { ...field, id: fieldId(field.signerId, key), page: opts.page ?? field.page, widget };
}

/** i18n key of the human label for a type, used in overlay chips and the properties header. */
export function typeLabelKey(type: WidgetType): string {
  return WIDGET_BY_TYPE[type]?.labelKey ?? type;
}

/** `signature` is mandatory regardless of status (constant/Utils.js:handleCheckResponse). */
export function isRequired(widget: Widget): boolean {
  return widget.type === "signature" || widget.options.status === "required";
}

export function optionValues(w: Widget): string[] {
  return Array.isArray(w.options.values) ? w.options.values : [];
}
