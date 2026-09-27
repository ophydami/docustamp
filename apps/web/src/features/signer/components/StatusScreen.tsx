import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, CheckCircle2, Clock, Download, FileQuestion, Hourglass, XCircle } from "lucide-react";
import { Button, Card, LanguageMini, Pill } from "@/components/ui";
import type { BlockReason } from "../types";
import { Wordmark } from "./Wordmark";

interface Props {
  reason: BlockReason;
  docName?: string;
  senderName?: string;
  senderEmail?: string;
  /** Who we are waiting on, for `waiting_turn`. */
  waitingOn?: string;
  declineReason?: string;
  declinedBy?: string;
  expiresAt?: string;
  onDownload?: () => void;
  downloading?: boolean;
  extra?: ReactNode;
}

const TONE: Record<
  BlockReason,
  { icon: typeof Clock; tone: string; pill: "accent" | "warn" | "danger" | "ink" | "neutral"; label: string }
> = {
  not_found: { icon: FileQuestion, tone: "bg-paper text-muted", pill: "neutral", label: "signer.status.pill.notAvailable" },
  declined: { icon: XCircle, tone: "bg-danger-soft text-danger", pill: "danger", label: "common.status.declined" },
  expired: { icon: AlertTriangle, tone: "bg-danger-soft text-danger", pill: "danger", label: "common.status.expired" },
  completed: { icon: CheckCircle2, tone: "bg-accent-soft text-accent", pill: "ink", label: "common.status.completed" },
  already_signed: { icon: CheckCircle2, tone: "bg-accent-soft text-accent", pill: "accent", label: "common.status.signed" },
  waiting_turn: { icon: Hourglass, tone: "bg-warn-soft text-warn-ink", pill: "warn", label: "signer.status.pill.waiting" },
  no_fields: { icon: FileQuestion, tone: "bg-paper text-muted", pill: "neutral", label: "signer.status.pill.nothingToSign" }
};

function copy(p: Props, t: TFunction): { title: string; body: ReactNode } {
  const sender = p.senderName || t("signer.doc.theSender");
  switch (p.reason) {
    case "not_found":
      return { title: t("signer.status.notFound.title"), body: t("signer.status.notFound.body") };
    case "declined":
      return {
        title: t("signer.status.declined.title"),
        body: (
          <>
            {p.declinedBy
              ? t("signer.status.declined.byPerson", { name: p.declinedBy })
              : t("signer.status.declined.byUnknown")}
            {p.declineReason ? (
              <span className="mt-3 block rounded-lg bg-danger-soft border border-danger-line px-3.5 py-2.5 text-[13px] text-ink-2">
                {t("signer.status.declined.reasonQuote", { reason: p.declineReason })}
              </span>
            ) : null}
          </>
        )
      };
    case "expired":
      return {
        title: t("signer.status.expired.title"),
        body: p.expiresAt
          ? t("signer.status.expired.bodyWithDate", { date: p.expiresAt, sender })
          : t("signer.status.expired.body", { sender })
      };
    case "completed":
      return { title: t("signer.status.completed.title"), body: t("signer.status.completed.body") };
    case "already_signed":
      return { title: t("signer.status.alreadySigned.title"), body: t("signer.status.alreadySigned.body", { sender }) };
    case "waiting_turn":
      return {
        title: t("signer.status.waitingTurn.title"),
        body: t("signer.status.waitingTurn.body", { name: p.waitingOn || t("signer.status.waitingTurn.someone") })
      };
    case "no_fields":
      return { title: t("signer.status.noFields.title"), body: t("signer.status.noFields.body", { sender }) };
  }
}

/**
 * The full-screen state a signer lands on when they cannot sign: expired,
 * declined, completed, already signed, waiting their turn, or a bad link.
 */
export function StatusScreen(props: Props) {
  const { t } = useTranslation();
  const { icon: Icon, tone, pill, label } = TONE[props.reason];
  const { title, body } = copy(props, t);
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ground">
      <div className="h-[52px] sm:h-[60px] shrink-0 flex items-center gap-2 px-5 border-b border-line bg-surface">
        <Wordmark />
        <span className="flex-1" />
        <LanguageMini className="shrink-0 [&>select]:h-11 sm:[&>select]:h-7" />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex items-start sm:items-center justify-center px-5 py-10">
        <Card className="w-full max-w-[520px] p-6 sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <span className={`inline-flex items-center justify-center size-10 rounded-lg ${tone}`}>
              <Icon className="size-5" strokeWidth={1.6} />
            </span>
            <Pill tone={pill}>{t(label)}</Pill>
          </div>
          <h1 className="mt-4 font-semibold text-[22px] leading-[1.15] text-ink tracking-[-.015em]">{title}</h1>
          {props.docName ? (
            <p className="mt-2 text-[13px] text-ink-2">
              <span className="font-medium">{props.docName}</span>
              {props.senderName ? (
                <span className="text-muted"> {t("signer.status.fromSender", { name: props.senderName })}</span>
              ) : null}
            </p>
          ) : null}
          <div className="mt-3 text-[13px] leading-relaxed text-muted">{body}</div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {props.onDownload ? (
              <Button
                variant="primary"
                icon={<Download className="size-3.5" strokeWidth={1.6} />}
                onClick={props.onDownload}
                loading={props.downloading}
                className="min-h-11 sm:min-h-0"
              >
                {t("signer.status.downloadSigned")}
              </Button>
            ) : null}
            {props.senderEmail ? (
              <a
                href={`mailto:${props.senderEmail}?subject=${encodeURIComponent(
                  props.docName ?? t("signer.status.mailSubjectFallback")
                )}`}
              >
                <Button className="min-h-11 sm:min-h-0">{t("signer.actions.askQuestion")}</Button>
              </a>
            ) : null}
          </div>
          {props.extra}
          <p className="mt-6 pt-4 border-t border-line text-[11px] text-muted-2">
            <Link to="/verify" className="hover:text-accent">
              {t("signer.status.verifyLink")}
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
