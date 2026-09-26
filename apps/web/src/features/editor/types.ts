/**
 * Persisted shapes for the field editor.
 *
 * These mirror `contracts_Document.Placeholders` / `contracts_Template.Placeholders`
 * exactly as the old OpenSign frontend writes them (docs/BACKEND_API.md §6.2, §7.2-7.4).
 * Casing is load-bearing and deliberately inconsistent: `xPosition`, `yPosition`,
 * `scale`, `zIndex`, `key`, `type`, `options`, `isStamp` are lower-camel while
 * `Width`, `Height`, `IsResize`, `SignUrl` are upper-camel.
 */

/** Every widget type string this build supports (§7.1). There is no textarea, number or attachment type. */
export type WidgetType =
  | "signature"
  | "stamp"
  | "initials"
  | "text input"
  | "name"
  | "job title"
  | "company"
  | "email"
  | "date"
  | "text"
  | "cells"
  | "checkbox"
  | "dropdown"
  | "radio button"
  | "image"
  | "draw";

export interface WidgetValidation {
  type?: string;
  pattern?: string;
  /** date-fns pattern, only when type === "date-format" */
  format?: string;
  minRequiredCount?: number;
  maxRequiredCount?: number;
}

/** `pos[].options` (§7.3). Unknown keys are preserved verbatim on round-trip. */
export interface WidgetOptions {
  /** Machine name, unique across all signers. Used by the API and bulk-send CSV columns. */
  name: string;
  status: "required" | "optional";
  defaultValue?: string | number[];
  response?: unknown;
  validation?: WidgetValidation;
  values?: string[];
  layout?: "vertical" | "horizontal";
  cellCount?: number;
  isReadOnly?: boolean;
  isHideLabel?: boolean;
  hint?: string;
  fontSize?: number;
  fontColor?: string;
  rotation?: number;
  penColors?: string[];
  [k: string]: unknown;
}

/** One entry of `placeHolder[].pos` (§7.2). */
export interface Widget {
  /** randomId(8): an 8-digit NUMBER, unique within the document. */
  key: number;
  type: WidgetType;
  /** Top-left corner in PDF page units at scale 1, measured from the page's top-left. */
  xPosition: number;
  yPosition: number;
  Width: number;
  Height: number;
  /** The container scale (rendered px per PDF point) at placement time. */
  scale: number;
  zIndex?: number;
  isStamp?: boolean;
  IsResize?: boolean;
  options: WidgetOptions;
  [k: string]: unknown;
}

export interface PagePlaceholder {
  /** 1-based. */
  pageNumber: number;
  pos: Widget[];
}

export interface ParsePointer {
  __type: "Pointer";
  className: string;
  objectId: string;
}

/** One entry of `Placeholders` (§6.2): a role / recipient plus every field assigned to it. */
export interface PlaceholderGroup {
  /** randomId(8): a NUMBER. */
  Id: number;
  Role: string;
  blockColor: string;
  /** contracts_Contactbook objectId. Always "" on templates and on unbound document roles. */
  signerObjId: string;
  /** {} when unbound. */
  signerPtr: ParsePointer | Record<string, never>;
  email?: string;
  /** The old app deletes this key entirely when a role has no widgets left. */
  placeHolder?: PagePlaceholder[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Editor-side (flattened) model
// ---------------------------------------------------------------------------

/** A role/recipient row in the editor. */
export interface SignerRow {
  /** Placeholders[].Id. Stable across the session. */
  id: number;
  role: string;
  color: string;
  /** contracts_Contactbook objectId, "" when the role is not bound to a contact yet. */
  contactId: string;
  name?: string;
  email?: string;
  /** The `Role: "prefill"` pseudo-signer: the sender fills these fields, not a recipient. */
  isPrefill: boolean;
  /** Keys we did not model, preserved so a save never drops backend data. */
  extra: Record<string, unknown>;
}

/** A field as the editor manipulates it: one widget, on one page, owned by one signer. */
export interface EditorField {
  /** Client-only stable id (the widget `key` as a string). */
  id: string;
  /** Owning SignerRow.id, or null when the field has no signer yet. */
  signerId: number | null;
  page: number;
  widget: Widget;
}

export interface EditorDoc {
  objectId: string;
  name: string;
  /** Presigned URL of the PDF to render. */
  url: string;
  placeholders: PlaceholderGroup[];
  /** contracts_Contactbook pointers, parallel to Placeholders (documents only). */
  signers: Array<{ objectId: string; Name?: string; Email?: string }>;
  isCompleted: boolean;
  isDeclined: boolean;
  /** true once the document has been sent; editing fields then is unsafe. */
  sent: boolean;
}

export type EditorMode = "document" | "template";

/** A snapshot the undo stack stores. */
export interface EditorSnapshot {
  fields: EditorField[];
  signers: SignerRow[];
}

export interface PageSize {
  number: number;
  /**
   * Intrinsic page size in PDF points, in the top-left system the fields are
   * stored in: the shared rule in @/lib/pageBox.
   */
  width: number;
  height: number;
  /** The painted area, i.e. `height` without the CropBox offset. */
  renderHeight: number;
}

/** A snap guide drawn while dragging. */
export interface SnapGuide {
  page: number;
  axis: "x" | "y";
  /** PDF-point offset on that axis. */
  at: number;
}
