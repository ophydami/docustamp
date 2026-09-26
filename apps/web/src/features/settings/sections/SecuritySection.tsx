import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LogOut, Monitor, X } from "lucide-react";
import { Button, Field, Input, Pill, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { ago, whenShort } from "@/lib/format";
import { changePassword, revokeSession, useSessions } from "../api";
import { FormColumn, SectionCard } from "../parts";

const RULES = [
  { key: "length", test: (p: string) => p.length >= 8 },
  { key: "case", test: (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) },
  { key: "special", test: (p: string) => /[!@#$%^&*()\-_=+{};:,<.>]/.test(p) }
];

export default function SecuritySection() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const sessions = useSessions();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const rules = RULES.map((r) => ({
    key: r.key,
    label: t(`settings.security.password.rules.${r.key}`),
    ok: r.test(next)
  }));
  const strong = rules.every((r) => r.ok);
  const matches = next.length > 0 && next === confirm;
  const canSubmit = current.length > 0 && strong && matches && !busy;

  const submit = async () => {
    if (!user?.email && !user?.username) {
      toast.error(
        t("settings.security.password.toast.cannotChange"),
        t("settings.security.password.toast.cannotChangeBody")
      );
      return;
    }
    setBusy(true);
    try {
      await changePassword(user.email || user.username, current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(
        t("settings.security.password.toast.updated"),
        t("settings.security.password.toast.updatedBody")
      );
      await sessions.refetch();
    } catch (err) {
      toast.error(t("settings.security.password.toast.failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const others = (sessions.data ?? []).filter((s) => !s.current);

  const signOutEverywhere = async () => {
    setSigningOut(true);
    try {
      for (const s of others) await revokeSession(s.objectId);
      toast.success(
        t("settings.security.sessions.toast.signedOutOthers"),
        t("settings.security.sessions.toast.signedOutOthersBody", { count: others.length })
      );
      await sessions.refetch();
    } catch (err) {
      toast.error(t("settings.security.sessions.toast.endOthersFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <FormColumn>
      <SectionCard title={t("settings.security.password.title")} note={t("settings.security.password.note")}>
        <Field label={t("settings.security.password.current")}>
          <Input type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("settings.security.password.new")}>
          <Input type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field
          label={t("settings.security.password.confirm")}
          error={confirm.length > 0 && !matches ? t("settings.security.password.mismatch") : undefined}
        >
          <Input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>

        {next.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {rules.map((r) => (
              <li key={r.key} className="flex items-center gap-1.5 text-[12px]">
                {r.ok ? (
                  <Check className="size-3.5 text-accent" strokeWidth={2} />
                ) : (
                  <X className="size-3.5 text-muted-2" strokeWidth={2} />
                )}
                <span className={r.ok ? "text-ink-2" : "text-muted-2"}>{r.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <Button variant="primary" size="sm" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {t("settings.security.password.submit")}
          </Button>
        </div>
      </SectionCard>

      {sessions.isSuccess && sessions.data.length > 0 ? (
        <SectionCard
          title={t("settings.security.sessions.title")}
          note={t("settings.security.sessions.note")}
          aside={
            others.length > 0 ? (
              <Button size="sm" loading={signingOut} onClick={() => void signOutEverywhere()}>
                {t("settings.security.sessions.signOutOthers")}
              </Button>
            ) : undefined
          }
          bodyClassName="gap-0 py-0"
        >
          {sessions.data.map((s) => (
            <div key={s.objectId} className="flex items-center gap-3 py-3 border-b border-line-soft last:border-0">
              <Monitor className="size-4 text-muted-2 shrink-0" strokeWidth={1.6} />
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] text-ink flex items-center gap-2">
                  {t("settings.security.sessions.started", { when: whenShort(s.createdAt) })}
                  {s.current ? <Pill tone="accent">{t("settings.security.sessions.thisDevice")}</Pill> : null}
                </span>
                <span className="text-[11px] text-muted-2 font-mono truncate">
                  {s.installationId ?? s.objectId}
                  {s.expiresAt ? ` · ${t("settings.security.sessions.expires", { when: ago(s.expiresAt) })}` : ""}
                </span>
              </div>
              {!s.current ? (
                <button
                  type="button"
                  className="ml-auto text-[12px] font-semibold text-danger hover:underline"
                  onClick={() =>
                    void revokeSession(s.objectId)
                      .then(() => sessions.refetch())
                      .catch((err: unknown) =>
                        toast.error(
                          t("settings.security.sessions.toast.endOneFailed"),
                          err instanceof Error ? err.message : String(err)
                        )
                      )
                  }
                >
                  {t("settings.security.sessions.end")}
                </button>
              ) : null}
            </div>
          ))}
        </SectionCard>
      ) : null}

      <SectionCard title={t("settings.security.signOut.title")}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12px] text-muted">
            {sessions.isError
              ? t("settings.security.signOut.listUnavailable")
              : t("settings.security.signOut.thisDevice")}
          </p>
          <Button size="sm" icon={<LogOut className="size-3.5" strokeWidth={1.6} />} onClick={() => void logout()}>
            {t("common.actions.signOut")}
          </Button>
        </div>
      </SectionCard>
    </FormColumn>
  );
}
