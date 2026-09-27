import { useMemo, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Eye, EyeOff } from "lucide-react";
import { Button, Checkbox, Field, Input, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { cn } from "@/lib/cn";
import { AuthLayout, FormError } from "./AuthLayout";
import {
  EMAIL_RE,
  adminExists,
  createAccount,
  errorMessage,
  isAlreadyExists,
  normalizeEmail
} from "./api";

/** Same policy the old app enforced client-side; the server checks nothing. */
const RULES = [
  { id: "length", test: (v: string) => v.length >= 8 },
  { id: "mix", test: (v: string) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) },
  { id: "special", test: (v: string) => /[!@#$%^&*()_=+{};:,<.>-]/.test(v) }
] as const;

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  company?: string;
  jobTitle?: string;
  terms?: string;
}

export default function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loginWithSessionToken } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [company, setCompany] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The very first account on an install has to be created through `addadmin`
  // so it gets the contracts_Admin role, an organization and an "All Users" team.
  const firstAccount = useQuery({
    queryKey: ["auth", "adminExists"],
    queryFn: async () => !(await adminExists()),
    staleTime: 60_000,
    retry: 1
  });

  const passed = useMemo(() => RULES.filter((r) => r.test(password)).length, [password]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!name.trim()) next.name = t("auth.errors.nameRequired");
    if (!EMAIL_RE.test(normalizeEmail(email))) next.email = t("auth.errors.invalidEmail");
    if (passed < RULES.length) next.password = t("auth.errors.passwordRules");
    if (!company.trim()) next.company = t("auth.errors.companyRequired");
    if (!jobTitle.trim()) next.jobTitle = t("auth.errors.jobTitleRequired");
    if (!agreed) next.terms = t("auth.errors.termsRequired");
    setFieldErrors(next);
    if (Object.keys(next).length) return;

    setError(null);
    setBusy(true);
    try {
      const result = await createAccount({
        name,
        email,
        password,
        phone,
        company,
        jobTitle,
        asAdmin: firstAccount.data === true
      });
      // Both signup functions answer "User already exist" when a contracts_Users
      // row is already attached to this email, and hand back a session only when
      // the password typed here proved the account is theirs.
      const existed = isAlreadyExists(result);
      if (!result.sessionToken) {
        const message = existed
          ? t("auth.errors.emailTaken")
          : errorMessage(result.message, t("auth.errors.accountNotCreated"));
        setError(message);
        return;
      }
      await loginWithSessionToken(result.sessionToken);
      // Nothing was created on that path: they are back in the workspace they
      // already had, so do not congratulate them on a new one.
      toast.success(
        existed ? t("auth.toast.existingAccount") : t("auth.toast.workspaceCreated"),
        existed
          ? t("auth.toast.existingAccountBody")
          : t("auth.toast.workspaceCreatedBody", { name: name.trim() })
      );
      navigate("/inbox", { replace: true });
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.accountNotCreated"));
      setError(message);
      toast.error(t("auth.toast.signUpFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="flex items-baseline justify-between gap-3 mb-7">
        <h1 className="font-semibold text-[24px] leading-tight tracking-[-.015em]">
          {t("auth.signUp.title")}
        </h1>
        <span className="text-[12px] text-muted whitespace-nowrap">
          <Trans i18nKey="auth.signUp.haveAccount" components={{ 1: <Link to="/login" /> }} />
        </span>
      </div>

      {firstAccount.data === true ? (
        <p className="mb-5 rounded-md border border-accent-line bg-accent-tint px-3 py-2 text-[12px] text-ink-2">
          {t("auth.signUp.firstAccountNotice")}
        </p>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError>{error}</FormError>

        <Field label={t("auth.fields.fullName")} error={fieldErrors.name}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("auth.placeholders.fullName")}
            autoComplete="name"
            autoFocus
            invalid={!!fieldErrors.name}
            disabled={busy}
          />
        </Field>

        <Field label={t("auth.fields.workEmail")} error={fieldErrors.email}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.placeholders.email")}
            autoComplete="username"
            invalid={!!fieldErrors.email}
            disabled={busy}
          />
        </Field>

        <Field label={t("auth.fields.password")} error={fieldErrors.password}>
          <Input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            invalid={!!fieldErrors.password}
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

        <ul className="-mt-2 flex flex-col gap-1">
          {RULES.map((rule) => {
            const ok = rule.test(password);
            return (
              <li
                key={rule.id}
                className={cn("flex items-center gap-2 text-[11px]", ok ? "text-success-ink" : "text-muted-2")}
              >
                <span
                  className={cn(
                    "grid place-items-center size-3.5 rounded-full border",
                    ok ? "border-success bg-success text-on-accent" : "border-faint"
                  )}
                >
                  {ok ? <Check className="size-2.5" strokeWidth={2.4} /> : null}
                </span>
                {t(`auth.password.rules.${rule.id}`)}
              </li>
            );
          })}
        </ul>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("auth.fields.company")} error={fieldErrors.company}>
            <Input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Acme Inc."
              autoComplete="organization"
              invalid={!!fieldErrors.company}
              disabled={busy}
            />
          </Field>
          <Field label={t("auth.fields.jobTitle")} error={fieldErrors.jobTitle}>
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder={t("auth.placeholders.jobTitle")}
              autoComplete="organization-title"
              invalid={!!fieldErrors.jobTitle}
              disabled={busy}
            />
          </Field>
        </div>

        <Field label={t("auth.fields.phone")} hint={t("auth.hints.phone")}>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("auth.placeholders.phone")}
            autoComplete="tel"
            disabled={busy}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2.5">
            <span className="pt-0.5">
              <Checkbox
                checked={agreed}
                onChange={(v) => {
                  setAgreed(v);
                  setFieldErrors((f) => ({ ...f, terms: undefined }));
                }}
                label={t("auth.a11y.acceptTerms")}
                disabled={busy}
              />
            </span>
            <span className="text-[12px] leading-relaxed text-ink-2">
              <Trans
                i18nKey="auth.signUp.termsAgreement"
                components={{ 1: <Link to="/terms" />, 2: <Link to="/privacy" /> }}
              />
            </span>
          </div>
          {fieldErrors.terms ? (
            <span className="text-[12px] text-danger">{fieldErrors.terms}</span>
          ) : null}
        </div>

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t("auth.actions.createWorkspace")}
        </Button>
      </form>

      <p className="mt-8 pt-5 border-t border-line text-[12px] leading-relaxed text-muted-2">
        {t("auth.footer.signerNote")}
      </p>
    </AuthLayout>
  );
}
