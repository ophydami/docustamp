import i18next, { type TFunction } from "i18next";
import { PREFILL_COLOR, PREFILL_ROLE, SIGNER_COLORS } from "./constants";
import { fieldId, randomKey, round2 } from "./widgets";
import type {
  EditorDoc,
  EditorField,
  EditorMode,
  PagePlaceholder,
  ParsePointer,
  PlaceholderGroup,
  SignerRow,
  Widget
} from "./types";

/**
 * Keys the editor owns. Everything else on a loaded group (`email`, `Name`, anything a
 * future server version adds) is kept in `SignerRow.extra` and written back verbatim.
 */
const GROUP_OWNED_KEYS = new Set(["Id", "Role", "blockColor", "signerObjId", "signerPtr", "placeHolder"]);

function contactPointer(objectId: string): ParsePointer {
  return { __type: "Pointer", className: "contracts_Contactbook", objectId };
}

/**
 * `signerPtr` comes back denormalised by the `include`s on getDocument, so it can be a
 * plain object carrying an objectId rather than a Pointer (§6.2).
 */
function pointerObjectId(ptr: unknown): string {
  if (!ptr || typeof ptr !== "object") return "";
  const o = ptr as { objectId?: unknown };
  return typeof o.objectId === "string" ? o.objectId : "";
}

function isWidget(v: unknown): v is Widget {
  if (!v || typeof v !== "object") return false;
  const w = v as Partial<Widget>;
  return typeof w.type === "string" && typeof w.xPosition === "number" && typeof w.yPosition === "number";
}

/** Name a role gets when the server has none. Resolved at load time, not at module scope. */
function defaultRoleName(index: number): string {
  return i18next.t("editor.roles.defaultName", { index });
}

export interface LoadedModel {
  signers: SignerRow[];
  fields: EditorField[];
}

/** Split the persisted `Placeholders` array into editor signers plus flat fields. */
export function fromPlaceholders(doc: EditorDoc, mode: EditorMode): LoadedModel {
  const signers: SignerRow[] = [];
  const fields: EditorField[] = [];

  doc.placeholders.forEach((g, index) => {
    const id = typeof g.Id === "number" ? g.Id : randomKey(8);
    const contactId =
      typeof g.signerObjId === "string" && g.signerObjId ? g.signerObjId : pointerObjectId(g.signerPtr);
    const contact = doc.signers.find((s) => s.objectId === contactId);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(g)) if (!GROUP_OWNED_KEYS.has(k)) extra[k] = v;
    const isPrefill = g.Role === PREFILL_ROLE;

    signers.push({
      id,
      role: typeof g.Role === "string" && g.Role ? g.Role : defaultRoleName(index + 1),
      color: isPrefill
        ? PREFILL_COLOR
        : typeof g.blockColor === "string" && g.blockColor
          ? g.blockColor
          : SIGNER_COLORS[index % SIGNER_COLORS.length],
      contactId: mode === "template" ? "" : contactId,
      name: contact?.Name ?? (typeof extra.Name === "string" ? extra.Name : undefined),
      email: contact?.Email ?? (typeof extra.email === "string" ? extra.email : undefined),
      isPrefill,
      extra
    });

    for (const page of g.placeHolder ?? []) {
      const pageNumber = typeof page?.pageNumber === "number" ? page.pageNumber : 1;
      for (const w of page?.pos ?? []) {
        if (!isWidget(w)) continue;
        const key = typeof w.key === "number" ? w.key : randomKey(8);
        fields.push({ id: fieldId(id, key), signerId: id, page: pageNumber, widget: { ...w, key } });
      }
    }
  });

  // A document with recipients but no layout yet: seed one role per signer, in order,
  // so Placeholders stays index-parallel with Signers (§6.2, §11 quirk 4).
  if (!signers.length && mode === "document" && doc.signers.length) {
    doc.signers.forEach((s, i) => {
      signers.push({
        id: randomKey(8),
        role: defaultRoleName(i + 1),
        color: SIGNER_COLORS[i % SIGNER_COLORS.length],
        contactId: s.objectId,
        name: s.Name,
        email: s.Email,
        isPrefill: false,
        extra: {}
      });
    });
  }
  if (!signers.length) {
    signers.push({ id: randomKey(8), role: defaultRoleName(1), color: SIGNER_COLORS[0], contactId: "", isPrefill: false, extra: {} });
  }
  return { signers, fields };
}

/**
 * Rebuild the exact persisted shape.
 *
 * Group order is preserved: `Signers` is a parallel array indexed by position, and
 * reordering one without the other corrupts sequential signing (§11 quirk 4), so the
 * editor never reorders and never removes a group in document mode.
 */
export function toPlaceholders(signers: SignerRow[], fields: EditorField[]): PlaceholderGroup[] {
  return signers.map((s) => {
    const byPage = new Map<number, Widget[]>();
    for (const f of fields) {
      if (f.signerId !== s.id) continue;
      const list = byPage.get(f.page) ?? [];
      list.push(normalizeWidget(f.widget));
      byPage.set(f.page, list);
    }
    const placeHolder: PagePlaceholder[] = [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageNumber, pos]) => ({ pageNumber, pos: pos.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)) }));

    const group: PlaceholderGroup = {
      ...s.extra,
      Id: s.id,
      Role: s.isPrefill ? PREFILL_ROLE : s.role,
      blockColor: s.isPrefill ? PREFILL_COLOR : s.color,
      signerObjId: s.contactId,
      signerPtr: s.contactId ? contactPointer(s.contactId) : {}
    };
    // The old app deletes `placeHolder` entirely once a role has no widgets left.
    if (placeHolder.length) group.placeHolder = placeHolder;
    return group;
  });
}

function normalizeWidget(w: Widget): Widget {
  return {
    ...w,
    xPosition: round2(w.xPosition),
    yPosition: round2(w.yPosition),
    Width: round2(w.Width),
    Height: round2(w.Height)
  };
}

export function signerLabel(s: SignerRow, t: TFunction): string {
  if (s.isPrefill) return t("editor.roles.prefill");
  return s.name || s.email || s.role;
}

/** The colour the editor paints a role with. Prefill stores "transparent". */
export function signerColor(s: SignerRow | undefined, fallback: string): string {
  if (!s) return fallback;
  return s.color && s.color !== PREFILL_COLOR ? s.color : fallback;
}

/** Next unused colour when a role is added. */
export function nextColor(signers: SignerRow[]): string {
  const used = new Set(signers.map((s) => s.color));
  return SIGNER_COLORS.find((c) => !used.has(c)) ?? SIGNER_COLORS[signers.length % SIGNER_COLORS.length];
}
