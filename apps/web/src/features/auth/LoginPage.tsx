import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button, Field, Input, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { AuthHeading, AuthLayout, FormError, OrDivider } from "./AuthLayout";
import { CodeInput } from "./CodeInput";
import { CompleteProfile } from "./CompleteProfile";
import { GoogleButton } from "./GoogleButton";
import { useCooldown } from "./useCooldown";
import {
  EMAIL_RE,
  GOOGLE_CLIENT_ID,
  errorMessage,
  loadExtUser,
  loginErrorMessage,
  loginWithGoogleCredential,
  normalizeEmail,
  requestOtp,
  verifyOtp
} from "./api";

type Step = "signin" | "code" | "profile";
type Mode = "password" | "otp";

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, ready, login, loginWithSessionToken, logout } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? "/inbox";

  const [step, setStep] = useState<Step>("signin");
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const resend = useCooldown(45);

  /**
   * Post-login gate. `getUserDetails` tells us whether the account has a
   * contracts_Users row (and a tenant); without one the app has nothing to show,
   * so we run the onboarding step instead of landing on /inbox. A disabled row
   * means the admin switched the account off, and the session is dropped.
   */
  const settle = useCallback(async () => {
    try {
      const state = await loadExtUser();
      if (state.status === "disabled") {
        await logout();
        setStep("signin");
        setError(t("auth.errors.accountDisabled"));
        return;
      }
      if (state.status === "missing") {
        setStep("profile");
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.profileLoadFailed"));
      setError(message);
      toast.error(t("auth.toast.profileLoadFailed"), message);
    }
  }, [from, logout, navigate, t]);

  // A live session already in localStorage should not be made to sign in again.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (!ready || bootstrapped.current) return;
    bootstrapped.current = true;
    if (!user) {
      setBooting(false);
      return;
    }
    void settle().finally(() => setBooting(false));
  }, [ready, user, settle]);

  function validateEmail(): boolean {
    if (!EMAIL_RE.test(normalizeEmail(email))) {
      setEmailError(t("auth.errors.invalidEmail"));
      return false;
    }
    setEmailError(null);
    return true;
  }

  async function onPasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const emailOk = validateEmail();
    if (!password) setPasswordError(t("auth.errors.passwordRequired"));
    else setPasswordError(null);
    if (!emailOk || !password) return;

    setBusy(true);
    try {
      await login(normalizeEmail(email), password);
      await settle();
    } catch (err) {
      const message = loginErrorMessage(err);
      setError(message);
      toast.error(t("auth.toast.signInFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setError(null);
    if (!validateEmail()) return;
    setBusy(true);
    try {
      await requestOtp({ email });
      setCode("");
      setStep("code");
      resend.start();
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.codeEmailFailed"));
      setError(message);
      toast.error(t("auth.toast.codeSendFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(value: string) {
    setError(null);
    if (!/^\d{6}$/.test(value)) {
      setError(t("auth.errors.codeFourDigits"));
      return;
    }
    setBusy(true);
    try {
      const result = await verifyOtp({ email, otp: value });
      await loginWithSessionToken(result.sessionToken);
      await settle();
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.codeVerifyFallback"));
      setError(message);
      toast.error(t("auth.toast.signInFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  async function onGoogleCredential(credential: string) {
    setError(null);
    setBusy(true);
    try {
      const token = await loginWithGoogleCredential(credential);
      await loginWithSessionToken(token);
      await settle();
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.googleFailed"));
      setError(message);
      toast.error(t("auth.toast.googleFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready || booting) {
    return (
      <AuthLayout>
        <div className="flex items-center gap-2 text-muted-2 text-[13px]">
          <Loader2 className="size-4 animate-spin" strokeWidth={1.6} />
          {t("auth.status.checkingSession")}
        </div>
      </AuthLayout>
    );
  }

  if (step === "profile" && user) {
    return (
      <AuthLayout>
        <CompleteProfile
          name={user.name || user.email || user.username}
          email={user.email || user.username}
          onDone={() => navigate(from, { replace: true })}
        />
      </AuthLayout>
    );
  }

  if (step === "code") {
    return (
      <AuthLayout>
        <AuthHeading title={t("auth.checkEmail.title")}>
          <Trans
            i18nKey="auth.checkEmail.sentTo"
            values={{ email: normalizeEmail(email) }}
            components={{ 1: <span className="text-ink" /> }}
          />
        </AuthHeading>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode(code);
          }}
          noValidate
        >
          <FormError>{error}</FormError>

          <CodeInput
            value={code}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
            onComplete={(v) => void submitCode(v)}
            disabled={busy}
            invalid={!!error}
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {t("auth.actions.signIn")}
          </Button>

          <div className="flex items-center justify-between text-[12px]">
            <button
              type="button"
              onClick={() => {
                setStep("signin");
                setError(null);
                setCode("");
              }}
              className="inline-flex items-center gap-1.5 text-muted hover:text-ink"
            >
              <ArrowLeft className="size-3.5" strokeWidth={1.6} />
              {t("auth.actions.useDifferentEmail")}
            </button>
            <button
              type="button"
              disabled={resend.active || busy}
              onClick={() => void sendCode()}
              className="text-accent hover:text-accent-deep disabled:text-muted-2 disabled:cursor-not-allowed"
            >
              {resend.active
                ? t("auth.actions.resendIn", { seconds: resend.left })
                : t("auth.actions.resendCode")}
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex items-baseline justify-between gap-3 mb-7">
        <h1 className="font-serif text-[30px] leading-tight tracking-[-.015em]">
          {t("auth.signIn.title")}
        </h1>
        <span className="text-[12px] text-muted whitespace-nowrap">
          <Trans i18nKey="auth.signIn.newHere" components={{ 1: <Link to="/signup" /> }} />
        </span>
      </div>

      {GOOGLE_CLIENT_ID ? (
        <>
          <GoogleButton
            onCredential={(c) => void onGoogleCredential(c)}
            onError={(m) => setError(m)}
            disabled={busy}
          />
          <OrDivider />
        </>
      ) : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          if (mode === "otp") {
            e.preventDefault();
            void sendCode();
          } else {
            void onPasswordSubmit(e);
          }
        }}
        noValidate
      >
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

        {mode === "password" ? (
          <Field
            label={t("auth.fields.password")}
            error={passwordError}
            right={
              <Link to="/forgot-password" className="text-[12px] font-normal">
                {t("auth.actions.forgot")}
              </Link>
            }
          >
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError(null);
              }}
              autoComplete="current-password"
              invalid={!!passwordError}
              disabled={busy}
              right={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={
                    showPassword ? t("auth.a11y.hidePassword") : t("auth.a11y.showPassword")
                  }
                  className="text-muted-2 hover:text-ink"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" strokeWidth={1.6} />
                  ) : (
                    <Eye className="size-4" strokeWidth={1.6} />
                  )}
                </button>
              }
            />
          </Field>
        ) : null}

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {mode === "password" ? t("auth.actions.signIn") : t("auth.actions.emailMeACode")}
        </Button>
      </form>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setMode((m) => (m === "password" ? "otp" : "password"));
          setError(null);
          setPasswordError(null);
        }}
        className="mt-4 text-[12px] text-accent hover:text-accent-deep disabled:text-muted-2"
      >
        {mode === "password"
          ? t("auth.actions.switchToOtp")
          : t("auth.actions.switchToPassword")}
      </button>

      <p className="mt-8 pt-5 border-t border-line text-[12px] leading-relaxed text-muted-2">
        {t("auth.footer.signerNote")}
      </p>
    </AuthLayout>
  );
}
