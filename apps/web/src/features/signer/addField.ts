/**
 * Fields the signer places themselves.
 *
 * Two flows land here (docs/BACKEND_API.md §3.5, §7.2, §7.3):
 *
 *  - `AllowModifications: true` on a sent document lets the recipient drop extra
 *    widgets into their own placeholder group before signing (old app:
 *    `PdfRequestFiles.jsx` -> `getSignerPos`, palette gated in
 *    `WidgetComponent.jsx`);
 *  - self-sign, where the owner starts from a plain PDF with no placeholders at
 *    all and builds the whole layout (old app: `SignyourselfPdf.jsx`).
 *
 * Both produce the identical `pos` object the rest of the system expects, so the
 * ids, the `options.name` counter and the casing follow the old helpers
 * (`randomId`, `generateId`, `addWidgetOptions`, `addWidgetSelfsignOptions` in
 * `constant/Utils.js`). The old `pos` has exactly ten keys: `xPosition`,
 * `yPosition`, `isStamp`, `key`, `scale`, `zIndex`, `type`, `options`, `Width`,
 * `Height` (plus `IsResize` once the widget has been resized).
 */

import type {
  RawPage,
  RawPlaceholder,
  RawWidget,
  RawWidgetOptions,
  SignerField,
  WidgetType
} from "./types";
import { defaultSize, IMAGE_TYPES } from "./widgets";

/**
 * What a signer may add, in palette order. These are wire `type` values; the
 * palette resolves their labels with `widgetLabel` at render time.
 */
export const ADDABLE_TYPES: WidgetType[] = ["signature", "initials", "date", "text", "checkbox"];

/** `randomId` in `constant/Utils.js`: an 8-digit NUMBER, not a string (§6.2). */
export function randomId(digits = 8): number {
  const raw = crypto.getRandomValues(new Uint32Array(1))[0];
  const min = Math.pow(10, digits - 1);
  const range = Math.pow(10, digits) - min;
  return min + (raw % range);
}

/** `generateId` in `constant/Utils.js`: alphanumeric, used inside `options.name`. */
export function generateId(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += chars.charAt(bytes[i] % chars.length);
  return out;
}

/**
 * `addWidgetOptions` / `addWidgetSelfsignOptions`. Every widget starts as
 * `{ name: "<type>-<generateId(6)>-<count>", status: "required" }` and gains
 * per-type keys from there; `count` is 1 + the widgets of the same type the
 * signer already has. Self-sign leaves `isReadOnly` off date and checkbox.
 */
export function newWidgetOptions(
  type: WidgetType,
  count: number,
  opts: { selfSign: boolean; dateFormat: string }
): RawWidgetOptions {
  const base: RawWidgetOptions = { name: `${type}-${generateId(6)}-${count}`, status: "required" };
  switch (type) {
    case "date":
      return {
        ...base,
        response: "",
        ...(opts.selfSign ? {} : { isReadOnly: false }),
        validation: { format: opts.dateFormat, type: "date-format" }
      };
    case "checkbox":
      return opts.selfSign ? base : { ...base, isReadOnly: false, isHideLabel: false };
    default:
      // signature, initials, stamp, text: nothing beyond name and status.
      return base;
  }
}

export interface NewFieldInput {
  type: WidgetType;
  page: number;
  /** Top-left in PDF points from the page top-left (§7.4). */
  x: number;
  y: number;
  /** The container scale at placement time, recorded on the widget. */
  placedScale: number;
  zIndex: number;
  /** Widgets of this type the signer already has, for the `options.name` counter. */
  sameTypeCount: number;
  selfSign: boolean;
  dateFormat: string;
  party: { name: string; email?: string; color: string };
  placeholderIndex: number;
}

/** Build the in-memory field. `defaultSize` is the §7.1 palette size at scale 1. */
export function newField(input: NewFieldInput): SignerField {
  const size = defaultSize(input.type);
  const options = newWidgetOptions(input.type, input.sameTypeCount + 1, {
    selfSign: input.selfSign,
    dateFormat: input.dateFormat
  });
  return {
    key: randomId(),
    type: input.type,
    page: input.page,
    placeholderIndex: input.placeholderIndex,
    pageIndex: -1,
    posIndex: -1,
    mine: true,
    added: true,
    rawOptions: options,
    zIndex: input.zIndex,
    signerName: input.party.name,
    signerEmail: input.party.email,
    color: input.party.color,
    required: true,
    readOnly: false,
    hideLabel: false,
    name: options.name,
    values: [],
    layout: "vertical",
    cellCount: 5,
    fontSize: 12,
    fontColor: "black",
    rotation: 0,
    validation: options.validation,
    x: input.x,
    y: input.y,
    w: size.w,
    h: size.h,
    placedScale: input.placedScale
  };
}

/**
 * The wire `pos` object (§7.2). Image-bearing answers are deliberately left out:
 * the old self-sign autosave strips `SignUrl` and `options.response` for
 * signature / stamp / image / initials because the picture is already flattened
 * into the PDF bytes that `signPdf` receives.
 */
export function toRawWidget(f: SignerField): RawWidget {
  const base = f.rawOptions ?? { name: f.name, status: f.required ? "required" : "optional" };
  const keepResponse = !IMAGE_TYPES.has(f.type) && f.response !== undefined;
  const options: RawWidgetOptions = keepResponse ? { ...base, response: f.response } : { ...base };
  const widget: RawWidget = {
    xPosition: f.x,
    yPosition: f.y,
    isStamp: f.type === "stamp" || f.type === "image",
    key: f.key,
    scale: f.placedScale,
    zIndex: f.zIndex ?? 1,
    type: f.type,
    options,
    Width: f.w,
    Height: f.h
  };
  if (f.resized) widget.IsResize = true;
  return widget;
}

/**
 * Where the signer's own pages live: self-sign keeps them flat at the top level
 * of `Placeholders`, everyone else nests them under `placeHolder` (§7.2).
 */
function myPages(placeholders: RawPlaceholder[], selfSign: boolean, placeholderIndex: number): RawPage[] {
  if (selfSign) {
    return placeholders
      .filter((p) => Array.isArray(p.pos))
      .map((p) => ({ pageNumber: p.pageNumber ?? 1, pos: [...(p.pos as RawWidget[])] }));
  }
  const entry = placeholders[placeholderIndex];
  if (!entry || !Array.isArray(entry.placeHolder)) return [];
  return entry.placeHolder.map((pg) => ({ pageNumber: pg.pageNumber ?? 1, pos: [...(pg.pos ?? [])] }));
}

/**
 * `Placeholders` with the widgets this signer just added folded in. Everything
 * that was already stored is copied through untouched, so other signers' groups
 * and answers survive. Pages ascend, widgets inside a page sort top to bottom,
 * exactly like `getSignerPos`.
 */
export function placeholdersWithAdded(
  placeholders: RawPlaceholder[],
  added: SignerField[],
  opts: { selfSign: boolean; placeholderIndex: number }
): RawPlaceholder[] {
  const pages = myPages(placeholders, opts.selfSign, opts.placeholderIndex);
  for (const f of added) {
    const widget = toRawWidget(f);
    const page = pages.find((pg) => pg.pageNumber === f.page);
    if (page) page.pos.push(widget);
    else pages.push({ pageNumber: f.page, pos: [widget] });
  }
  for (const pg of pages) pg.pos.sort((a, b) => a.yPosition - b.yPosition);
  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  if (opts.selfSign) return pages as unknown as RawPlaceholder[];

  return placeholders.map((entry, i) => (i === opts.placeholderIndex ? { ...entry, placeHolder: pages } : entry));
}
