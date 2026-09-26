import { useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Inbox, FileText, LayoutTemplate, Users, BarChart3, Workflow, Plus, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, Cap, Kbd, Avatar, ThemeToggleButton } from "@/components/ui";
import { useBrand } from "@/lib/brand";
import { SOURCE_URL } from "@/lib/source";
import { useBadges, useNavDrawer } from "@/lib/store";
import { useAuth } from "./auth";

const nav = [
  { to: "/inbox", labelKey: "app.nav.inbox", icon: Inbox, badge: "inbox" as const },
  { to: "/ai", labelKey: "app.nav.ai", icon: Sparkles },
  { to: "/documents", labelKey: "app.nav.documents", icon: FileText },
  { to: "/templates", labelKey: "app.nav.templates", icon: LayoutTemplate },
  { to: "/contacts", labelKey: "app.nav.contacts", icon: Users },
  { to: "/reports", labelKey: "app.nav.reports", icon: BarChart3 },
  { to: "/automations", labelKey: "app.nav.automations", icon: Workflow }
];

const savedViews = [
  { to: "/documents?view=waiting-on-me", labelKey: "app.savedViews.waitingOnMe", badge: "inbox" as const, tone: "accent" },
  { to: "/documents?view=expiring", labelKey: "app.savedViews.expiring", badge: "expiring" as const, tone: "danger" },
  { to: "/documents?view=sent-by-me", labelKey: "app.savedViews.sentByMe" }
];

/** Everything inside the sidebar column. Shared by the desktop rail and the drawer. */
function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const badges = useBadges();
  const { user } = useAuth();
  const navigate = useNavigate();
  const brand = useBrand();

  return (
    <>
      <div className="flex items-center gap-2.5 px-2.5 pb-4 pt-0.5">
        {brand.logoUrl ? (
          <img src={brand.logoUrl} alt={brand.name} className="max-h-7 max-w-[150px] object-contain" />
        ) : (
          <>
            <span className="size-[22px] rounded-[6px] bg-accent shrink-0" />
            <span className="text-[15px] font-semibold tracking-[-0.01em] truncate">{brand.name}</span>
          </>
        )}
        {onClose ? (
          <button
            type="button"
            aria-label={t("app.a11y.closeNav")}
            onClick={onClose}
            className="ml-auto -mr-1 size-7 inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-line-soft"
          >
            <X className="size-4" strokeWidth={1.6} />
          </button>
        ) : null}
      </div>

      <Button variant="dark" size="lg" block kbd="N" className="mb-3 justify-start" icon={<Plus className="size-3.5" />}
        onClick={() => navigate("/send")}>
        <span className="flex-1 text-left">{t("app.actions.newRequest")}</span>
      </Button>

      {nav.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 h-[34px] px-2.5 rounded-md text-[13px] font-medium text-ink-2",
              isActive && "bg-surface text-ink shadow-[0_1px_0_var(--color-line)]"
            )
          }
        >
          <n.icon className="size-4" strokeWidth={1.6} />
          {t(n.labelKey)}
          {n.badge && badges[n.badge] > 0 ? (
            <span className="num ml-auto text-[11px] font-semibold text-accent">{badges[n.badge]}</span>
          ) : null}
        </NavLink>
      ))}

      <div className="h-px bg-line my-2.5" />
      <Cap className="px-2.5 pb-1.5">{t("app.savedViews.title")}</Cap>
      {savedViews.map((v) => (
        <NavLink
          key={v.to}
          to={v.to}
          className="flex items-center gap-2.5 h-[34px] px-2.5 rounded-md text-[13px] text-ink-2 hover:bg-surface"
        >
          {t(v.labelKey)}
          {v.badge && badges[v.badge] > 0 ? (
            <span className={cn("num ml-auto text-[11px]", v.tone === "danger" ? "text-danger" : "text-accent")}>
              {badges[v.badge]}
            </span>
          ) : null}
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col gap-1">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 h-[34px] px-2.5 rounded-md text-[13px] text-ink-2",
              isActive && "bg-surface text-ink"
            )
          }
        >
          <SettingsIcon className="size-4" strokeWidth={1.6} />
          {t("app.nav.settings")}
          <Kbd className="ml-auto">,</Kbd>
        </NavLink>
        <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-surface border border-line">
          <NavLink to="/settings/profile" className="flex items-center gap-2.5 min-w-0 flex-1">
            <Avatar name={user?.name} email={user?.email} tone="ink" size={26} />
            <span className="flex flex-col min-w-0">
              <span className="text-[12px] font-semibold truncate">{user?.name || user?.email}</span>
              <span className="text-[11px] text-muted-2 truncate">{user?.email}</span>
            </span>
          </NavLink>
          <ThemeToggleButton className="-mr-1" />
        </div>
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="px-2.5 pt-1 text-[11px] text-muted-2 hover:text-accent"
        >
          {t("auth.footer.openSource")} · {t("auth.footer.source")}
        </a>
      </div>
    </>
  );
}

/** Permanent sidebar column. Hidden below 1024px, where the drawer takes over. */
export function Sidebar() {
  return (
    <aside className="w-[228px] shrink-0 border-r border-line hidden lg:flex flex-col px-3 py-4 gap-1 bg-ground">
      <SidebarContent />
    </aside>
  );
}

/**
 * Off-canvas sidebar for phones and tablets: same contents, opened from the top
 * bar hamburger. Esc and the backdrop close it, and so does any navigation.
 */
export function SidebarDrawer() {
  const { t } = useTranslation();
  const { open, setOpen } = useNavDrawer();
  const { pathname, search } = useLocation();

  // Close on navigation, including a tap on the link for the current page.
  useEffect(() => {
    setOpen(false);
  }, [pathname, search, setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="lg:hidden fixed inset-0 z-50 flex">
      <div
        className="absolute inset-0 bg-scrim"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t("app.a11y.mainNav")}
        className="relative w-[228px] max-w-[86vw] shrink-0 border-r border-line flex flex-col px-3 py-4 gap-1 bg-ground overflow-y-auto scroll-thin"
      >
        <SidebarContent onClose={() => setOpen(false)} />
      </aside>
    </div>
  );
}
