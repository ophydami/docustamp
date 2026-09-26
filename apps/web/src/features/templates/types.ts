import i18next from "i18next";

/**
 * Types for the templates gallery.
 *
 * Rows come from `getReport` with the templates report id (see BACKEND_API.md §9),
 * which returns plain JSON with a fixed key set. `contracts_Template` cannot be
 * queried with `find` from a client (CLP, §3.1), so getReport / getTemplate are the
 * only reads available.
 */

/** A widget inside a placeholder page (BACKEND_API.md §7.2). Only what the card needs. */
export interface RawWidget {
  key?: number | string;
  type?: string;
}

export interface RawPlaceholderPage {
  pageNumber?: number;
  pos?: RawWidget[];
}

/** One entry per role/recipient (BACKEND_API.md §6.2). */
export interface RawPlaceholder {
  Id?: number | string;
  Role?: string;
  Name?: string;
  blockColor?: string;
  signerObjId?: string;
  email?: string;
  placeHolder?: RawPlaceholderPage[];
}

export interface RawPointerRow {
  objectId?: string;
  Name?: string;
  Email?: string;
}

/** Shape of a row returned by getReport for the templates report. */
export interface RawTemplate {
  objectId: string;
  Name?: string;
  Note?: string;
  URL?: string;
  Placeholders?: RawPlaceholder[];
  Signers?: RawPointerRow[];
  Folder?: RawPointerRow;
  ExtUserPtr?: RawPointerRow;
  IsPublic?: boolean;
  SharedWith?: RawPointerRow[];
  SendinOrder?: boolean;
  NotifyOnSignatures?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TemplateRole {
  /** Placeholder Id, or the index when the backend left it out. */
  id: string;
  name: string;
  /** blockColor from the placeholder, used for the role dot. */
  color: string;
  fieldCount: number;
  /** True for the magic "prefill" entry, which is not a person (§11.5). */
  prefill: boolean;
  /** A role can only be sent to once it carries a signature widget. */
  hasSignature: boolean;
}

export interface Template {
  id: string;
  name: string;
  note: string;
  /**
   * Original PDF url, presigned by TemplateAfterFind for the first 200 rows of
   * a result. Past that cap, or once the token has aged out, `getsignedurl`
   * mints a fresh one (§11.12).
   */
  url: string;
  folder: string;
  ownerId: string;
  ownerName: string;
  isPublic: boolean;
  sharedTeams: { id: string; name: string }[];
  sendInOrder: boolean;
  roles: TemplateRole[];
  /** Signer roles only, prefill excluded. */
  signerRoles: TemplateRole[];
  fieldCount: number;
  /** Highest page number referenced by a field. 0 when the template has no fields yet. */
  fieldPages: number;
  /**
   * Every signer role is named and carries a signature widget, which is exactly
   * what the send and bulk-send flows check before they will accept a template.
   */
  bulkReady: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TemplateScope = "all" | "mine" | "shared";
export type TemplateSort = "used" | "updated" | "name";

export interface TemplateUsage {
  /** templateId -> number of documents created from it. */
  byTemplate: Record<string, number>;
  /** Documents created from any template since the start of this quarter. */
  thisQuarter: number;
}

const ROLE_COLORS = ["#93a3db", "#c8a2c8", "#8fbf9f", "#e0b05f", "#d99a94", "#8ec7d2"];

export function roleColor(raw: RawPlaceholder, index: number): string {
  const c = raw.blockColor;
  if (c && c !== "transparent") return c;
  return ROLE_COLORS[index % ROLE_COLORS.length];
}

function countFields(p: RawPlaceholder): number {
  return (p.placeHolder ?? []).reduce((n, page) => n + (page.pos?.length ?? 0), 0);
}

function hasSignatureWidget(p: RawPlaceholder): boolean {
  return (p.placeHolder ?? []).some((page) => (page.pos ?? []).some((w) => w.type === "signature"));
}

function maxPage(placeholders: RawPlaceholder[]): number {
  let max = 0;
  for (const p of placeholders) {
    for (const page of p.placeHolder ?? []) {
      if (typeof page.pageNumber === "number" && page.pageNumber > max) max = page.pageNumber;
    }
  }
  return max;
}

/** Convert a getReport row into the plain record the UI works with. */
export function toTemplate(raw: RawTemplate): Template {
  const placeholders = Array.isArray(raw.Placeholders) ? raw.Placeholders : [];
  const roles: TemplateRole[] = placeholders.map((p, i) => {
    const prefill = p.Role === "prefill";
    return {
      id: String(p.Id ?? i),
      name: prefill
        ? i18next.t("templates.roles.prefill")
        : (p.Role || i18next.t("templates.roles.fallback", { index: i + 1 })).trim(),
      color: prefill ? "var(--color-faint)" : roleColor(p, i),
      fieldCount: countFields(p),
      prefill,
      hasSignature: hasSignatureWidget(p)
    };
  });
  const signerRoles = roles.filter((r) => !r.prefill);
  const fieldCount = roles.reduce((n, r) => n + r.fieldCount, 0);

  return {
    id: raw.objectId,
    name: raw.Name?.trim() || i18next.t("templates.card.untitled"),
    note: raw.Note ?? "",
    url: raw.URL ?? "",
    folder: raw.Folder?.Name ?? "",
    ownerId: raw.ExtUserPtr?.objectId ?? "",
    ownerName: raw.ExtUserPtr?.Name || raw.ExtUserPtr?.Email || "",
    isPublic: raw.IsPublic === true,
    sharedTeams: (raw.SharedWith ?? [])
      .filter((team) => team?.objectId)
      .map((team) => ({ id: team.objectId as string, name: team.Name ?? i18next.t("templates.share.unnamedTeam") })),
    sendInOrder: raw.SendinOrder === true,
    roles,
    signerRoles,
    fieldCount,
    fieldPages: maxPage(placeholders),
    bulkReady: signerRoles.length > 0 && signerRoles.every((r) => r.hasSignature),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? raw.createdAt ?? ""
  };
}
