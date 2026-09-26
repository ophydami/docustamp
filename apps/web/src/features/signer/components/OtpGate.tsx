import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button, Card, Field, Input, toast } from "@/components/ui";
import { sendOtp, verifyOtp } from "../api";
import { Wordmark } from "./Wordmark";

/**
 * OTP gate for documents with `IsEnableOTP` (§2.5, §6.8). The code is a 4-digit
 * number mailed by `SendOTPMailV1`; `AuthLoginAsMail` swaps it for a session
 * token, which we hand to `loginWithSessionToken` so every later call is
 * authenticated.
 */
export function OtpGate({
  email,
  docId,
  signingToken,
  onVerified
}: {
  email: string;
  docId: string;
  /** Per-signer token from the signing link, so `SendOTPMailV1` trusts the caller. */
  signingToken?: string;
  onVerified: (sessionToken: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const send = async () => {
    if (!email) {
      setError(t("signer.otp.errors.unknownEmail"));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendOtp(email, docId, signingToken);
      setSent(true);
      setCooldown(30);
      toast.success(t("signer.otp.toast.sentTitle"), t("signer.otp.toast.sentBody", { email }));
      window.setTimeout(() => inputRef.current?.focus(), 60);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("signer.otp.errors.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    const otp = code.trim();
    if (!otp) {
      setError(t("signer.otp.errors.enterCode"));
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const res = await verifyOtp(email, otp);
      await onVerified(res.sessionToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("signer.otp.errors.verifyFailed"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center bg-ground px-5 py-10">
      <Wordmark className="mb-7" />
      <Card className="w-full max-w-[400px] p-6">
        <span className="inline-flex items-center justify-center size-9 rounded-lg bg-accent-soft text-accent">
          <Mail className="size-4.5" strokeWidth={1.6} />
        </span>
        <h1 className="mt-3.5 font-serif text-[26px] leading-tight text-ink">{t("signer.otp.title")}</h1>
        <p className="mt-1.5 text-[13px] text-muted leading-relaxed">
          <Trans
            i18nKey={sent ? "signer.otp.sentBody" : "signer.otp.intro"}
            values={{ email: sent ? email : email || t("signer.otp.yourAddress") }}
            components={{ 1: <span className="font-mono text-[12px] text-ink-2" /> }}
          />
        </p>

        {sent ? (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <Field label={t("signer.otp.codeLabel")} error={error}>
              <Input
                ref={inputRef}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="1234"
                invalid={!!error}
                className="h-11 text-center font-mono text-[18px] tracking-[0.35em]"
              />
            </Field>
            <Button type="submit" variant="primary" block loading={checking} className="h-11">
              {t("signer.otp.openDocument")}
            </Button>
            <div className="flex items-center justify-between">
              <button
                type="button"
                disabled={cooldown > 0 || sending}
                onClick={() => void send()}
                className="text-[12px] text-muted hover:text-accent disabled:text-faint disabled:cursor-not-allowed"
              >
                {cooldown > 0 ? t("signer.otp.resendIn", { seconds: cooldown }) : t("signer.otp.sendNewCode")}
              </button>
              <span className="text-[11px] text-muted-2">{t("signer.otp.codesNote")}</span>
            </div>
          </form>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            {error ? <p className="text-[12px] text-danger">{error}</p> : null}
            <Button variant="primary" block loading={sending} onClick={() => void send()} className="h-11">
              {t("signer.otp.sendCode")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
