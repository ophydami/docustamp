import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { extUserKey } from "@/lib/extUser";
import { queryClient } from "@/lib/queryClient";
import { AuthHeading, FormError } from "./AuthLayout";
import { ensureExtUser, errorMessage } from "./api";

export interface CompleteProfileProps {
  name: string;
  email: string;
  phone?: string;
  onDone: () => void | Promise<void>;
}

/**
 * Shown when a signed-in account has no `contracts_Users` row yet, which is the
 * case for a first Google sign-in and for accounts the server created as a side
 * effect of being a signing contact. Creating the row also creates the tenant,
 * so the workspace name comes from the company field. That is the wrong move
 * for someone whose company already has a workspace, so the form says up front
 * that joining one is the admin's job (Settings > Team).
 */
export function CompleteProfile({ name, email, phone, onDone }: CompleteProfileProps) {
  const { t } = useTranslation();
  const { loginWithSessionToken, logout } = useAuth();
  const [company, setCompany] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ company?: string; jobTitle?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: { company?: string; jobTitle?: string } = {};
    if (!company.trim()) next.company = t("auth.errors.companyRequired");
    if (!jobTitle.trim()) next.jobTitle = t("auth.errors.jobTitleRequired");
    setFieldErrors(next);
    if (next.company || next.jobTitle) return;

    setError(null);
    setBusy(true);
    try {
      const res = await ensureExtUser({ name, email, phone, company, jobTitle });
      // `/loginAs` mints a brand new session, so adopt it before continuing.
      if (res.sessionToken) await loginWithSessionToken(res.sessionToken);
      // A cached "no profile" answer would keep RequireProfile showing this form.
      await queryClient.invalidateQueries({ queryKey: extUserKey });
      await onDone();
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.setupFailed"));
      setError(message);
      toast.error(t("auth.toast.setupFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <AuthHeading title={t("auth.profile.title")}>
        {t("auth.profile.subtitle", { email })}
      </AuthHeading>

      <div className="mb-5 rounded-md border border-accent-line bg-accent-tint px-3 py-2 text-[12px] text-ink-2">
        <p className="font-medium text-ink">{t("auth.profile.joinTeamTitle")}</p>
        <p className="mt-0.5">{t("auth.profile.joinTeamBody", { email })}</p>
      </div>

      <div className="flex flex-col gap-4">
        <FormError>{error}</FormError>

        <Field label={t("auth.fields.company")} error={fieldErrors.company}>
          <Input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Acme Inc."
            autoComplete="organization"
            autoFocus
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

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t("common.actions.continue")}
        </Button>

        <button
          type="button"
          onClick={() => void logout()}
          className="text-[12px] text-muted hover:text-ink underline-offset-2 hover:underline"
        >
          {t("auth.actions.useDifferentAccount")}
        </button>
      </div>
    </form>
  );
}
