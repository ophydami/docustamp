import { useEffect, type ComponentType } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Inbox, FileText, LayoutTemplate, Users, BarChart3, Workflow, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Cap, Kbd, Avatar, LogoMark, ThemeToggleButton } from "@/components/ui";
import { useBrand } from "@/lib/brand";
import { SOURCE_URL } from "@/lib/source";
import { useBadges, useNavDrawer } from "@/lib/store";
import { useAuth } from "./auth";

type Badge = "inbox" | "expiring";

interface NavItem {
  to: string;
  labelKey: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  badge?: Badge;
}

const groups: Array<{ titleKey: string; items: NavItem[] }> = [
  {
    titleKey: "app.navGroups.signing",
    items: [
      { to: "/inbox", labelKey: "app.nav.inbox", icon: Inbox, badge: "inbox" },
      { to: "/documents", labelKey: "app.nav.documents", icon: FileText },
      { to: "/templates", labelKey: "app.nav.templates", icon: LayoutTemplate },
      { to: "/contacts", labelKey: "app.nav.contacts", icon: Users }
    ]
  },
  {
    titleKey: "app.navGroups.insight",
    items: [
      { to: "/ai", labelKey: "app.nav.ai", icon: Sparkles },
      { to: "/reports", labelKey: "app.nav.reports", icon: BarChart3 },
      { to: "/automations", labelKey: "app.nav.automations", icon: Workflow }
    ]
  }
];

const savedViews: Array<{ view: string; labelKey: string; badge?: Badge; dot: string }> = [
  { view: "waiting-on-me", labelKey: "app.savedViews.waitingOnMe", badge: "inbox", dot: "bg-accent" },
  { view: "expiring", labelKey: "app.savedViews.expiring", badge: "expiring", dot: "bg-warn" },
  { view: "sent-by-me", labelKey: "app.savedViews.sentByMe", dot: "bg-faint" }
];

const row = "flex items-center gap-[9px] h-[30px] px-2 rounded-md text-[13px] text-ink-2 transition-colors";
const rowIdle = "hover:bg-surface-3/70 hover:text-ink";
const rowOn = "bg-surface-3 text-ink font-semibold";

function Count({ n, tone = "accent" }: { n: number; tone?: "accent" | "warn" }) {
  return (
    <span
      className={cn(
        "num ml-auto min-w-[18px] h-[18px] px-1.5 rounded-full inline-flex items-center justify-center text-[10.5px] font-medium",
        tone === "warn" ? "bg-warn-soft text-warn-ink" : "bg-accent-soft text-accent"
      )}
    >
      {n}
    </span>
  );
}

/** Everything inside the sidebar column. Shared by the desktop rail and the drawer. */
function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const badges = useBadges();
  const { user } = useAuth();
  const brand = useBrand();
  const { pathname, search } = useLocation();
  const activeView = pathname === "/documents" ? new URLSearchParams(search).get("view") : null;

  return (
    <>
      <div className="flex items-center gap-[9px] h-[38px] px-2 shrink-0">
        {brand.logoUrl ? (
          <img src={brand.logoUrl} alt={brand.name} className="max-h-6 max-w-[150px] object-contain" />
        ) : (
          <>
            <LogoMark size={22} className="text-ink" />
            <span className="text-[14px] font-semibold tracking-[-0.01em] truncate">{brand.name}</span>
          </>
        )}
        {onClose ? (
          <button
            type="button"
            aria-label={t("app.a11y.closeNav")}
            onClick={onClose}
            className="ml-auto -mr-1 size-7 inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-surface-3"
          >
            <X className="size-4" strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

      {groups.map((g) => (
        <nav key={g.titleKey} aria-label={t(g.titleKey)} className="flex flex-col gap-px">
          <Cap className="block px-2 pt-4 pb-1.5">{t(g.titleKey)}</Cap>
          {g.items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => cn(row, isActive && !activeView ? rowOn : rowIdle)}
            >
              {({ isActive }) => (
                <>
                  <n.icon
                    className={cn("size-[15px] shrink-0", isActive && !activeView ? "text-accent" : "text-muted")}
                    strokeWidth={1.9}
                  />
                  <span className="truncate">{t(n.labelKey)}</span>
                  {n.badge && badges[n.badge] > 0 ? <Count n={badges[n.badge]} /> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      ))}

      <nav aria-label={t("app.savedViews.title")} className="flex flex-col gap-px">
        <Cap className="block px-2 pt-4 pb-1.5">{t("app.savedViews.title")}</Cap>
        {savedViews.map((v) => (
          <NavLink
            key={v.view}
            to={`/documents?view=${v.view}`}
            className={cn(row, activeView === v.view ? rowOn : rowIdle)}
          >
            <span className={cn("size-[7px] rounded-full mx-1 shrink-0", v.dot)} />
            <span className="truncate">{t(v.labelKey)}</span>
            {v.badge && badges[v.badge] > 0 ? (
              <Count n={badges[v.badge]} tone={v.badge === "expiring" ? "warn" : "accent"} />
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto pt-4 flex flex-col gap-px">
        <NavLink to="/settings" className={({ isActive }) => cn(row, isActive ? rowOn : rowIdle)}>
          {({ isActive }) => (
            <>
              <SettingsIcon className={cn("size-[15px] shrink-0", isActive ? "text-accent" : "text-muted")} strokeWidth={1.9} />
              {t("app.nav.settings")}
              <Kbd className="ml-auto">,</Kbd>
            </>
          )}
        </NavLink>
        <div className="flex items-center gap-[9px] h-11 px-2 mt-2 border-t border-line">
          <NavLink to="/settings/profile" className="flex items-center gap-[9px] min-w-0 flex-1 text-ink hover:text-ink">
            <Avatar name={user?.name} email={user?.email} tone="neutral" size={24} />
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[12.5px] font-medium truncate">{user?.name || user?.email}</span>
              {user?.name ? <span className="text-[11px] text-muted truncate">{user?.email}</span> : null}
            </span>
          </NavLink>
          <ThemeToggleButton className="-mr-1" />
        </div>
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="px-2 pt-0.5 text-[11px] text-muted hover:text-accent"
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
    <aside className="w-[236px] shrink-0 border-r border-line hidden lg:flex flex-col px-2.5 py-3 bg-surface-2 overflow-y-auto scroll-thin">
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
        className="relative w-[236px] max-w-[86vw] shrink-0 border-r border-line flex flex-col px-2.5 py-3 bg-surface-2 overflow-y-auto scroll-thin"
      >
        <SidebarContent onClose={() => setOpen(false)} />
      </aside>
    </div>
  );
}
