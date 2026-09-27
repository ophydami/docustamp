import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Copy, MoreHorizontal, UserPlus } from "lucide-react";
import { Avatar, Button, Dialog, Field, Input, Menu, Pill, Select, toast, type PillTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { whenShort } from "@/lib/format";
import { isAdminRole, useExtUser } from "@/lib/extUser";
import { useAuth } from "@/app/auth";
import {
  addUser,
  deleteMember,
  resetUserPassword,
  setMemberDisabled,
  setMemberRole,
  settingsKeys,
  useTeamMembers,
  useTeams
} from "../api";
import { browserTimezone } from "../constants";
import type { TeamMember } from "../types";
import { FormColumn, SectionCard, SectionError, SectionLoading } from "../parts";

const ROLE_KEY: Record<string, string> = {
  contracts_Admin: "admin",
  contracts_OrgAdmin: "orgAdmin",
  contracts_Editor: "editor",
  contracts_User: "user"
};

/** Display name for a `contracts_*` role, falling back to "Unknown". */
function roleLabel(t: TFunction, role?: string): string {
  const key = ROLE_KEY[role ?? ""];
  return key ? t(`settings.team.roles.${key}`) : t("common.state.unknown");
}

const ROLE_TONE: Record<string, PillTone> = {
  contracts_Admin: "ink",
  contracts_OrgAdmin: "violet",
  contracts_Editor: "accent",
  contracts_User: "neutral"
};

const GRID = "grid-cols-[minmax(0,2fr)_minmax(0,2.2fr)_110px_minmax(0,1fr)_92px_86px_32px]";

function generatePassword(length = 14) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*()-_=+";
  const all = upper + lower + digits + special;
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(special)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export default function TeamSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: extUser } = useExtUser();
  const qc = useQueryClient();
  const admin = isAdminRole(extUser?.UserRole);
  const orgId = typeof extUser?.OrganizationId?.objectId === "string" ? extUser.OrganizationId.objectId : undefined;
  const tenantId = typeof extUser?.TenantId?.objectId === "string" ? extUser.TenantId.objectId : undefined;
  const members = useTeamMembers(admin ? orgId : undefined);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resetFor, setResetFor] = useState<TeamMember | null>(null);
  const [removeFor, setRemoveFor] = useState<TeamMember | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: settingsKeys.members(orgId) });

  if (!admin) {
    return (
      <FormColumn className="max-w-[560px]">
        <SectionCard title={t("settings.team.self.title")} note={t("settings.team.self.note")}>
          <MemberRowCard
            name={extUser?.Name ?? user?.name ?? ""}
            email={extUser?.Email ?? user?.email ?? ""}
            role={extUser?.UserRole}
            disabled={extUser?.IsDisabled === true}
          />
          <p className="text-[12px] text-muted leading-relaxed">{t("settings.team.self.body")}</p>
        </SectionCard>
      </FormColumn>
    );
  }

  if (!orgId) {
    return (
      <SectionCard title={t("settings.sections.team.title")}>
        <p className="text-[13px] text-muted">{t("settings.team.noOrg")}</p>
      </SectionCard>
    );
  }

  if (members.error) return <SectionError error={members.error} onRetry={() => void members.refetch()} />;
  if (members.isPending) return <SectionLoading />;

  const rows = members.data;

  const toggleDisabled = async (m: TeamMember) => {
    setBusyId(m.objectId);
    try {
      await setMemberDisabled(m.objectId, m.IsDisabled !== true);
      await refresh();
      toast.success(
        m.IsDisabled ? t("settings.team.toast.accessRestored") : t("settings.team.toast.accessSuspended"),
        m.Email ?? ""
      );
    } catch (err) {
      toast.error(t("settings.team.toast.updateFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = async (m: TeamMember, role: string) => {
    setBusyId(m.objectId);
    try {
      await setMemberRole(m.objectId, role);
      await refresh();
      toast.success(
        t("settings.team.toast.roleUpdated"),
        t("settings.team.toast.roleUpdatedBody", { name: m.Name ?? m.Email, role: roleLabel(t, role) })
      );
    } catch (err) {
      toast.error(t("settings.team.toast.roleFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1000px]">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[12px] text-muted">{t("settings.team.countLine", { count: rows.length })}</p>
        <Button
          variant="primary"
          size="sm"
          icon={<UserPlus className="size-3.5" strokeWidth={1.6} />}
          onClick={() => setInviteOpen(true)}
        >
          {t("settings.team.invite.button")}
        </Button>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden shadow-[var(--shadow-card)]">
        <div className="overflow-x-auto scroll-thin">
        {/* Floor stays at every width: at lg the settings nav and sidebar leave ~520px, which crushed the fr columns. */}
        <div className="min-w-[720px]">
        <div className={cn("grid h-[34px] items-center bg-surface-2 border-b border-line px-4 gap-3", GRID)}>
          {[
            t("settings.team.table.name"),
            t("settings.team.table.email"),
            t("settings.team.table.role"),
            t("settings.team.table.teams"),
            t("settings.team.table.status"),
            t("settings.team.table.added"),
            ""
          ].map((h, i) => (
            <span key={i} className="text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium truncate">
              {h}
            </span>
          ))}
        </div>
        {rows.map((m) => {
          const isSelf = m.UserId?.objectId === user?.id || m.objectId === extUser?.objectId;
          const isAdminRow = m.UserRole === "contracts_Admin";
          const locked = isSelf || isAdminRow;
          return (
            <div
              key={m.objectId}
              className={cn(
                "grid items-center px-4 gap-3 h-[52px] border-b border-line-soft last:border-0",
                GRID,
                busyId === m.objectId && "opacity-60"
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Avatar name={m.Name} email={m.Email} size={22} />
                <span className="text-[13px] truncate">{m.Name || t("settings.team.table.unnamed")}</span>
              </span>
              <span className="text-[13px] text-muted truncate">{m.Email ?? "-"}</span>
              <span>
                <Pill tone={ROLE_TONE[m.UserRole ?? ""] ?? "neutral"}>{roleLabel(t, m.UserRole)}</Pill>
              </span>
              <span className="text-[12px] text-muted truncate">
                {m.TeamIds?.map((team) => team.Name).filter(Boolean).join(", ") || "-"}
              </span>
              <span>
                {m.IsDisabled ? (
                  <Pill tone="danger">{t("settings.team.table.suspended")}</Pill>
                ) : (
                  <Pill tone="accent" dot>
                    {t("settings.team.table.active")}
                  </Pill>
                )}
              </span>
              <span className="text-[12px] text-muted-2">{whenShort(m.createdAt)}</span>
              <Menu
                align="right"
                trigger={(p) => (
                  <button
                    type="button"
                    aria-label={t("settings.team.actions.label", {
                      name: m.Name ?? m.Email ?? t("settings.team.actions.memberFallback")
                    })}
                    className="size-6 inline-flex items-center justify-center rounded-md text-muted-2 hover:text-ink hover:bg-line-soft"
                    {...p}
                  >
                    <MoreHorizontal className="size-4" strokeWidth={1.6} />
                  </button>
                )}
                items={[
                  {
                    label: t("settings.team.actions.makeOrgAdmin"),
                    disabled: locked || m.UserRole === "contracts_OrgAdmin",
                    onSelect: () => void changeRole(m, "contracts_OrgAdmin")
                  },
                  {
                    label: t("settings.team.actions.makeEditor"),
                    disabled: locked || m.UserRole === "contracts_Editor",
                    onSelect: () => void changeRole(m, "contracts_Editor")
                  },
                  {
                    label: t("settings.team.actions.makeUser"),
                    disabled: locked || m.UserRole === "contracts_User",
                    onSelect: () => void changeRole(m, "contracts_User")
                  },
                  "separator",
                  { label: t("settings.team.actions.resetPassword"), disabled: locked, onSelect: () => setResetFor(m) },
                  {
                    label: m.IsDisabled ? t("settings.team.actions.restoreAccess") : t("settings.team.actions.suspendAccess"),
                    disabled: locked,
                    onSelect: () => void toggleDisabled(m)
                  },
                  {
                    label: t("settings.team.actions.remove"),
                    danger: true,
                    disabled: locked,
                    onSelect: () => setRemoveFor(m)
                  }
                ]}
              />
            </div>
          );
        })}
        </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-2 leading-relaxed max-w-[560px]">{t("settings.team.note")}</p>

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        tenantId={tenantId}
        organizationId={orgId}
        company={extUser?.Company}
        onDone={() => void refresh()}
      />
      <ResetPasswordDialog member={resetFor} onClose={() => setResetFor(null)} />
      <RemoveDialog member={removeFor} onClose={() => setRemoveFor(null)} onDone={() => void refresh()} />
    </div>
  );
}

function MemberRowCard({
  name,
  email,
  role,
  disabled
}: {
  name: string;
  email: string;
  role?: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <Avatar name={name} email={email} size={32} />
      <div className="flex flex-col min-w-0">
        <span className="text-[13px] font-medium truncate">{name || t("settings.team.table.unnamed")}</span>
        <span className="text-[12px] text-muted truncate">{email}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Pill tone={ROLE_TONE[role ?? ""] ?? "neutral"}>{roleLabel(t, role)}</Pill>
        {disabled ? <Pill tone="danger">{t("settings.team.table.suspended")}</Pill> : null}
      </div>
    </div>
  );
}

function CopyableSecret({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 font-mono text-[12px] bg-paper rounded-md px-3 py-2 break-all">{value}</code>
      <Button
        size="sm"
        icon={<Copy className="size-3.5" strokeWidth={1.6} />}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success(t("common.actions.copied")))
            .catch(() => toast.error(t("settings.team.toast.copyFailed"), t("settings.team.toast.copyFailedBody")));
        }}
      >
        {t("common.actions.copy")}
      </Button>
    </div>
  );
}

function InviteDialog({
  open,
  onClose,
  tenantId,
  organizationId,
  company,
  onDone
}: {
  open: boolean;
  onClose: () => void;
  tenantId?: string;
  organizationId: string;
  company?: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const teams = useTeams(open);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"OrgAdmin" | "Editor" | "User">("User");
  const [team, setTeam] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const teamId =
    team || teams.data?.find((row) => row.Name === "All Users")?.objectId || teams.data?.[0]?.objectId || "";
  const emailOk = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
  const canSubmit = name.trim().length > 0 && emailOk && !!teamId && !!tenantId && !busy;

  const close = () => {
    setCreated(null);
    onClose();
  };

  const submit = async () => {
    if (!tenantId) return;
    setBusy(true);
    try {
      await addUser({
        name: name.trim(),
        email: email.trim().toLowerCase().replace(/\s/g, ""),
        phone: phone.trim(),
        password,
        role,
        team: teamId,
        tenantId,
        organizationId,
        company,
        timezone: browserTimezone()
      });
      setCreated(password);
      onDone();
      toast.success(t("settings.team.invite.toast.added"), email);
      setName("");
      setEmail("");
      setPhone("");
      setPassword(generatePassword());
    } catch (err) {
      toast.error(t("settings.team.invite.toast.failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      width={540}
      title={t("settings.team.invite.title")}
      description={t("settings.team.invite.description")}
      footer={
        created ? (
          <Button onClick={close}>{t("common.actions.done")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
              {t("settings.team.invite.submit")}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2">{t("settings.team.invite.created")}</p>
          <CopyableSecret value={created} />
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3.5">
            <Field label={t("settings.team.invite.fullName")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana Silva" autoFocus />
            </Field>
            <Field label={t("settings.team.invite.phone")}>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          </div>
          <Field
            label={t("settings.team.invite.email")}
            error={email.length > 0 && !emailOk ? t("common.errors.invalidEmail") : undefined}
          >
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value.toLowerCase().replace(/\s/g, ""))}
              placeholder="ana@acme.com"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3.5">
            <Field label={t("settings.team.invite.role")}>
              <Select value={role} onChange={(e) => setRole(e.target.value as "OrgAdmin" | "Editor" | "User")}>
                <option value="User">{t("settings.team.roles.user")}</option>
                <option value="Editor">{t("settings.team.roles.editor")}</option>
                <option value="OrgAdmin">{t("settings.team.roles.orgAdmin")}</option>
              </Select>
            </Field>
            <Field label={t("settings.team.invite.team")} hint={teams.isPending ? t("settings.team.invite.teamLoading") : undefined}>
              <Select value={teamId} onChange={(e) => setTeam(e.target.value)} disabled={teams.isPending}>
                {(teams.data ?? []).map((row) => (
                  <option key={row.objectId} value={row.objectId}>
                    {row.Name ?? row.objectId}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("settings.team.invite.password")} hint={t("settings.team.invite.passwordHint")}>
            <div className="flex items-center gap-2">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
              <Button size="sm" onClick={() => setPassword(generatePassword())}>
                {t("settings.team.invite.newPassword")}
              </Button>
            </div>
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const close = () => {
    setDone(false);
    setPassword(generatePassword());
    onClose();
  };

  const submit = async () => {
    const userId = member?.UserId?.objectId;
    if (!userId) {
      toast.error(t("settings.team.reset.toast.cannot"), t("settings.team.reset.toast.cannotBody"));
      return;
    }
    setBusy(true);
    try {
      await resetUserPassword(userId, password);
      setDone(true);
      toast.success(t("settings.team.reset.toast.done"), member?.Email ?? "");
    } catch (err) {
      toast.error(t("settings.team.reset.toast.failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!member}
      onClose={close}
      width={480}
      title={t("settings.team.reset.title")}
      description={
        member ? t("settings.team.reset.description", { name: member.Name ?? member.Email }) : undefined
      }
      footer={
        done ? (
          <Button onClick={close}>{t("common.actions.done")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="primary" loading={busy} disabled={password.length < 8} onClick={() => void submit()}>
              {t("settings.team.reset.submit")}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2">{t("settings.team.reset.done")}</p>
          <CopyableSecret value={password} />
        </div>
      ) : (
        <Field label={t("settings.team.reset.newPassword")} hint={t("settings.team.reset.newPasswordHint")}>
          <div className="flex items-center gap-2">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
            <Button size="sm" onClick={() => setPassword(generatePassword())}>
              {t("settings.team.reset.generate")}
            </Button>
          </div>
        </Field>
      )}
    </Dialog>
  );
}

function RemoveDialog({
  member,
  onClose,
  onDone
}: {
  member: TeamMember | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setConfirm("");
    onClose();
  };

  const submit = async () => {
    const userId = member?.UserId?.objectId;
    if (!userId) {
      toast.error(t("settings.team.remove.toast.cannot"), t("settings.team.remove.toast.cannotBody"));
      return;
    }
    setBusy(true);
    try {
      const message = await deleteMember(userId);
      onDone();
      toast.success(t("settings.team.remove.toast.done"), message);
      close();
    } catch (err) {
      toast.error(t("settings.team.remove.toast.failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const target = (member?.Email ?? "").toLowerCase();
  return (
    <Dialog
      open={!!member}
      onClose={close}
      width={480}
      title={t("settings.team.remove.title")}
      description={t("settings.team.remove.description")}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={confirm.trim().toLowerCase() !== target || !target}
            onClick={() => void submit()}
          >
            {t("common.actions.remove")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          <Trans
            i18nKey="settings.team.remove.confirm"
            values={{ email: member?.Email ?? "" }}
            components={{ 1: <span className="font-mono" /> }}
          />
        </p>
        <Field label={t("settings.team.remove.emailLabel")}>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
        </Field>
      </div>
    </Dialog>
  );
}
