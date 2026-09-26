import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { Button, Dialog, Field, Input, Toggle, toast } from "@/components/ui";
import { useSaveAsTemplate, type SavedTemplate } from "./api";
import type { Document } from "./types";

/**
 * Turn a document into a reusable template.
 *
 * `saveastemplate` copies the document, clears every response and default, and
 * unbinds each signer while keeping their role label. The toggle below decides
 * whether those labels survive: off, each role becomes a plain "Role 1", "Role
 * 2" so the template does not carry a real person's name around.
 */
export function SaveAsTemplateDialog({ doc, onClose }: { doc: Document | null; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [keepRoles, setKeepRoles] = useState(true);
  const [saved, setSaved] = useState<SavedTemplate | null>(null);
  const save = useSaveAsTemplate();

  useEffect(() => {
    if (doc) {
      setName(doc.name.replace(/\.pdf$/i, ""));
      setKeepRoles(true);
      setSaved(null);
    }
  }, [doc]);

  const roleNames = doc ? [...new Set(doc.recipients.map((r) => r.role).filter(Boolean))] : [];

  const submit = () => {
    if (!doc) return;
    save.mutate(
      { docId: doc.objectId, name, keepSignerRoles: keepRoles },
      {
        onSuccess: (template) => {
          setSaved(template);
          toast.success(t("documents.template.saved"), template.name);
        },
        onError: (e: Error) => toast.error(t("documents.toast.templateSaveFailed"), e.message)
      }
    );
  };

  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      title={saved ? t("documents.template.saved") : t("documents.actions.saveAsTemplate")}
      description={saved ? t("documents.template.savedDescription") : t("documents.template.description")}
      width={480}
      footer={
        saved ? (
          <>
            <Button onClick={onClose}>{t("common.actions.done")}</Button>
            <Button variant="primary" onClick={() => navigate(`/templates/${saved.objectId}/edit`)}>
              {t("documents.template.open")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              {t("documents.template.save")}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] flex items-center gap-2">
            <Check className="size-4 text-accent" strokeWidth={1.6} />
            <span className="font-semibold truncate">{saved.name}</span>
          </p>
          <p className="text-[12px] text-muted">
            <span className="font-mono text-[11px]">{saved.objectId}</span>
            {` · ${
              saved.roles.length
                ? t("documents.template.roles", { roles: saved.roles.join(", ") })
                : t("documents.template.noRoles")
            }`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Field label={t("documents.fields.templateName")} hint={t("documents.template.nameHint")}>
            <Input
              value={name}
              autoFocus
              maxLength={250}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </Field>

          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink-2">{t("documents.template.keepRoles")}</div>
              <div className="text-[11px] text-muted-2 mt-0.5">
                {roleNames.length
                  ? t("documents.template.keepRolesHintWithRoles", { roles: roleNames.join(", ") })
                  : t("documents.template.keepRolesHint")}
              </div>
            </div>
            <div className="pt-0.5 shrink-0">
              <Toggle checked={keepRoles} onChange={setKeepRoles} label={t("documents.template.keepRoles")} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
