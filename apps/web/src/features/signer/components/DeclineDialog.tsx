import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, Field, Textarea } from "@/components/ui";

/** Declining is final: `declinedoc` sets IsDeclined and emails the sender (§6.9). */
export function DeclineDialog({
  open,
  onClose,
  onConfirm,
  busy,
  docName,
  senderName
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  docName: string;
  senderName: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      title={<span className="font-serif text-[22px] leading-tight">{t("signer.decline.title")}</span>}
      description={t("signer.decline.description", { sender: senderName, document: docName })}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t("signer.decline.keepReviewing")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => onConfirm(reason.trim())}>
            {t("signer.decline.confirm")}
          </Button>
        </div>
      }
    >
      <Field label={t("signer.decline.reasonLabel")} hint={t("signer.decline.reasonHint")}>
        <Textarea
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("signer.decline.reasonPlaceholder")}
          maxLength={500}
          autoFocus
        />
      </Field>
    </Dialog>
  );
}
