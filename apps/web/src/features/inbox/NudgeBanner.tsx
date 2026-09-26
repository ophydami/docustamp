import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui";
import { ago } from "@/lib/format";
import { expiresPhrase } from "./metrics";
import { firstName } from "./DocumentRow";
import type { DocumentRecord } from "./types";

export interface NudgeBannerProps {
  doc: DocumentRecord;
  onRemind: () => void;
  onExtend: () => void;
  reminding: boolean;
  extending: boolean;
}

/** The one document about to expire, with the two things worth doing about it. */
export function NudgeBanner({ doc, onRemind, onExtend, reminding, extending }: NudgeBannerProps) {
  const { t } = useTranslation();
  const pending = doc.nextSigner ?? doc.recipients.find((r) => !r.signedAt);
  const expiry = doc.expiryDate ? expiresPhrase(doc.expiryDate) : "";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-danger-line bg-danger-soft px-3.5 py-3">
      <AlertTriangle className="size-4 text-danger shrink-0" strokeWidth={1.6} />
      <p className="text-[13px] text-ink-2 flex-1 min-w-[200px]">
        <Trans
          i18nKey="inbox.nudge.expiring"
          values={{ name: doc.name, phrase: expiry }}
          components={{ 1: <span className="font-semibold text-ink" /> }}
        />
        {pending ? (
          <>
            {" "}
            {pending.viewedAt
              ? t("inbox.nudge.openedNotSigned", {
                  name: pending.name,
                  ago: ago(pending.viewedAt)
                })
              : t("inbox.nudge.notOpened", { name: pending.name })}
          </>
        ) : null}
      </p>
      {pending ? (
        <Button size="sm" onClick={onRemind} loading={reminding}>
          {t("inbox.actions.remindPerson", { name: firstName(pending.name) })}
        </Button>
      ) : null}
      {doc.isMine ? (
        <Button size="sm" onClick={onExtend} loading={extending}>
          {t("inbox.actions.extend", { count: 7 })}
        </Button>
      ) : null}
    </div>
  );
}
