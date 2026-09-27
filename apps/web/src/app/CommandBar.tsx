import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Command } from "cmdk";
import { Search, Plus, PenLine, LayoutTemplate, Inbox, FileText, Users, BarChart3, Settings, Menu as MenuIcon, Layers, Moon, Sun } from "lucide-react";
import { Button, Kbd, Menu } from "@/components/ui";
import { useCommands, useNavDrawer, usePalette } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { useHotkeys } from "@/lib/hotkeys";
import { weekdayShort } from "@/lib/format";

/** Section title for the top bar, from the first path segment. */
const TITLES: Record<string, string> = {
  inbox: "app.nav.inbox",
  ai: "app.nav.ai",
  documents: "app.nav.documents",
  templates: "app.nav.templates",
  contacts: "app.nav.contacts",
  reports: "app.nav.reports",
  automations: "app.nav.automations",
  settings: "app.nav.settings"
};

/**
 * Top bar: section title, ⌘K search, today's date and the quick actions, with
 * "New request" as the one ink button.
 * Below 1024px it compresses: a hamburger opens the sidebar drawer, the search
 * field becomes an icon, and the quick actions collapse into one "+" menu.
 */
export function TopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setOpen = usePalette((s) => s.setOpen);
  const toggleNav = useNavDrawer((s) => s.toggle);
  const titleKey = TITLES[pathname.split("/")[1] ?? ""];

  useHotkeys(
    {
      "mod+k": (e) => {
        e.preventDefault();
        setOpen(true);
      },
      n: () => navigate("/send"),
      s: () => navigate("/send?mode=self"),
      t: () => navigate("/templates"),
      ",": () => navigate("/settings")
    },
    [navigate],
    { priority: "low" }
  );

  return (
    <div className="h-[54px] shrink-0 border-b border-line bg-surface flex items-center pl-3 pr-3 lg:pl-6 lg:pr-5 gap-2 lg:gap-3">
      <button
        type="button"
        aria-label={t("app.a11y.openNav")}
        onClick={toggleNav}
        className="lg:hidden size-8 shrink-0 inline-flex items-center justify-center rounded-md text-ink-2 hover:bg-surface-3"
      >
        <MenuIcon className="size-[18px]" strokeWidth={1.8} />
      </button>

      {titleKey ? (
        <span className="text-[17px] lg:text-[20px] font-semibold tracking-[-0.015em] truncate">{t(titleKey)}</span>
      ) : null}

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden lg:flex items-center gap-2 w-[240px] h-[34px] shrink-0 border border-line rounded-md px-2.5 text-muted text-[13px] bg-surface-2 hover:border-line-strong text-left"
      >
        <Search className="size-3.5" strokeWidth={2} />
        <span className="flex-1 truncate">{t("app.topbar.searchPlaceholder")}</span>
        <span className="font-mono text-[10.5px]">⌘K</span>
      </button>

      <button
        type="button"
        aria-label={t("app.topbar.searchPlaceholder")}
        onClick={() => setOpen(true)}
        className="lg:hidden size-8 shrink-0 inline-flex items-center justify-center rounded-md border border-line bg-surface-2 text-muted hover:border-line-strong"
      >
        <Search className="size-4" strokeWidth={1.8} />
      </button>

      <span className="num hidden xl:block text-[12.5px] text-muted whitespace-nowrap">{weekdayShort(new Date())}</span>

      <div className="hidden lg:flex gap-2">
        <Button onClick={() => navigate("/send?mode=self")}>{t("app.actions.signYourself")}</Button>
        <Button onClick={() => navigate("/templates")}>{t("app.actions.useTemplate")}</Button>
        <Button variant="dark" icon={<Plus className="size-3.5" strokeWidth={2.4} />} onClick={() => navigate("/send")}>
          {t("app.actions.newRequest")}
        </Button>
      </div>

      <Menu
        className="lg:hidden"
        items={[
          { label: t("app.actions.newRequest"), icon: <Plus className="size-4" strokeWidth={1.6} />, onSelect: () => navigate("/send") },
          { label: t("app.actions.signYourself"), icon: <PenLine className="size-4" strokeWidth={1.6} />, onSelect: () => navigate("/send?mode=self") },
          { label: t("app.actions.useTemplate"), icon: <LayoutTemplate className="size-4" strokeWidth={1.6} />, onSelect: () => navigate("/templates") },
          { label: t("app.actions.bulkSend"), icon: <Layers className="size-4" strokeWidth={1.6} />, onSelect: () => navigate("/send?mode=bulk") }
        ]}
        trigger={(p) => (
          <Button variant="dark" aria-label={t("app.actions.new")} className="px-2.5" {...p}>
            <Plus className="size-4" strokeWidth={2} />
          </Button>
        )}
      />

      <CommandPalette />
    </div>
  );
}

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { open, setOpen } = usePalette();
  const extra = useCommands((s) => s.commands);
  const resolvedTheme = useTheme((s) => s.resolved);
  const toggleTheme = useTheme((s) => s.toggle);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const nav = useMemo(
    () => [
      { id: "inbox", label: t("app.nav.inbox"), icon: <Inbox className="size-4" />, run: () => go("/inbox") },
      { id: "documents", label: t("app.nav.documents"), icon: <FileText className="size-4" />, run: () => go("/documents") },
      { id: "templates", label: t("app.nav.templates"), icon: <LayoutTemplate className="size-4" />, run: () => go("/templates") },
      { id: "contacts", label: t("app.nav.contacts"), icon: <Users className="size-4" />, run: () => go("/contacts") },
      { id: "reports", label: t("app.nav.reports"), icon: <BarChart3 className="size-4" />, run: () => go("/reports") },
      { id: "settings", label: t("app.nav.settings"), icon: <Settings className="size-4" />, kbd: ",", run: () => go("/settings") }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("app.palette.label")}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-[620px] max-w-[92vw] bg-surface border border-line rounded-xl shadow-[var(--shadow-pop)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
          <Search className="size-4 text-muted-2" />
          <Command.Input
            autoFocus
            placeholder={t("app.topbar.searchPlaceholder")}
            className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-muted-2"
          />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[50vh] overflow-auto scroll-thin p-2">
          <Command.Empty className="px-3 py-8 text-center text-muted text-[13px]">{t("app.palette.noResults")}</Command.Empty>
          <Command.Group heading={t("app.palette.groupActions")} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:label-mono">
            <Item icon={<Plus className="size-4" />} kbd="N" onSelect={() => go("/send")}>{t("app.actions.newRequest")}</Item>
            <Item icon={<PenLine className="size-4" />} kbd="S" onSelect={() => go("/send?mode=self")}>{t("app.actions.signYourself")}</Item>
            <Item icon={<LayoutTemplate className="size-4" />} kbd="T" onSelect={() => go("/templates")}>{t("app.palette.useATemplate")}</Item>
            <Item icon={<Layers className="size-4" />} onSelect={() => go("/send?mode=bulk")}>{t("app.actions.bulkSend")}</Item>
            <Item
              icon={resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              onSelect={() => {
                setOpen(false);
                toggleTheme();
              }}
            >
              {t("app.palette.toggleDark")}
            </Item>
            {extra.filter((c) => !c.group || c.group === "Actions").map((c) => (
              <Item key={c.id} icon={c.icon} kbd={c.kbd} onSelect={() => { setOpen(false); c.run(); }}>{c.label}</Item>
            ))}
          </Command.Group>
          <Command.Group heading={t("app.palette.groupGoTo")} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:label-mono">
            {nav.map((n) => (
              <Item key={n.id} icon={n.icon} kbd={n.kbd} onSelect={n.run}>{n.label}</Item>
            ))}
          </Command.Group>
          {extra.some((c) => c.group && c.group !== "Actions") ? (
            <Command.Group heading={t("app.palette.groupThisPage")} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:label-mono">
              {extra.filter((c) => c.group && c.group !== "Actions").map((c) => (
                <Item key={c.id} icon={c.icon} kbd={c.kbd} onSelect={() => { setOpen(false); c.run(); }}>{c.label}</Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Item({ children, icon, kbd, onSelect }: { children: React.ReactNode; icon?: React.ReactNode; kbd?: string; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2.5 h-9 px-2 rounded-md text-[13px] cursor-pointer data-[selected=true]:bg-surface-3 data-[selected=true]:text-ink data-[selected=true]:[&>span:first-child]:text-accent"
    >
      <span className="text-muted-2">{icon}</span>
      <span className="flex-1">{children}</span>
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </Command.Item>
  );
}
