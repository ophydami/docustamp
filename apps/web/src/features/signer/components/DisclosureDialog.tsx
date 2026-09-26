import { useTranslation } from "react-i18next";
import { Button, Dialog } from "@/components/ui";

/** Section order. Each id maps onto `signer.disclosure.sections.<id>` in the bundle. */
const SECTION_IDS = [
  "purpose",
  "consent",
  "withdraw",
  "requirements",
  "retention",
  "acknowledgment",
  "legal",
  "platform",
  "termination"
] as const;

/** The full "Electronic record and signature disclosure" the signer can read at any time. */
export function DisclosureDialog({
  open,
  onClose,
  senderEmail
}: {
  open: boolean;
  onClose: () => void;
  senderEmail?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title={<span className="font-serif text-[22px] leading-tight">{t("signer.disclosure.title")}</span>}
      footer={
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {t("common.actions.close")}
          </Button>
        </div>
      }
    >
      <div className="max-h-[58vh] overflow-y-auto scroll-thin pr-2 flex flex-col gap-4 text-[13px] leading-relaxed text-ink-2">
        <p>{t("signer.disclosure.intro")}</p>
        {SECTION_IDS.map((id) => {
          const raw = t(`signer.disclosure.sections.${id}.points`, { returnObjects: true, defaultValue: [] });
          const points = Array.isArray(raw) ? (raw as string[]) : [];
          return (
            <section key={id} className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-semibold text-ink">{t(`signer.disclosure.sections.${id}.heading`)}</h3>
              <p>{t(`signer.disclosure.sections.${id}.intro`)}</p>
              {points.length ? (
                <ul className="flex flex-col gap-1 pl-4">
                  {points.map((p) => (
                    <li key={p} className="list-disc marker:text-faint">
                      {p}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
        <p className="font-semibold text-ink">{t("signer.disclosure.closing")}</p>
        <p>
          {senderEmail ? (
            <>
              {t("signer.disclosure.questionsWithEmail")}{" "}
              <a href={`mailto:${senderEmail}`} className="font-mono text-[12px]">
                {senderEmail}
              </a>
              .
            </>
          ) : (
            t("signer.disclosure.questions")
          )}
        </p>
      </div>
    </Dialog>
  );
}
