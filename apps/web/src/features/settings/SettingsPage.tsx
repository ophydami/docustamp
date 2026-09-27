import { useEffect, type ReactElement } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Button, Cap } from "@/components/ui";
import { useHotkeys } from "@/lib/hotkeys";
import { useExtUser, isAdminRole } from "@/lib/extUser";
import { SaveBarContext, useSaveBarHost } from "./sectionForm";
import {
  WORKSPACE_SECTIONS,
  YOU_SECTIONS,
  sectionDescription,
  sectionLabel,
  sectionMeta,
  sectionTitle,
  type SectionMeta
} from "./constants";
import { useTeamMembers } from "./api";
import ProfileSection from "./sections/ProfileSection";
import SignatureSection from "./sections/SignatureSection";
import NotificationsSection from "./sections/NotificationsSection";
import SecuritySection from "./sections/SecuritySection";
import GeneralSection from "./sections/GeneralSection";
import TeamSection from "./sections/TeamSection";
import BrandingSection from "./sections/BrandingSection";
import SigningDefaultsSection from "./sections/SigningDefaultsSection";
import EmailTemplatesSection from "./sections/EmailTemplatesSection";
import IntegrationsSection from "./sections/IntegrationsSection";
import ApiWebhooksSection from "./sections/ApiWebhooksSection";
import AuditSection from "./sections/AuditSection";
import BillingSection from "./sections/BillingSection";

const bodies: Record<string, () => ReactElement> = {
  profile: ProfileSection,
  signature: SignatureSection,
  notifications: NotificationsSection,
  security: SecuritySection,
  general: GeneralSection,
  team: TeamSection,
  branding: BrandingSection,
  signing: SigningDefaultsSection,
  email: EmailTemplatesSection,
  integrations: IntegrationsSection,
  api: ApiWebhooksSection,
  audit: AuditSection,
  billing: BillingSection
};

function NavItem({ item, count }: { item: SectionMeta; count?: number }) {
  const { t } = useTranslation();
  return (
    <NavLink
      to={`/settings/${item.id}`}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 h-[30px] px-2 rounded-md text-[13px] text-ink-2 transition-colors",
          isActive ? "bg-surface-3 text-ink font-semibold" : "hover:bg-surface-3/70 hover:text-ink"
        )
      }
    >
      <span className="truncate">{sectionLabel(t, item.id)}</span>
      {count !== undefined ? <span className="num ml-auto text-[11px] text-muted">{count}</span> : null}
    </NavLink>
  );
}

export default function SettingsPage() {
  const { section } = useParams<{ section: string }>();
  const { t } = useTranslation();
  const { data: extUser } = useExtUser();
  const admin = isAdminRole(extUser?.UserRole);
  const orgId = typeof extUser?.OrganizationId?.objectId === "string" ? extUser.OrganizationId.objectId : undefined;
  const team = useTeamMembers(admin ? orgId : undefined);
  const { state, value } = useSaveBarHost();

  useHotkeys(
    {
      "mod+s": (e) => {
        if (!state?.dirty || state.saving) return;
        e.preventDefault();
        state.save();
      }
    },
    [state?.dirty, state?.saving]
  );

  useEffect(() => {
    if (!state?.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state?.dirty]);

  if (!section) return <Navigate to="/settings/profile" replace />;
  const meta = sectionMeta(section);
  if (!meta) return <Navigate to="/settings/profile" replace />;

  const Body = bodies[meta.id];
  const tenantName =
    (typeof extUser?.TenantId?.TenantName === "string" && extUser.TenantId.TenantName) ||
    t("settings.workspaceFallback");

  const allSections = [...YOU_SECTIONS, ...WORKSPACE_SECTIONS];

  return (
    <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      <div className="md:hidden shrink-0 border-b border-line bg-surface overflow-x-auto scroll-thin">
        <div className="flex items-center gap-1.5 px-4 py-2.5 w-max">
          {allSections.map((s) => (
            <NavLink
              key={s.id}
              to={`/settings/${s.id}`}
              className={({ isActive }) =>
                cn(
                  "inline-flex items-center h-7 px-2.5 rounded-md text-[12px] font-medium border whitespace-nowrap",
                  isActive
                    ? "bg-surface-3 text-ink border-line-strong"
                    : "bg-surface text-muted border-line hover:text-ink hover:border-line-strong"
                )
              }
            >
              {sectionLabel(t, s.id)}
            </NavLink>
          ))}
        </div>
      </div>

      <nav aria-label={t("settings.title")} className="w-[220px] shrink-0 border-r border-line bg-surface hidden md:flex flex-col min-h-0">
        <div className="flex-1 min-h-0 overflow-auto scroll-thin px-2.5 pt-1 pb-5 flex flex-col gap-px">
          <Cap className="block px-2 pt-4 pb-1.5">{t("settings.nav.you")}</Cap>
          {YOU_SECTIONS.map((s) => (
            <NavItem key={s.id} item={s} />
          ))}

          <Cap className="block px-2 pt-4 pb-1.5 truncate" title={tenantName}>
            {t("settings.nav.workspace")} · {tenantName}
          </Cap>
          {WORKSPACE_SECTIONS.map((s) => (
            <NavItem key={s.id} item={s} count={s.id === "team" ? team.data?.length : undefined} />
          ))}
        </div>
      </nav>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <header className="h-[52px] shrink-0 bg-surface border-b border-line flex items-center gap-4 px-4 lg:px-7">
          <div className="min-w-0 flex items-baseline gap-2.5">
            <h1 className="text-[14px] font-semibold whitespace-nowrap">{sectionTitle(t, meta.id)}</h1>
            <p className="text-[12px] text-muted truncate hidden sm:block">{sectionDescription(t, meta.id)}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {state ? (
              <>
                <Button size="sm" variant="ghost" disabled={!state.dirty || state.saving} onClick={() => state.discard()}>
                  {t("common.actions.discard")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  kbd="⌘S"
                  loading={state.saving}
                  disabled={!state.dirty}
                  onClick={() => state.save()}
                >
                  {t("common.actions.saveChanges")}
                </Button>
              </>
            ) : null}
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-auto scroll-thin px-4 py-4 lg:px-7 lg:py-6">
          <SaveBarContext.Provider value={value}>
            <Body />
          </SaveBarContext.Provider>
        </div>
      </div>
    </div>
  );
}
