import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, Check, FileText, Send } from "lucide-react";
import { Avatar, Button, Cap, Card, Pill } from "@/components/ui";
import { formatBytes } from "../upload";
import { activeLocale } from "@/lib/format";
import type { Recipient, SendMessage, SendSettings, Step } from "../types";

export interface Problem {
  id: string;
  label: string;
  step: Step;
}

export interface StepReviewProps {
  fileName: string;
  pageCount?: number;
  bytes?: number;
  documentName: string;
  note: string;
  recipients: Recipient[];
  settings: SendSettings;
  message: SendMessage;
  expiryDate: Date;
  problems: Problem[];
  onGoto: (step: Step) => void;
  onSend: () => void;
  sending: boolean;
}

export function StepReview(props: StepReviewProps) {
  const { t } = useTranslation();
  const signers = props.recipients.filter((r) => r.role === "signer");
  const cc = props.recipients.filter((r) => r.role === "cc");

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[22px] leading-tight tracking-[-.015em]">{t("send.review.title")}</h1>
        <p className="text-[13px] text-muted">
          {signers.length
            ? t(props.settings.sendInOrder ? "send.review.signersInOrder" : "send.review.signers", {
                count: signers.length
              })
            : t("send.review.addSigner")}
        </p>
      </div>

      {props.problems.length ? (
        <Card className="border-warn-soft bg-warn-soft px-4 py-3.5 flex flex-col gap-2.5">
          <span className="flex items-center gap-2 text-warn-ink">
            <AlertTriangle className="size-3.5" strokeWidth={1.6} />
            <Cap className="text-warn-ink">{t("send.review.problems", { count: props.problems.length })}</Cap>
          </span>
          <ul className="flex flex-col gap-1.5">
            {props.problems.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-warn-ink">{p.label}</span>
                <button
                  type="button"
                  onClick={() => props.onGoto(p.step)}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-warn-ink hover:underline"
                >
                  {t("send.actions.fix")}
                  <ArrowRight className="size-3" strokeWidth={1.6} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card className="border-accent-line bg-accent-tint px-4 py-3 flex items-center gap-2 text-accent">
          <Check className="size-3.5" strokeWidth={1.6} />
          <span className="text-[13px] font-semibold">{t("send.review.allGood")}</span>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <Cap>{t("send.review.documentHeading")}</Cap>
        <Card className="px-4 py-3.5 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent shrink-0">
            <FileText className="size-4" strokeWidth={1.6} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-semibold truncate">{props.documentName}</span>
            <span className="block text-[11px] text-muted-2 truncate">
              {[
                props.fileName,
                props.pageCount ? t("common.count.page", { count: props.pageCount }) : null,
                props.bytes ? formatBytes(props.bytes) : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <Button size="sm" onClick={() => props.onGoto(1)}>
            {t("send.actions.change")}
          </Button>
        </Card>
        {props.note ? (
          <p className="text-[12px] text-muted">{t("send.review.note", { note: props.note })}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Cap>{t("send.review.recipientsHeading")}</Cap>
          <Button size="xs" onClick={() => props.onGoto(2)}>
            {t("common.actions.edit")}
          </Button>
        </div>
        <Card className="divide-y divide-line-soft">
          {props.recipients.map((r, i) => (
            <div key={r.key} className="flex items-center gap-3 px-4 h-[54px]">
              <span className="num w-4 text-[12px] text-muted-2">
                {r.role === "signer" && props.settings.sendInOrder ? signers.findIndex((s) => s.key === r.key) + 1 : i + 1}
              </span>
              <Avatar name={r.name} email={r.email} size={26} />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium truncate">
                  {r.name || r.email || t("send.review.noName")}
                </span>
                <span className="block text-[11px] text-muted-2 truncate">
                  {r.email || t("send.review.noEmail")}
                </span>
              </span>
              <Pill tone={r.role === "signer" ? "accent" : "neutral"}>
                {r.role === "signer" ? t("send.recipients.roleSigner") : t("send.recipients.roleCc")}
              </Pill>
              {r.role === "signer" ? (
                <Pill tone="neutral">
                  {props.settings.auth === "otp" ? t("send.settings.emailCode") : t("send.settings.emailLink")}
                </Pill>
              ) : null}
            </div>
          ))}
          {props.recipients.length === 0 ? (
            <p className="px-4 py-5 text-[12px] text-muted-2">{t("send.review.noRecipients")}</p>
          ) : null}
        </Card>
        {cc.length ? (
          <p className="text-[11px] text-muted-2">{t("send.review.ccNote")}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Cap>{t("send.review.messageHeading")}</Cap>
          <Button size="xs" onClick={() => props.onGoto(2)}>
            {t("common.actions.edit")}
          </Button>
        </div>
        <Card className="px-4 py-3.5 flex flex-col gap-2">
          <span className="text-[13px] font-semibold">{props.message.subject || t("send.review.noSubject")}</span>
          <p className="text-[12px] text-muted whitespace-pre-wrap leading-relaxed">
            {props.message.body || t("send.review.noBody")}
          </p>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <Cap>{t("send.review.settingsHeading")}</Cap>
        <Card className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 px-4 py-4">
          <Fact
            label={t("send.settings.expires")}
            value={props.expiryDate.toLocaleDateString(activeLocale())}
          />
          <Fact
            label={t("send.settings.reminders")}
            value={
              props.settings.remindEveryDays
                ? t("send.settings.everyDays", { count: props.settings.remindEveryDays })
                : t("common.state.none")
            }
          />
          <Fact
            label={t("send.settings.order")}
            value={
              props.settings.sendInOrder
                ? props.settings.strictOrder
                  ? t("send.settings.inOrderEnforced")
                  : t("send.settings.inOrder")
                : t("send.settings.anyOrder")
            }
          />
          <Fact
            label={t("send.settings.notifyMe")}
            value={
              props.settings.notifyOnSignatures ? t("send.settings.onEachSignature") : t("send.settings.off")
            }
          />
          <Fact
            label={t("send.settings.signerCheck")}
            value={props.settings.auth === "otp" ? t("send.settings.emailCode") : t("send.settings.emailLink")}
          />
          <Fact
            label={t("send.settings.signerFields")}
            value={
              props.settings.allowModifications
                ? t("send.settings.signersMayAdd")
                : t("send.settings.onlyYourFields")
            }
          />
          <Fact
            label={t("send.settings.afterSigning")}
            value={props.settings.redirectUrl.trim() || t("send.settings.staysOnConfirmation")}
          />
          <Fact
            label={t("send.settings.bcc")}
            value={
              props.settings.bcc.length
                ? props.settings.bcc.map((b) => b.email).join(", ")
                : t("send.settings.nobody")
            }
          />
        </Card>
      </section>

      <div className="pb-10">
        <Button
          variant="primary"
          size="lg"
          loading={props.sending}
          disabled={props.problems.length > 0}
          icon={<Send className="size-3.5" strokeWidth={1.6} />}
          onClick={props.onSend}
          kbd="⌘↵"
        >
          {t("send.nav.sendNow")}
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-1 min-w-0">
      <Cap>{label}</Cap>
      <span className="text-[13px] break-words">{value}</span>
    </span>
  );
}
