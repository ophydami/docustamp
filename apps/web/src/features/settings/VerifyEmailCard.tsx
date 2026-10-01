import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { BadgeCheck, MailCheck, Send } from "lucide-react";
import { Button, Card, Pill, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CodeInput } from "@/features/auth/CodeInput";
import { useCooldown } from "@/features/auth/useCooldown";
import { SectionCard } from "./parts";
import { useEmailVerification, useSendEmailVerification, useVerifyEmail } from "./api";

export interface VerifyEmailCardProps {
  /**
   * "card": a settings card (Settings > API and MCP).
   * "inline": a tinted box for a page that needs a verified email right now,
   * such as Approvals or the connect page.
   */
  variant?: "card" | "inline";
  /** One line on why this page needs it. Defaults to the signing reason. */
  reason?: ReactNode;
  className?: string;
}

/**
 * "Verify your email": a 6-digit code sent to the account's address
 * (`sendemailverification`, then `verifyemail`). An app can only sign for
 * someone whose email is verified, so every place that turns signing on shows
 * this until it is done, then a one-line verified state.
 *
 * Renders nothing when the server has no email verification (the query fails),
 * so older servers keep their pages unchanged.
 */
export function VerifyEmailCard({ variant = "card", reason, className }: VerifyEmailCardProps) {
  const { t } = useTranslation();
  const state = useEmailVerification();
  const send = useSendEmailVerification();
  const verify = useVerifyEmail();
  const cooldown = useCooldown(45);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  if (state.isLoading) return <VerifySkeleton variant={variant} className={className} />;
  if (state.isError || !state.data) return null;

  const { email, verified } = state.data;

  if (verified) {
    return variant === "card" ? (
      <Card className={cn("px-5 py-3 flex items-center gap-3", className)}>
        <BadgeCheck className="size-4 shrink-0 text-success" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 text-[13px] text-ink-2 truncate">
          <Trans
            i18nKey="settings.verifyEmail.verifiedLine"
            values={{ email }}
            components={[<span key="email" className="font-medium text-ink" />]}
          />
        </span>
        <Pill tone="success" dot>
          {t("settings.verifyEmail.verified")}
        </Pill>
      </Card>
    ) : (
      <div className={cn("flex items-center gap-2 text-[12px] text-muted", className)}>
        <BadgeCheck className="size-3.5 shrink-0 text-success" strokeWidth={1.8} />
        <span className="min-w-0 truncate">
          <Trans
            i18nKey="settings.verifyEmail.verifiedLine"
            values={{ email }}
            components={[<span key="email" className="font-medium text-ink-2" />]}
          />
        </span>
      </div>
    );
  }

  async function onSend() {
    setError("");
    try {
      const res = await send.mutateAsync();
      if (res.verified) return;
      setSentTo(res.email || email);
      setCode("");
      cooldown.start();
    } catch (err) {
      setError((err as Error).message || t("settings.verifyEmail.sendFailed"));
    }
  }

  async function onVerify(value = code) {
    if (value.length !== 6 || verify.isPending) return;
    setError("");
    try {
      await verify.mutateAsync(value);
      toast.success(t("settings.verifyEmail.done"));
    } catch (err) {
      setCode("");
      setError((err as Error).message || t("settings.verifyEmail.wrongCode"));
    }
  }

  const body = (
    <>
      {sentTo === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted">
            {reason ?? t("settings.verifyEmail.reason")}{" "}
            <Trans
              i18nKey="settings.verifyEmail.willSend"
              values={{ email }}
              components={[<span key="email" className="font-medium text-ink-2" />]}
            />
          </p>
          <div>
            <Button
              size="sm"
              variant="primary"
              loading={send.isPending}
              icon={<Send className="size-3.5" strokeWidth={1.6} />}
              onClick={() => void onSend()}
            >
              {t("settings.verifyEmail.send")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted">
            <Trans
              i18nKey="settings.verifyEmail.sent"
              values={{ email: sentTo }}
              components={[<span key="email" className="font-medium text-ink-2" />]}
            />
          </p>
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={(value) => void onVerify(value)}
            disabled={verify.isPending}
            invalid={Boolean(error)}
            autoFocus
            label={t("settings.verifyEmail.codeLabel")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={verify.isPending}
              disabled={code.length !== 6}
              onClick={() => void onVerify()}
            >
              {t("settings.verifyEmail.verify")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={cooldown.active || send.isPending}
              onClick={() => void onSend()}
            >
              {cooldown.active ? (
                <Trans
                  i18nKey="settings.verifyEmail.resendIn"
                  values={{ seconds: cooldown.left }}
                  components={[<span key="n" className="num" />]}
                />
              ) : (
                t("settings.verifyEmail.resend")
              )}
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return (
      <div className={cn("flex flex-col gap-3 rounded-lg border border-accent-line bg-accent-tint px-4 py-3.5", className)}>
        <div className="flex items-center gap-2">
          <MailCheck className="size-4 shrink-0 text-accent" strokeWidth={1.8} />
          <span className="text-[13px] font-semibold text-ink">{t("settings.verifyEmail.title")}</span>
        </div>
        {body}
      </div>
    );
  }

  return (
    <SectionCard
      className={className}
      title={t("settings.verifyEmail.title")}
      note={t("settings.verifyEmail.note")}
      aside={<MailCheck className="size-4 text-accent" strokeWidth={1.6} />}
    >
      {body}
    </SectionCard>
  );
}

function VerifySkeleton({ variant, className }: { variant: "card" | "inline"; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse flex flex-col gap-2.5",
        variant === "card" ? "bg-surface border border-line rounded-xl px-5 py-4" : "rounded-lg border border-line px-4 py-3.5",
        className
      )}
    >
      <span className="h-3 w-40 rounded bg-line-soft" />
      <span className="h-2.5 w-3/4 rounded bg-line-soft" />
    </div>
  );
}
