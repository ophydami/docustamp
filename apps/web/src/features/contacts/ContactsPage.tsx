import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, MoreHorizontal, Search, Upload, UserPlus } from "lucide-react";
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Input,
  Kbd,
  Menu,
  PageTitle,
  toast
} from "@/components/ui";
import type { AvatarTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { whenShort } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useExtUser } from "@/lib/extUser";
import { useContacts, useContactStats, useDeleteContact } from "./api";
import { ContactFormDialog, ImportDialog } from "./ContactDialogs";
import { ContactPanel } from "./ContactPanel";
import type { Contact, ContactActivity, ContactStats, CompanyGroup, SortKey, ViewKey } from "./types";

// The table tracks only exist from 768px up; below that rows become cards.
const ROWS = "hidden md:grid grid-cols-[24px_1fr_170px_90px_120px_28px] gap-3 items-center px-4";
const COMPANY_ROWS = "hidden md:grid grid-cols-[1fr_90px_110px] gap-3 items-center px-4";

const SORT_KEYS: Record<SortKey, string> = {
  recent: "contacts.sort.recent",
  name: "contacts.sort.name",
  documents: "contacts.sort.documents"
};

const SORT_ORDER = Object.keys(SORT_KEYS) as SortKey[];

const TONES: AvatarTone[] = ["accent", "ink", "neutral"];
function toneFor(seed: string): AvatarTone {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n + seed.charCodeAt(i)) % 997;
  return TONES[n % TONES.length];
}

function companyOf(c: Contact, noCompany: string) {
  if (c.company) return { key: c.company.trim().toLowerCase(), name: c.company.trim(), inferred: false };
  const domain = (c.email.split("@")[1] ?? "").toLowerCase();
  return { key: domain || "unknown", name: domain || noCompany, inferred: true };
}

/** "Signed, 14:02" / "Opened, did not sign · Yesterday" / "Sent, Yesterday" */
function ActivityCell({ activity }: { activity: ContactActivity | null | undefined }) {
  const { t } = useTranslation();
  if (!activity) return <span className="text-faint">{t("contacts.activity.none")}</span>;
  const when = whenShort(activity.at);
  if (activity.kind === "signed")
    return <span className="text-ink-2">{t("contacts.activity.signed", { when })}</span>;
  if (activity.kind === "declined")
    return <span className="text-danger">{t("contacts.activity.declined", { when })}</span>;
  if (activity.kind === "viewed") {
    return activity.stale ? (
      <span className="text-danger">{t("contacts.activity.viewedStale", { when })}</span>
    ) : (
      <span className="text-ink-2">{t("contacts.activity.viewed", { when })}</span>
    );
  }
  return <span className="text-muted">{t("contacts.activity.sent", { when })}</span>;
}

function SkeletonRows({ className }: { className: string }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i}>
          <div className="md:hidden px-4 py-3 flex flex-col gap-2 border-b border-line-soft">
            <span className="h-3 rounded bg-paper animate-pulse" style={{ width: `${45 + ((i * 13) % 35)}%` }} />
            <span className="h-3 w-1/3 rounded bg-paper animate-pulse" />
          </div>
          <div className={cn(className, "h-[52px] border-b border-line-soft last:border-b-0")}>
            <span />
            <span className="h-3 rounded bg-paper animate-pulse" style={{ width: `${45 + ((i * 13) % 35)}%` }} />
            <span className="h-3 rounded bg-paper animate-pulse" />
            <span className="h-3 rounded bg-paper animate-pulse" />
            <span className="h-3 rounded bg-paper animate-pulse" />
            <span />
          </div>
        </div>
      ))}
    </>
  );
}

export default function ContactsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { contactId } = useParams();
  const { data: extUser } = useExtUser();
  const tenantId = extUser?.TenantId?.objectId;

  const contactsQuery = useContacts();
  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const statsQuery = useContactStats(contactsQuery.data);
  const stats = statsQuery.data?.stats;
  const del = useDeleteContact();

  const [view, setView] = useState<ViewKey>("people");
  const [sort, setSort] = useState<SortKey>("recent");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [confirming, setConfirming] = useState<Contact[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* -------------------------------------------------- derived data */

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? contacts.filter((c) =>
          [c.name, c.email, c.company, c.jobTitle].some((v) => v?.toLowerCase().includes(q))
        )
      : contacts;
    const sorted = [...rows];
    if (sort === "name") sorted.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    else if (sort === "documents")
      sorted.sort((a, b) => (stats?.get(b.objectId)?.total ?? 0) - (stats?.get(a.objectId)?.total ?? 0));
    else sorted.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return sorted;
  }, [contacts, query, sort, stats]);

  const noCompany = t("contacts.company.none");

  const companies = useMemo<CompanyGroup[]>(() => {
    const map = new Map<string, CompanyGroup & { docIds: Set<string> }>();
    for (const c of filtered) {
      const { key, name, inferred } = companyOf(c, noCompany);
      let g = map.get(key);
      if (!g) {
        g = { key, name, inferred, people: [], documents: 0, docIds: new Set() };
        map.set(key, g);
      }
      g.people.push(c);
      for (const d of stats?.get(c.objectId)?.docs ?? []) g.docIds.add(d.objectId);
    }
    const list = [...map.values()].map((g) => ({
      key: g.key,
      name: g.name,
      inferred: g.inferred,
      people: g.people,
      documents: g.docIds.size
    }));
    if (sort === "documents") list.sort((a, b) => b.documents - a.documents);
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => b.people.length - a.people.length);
    return list;
  }, [filtered, stats, sort, noCompany]);

  const companyCount = useMemo(
    () => new Set(contacts.map((c) => companyOf(c, noCompany).key)).size,
    [contacts, noCompany]
  );

  const selected = useMemo(
    () => contacts.find((c) => c.objectId === contactId) ?? null,
    [contacts, contactId]
  );

  /* -------------------------------------------------- focus + keys */

  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const open = useCallback(
    (index: number, replace: boolean) => {
      const c = filtered[index];
      if (!c) return;
      setFocus(index);
      navigate(`/contacts/${c.objectId}`, { replace });
      listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
    },
    [filtered, navigate]
  );

  const move = useCallback(
    (delta: number) => {
      if (view !== "people" || !filtered.length) return;
      open(Math.max(0, Math.min(filtered.length - 1, focus + delta)), true);
    },
    [view, filtered.length, focus, open]
  );

  const toggleCheck = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dialogOpen = adding || importing || !!editing || !!confirming;

  useHotkeys(
    {
      j: (e) => {
        if (dialogOpen) return;
        e.preventDefault();
        move(1);
      },
      k: (e) => {
        if (dialogOpen) return;
        e.preventDefault();
        move(-1);
      },
      enter: (e) => {
        if (dialogOpen || view !== "people") return;
        e.preventDefault();
        open(focus, false);
      },
      x: () => {
        if (dialogOpen || view !== "people") return;
        const c = filtered[focus];
        if (c) toggleCheck(c.objectId);
      },
      n: () => {
        if (dialogOpen) return;
        const c = selected ?? filtered[focus];
        if (c) navigate(`/send?to=${encodeURIComponent(c.email)}`);
        else setAdding(true);
      },
      a: () => {
        if (dialogOpen) return;
        setAdding(true);
      },
      escape: () => {
        if (dialogOpen) return;
        if (checked.size) setChecked(new Set());
        else if (contactId) navigate("/contacts", { replace: true });
      }
    },
    [dialogOpen, view, filtered, focus, checked.size, contactId, selected, move, open, toggleCheck, navigate]
  );

  /* -------------------------------------------------- actions */

  async function remove(list: Contact[]) {
    try {
      for (const c of list) await del.mutateAsync(c.objectId);
      toast.success(t("contacts.toast.deleted", { count: list.length }));
      setChecked(new Set());
      if (contactId && list.some((c) => c.objectId === contactId)) navigate("/contacts", { replace: true });
    } catch (err) {
      toast.error(t("contacts.toast.deleteFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(null);
    }
  }

  const allChecked =
    filtered.length > 0 && filtered.every((c) => checked.has(c.objectId))
      ? true
      : checked.size > 0
        ? "mixed"
        : false;

  /* -------------------------------------------------- render */

  const loading = contactsQuery.isLoading;
  const error = contactsQuery.isError ? contactsQuery.error : null;

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col overflow-auto scroll-thin px-4 py-4 lg:px-6 lg:py-[22px] gap-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="flex flex-col gap-1">
            <PageTitle>{t("contacts.title")}</PageTitle>
            <p className="text-[13px] text-muted">
              {t("common.count.person", { count: contacts.length })} ·{" "}
              {t("common.count.company", { count: companyCount })}
            </p>
          </div>
          <div className="sm:ml-auto flex gap-2 flex-wrap">
            <Button icon={<Upload className="size-3.5" strokeWidth={1.6} />} onClick={() => setImporting(true)}>
              {t("contacts.actions.importCsv")}
            </Button>
            <Button
              variant="primary"
              kbd="A"
              icon={<UserPlus className="size-3.5" strokeWidth={1.6} />}
              onClick={() => setAdding(true)}
            >
              {t("contacts.actions.addPerson")}
            </Button>
          </div>
        </header>

        <div className="flex items-center gap-2 flex-wrap">
          <Chip active={view === "people"} onClick={() => setView("people")}>
            {t("contacts.view.people")}
          </Chip>
          <Chip active={view === "companies"} onClick={() => setView("companies")}>
            {t("contacts.view.companies")}
          </Chip>
          <span className="h-4 w-px bg-line mx-1" />
          <Menu
            align="left"
            trigger={(p) => (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium border border-line bg-surface text-ink-2 hover:border-line-strong"
                {...p}
              >
                {t("contacts.sort.trigger", { value: t(SORT_KEYS[sort]) })}
                <ChevronDown className="size-3.5" strokeWidth={1.6} />
              </button>
            )}
            items={SORT_ORDER.map((k) => ({
              label: t(SORT_KEYS[k]),
              onSelect: () => setSort(k)
            }))}
          />
          <div className="ml-auto w-full sm:w-[260px]">
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("contacts.filter.placeholder")}
              left={<Search className="size-3.5" strokeWidth={1.6} />}
              aria-label={t("contacts.filter.label")}
            />
          </div>
        </div>

        {checked.size ? (
          <div className="flex items-center gap-3 h-10 px-4 rounded-lg bg-accent-tint border border-accent-line text-[13px]">
            <span className="font-medium">{t("contacts.selection.count", { count: checked.size })}</span>
            <Button
              size="sm"
              variant="danger"
              className="ml-auto"
              onClick={() => setConfirming(contacts.filter((c) => checked.has(c.objectId)))}
            >
              {t("common.actions.delete")}
            </Button>
            <Button size="sm" onClick={() => setChecked(new Set())}>
              {t("common.actions.clear")}
            </Button>
          </div>
        ) : null}

        <Card className="overflow-hidden">
          {view === "people" ? (
            <>
              <div
                className={cn(
                  ROWS,
                  "h-[34px] bg-surface-2 border-b border-line text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium"
                )}
              >
                <Checkbox
                  checked={allChecked}
                  label={t("contacts.a11y.selectAll")}
                  onChange={(v) =>
                    setChecked(v ? new Set(filtered.map((c) => c.objectId)) : new Set())
                  }
                />
                <span>{t("contacts.table.person")}</span>
                <span>{t("contacts.table.company")}</span>
                <span>{t("contacts.table.documents")}</span>
                <span>{t("contacts.table.lastActivity")}</span>
                <span />
              </div>

              {loading ? (
                <SkeletonRows className={ROWS} />
              ) : error ? (
                <EmptyState
                  title={t("contacts.empty.loadFailedTitle")}
                  body={error instanceof Error ? error.message : t("contacts.empty.loadFailedBody")}
                  action={
                    <Button onClick={() => contactsQuery.refetch()}>{t("common.actions.tryAgain")}</Button>
                  }
                />
              ) : !filtered.length ? (
                <EmptyState
                  title={t(query ? "contacts.empty.noMatchTitle" : "contacts.empty.noContactsTitle")}
                  body={t(query ? "contacts.empty.noMatchBody" : "contacts.empty.noContactsBody")}
                  action={
                    query ? (
                      <Button onClick={() => setQuery("")}>{t("contacts.empty.clearFilter")}</Button>
                    ) : (
                      <Button variant="primary" onClick={() => setAdding(true)}>
                        {t("contacts.actions.addPerson")}
                      </Button>
                    )
                  }
                />
              ) : (
                <div ref={listRef}>
                  {filtered.map((c, i) => (
                    <ContactRow
                      key={c.objectId}
                      contact={c}
                      index={i}
                      stats={stats?.get(c.objectId)}
                      statsLoading={statsQuery.isLoading}
                      focused={i === focus}
                      active={c.objectId === contactId}
                      checked={checked.has(c.objectId)}
                      onCheck={() => toggleCheck(c.objectId)}
                      onOpen={() => open(i, false)}
                      onEdit={() => setEditing(c)}
                      onDelete={() => setConfirming([c])}
                      onSend={() => navigate(`/send?to=${encodeURIComponent(c.email)}`)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div
                className={cn(
                  COMPANY_ROWS,
                  "h-[34px] bg-surface-2 border-b border-line text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium"
                )}
              >
                <span>{t("contacts.table.company")}</span>
                <span>{t("contacts.table.people")}</span>
                <span>{t("contacts.table.documents")}</span>
              </div>
              {loading ? (
                <SkeletonRows className={COMPANY_ROWS} />
              ) : !companies.length ? (
                <EmptyState
                  title={t("contacts.empty.noCompaniesTitle")}
                  body={t("contacts.empty.noCompaniesBody")}
                />
              ) : (
                companies.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => {
                      setView("people");
                      setQuery(g.inferred ? g.name : g.name);
                    }}
                    className={cn(
                      COMPANY_ROWS,
                      "w-full h-[52px] text-left border-b border-line-soft last:border-b-0 hover:bg-surface-2"
                    )}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={g.name} tone={toneFor(g.key)} size={26} />
                      <span className="truncate text-[13px] font-medium">{g.name}</span>
                      {g.inferred ? (
                        <span className="text-[11px] text-faint shrink-0">
                          {t("contacts.company.fromEmail")}
                        </span>
                      ) : null}
                    </span>
                    <span className="num text-[13px] text-ink-2">{g.people.length}</span>
                    <span className="num text-[13px] text-ink-2">{g.documents}</span>
                  </button>
                ))
              )}
              {loading || !companies.length ? null : (
                companies.map((g) => (
                  <button
                    key={`card-${g.key}`}
                    type="button"
                    onClick={() => {
                      setView("people");
                      setQuery(g.name);
                    }}
                    className="md:hidden w-full px-4 py-3 text-left border-b border-line-soft last:border-b-0 flex items-center gap-2.5"
                  >
                    <Avatar name={g.name} tone={toneFor(g.key)} size={26} />
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="truncate text-[13px] font-medium">{g.name}</span>
                      <span className="text-[12px] text-muted-2">
                        {t("common.count.person", { count: g.people.length })} ·{" "}
                        {t("common.count.document", { count: g.documents })}
                      </span>
                    </span>
                    {g.inferred ? (
                      <span className="text-[11px] text-faint shrink-0">
                        {t("contacts.company.fromEmail")}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </>
          )}
        </Card>

        {statsQuery.isError ? (
          <p className="text-[12px] text-danger">{t("contacts.stats.error")}</p>
        ) : statsQuery.data?.capped ? (
          <p className="text-[12px] text-muted-2">{t("contacts.stats.capped", { count: 500 })}</p>
        ) : null}

        <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap text-[11px] text-muted-2 pb-1">
          <span className="flex items-center gap-1.5">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> {t("common.hints.move")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> {t("common.hints.open")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>X</Kbd> {t("common.hints.select")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>N</Kbd> {t("contacts.hints.newRequest")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>A</Kbd> {t("contacts.hints.addPerson")}
          </span>
        </div>
      </div>

      {selected ? (
        <ContactPanel
          contact={selected}
          stats={stats?.get(selected.objectId)}
          onClose={() => navigate("/contacts", { replace: true })}
          onEdit={() => setEditing(selected)}
          onDelete={() => setConfirming([selected])}
        />
      ) : null}

      <ContactFormDialog open={adding} onClose={() => setAdding(false)} tenantId={tenantId} />
      <ContactFormDialog
        open={!!editing}
        contact={editing ?? undefined}
        onClose={() => setEditing(null)}
        tenantId={tenantId}
        onSaved={(newId) => {
          if (newId) navigate(`/contacts/${newId}`, { replace: true });
        }}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} tenantId={tenantId} />

      <Dialog
        open={!!confirming}
        onClose={() => setConfirming(null)}
        width={420}
        title={t("contacts.dialog.deleteTitle", { count: confirming?.length ?? 1 })}
        description={
          confirming && confirming.length === 1
            ? t("contacts.dialog.deleteOneBody", {
                name: confirming[0].name || confirming[0].email
              })
            : t("contacts.dialog.deleteManyBody")
        }
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => confirming && remove(confirming)}
            >
              {t("common.actions.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ContactRow({
  contact,
  index,
  stats,
  statsLoading,
  focused,
  active,
  checked,
  onCheck,
  onOpen,
  onEdit,
  onDelete,
  onSend
}: {
  contact: Contact;
  index: number;
  stats?: ContactStats;
  statsLoading: boolean;
  focused: boolean;
  active: boolean;
  checked: boolean;
  onCheck: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const name = contact.name || contact.email;
  const menu = (
    <Menu
      trigger={(p) => (
        <button
          type="button"
          aria-label={t("contacts.a11y.rowActions", { name })}
          className="text-muted-2 hover:text-ink p-1"
          {...p}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.6} />
        </button>
      )}
      items={[
        { label: t("contacts.actions.sendDocument"), onSelect: onSend },
        { label: t("common.actions.edit"), onSelect: onEdit },
        "separator",
        { label: t("common.actions.delete"), danger: true, onSelect: onDelete }
      ]}
    />
  );

  return (
    <>
      <div
        onClick={onOpen}
        className={cn(
          "md:hidden relative px-4 py-3 border-b border-line-soft last:border-b-0 flex flex-col gap-2 cursor-pointer",
          active ? "bg-accent-tint" : focused ? "bg-surface-2" : ""
        )}
      >
        {focused ? <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" /> : null}
        <div className="flex items-center gap-2.5 min-w-0">
          <Checkbox checked={checked} onChange={onCheck} label={t("contacts.a11y.selectOne", { name })} />
          <Avatar name={contact.name} email={contact.email} tone={toneFor(contact.objectId)} size={28} />
          <button type="button" onClick={onOpen} className="flex flex-col min-w-0 flex-1 text-left">
            <span className="text-[13px] font-medium truncate w-full">{name}</span>
            <span className="text-[12px] text-muted truncate w-full">{contact.email}</span>
          </button>
          <span className="shrink-0">{menu}</span>
        </div>
        <div className="flex items-center gap-2 text-[12px] min-w-0">
          <span className="text-ink-2 truncate">
            {contact.company || t("contacts.company.none")}
          </span>
          <span className="num text-muted-2 ml-auto shrink-0">
            {statsLoading ? "" : t("common.count.document", { count: stats?.total ?? 0 })}
          </span>
        </div>
        <div className="text-[12px] truncate">
          <ActivityCell activity={stats?.activity} />
        </div>
      </div>

      <div
        data-row={index}
        onClick={onOpen}
        className={cn(
          ROWS,
          "h-[52px] border-b border-line-soft last:border-b-0 relative cursor-pointer",
          active ? "bg-accent-tint" : focused ? "bg-surface-2" : "hover:bg-surface-2"
        )}
      >
        {focused ? <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" /> : null}
        <Checkbox checked={checked} onChange={onCheck} label={t("contacts.a11y.selectOne", { name })} />
        <button type="button" onClick={onOpen} className="flex items-center gap-2.5 min-w-0 text-left h-full">
          <Avatar name={contact.name} email={contact.email} tone={toneFor(contact.objectId)} size={28} />
          <span className="flex flex-col min-w-0">
            <span className="text-[13px] font-medium truncate">{name}</span>
            <span className="text-[12px] text-muted truncate">{contact.email}</span>
          </span>
        </button>
        <span className="text-[13px] text-ink-2 truncate">{contact.company}</span>
        <span className="num text-[13px] text-ink-2">
          {statsLoading ? (
            <span className="block h-3 w-5 rounded bg-paper animate-pulse" />
          ) : (
            (stats?.total ?? 0)
          )}
        </span>
        <span className="text-[12px] truncate">
          <ActivityCell activity={stats?.activity} />
        </span>
        {menu}
      </div>
    </>
  );
}
