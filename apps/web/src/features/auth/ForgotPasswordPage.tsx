import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowLeft, MailCheck } from "lucide-react";
import { Button, Field, Input, toast } from "@/components/ui";
import { AuthHeading, AuthLayout, FormError } from "./AuthLayout";
import { EMAIL_RE, errorMessage, normalizeEmail, requestPasswordReset } from "./api";

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(normalizeEmail(email))) {
      setEmailError(t("auth.errors.invalidEmail"));
      return;
    }
    setEmailError(null);
    setError(null);
    setBusy(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.resetSendFailed"));
      setError(message);
      toast.error(t("auth.toast.resetFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <span className="grid place-items-center size-10 rounded-lg bg-accent-soft text-accent mb-5">
          <MailCheck className="size-5" strokeWidth={1.6} />
        </span>
        <AuthHeading title={t("auth.checkEmail.title")}>
          <Trans
            i18nKey="auth.forgot.sentBody"
            values={{ email: normalizeEmail(email) }}
            components={{ 1: <span className="text-ink" /> }}
          />
        </AuthHeading>
        <div className="flex flex-col gap-3">
          <Link to="/login">
            <Button variant="primary" size="lg" block>
              {t("auth.actions.backToSignIn")}
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => setSent(false)}
            className="text-[12px] text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            {t("auth.actions.sendToDifferentAddress")}
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title={t("auth.forgot.title")}>{t("auth.forgot.subtitle")}</AuthHeading>

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError>{error}</FormError>

        <Field label={t("auth.fields.workEmail")} error={emailError}>
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
            }}
            placeholder={t("auth.placeholders.email")}
            autoComplete="username"
            autoFocus
            invalid={!!emailError}
            disabled={busy}
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t("auth.actions.sendResetLink")}
        </Button>
      </form>

      <Link
        to="/login"
        className="mt-5 inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.6} />
        {t("auth.actions.backToSignIn")}
      </Link>
    </AuthLayout>
  );
}
