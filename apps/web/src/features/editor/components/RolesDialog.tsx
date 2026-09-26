import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button, Dialog, Input } from "@/components/ui";
import { nextColor } from "../model";
import { randomKey } from "../widgets";
import type { EditorField, SignerRow } from "../types";

export interface RolesDialogProps {
  open: boolean;
  onClose: () => void;
  signers: SignerRow[];
  fields: EditorField[];
  onSave: (signers: SignerRow[]) => void;
}

/** Add and rename template roles. Roles carrying fields cannot be removed. */
export function RolesDialog({ open, onClose, signers, fields, onSave }: RolesDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SignerRow[]>(signers);

  useEffect(() => {
    if (open) setDraft(signers);
  }, [open, signers]);

  const count = (id: number) => fields.filter((f) => f.signerId === id).length;
  const valid = draft.every((s) => s.isPrefill || s.role.trim().length > 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("editor.roles.title")}
      description={t("editor.roles.description")}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button
            variant="dark"
            disabled={!valid}
            onClick={() => {
              onSave(draft.map((s) => ({ ...s, role: s.role.trim() })));
              onClose();
            }}
          >
            {t("editor.roles.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {draft.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <span className="swatch size-3 rounded-full shrink-0 border border-ink/15" style={{ ["--swatch" as string]: s.color, background: "var(--swatch-on)" }} />
            <Input
              className="h-9"
              value={s.isPrefill ? t("editor.roles.prefill") : s.role}
              disabled={s.isPrefill}
              aria-label={t("editor.roles.nameLabel", { index: i + 1 })}
              onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, role: e.target.value } : d)))}
            />
            <span className="text-[11px] text-muted-2 num w-14 text-right">
              {t("common.count.field", { count: count(s.id) })}
            </span>
            <button
              type="button"
              aria-label={t("editor.roles.remove", { role: s.role })}
              title={count(s.id) ? t("editor.roles.removeBlocked") : t("editor.roles.removeTitle")}
              disabled={s.isPrefill || count(s.id) > 0 || draft.length <= 1}
              onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              className="p-1.5 text-muted-2 hover:text-danger disabled:opacity-30 disabled:hover:text-muted-2"
            >
              <Trash2 className="size-3.5" strokeWidth={1.6} />
            </button>
          </div>
        ))}
        <Button
          size="sm"
          className="self-start mt-1"
          icon={<Plus className="size-3.5" strokeWidth={1.6} />}
          onClick={() =>
            setDraft([
              ...draft,
              {
                id: randomKey(8),
                role: t("editor.roles.defaultName", { index: draft.filter((d) => !d.isPrefill).length + 1 }),
                color: nextColor(draft),
                contactId: "",
                isPrefill: false,
                extra: {}
              }
            ])
          }
        >
          {t("editor.roles.add")}
        </Button>
      </div>
    </Dialog>
  );
}
