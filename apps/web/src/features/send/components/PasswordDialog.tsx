import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, Field, Input } from "@/components/ui";

export interface PasswordRequest {
  /** Increments per attempt, so the field resets on a retry. */
  id: number;
  fileName: string;
  retry: boolean;
  resolve: (password: string | null) => void;
}

/** Asked when a picked PDF turns out to be encrypted (§5 /decryptpdf). */
export function PasswordDialog({ request }: { request: PasswordRequest | null }) {
  if (!request) return null;
  return <PasswordBody key={request.id} request={request} />;
}

function PasswordBody({ request }: { request: PasswordRequest }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  return (
    <Dialog
      open
      onClose={() => request.resolve(null)}
      title={t("send.password.title")}
      description={t("send.password.description", { fileName: request.fileName })}
      width={460}
      footer={
        <>
          <Button onClick={() => request.resolve(null)}>{t("common.actions.cancel")}</Button>
          <Button variant="primary" disabled={!value} onClick={() => request.resolve(value)}>
            {t("send.password.unlock")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value) request.resolve(value);
        }}
      >
        <Field label={t("send.password.label")} error={request.retry ? t("send.password.wrong") : undefined}>
          <Input
            autoFocus
            type="password"
            value={value}
            invalid={request.retry}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("send.password.placeholder")}
          />
        </Field>
      </form>
    </Dialog>
  );
}
