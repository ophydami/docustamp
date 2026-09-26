import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PenLine } from "lucide-react";
import { Button, toast } from "@/components/ui";
import { useExtUser } from "@/lib/extUser";
import { uploadImage, useSaveSignature, useSignature } from "../api";
import { dataUrlToFile } from "../imageUtils";
import { FormColumn, SectionCard, SectionError, SectionLoading } from "../parts";
import { SignatureDialog } from "../components/SignatureDialog";

export default function SignatureSection() {
  const { t } = useTranslation();
  const { data: extUser } = useExtUser();
  const { data: signature, isPending, error, refetch } = useSignature();
  const saveSignature = useSaveSignature();
  const [editing, setEditing] = useState<"signature" | "initials" | null>(null);

  const name = extUser?.Name ?? "";

  const commit = async (target: "signature" | "initials", dataUrl: string) => {
    const file = dataUrlToFile(dataUrl, `${(name || "signature").replace(/[^\w-]+/g, "_")}_${target}`);
    const url = await uploadImage(file);
    await saveSignature.mutateAsync({
      id: signature?.objectId,
      title: signature?.SignatureName || name || undefined,
      ...(target === "signature" ? { signature: url } : { initials: url })
    });
    toast.success(
      target === "signature" ? t("settings.signature.toast.signatureSaved") : t("settings.signature.toast.initialsSaved")
    );
  };

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending) return <SectionLoading />;

  return (
    <FormColumn className="max-w-[560px]">
      <SectionCard
        title={t("settings.signature.signature.title")}
        note={t("settings.signature.signature.note")}
        aside={
          <Button size="sm" icon={<PenLine className="size-3.5" strokeWidth={1.6} />} onClick={() => setEditing("signature")}>
            {signature?.ImageURL ? t("settings.signature.change") : t("settings.signature.signature.add")}
          </Button>
        }
      >
        <Preview src={signature?.ImageURL} empty={t("settings.signature.signature.empty")} height={120} />
      </SectionCard>

      <SectionCard
        title={t("settings.signature.initials.title")}
        note={t("settings.signature.initials.note")}
        aside={
          <Button size="sm" icon={<PenLine className="size-3.5" strokeWidth={1.6} />} onClick={() => setEditing("initials")}>
            {signature?.Initials ? t("settings.signature.change") : t("settings.signature.initials.add")}
          </Button>
        }
      >
        <Preview src={signature?.Initials} empty={t("settings.signature.initials.empty")} height={96} />
      </SectionCard>

      <p className="text-[11px] text-muted-2 leading-relaxed">{t("settings.signature.note")}</p>

      {editing ? (
        <SignatureDialog
          open
          target={editing}
          suggestedText={editing === "initials" ? initialsOf(name) : name}
          onClose={() => setEditing(null)}
          onCommit={(dataUrl) => commit(editing, dataUrl)}
        />
      ) : null}
    </FormColumn>
  );
}

function initialsOf(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function Preview({ src, empty, height }: { src?: string; empty: string; height: number }) {
  return (
    <div className="theme-light bg-paper rounded-md flex items-center justify-center px-4" style={{ minHeight: height }}>
      {src ? (
        <img src={src} alt="" className="max-w-full object-contain" style={{ maxHeight: height - 24 }} />
      ) : (
        <span className="text-[12px] text-muted-2">{empty}</span>
      )}
    </div>
  );
}
