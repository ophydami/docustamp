import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import {
  Button,
  Cap,
  Card,
  Chip,
  EmptyState,
  Kbd,
  Stat,
  Tabs,
  toast,
  type TabItem
} from "@/components/ui";
import { useAuth } from "@/app/auth";
import { useExtUser } from "@/lib/extUser";
import { cn } from "@/lib/cn";
import { formatDate, num } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { errorMessage, remindError, remindSummary, totalsOf } from "@/lib/reminder";
import { useBadges, useCommands } from "@/lib/store";
import {
  useDocumentDetail,
  useDownload,
  useExtendExpiry,
  useInbox,
  useMe,
  useRecreate,
  useRemind
} from "./api";
import {
  computeKpis,
  expiresPhrase,
  expiringThisWeek,
  findNudge,
  numberWord,
  shortDuration,
  timeOfDay,
  type TimeOfDay
} from "./metrics";
import { DocumentRow, GRID, RECIPIENTS_CELL, RECIPIENTS_HEAD, UPDATED_CELL, type RowActionKind } from "./DocumentRow";
import { Inspector } from "./Inspector";
import { NudgeBanner } from "./NudgeBanner";
import { ShortcutsDialog } from "./ShortcutsDialog";
import type { DocumentRecord, InboxTab } from "./types";

const PAGE_SIZE = 12;
const DAY = 86_400_000;

const TAB_MATCH: Record<InboxTab, (d: DocumentRecord) => boolean> = {
  all: () => true,
  needsYou: (d) => d.needsMe,
  inProgress: (d) => d.status === "waiting",
  completed: (d) => d.isCompleted,
  declined: (d) => d.isDeclined,
  drafts: (d) => d.isDraft
};

function signRoute(doc: DocumentRecord) {
  return doc.myContactId ? `/sign/${doc.id}/${doc.myContactId}` : `/sign-yourself/${doc.id}`;
}

function firstWordUpper(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Which greeting the clock asks for, with and without a name to address. */
const GREETING_KEYS: Record<TimeOfDay, { plain: string; named: string }> = {
  morning: { plain: "inbox.greeting.morning", named: "inbox.greeting.morningNamed" },
  afternoon: { plain: "inbox.greeting.afternoon", named: "inbox.greeting.afternoonNamed" },
  evening: { plain: "inbox.greeting.evening", named: "inbox.greeting.eveningNamed" }
};

/**
 * Wraps a clause for a `<Trans>` component slot. react-i18next only keeps a
 * slot's own children when they are an array of elements, so a bare node would
 * be dropped by `<1/>`.
 */
function clauseSlot(node: ReactNode) {
  return <>{[<Fragment key="clause">{node}</Fragment>]}</>;
}

export default function InboxPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, ready } = useMe();
  const inbox = useInbox(me, ready);
  const setBadges = useBadges((s) => s.setBadges);
  const register = useCommands((s) => s.register);

  const [tab, setTab] = useState<InboxTab>("all");
  const [ownerMine, setOwnerMine] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const remind = useRemind();
  const extend = useExtendExpiry();
  const recreate = useRecreate();
  const download = useDownload();
  // Stable across renders, unlike the mutation objects themselves.
  const remindAsync = remind.mutateAsync;
  const recreateAsync = recreate.mutateAsync;
  const downloadAsync = download.mutateAsync;
  const refetchInbox = inbox.refetch;

  const docs = useMemo(() => inbox.data?.docs ?? [], [inbox.data]);

  const scoped = useMemo(() => {
    const cutoff = Date.now() - 30 * DAY;
    return docs.filter(
      (d) =>
        (!ownerMine || d.isMine) && (!recentOnly || new Date(d.updatedAt).getTime() >= cutoff)
    );
  }, [docs, ownerMine, recentOnly]);

  const rows = useMemo(() => scoped.filter(TAB_MATCH[tab]), [scoped, tab]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  // The selection is derived, so it survives filtering: it falls back to the
  // first row whenever the chosen document leaves the current view.
  const selected = rows.find((d) => d.id === selectedId) ?? rows[0];
  const detail = useDocumentDetail(selected?.id, me);

  const kpis = useMemo(
    () => computeKpis(docs, inbox.data?.truncated.completed ?? false),
    [docs, inbox.data]
  );
  const nudge = useMemo(() => findNudge(docs), [docs]);

  useEffect(() => {
    if (!inbox.data) return;
    setBadges({ inbox: inbox.data.counts.needsYou, expiring: expiringThisWeek(docs) });
  }, [inbox.data, docs, setBadges]);

  const runAction = useCallback(
    async (doc: DocumentRecord, kind: RowActionKind) => {
      if (kind === "sign") {
        navigate(signRoute(doc));
        return;
      }
      if (kind === "open") {
        navigate(`/documents/${doc.id}`);
        return;
      }
      setBusyId(doc.id);
      try {
        if (kind === "remind") {
          const outcome = await remindAsync({ doc });
          const { title, detail } = remindSummary(totalsOf(outcome));
          if (outcome.sent.length) toast.success(title, detail);
          else toast.show(title, detail);
        } else if (kind === "download") {
          await downloadAsync(doc.id);
        } else if (kind === "recreate") {
          const newId = await recreateAsync(doc.id);
          toast.success(t("inbox.toast.recreated"), t("inbox.toast.recreatedBody"));
          navigate(`/documents/${newId}`);
        }
      } catch (err) {
        if (kind === "remind") {
          const { title, detail } = remindError(err);
          toast.error(title, detail);
        } else {
          toast.error(t("inbox.toast.actionFailed"), errorMessage(err));
        }
      } finally {
        setBusyId(null);
      }
    },
    [downloadAsync, navigate, recreateAsync, remindAsync, t]
  );

  const move = useCallback(
    (delta: number) => {
      if (!rows.length) return;
      const index = Math.max(
        0,
        rows.findIndex((d) => d.id === selected?.id)
      );
      const next = Math.min(rows.length - 1, Math.max(0, index + delta));
      setSelectedId(rows[next].id);
      setPage(Math.floor(next / PAGE_SIZE));
    },
    [rows, selected]
  );

  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      x: () => {
        if (!selected) return;
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(selected.id)) next.delete(selected.id);
          else next.add(selected.id);
          return next;
        });
      },
      enter: () => selected && navigate(`/documents/${selected.id}`),
      r: () => selected && void runAction(selected, "remind"),
      "?": () => setShortcuts(true)
    },
    [move, selected, navigate, runAction]
  );

  useEffect(() => {
    if (!selected) return;
    return register([
      {
        id: "inbox-remind",
        label: t("inbox.commands.remind", { name: selected.name }),
        group: t("inbox.commands.group"),
        kbd: "R",
        run: () => void runAction(selected, "remind")
      },
      {
        id: "inbox-open",
        label: t("inbox.commands.open", { name: selected.name }),
        group: t("inbox.commands.group"),
        kbd: "↵",
        run: () => navigate(`/documents/${selected.id}`)
      },
      {
        id: "inbox-refresh",
        label: t("inbox.commands.refresh"),
        group: t("inbox.commands.group"),
        run: () => void refetchInbox()
      }
    ]);
  }, [selected, register, runAction, navigate, refetchInbox, t]);

  const tabs: TabItem<InboxTab>[] = [
    { value: "all", label: t("inbox.tabs.all"), count: scoped.length },
    {
      value: "needsYou",
      label: t("common.status.needsYou"),
      count: scoped.filter(TAB_MATCH.needsYou).length,
      countTone: "accent"
    },
    {
      value: "inProgress",
      label: t("common.status.inProgress"),
      count: scoped.filter(TAB_MATCH.inProgress).length
    },
    {
      value: "completed",
      label: t("common.status.completed"),
      count: scoped.filter(TAB_MATCH.completed).length
    },
    {
      value: "declined",
      label: t("common.status.declined"),
      count: scoped.filter(TAB_MATCH.declined).length
    },
    { value: "drafts", label: t("inbox.tabs.drafts"), count: scoped.filter(TAB_MATCH.drafts).length }
  ];

  const from = rows.length ? currentPage * PAGE_SIZE + 1 : 0;
  const to = currentPage * PAGE_SIZE + visible.length;

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 overflow-y-auto scroll-thin px-4 py-4 lg:px-6 lg:py-[22px] flex flex-col gap-5">
        <Greeting docs={docs} needsYou={kpis.awaiting} loading={inbox.isLoading} />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat
            tone="accent"
            label={t("inbox.kpi.awaiting")}
            value={inbox.isLoading ? "–" : num(kpis.awaiting)}
            note={
              kpis.awaitingOldest ? t("inbox.kpi.oldest", { age: kpis.awaitingOldest }) : undefined
            }
          />
          <Stat
            label={t("inbox.kpi.waiting")}
            value={inbox.isLoading ? "–" : num(kpis.waiting)}
            note={
              kpis.waitingExpiring > 0
                ? t("inbox.kpi.expiringThisWeek", { count: kpis.waitingExpiring })
                : undefined
            }
          />
          <Stat
            label={t("inbox.kpi.completedLabel")}
            value={inbox.isLoading ? "–" : num(kpis.completed30)}
            note={
              kpis.completedDelta === undefined
                ? undefined
                : t("inbox.kpi.completedDelta", {
                    delta: num(kpis.completedDelta, { signDisplay: "always" })
                  })
            }
          />
          <Stat
            label={t("inbox.kpi.medianSign")}
            value={kpis.medianSignMs === undefined ? "–" : shortDuration(kpis.medianSignMs)}
            note={
              kpis.fastestSignMs === undefined
                ? undefined
                : t("inbox.kpi.fastestThisMonth", { duration: shortDuration(kpis.fastestSignMs) })
            }
          />
        </div>

        {nudge ? (
          <NudgeBanner
            doc={nudge}
            reminding={remind.isPending}
            extending={extend.isPending}
            onRemind={() => void runAction(nudge, "remind")}
            onExtend={async () => {
              try {
                const until = await extend.mutateAsync({ doc: nudge, days: 7 });
                toast.success(
                  t("inbox.toast.expiryMoved"),
                  t("inbox.toast.expiryMovedBody", { date: formatDate(until, "d MMM") })
                );
              } catch (err) {
                toast.error(
                  t("inbox.toast.expiryFailed"),
                  err instanceof Error ? err.message : String(err)
                );
              }
            }}
          />
        ) : null}

        <Tabs
          items={tabs}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setPage(0);
          }}
          right={
            <>
              <Chip
                active={ownerMine}
                onClick={() => {
                  setOwnerMine((v) => !v);
                  setPage(0);
                }}
              >
                {ownerMine ? t("inbox.filters.ownerMe") : t("inbox.filters.ownerAnyone")}
              </Chip>
              <Chip
                active={recentOnly}
                onClick={() => {
                  setRecentOnly((v) => !v);
                  setPage(0);
                }}
              >
                {t("inbox.filters.last30Days")}
              </Chip>
            </>
          }
        />

        <Card role="table" className="@container overflow-hidden">
          <div
            role="row"
            className={cn(
              "h-[34px] bg-surface-2 border-b border-line text-[11px] uppercase tracking-[.08em] text-muted-2 font-medium",
              GRID
            )}
          >
            <span />
            <span>{t("inbox.table.document")}</span>
            <span className={RECIPIENTS_HEAD}>{t("inbox.table.recipients")}</span>
            <span>{t("inbox.table.progress")}</span>
            <span className={UPDATED_CELL}>{t("inbox.table.updated")}</span>
            <span className="text-right">{t("inbox.table.action")}</span>
          </div>

          {inbox.isLoading ? (
            <SkeletonRows />
          ) : inbox.isError ? (
            <EmptyState
              title={t("inbox.errors.loadFailed")}
              body={
                inbox.error instanceof Error ? inbox.error.message : t("common.errors.generic")
              }
              action={
                <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void refetchInbox()}>
                  {t("common.actions.tryAgain")}
                </Button>
              }
            />
          ) : visible.length ? (
            visible.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                selected={doc.id === selected?.id}
                checked={checked.has(doc.id)}
                busy={busyId === doc.id}
                onSelect={() => setSelectedId(doc.id)}
                onOpen={() => navigate(`/documents/${doc.id}`)}
                onCheck={() =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(doc.id)) next.delete(doc.id);
                    else next.add(doc.id);
                    return next;
                  })
                }
                onAction={(kind) => void runAction(doc, kind)}
              />
            ))
          ) : (
            <EmptyState
              title={t(tab === "all" ? "inbox.empty.clearTitle" : "inbox.empty.filteredTitle")}
              body={t(tab === "all" ? "inbox.empty.clearBody" : "inbox.empty.filteredBody")}
              action={
                <Button variant="primary" kbd="N" onClick={() => navigate("/send")}>
                  {t("inbox.actions.newRequest")}
                </Button>
              }
            />
          )}
        </Card>

        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap text-[11px] text-muted-2 pb-1">
          <span className="num">
            {t("inbox.pagination.range", {
              from: num(from),
              to: num(to),
              total: num(rows.length)
            })}
          </span>
          {pageCount > 1 ? (
            <span className="flex gap-1">
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("inbox.a11y.previousPage")}
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                icon={<ChevronLeft className="size-3.5" />}
              />
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("inbox.a11y.nextPage")}
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
                icon={<ChevronRight className="size-3.5" />}
              />
            </span>
          ) : null}
          {checked.size > 0 ? (
            <span>{t("inbox.table.rowsSelected", { count: checked.size })}</span>
          ) : null}
          <span className="ml-auto flex items-center gap-x-3 gap-y-1.5 flex-wrap">
            <HintKey keys="J / K">{t("common.hints.move")}</HintKey>
            <HintKey keys="↵">{t("common.hints.open")}</HintKey>
            <HintKey keys="X">{t("common.hints.select")}</HintKey>
            <HintKey keys="R">{t("inbox.hints.remind")}</HintKey>
            <HintKey keys="?">{t("inbox.hints.allShortcuts")}</HintKey>
            {inbox.isFetching ? <Loader2 className="size-3 animate-spin" /> : null}
          </span>
        </div>
      </div>

      {selected ? (
        <Inspector
          doc={selected}
          detail={detail.data}
          detailLoading={detail.isLoading}
          detailError={detail.isError}
          docs={docs}
          reminding={remind.isPending}
          onSign={() => navigate(signRoute(selected))}
          onRemind={() => void runAction(selected, "remind")}
          onOpenDocument={() => navigate(`/documents/${selected.id}`)}
          onDownload={() => void runAction(selected, "download")}
        />
      ) : null}

      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
    </div>
  );
}

function HintKey({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <Kbd>{keys}</Kbd>
      {children}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i}>
          <div className="md:hidden border-b border-line-soft px-4 py-3 flex flex-col gap-2.5">
            <span className="h-3 w-2/3 rounded bg-line-soft" />
            <span className="h-1 w-full rounded-full bg-line-soft" />
            <span className="h-5 w-28 rounded-full bg-line-soft" />
          </div>
          <div className={cn("h-[54px] border-b border-line-soft", GRID)}>
            <span className="size-3.5 rounded bg-line-soft" />
            <span className="h-3 w-2/3 rounded bg-line-soft" />
            <span className={cn(RECIPIENTS_CELL, "h-5 w-16 rounded-full bg-line-soft")} />
            <span className="h-3 w-24 rounded bg-line-soft" />
            <span className={cn(UPDATED_CELL, "h-3 w-10 rounded bg-line-soft")} />
            <span className="h-6 w-14 rounded-md bg-line-soft justify-self-end" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Date line plus one sentence built from whatever actually needs attention. */
function Greeting({
  docs,
  needsYou,
  loading
}: {
  docs: DocumentRecord[];
  needsYou: number;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const name = useFirstName();
  const soon = useMemo(() => {
    const now = Date.now();
    return docs
      .filter((d) => !d.isCompleted && !d.isDeclined && !d.isDraft && d.expiryDate)
      .filter((d) => {
        const left = new Date(d.expiryDate as string).getTime() - now;
        return left > 0 && left <= 7 * DAY;
      })
      .sort((a, b) => (a.expiryDate as string).localeCompare(b.expiryDate as string))
      .at(0);
  }, [docs]);

  const clauses: ReactNode[] = [];
  if (needsYou > 0) {
    clauses.push(
      <Trans
        key="needs"
        i18nKey="inbox.greeting.needsSignature"
        count={needsYou}
        values={{ words: firstWordUpper(numberWord(needsYou)) }}
        components={{ 1: <span className="text-accent" /> }}
      />
    );
  }
  if (soon) {
    clauses.push(
      <Fragment key="expiry">
        {t("inbox.greeting.expires", {
          name: soon.name,
          phrase: expiresPhrase(soon.expiryDate as string)
        })}
      </Fragment>
    );
  }

  const greeting = GREETING_KEYS[timeOfDay()];

  return (
    <div className="flex flex-col gap-1.5">
      <Cap>{formatDate(new Date(), "EEEE, d MMMM")}</Cap>
      <h1 className="font-serif text-[22px] md:text-[28px] leading-tight font-medium max-w-3xl">
        {name ? t(greeting.named, { name }) : t(greeting.plain)}{" "}
        {loading ? (
          <span className="text-muted-2">{t("inbox.greeting.counting")}</span>
        ) : clauses.length === 0 ? (
          t("inbox.greeting.nothing")
        ) : clauses.length === 1 ? (
          <Trans i18nKey="inbox.greeting.single" components={{ 1: clauseSlot(clauses[0]) }} />
        ) : (
          <Trans
            i18nKey="inbox.greeting.join"
            components={{ 1: clauseSlot(clauses[0]), 2: clauseSlot(clauses[1]) }}
          />
        )}
      </h1>
    </div>
  );
}

/** Preferred display name: the profile row, then the account, then the address. */
function useFirstName() {
  const { user } = useAuth();
  const ext = useExtUser();
  const full = ext.data?.Name ?? user?.name ?? user?.email ?? "";
  const word = full.replace(/@.*/, "").split(/[\s._-]+/)[0] ?? "";
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "";
}
