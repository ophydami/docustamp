import {
  AlignLeft,
  AtSign,
  Baseline,
  Briefcase,
  Building2,
  CalendarDays,
  ChevronsUpDown,
  CircleDot,
  Grid3x3,
  Image as ImageIcon,
  PenLine,
  PenTool,
  Signature,
  SquareCheck,
  Stamp,
  UserRound,
  type LucideIcon
} from "lucide-react";
import type { TFunction } from "i18next";
import { percent } from "@/lib/format";
import type { WidgetType } from "./types";

/**
 * Signer block colours, verbatim from the old app (`constant/Utils.js:color`) so a
 * document opened in either frontend shows the same colour per role.
 */
export const SIGNER_COLORS = [
  "#93a3db",
  "#e6c3db",
  "#c0e3bc",
  "#bce3db",
  "#b8ccdb",
  "#ceb8db",
  "#ffccff",
  "#99ffcc",
  "#cc99ff",
  "#ffcc99",
  "#66ccff",
  "#ffffcc"
] as const;

/** Darker companions used for label text (`constant/Utils.js:nameColor`). */
export const SIGNER_TEXT_COLORS = [
  "#304fbf",
  "#7d5270",
  "#5f825b",
  "#578077",
  "#576e80",
  "#6d527d",
  "#cc00cc",
  "#006666",
  "#cc00ff",
  "#ff9900",
  "#336699",
  "#cc9900"
] as const;

export const PREFILL_ROLE = "prefill";
export const PREFILL_COLOR = "transparent";
/** What the editor paints prefill fields with, since "transparent" is not a usable border. */
export const PREFILL_DISPLAY_COLOR = "#8a857b";

export function textColorFor(blockColor: string): string {
  const i = SIGNER_COLORS.indexOf(blockColor as (typeof SIGNER_COLORS)[number]);
  return i >= 0 ? SIGNER_TEXT_COLORS[i] : "#4a4740";
}

export interface WidgetSpec {
  type: WidgetType;
  /** i18n key for the tile label. `type` stays the wire value and is never translated. */
  labelKey: string;
  icon: LucideIcon;
  group: "signature" | "autofill" | "input";
  /** Default size in PDF points (docs/BACKEND_API.md §7.1). */
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Widgets that carry an image get `isStamp: true`. */
  isStamp?: boolean;
  /**
   * Only offered on the `prefill` role. The request-signature palette excludes
   * `text` and `draw` (§7.1 per-flow restrictions).
   */
  prefillOnly?: boolean;
  /** i18n key for the search terms beyond the label. */
  keywordsKey?: string;
}

/**
 * The palette. Types and default sizes match §7.1 exactly. There is no number,
 * attachment or textarea widget in this build, so those tiles do not exist.
 */
export const WIDGETS: WidgetSpec[] = [
  { type: "signature", labelKey: "editor.widgets.signature.label", icon: Signature, group: "signature", width: 150, height: 60, minWidth: 60, minHeight: 24 },
  { type: "initials", labelKey: "editor.widgets.initials.label", icon: PenLine, group: "signature", width: 50, height: 50, minWidth: 24, minHeight: 20 },
  { type: "stamp", labelKey: "editor.widgets.stamp.label", icon: Stamp, group: "signature", width: 150, height: 60, minWidth: 40, minHeight: 24, isStamp: true },
  { type: "date", labelKey: "editor.widgets.date.label", icon: CalendarDays, group: "signature", width: 100, height: 20, minWidth: 50, minHeight: 14, keywordsKey: "editor.widgets.date.keywords" },

  { type: "name", labelKey: "editor.widgets.name.label", icon: UserRound, group: "autofill", width: 150, height: 19, minWidth: 40, minHeight: 14 },
  { type: "email", labelKey: "editor.widgets.email.label", icon: AtSign, group: "autofill", width: 150, height: 19, minWidth: 40, minHeight: 14 },
  { type: "company", labelKey: "editor.widgets.company.label", icon: Building2, group: "autofill", width: 150, height: 19, minWidth: 40, minHeight: 14 },
  { type: "job title", labelKey: "editor.widgets.jobTitle.label", icon: Briefcase, group: "autofill", width: 150, height: 19, minWidth: 40, minHeight: 14 },

  { type: "text input", labelKey: "editor.widgets.textInput.label", icon: Baseline, group: "input", width: 150, height: 19, minWidth: 40, minHeight: 14, keywordsKey: "editor.widgets.textInput.keywords" },
  { type: "checkbox", labelKey: "editor.widgets.checkbox.label", icon: SquareCheck, group: "input", width: 15, height: 19, minWidth: 12, minHeight: 12 },
  { type: "radio button", labelKey: "editor.widgets.radioButton.label", icon: CircleDot, group: "input", width: 5, height: 10, minWidth: 5, minHeight: 10, keywordsKey: "editor.widgets.radioButton.keywords" },
  { type: "dropdown", labelKey: "editor.widgets.dropdown.label", icon: ChevronsUpDown, group: "input", width: 120, height: 22, minWidth: 40, minHeight: 16, keywordsKey: "editor.widgets.dropdown.keywords" },
  { type: "image", labelKey: "editor.widgets.image.label", icon: ImageIcon, group: "input", width: 70, height: 70, minWidth: 24, minHeight: 24, isStamp: true, keywordsKey: "editor.widgets.image.keywords" },
  { type: "cells", labelKey: "editor.widgets.cells.label", icon: Grid3x3, group: "input", width: 112, height: 22, minWidth: 40, minHeight: 16, keywordsKey: "editor.widgets.cells.keywords" },

  { type: "text", labelKey: "editor.widgets.text.label", icon: AlignLeft, group: "input", width: 150, height: 19, minWidth: 40, minHeight: 14, prefillOnly: true, keywordsKey: "editor.widgets.text.keywords" },
  { type: "draw", labelKey: "editor.widgets.draw.label", icon: PenTool, group: "input", width: 150, height: 60, minWidth: 40, minHeight: 24, prefillOnly: true, keywordsKey: "editor.widgets.draw.keywords" }
];

export const WIDGET_BY_TYPE: Record<WidgetType, WidgetSpec> = Object.fromEntries(
  WIDGETS.map((w) => [w.type, w])
) as Record<WidgetType, WidgetSpec>;

export const GROUP_LABEL_KEYS: Record<WidgetSpec["group"], string> = {
  signature: "editor.palette.groups.signature",
  autofill: "editor.palette.groups.autofill",
  input: "editor.palette.groups.input"
};

/** Hotkey → widget type, matching the palette hint row. */
export const KEY_TO_TYPE: Record<string, WidgetType> = {
  s: "signature",
  d: "date",
  t: "text input"
};

/**
 * Date formats the server understands (`selectFormat`, §7.3). The label is what the
 * old UI shows, the value is the date-fns pattern actually stored in
 * `options.validation.format`.
 */
export const DATE_FORMATS: Array<{ label: string; value: string }> = [
  { label: "MM/DD/YYYY", value: "MM/dd/yyyy" },
  { label: "DD-MM-YYYY", value: "dd-MM-yyyy" },
  { label: "DD/MM/YYYY", value: "dd/MM/yyyy" },
  { label: "MMMM DD, YYYY", value: "MMMM dd, yyyy" },
  { label: "DD MMM, YYYY", value: "dd MMM, yyyy" },
  { label: "YYYY-MM-DD", value: "yyyy-MM-dd" },
  { label: "MM-DD-YYYY", value: "MM-dd-yyyy" },
  { label: "MM.DD.YYYY", value: "MM.dd.yyyy" },
  { label: "MMM DD, YYYY", value: "MMM dd, yyyy" },
  { label: "DD MMMM, YYYY", value: "dd MMMM, yyyy" },
  { label: "DD.MM.YYYY", value: "dd.MM.yyyy" },
  { label: "DD-MMM-YYYY", value: "dd-MMM-yyyy" }
];

export const DEFAULT_DATE_FORMAT = "MM/dd/yyyy";

/** `options.fontSize` allow-list (§7.3). */
export const FONT_SIZES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
export const DEFAULT_FONT_SIZE = 12;
/** `options.fontColor` allow-list (§7.3). Only these four names are understood. */
export const FONT_COLORS = ["black", "red", "blue", "yellow"];

/** `validation.type` vocabulary understood by the signer app (§7.3). */
export const VALIDATION_TYPES: Array<{ labelKey: string; value: string }> = [
  { labelKey: "editor.properties.validationTypes.none", value: "" },
  { labelKey: "editor.properties.validationTypes.email", value: "email" },
  { labelKey: "editor.properties.validationTypes.number", value: "number" },
  { labelKey: "editor.properties.validationTypes.letters", value: "text" },
  { labelKey: "editor.properties.validationTypes.ssn", value: "ssn" },
  { labelKey: "editor.properties.validationTypes.regex", value: "regex" }
];

/** Types whose value is a list the sender edits. */
export const OPTION_LIST_TYPES: WidgetType[] = ["dropdown", "radio button", "checkbox"];
/** Adding/removing an option grows or shrinks the widget by this many points (§7.3). */
export const OPTION_ROW_HEIGHT = 15;

export const DEFAULT_OPTION_VALUES = ["Option-1", "Option-2"];

/** Types that must count toward "this signer can actually sign". */
export const SIGNING_TYPES: WidgetType[] = ["signature", "initials"];

/** Zoom presets in the top bar. `null` means fit-to-width. */
export const ZOOM_PRESETS: Array<number | null> = [null, 0.75, 1, 1.25, 1.5];

/** Label for a zoom preset: the translated "fit width", or a locale-formatted percentage. */
export function zoomLabel(t: TFunction, value: number | null): string {
  return value === null ? t("editor.topBar.zoom.fitWidth") : percent(value * 100);
}

/** Snapping tolerance in PDF points. */
export const SNAP_TOLERANCE = 4;
/** Page margin guides, in PDF points. */
export const PAGE_MARGIN = 36;
export const THUMB_WIDTH = 56;
