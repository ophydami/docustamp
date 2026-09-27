import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  FolderTree,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Upload
} from "lucide-react";
import {
  AvatarStack,
  Button,
  Cap,
  Card,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Input,
  Kbd,
  Menu,
  Pill,
  toast
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useAuth } from "@/app/auth";
import { useHotkeys } from "@/lib/hotkeys";
import { useCommands } from "@/lib/store";
import { num, untilShort, whenShort } from "@/lib/format";
import {
  documentsToCsv,
  downloadCsv,
  useBucketCounts,
  useDocuments,
  useDrive,
  useMoveDocuments,
  useTemplateOptions
} from "./api";
import { FolderRail, folderPath } from "./FolderRail";
import { tristate, useDocumentActions } from "./actions";
import type { DateFilter, DocFilter, Document, DocumentQuery, OwnerFilter, SavedView } from "./types";

const PER_PAGE = 25;
const COLUMN_STORAGE_KEY = "sign.documents.columns";
const RAIL_STORAGE_KEY = "sign.documents.rail";

interface ColumnDef {
  id: string;
  labelKey: string;
  width: string;
  fixed?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { id: "recipients", labelKey: "documents.table.recipients", width: "130px" },
  { id: "status", labelKey: "documents.table.status", width: "160px", fixed: true },
  { id: "owner", labelKey: "documents.table.owner", width: "110px" },
  { id: "folder", labelKey: "documents.table.folder", width: "120px" },
  { id: "updated", labelKey: "documents.table.updated", width: "90px" },
  { id: "expires", labelKey: "documents.table.expires", width: "80px" },
  { id: "created", labelKey: "documents.table.created", width: "90px" },
  { id: "template", labelKey: "documents.table.template", width: "120px" }
];

/** The name column never goes below this; everything else is px, so it is what kept vanishing. */
const NAME_MIN = 200;
/** Checkbox + menu tracks, the row's horizontal padding and the Card's 1px borders. */
const ROW_CHROME = 24 + 28 + 24 + 2;
const GAP = 12;
/** Optional columns give way in this order when the table is too narrow for the user's pick. */
const DROP_ORDER = ["template", "created", "folder", "owner", "expires", "updated", "recipients"];

/**
 * Trim the user's chosen columns to the ones that fit the measured table width, keeping
 * NAME_MIN for the document name. Fixed columns always stay. Infinity (unmeasured) keeps all.
 */
function fitColumns(columns: ColumnDef[], width: number): ColumnDef[] {
  const needed = (cols: ColumnDef[]) =>
    ROW_CHROME + NAME_MIN + cols.reduce((sum, c) => sum + parseInt(c.width, 10), 0) + GAP * (cols.length + 2);
  let cols = columns;
  for (const id of DROP_ORDER) {
    if (needed(cols) <= width) break;
    const victim = cols.find((c) => c.id === id && !c.fixed);
    if (victim) cols = cols.filter((c) => c !== victim);
  }
  return cols;
}

/** Width of an element, tracked through resizes. Infinity until first measured so nothing flashes away. */
function useContentWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const DEFAULT_COLUMNS = ["recipients", "status", "owner", "folder", "updated", "expires"];

const FILTERS: Array<{ id: DocFilter; labelKey: string; dot?: string }> = [
  { id: "all", labelKey: "documents.filters.all" },
  { id: "needs_you", labelKey: "documents.filters.needsYou", dot: "var(--color-accent)" },
  { id: "in_progress", labelKey: "common.status.inProgress", dot: "var(--color-warn)" },
  { id: "completed", labelKey: "common.status.completed", dot: "var(--color-success)" },
  { id: "declined", labelKey: "common.status.declined", dot: "var(--color-danger)" },
  { id: "expired", labelKey: "common.status.expired", dot: "var(--color-danger-2)" },
  { id: "draft", labelKey: "documents.filters.drafts", dot: "var(--color-faint)" }
];

const DATE_KEYS: Record<DateFilter, string> = {
  any: "documents.filters.anyDate",
  "7": "documents.filters.last7",
  "30": "documents.filters.last30",
  "90": "documents.filters.last90"
};

const VIEW_KEYS: Record<SavedView, string> = {
  "waiting-on-me": "documents.filters.waitingOnMe",
  expiring: "documents.filters.expiringThisWeek",
  "sent-by-me": "documents.filters.sentByMe"
};

function readColumns(): string[] {
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
  } catch {
    // ignore unreadable preferences
  }
  return DEFAULT_COLUMNS;
}

function readRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

function statusPill(doc: Document) {
  if (doc.status === "completed") return { tone: "success" as const, labelKey: "common.status.completed" };
  if (doc.status === "declined") return { tone: "danger" as const, labelKey: "common.status.declined" };
  if (doc.status === "expired") return { tone: "danger" as const, labelKey: "common.status.expired" };
  if (doc.status === "draft") return { tone: "neutral" as const, labelKey: "common.status.draft" };
  if (doc.needsYou) return { tone: "accent" as const, labelKey: "documents.filters.needsYou" };
  return { tone: "warn" as const, labelKey: "common.status.inProgress" };
}

function expiresSoon(doc: Document) {
  if (!doc.expiryDate || doc.status !== "in_progress") return false;
  const ms = new Date(doc.expiryDate).getTime() - Date.now();
  return ms > 0 && ms < 24 * 3600_000;
}

export default function DocumentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const me = useMemo(() => ({ userId: user?.id, email: user?.email }), [user?.id, user?.email]);

  const view = (params.get("view") as SavedView | null) ?? undefined;
  const statusParam = params.get("status") as DocFilter | null;
  const folderId = params.get("folder") ?? undefined;
  const owner = (params.get("owner") as OwnerFilter | null) ?? (view === "sent-by-me" ? "me" : "anyone");
  const date = (params.get("date") as DateFilter | null) ?? "any";
  const templateId = params.get("template") ?? undefined;
  const search = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);

  // Saved views seed the status chip; an explicit ?status= always wins.
  const filter: DocFilter = statusParam ?? (view === "waiting-on-me" ? "needs_you" : view === "expiring" ? "in_progress" : "all");

  const query: DocumentQuery = useMemo(
    () => ({ filter, owner, date, templateId, folderId, search, view, page, perPage: PER_PAGE }),
    [filter, owner, date, templateId, folderId, search, view, page]
  );

  const setParam = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!("page" in patch)) next.delete("page");
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const list = useDocuments(query, me);
  const counts = useBucketCounts(me, query);
  const drive = useDrive(me);
  const templates = useTemplateOptions();
  const moveDocs = useMoveDocuments();
  const folders = useMemo(() => drive.data?.folders ?? [], [drive.data]);
  const crumbs = useMemo(() => folderPath(folders, folderId), [folders, folderId]);

  const documents = useMemo(() => list.data?.documents ?? [], [list.data]);
  const total = list.data?.total ?? 0;

  // List rows carry TemplateId as a bare pointer (contracts_Template is not
  // findable by clients), so names come from the same report the filter uses.
  const templateNames = useMemo(
    () => new Map((templates.data ?? []).map((t) => [t.objectId, t.name])),
    [templates.data]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(readColumns);
  const [searchDraft, setSearchDraft] = useState(search);
  const [railOpen, setRailOpen] = useState(readRailOpen);
  const [folderSheet, setFolderSheet] = useState(false);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => setSearchDraft(search), [search]);
  useEffect(() => {
    setSelected(new Set());
    setCursor(0);
    setAnchor(null);
  }, [filter, owner, date, templateId, folderId, search, view, page]);

  useEffect(() => {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  useEffect(() => {
    localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "open" : "closed");
  }, [railOpen]);

  const actions = useDocumentActions({
    onRemoved: (ids) => setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))))
  });
  // Latest actions, so the hotkey listener does not have to rebind every render.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  const selectedDocs = useMemo(() => documents.filter((d) => selected.has(d.objectId)), [documents, selected]);

  const [tableRef, tableWidth] = useContentWidth<HTMLDivElement>();
  const picked = COLUMNS.filter((c) => c.fixed || visibleColumns.includes(c.id));
  // Narrow viewports drop the least important optional columns rather than crushing the name.
  const shown = fitColumns(picked, tableWidth);
  const gridTemplate = `24px minmax(${NAME_MIN}px,1fr) ${shown.map((c) => c.width).join(" ")} 28px`;

  const openDoc = useCallback(
    (doc: Document | undefined) => {
      if (doc) navigate(`/documents/${doc.objectId}`);
    },
    [navigate]
  );

  const toggleOne = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Only keyboard movement scrolls; hovering a row just moves the cursor.
  const keyboardMove = useRef(false);
  const moveCursor = useCallback(
    (delta: number) => {
      keyboardMove.current = true;
      setCursor((c) => Math.min(documents.length - 1, Math.max(0, c + delta)));
    },
    [documents.length]
  );

  useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  useHotkeys(
    {
      j: (e) => {
        e.preventDefault();
        moveCursor(1);
      },
      k: (e) => {
        e.preventDefault();
        moveCursor(-1);
      },
      // Shift+X shares this handler: useHotkeys resolves a shifted letter to the
      // plain key first, so the range branch has to live here.
      x: (e) => {
        e.preventDefault();
        const doc = documents[cursor];
        if (!doc) return;
        if (e.shiftKey && anchor !== null) {
          const [from, to] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
          setSelected((s) => {
            const next = new Set(s);
            for (let i = from; i <= to; i++) {
              const d = documents[i];
              if (d) next.add(d.objectId);
            }
            return next;
          });
          return;
        }
        toggleOne(doc.objectId);
        setAnchor(cursor);
      },
      enter: (e) => {
        e.preventDefault();
        openDoc(documents[cursor]);
      },
      r: (e) => {
        e.preventDefault();
        const targets = selectedDocs.length ? selectedDocs : documents[cursor] ? [documents[cursor]] : [];
        actionsRef.current.remind(targets);
      },
      u: (e) => {
        e.preventDefault();
        navigate("/send");
      },
      escape: () => {
        setSelected(new Set());
        setAnchor(null);
      },
      "mod+a": (e) => {
        e.preventDefault();
        setSelected(new Set(documents.map((d) => d.objectId)));
      }
    },
    [documents, cursor, anchor, selectedDocs, moveCursor, openDoc, toggleOne, navigate]
  );

  const register = useCommands((s) => s.register);
  useEffect(
    () =>
      register([
        {
          id: "documents.upload",
          label: t("documents.actions.uploadDocument"),
          group: t("documents.title"),
          run: () => navigate("/send")
        },
        {
          id: "documents.needsyou",
          label: t("documents.commands.needsYou"),
          group: t("documents.title"),
          run: () => navigate("/documents?status=needs_you")
        }
      ]),
    [register, navigate, t]
  );

  const folderName = folderId
    ? folders.find((f) => f.objectId === folderId)?.name ?? t("documents.list.thisFolder")
    : t("documents.list.allDocuments");

  /** Drop selected rows on a folder in the rail. */
  const dropOnFolder = useCallback(
    (target: string | null, ids: string[]) => {
      setDragIds([]);
      if (!ids.length || target === (folderId ?? null)) return;
      moveDocs.mutate(
        { ids, folderId: target },
        {
          onSuccess: () => {
            toast.success(
              t("documents.toast.moved", { count: ids.length }),
              target
                ? folders.find((f) => f.objectId === target)?.name
                : t("documents.toast.movedOutOfFolders")
            );
            setSelected(new Set());
          },
          onError: (e: Error) => toast.error(t("documents.toast.moveFailed"), e.message)
        }
      );
    },
    [folderId, folders, moveDocs, t]
  );

  const exportCsv = () => {
    if (!documents.length) {
      toast.show(t("documents.toast.nothingToExport"), t("documents.toast.nothingToExportBody"));
      return;
    }
    downloadCsv(`documents-${filter}-${new Date().toISOString().slice(0, 10)}.csv`, documentsToCsv(documents));
    toast.success(t("documents.toast.csvExported"), t("documents.toast.csvRows", { count: documents.length }));
  };

  const from = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  const selectFolder = (id: string | undefined) => setParam({ folder: id });

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Folder rail. Below lg it collapses into the "Folders" chip in the filter row. */}
      {railOpen ? (
        <div className="hidden lg:flex w-[200px] shrink-0 bg-ground border-r border-line flex-col min-h-0">
          <FolderRail
            folderId={folderId}
            onSelect={selectFolder}
            onDropDocuments={dropOnFolder}
            draggingIds={dragIds}
          />
          <button
            type="button"
            onClick={() => setRailOpen(false)}
            className="h-8 shrink-0 border-t border-line text-[12px] text-muted-2 hover:text-ink flex items-center justify-center gap-1.5"
          >
            <PanelLeftClose className="size-3.5" strokeWidth={1.6} />
            {t("documents.rail.hide")}
          </button>
        </div>
      ) : null}

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="px-4 md:px-6 pt-5 pb-3 flex items-start gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-[13px] text-muted pt-1.5">
            {list.isLoading
              ? t("common.state.loading")
              : t("documents.list.summary", { count: total, folder: folderName })}
            {view ? ` · ${t(VIEW_KEYS[view])}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setParam({ q: searchDraft.trim() || undefined });
              if (e.key === "Escape") {
                setSearchDraft("");
                setParam({ q: undefined });
              }
            }}
            placeholder={t("documents.search.placeholder")}
            left={<Search className="size-3.5" strokeWidth={1.6} />}
            className="w-40 sm:w-56"
          />
          <Button icon={<Download className="size-3.5" strokeWidth={1.6} />} onClick={exportCsv}>
            <span className="hidden sm:inline">{t("documents.actions.exportCsv")}</span>
            <span className="sm:hidden">{t("documents.actions.exportCsvShort")}</span>
          </Button>
          <Button
            variant="primary"
            icon={<Upload className="size-3.5" strokeWidth={1.6} />}
            kbd="U"
            onClick={() => navigate(folderId ? `/send?folder=${folderId}` : "/send")}
          >
            {t("common.actions.upload")}
          </Button>
        </div>
      </div>

      {crumbs.length ? (
        <nav
          aria-label={t("documents.a11y.breadcrumb")}
          className="px-4 md:px-6 pb-2 flex items-center gap-1.5 text-[13px] min-w-0 flex-wrap"
        >
          <button type="button" onClick={() => selectFolder(undefined)} className="text-muted-2 hover:text-ink">
            {t("documents.folders.allDocuments")}
          </button>
          {crumbs.map((f, i) => (
            <span key={f.objectId} className="flex items-center gap-1.5 min-w-0">
              <span className="text-muted-2">/</span>
              {i === crumbs.length - 1 ? (
                <span className="text-ink font-medium truncate max-w-[16rem]">{f.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => selectFolder(f.objectId)}
                  className="text-muted-2 hover:text-ink truncate max-w-[12rem]"
                >
                  {f.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="px-4 md:px-6 pb-3 flex items-center gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <Chip
            key={f.id}
            dot={f.dot}
            active={filter === f.id}
            onClick={() => setParam({ status: f.id === "all" ? undefined : f.id, view: undefined })}
          >
            {t(f.labelKey)}
            <span className={cn("num ml-1", filter === f.id ? "text-ink-2" : "text-muted")}>
              {counts.data ? num(counts.data[f.id]) : "-"}
            </span>
          </Chip>
        ))}

        <span className="w-px h-5 bg-line mx-1.5" />

        <FilterMenu
          label={owner === "me" ? t("documents.filters.ownerMe") : t("documents.filters.ownerAnyone")}
          items={[
            { label: t("documents.filters.anyone"), onSelect: () => setParam({ owner: undefined }) },
            { label: t("documents.filters.me"), onSelect: () => setParam({ owner: "me" }) }
          ]}
        />
        <FilterMenu
          label={t(DATE_KEYS[date])}
          items={(Object.keys(DATE_KEYS) as DateFilter[]).map((d) => ({
            label: t(DATE_KEYS[d]),
            onSelect: () => setParam({ date: d === "any" ? undefined : d })
          }))}
        />
        {templates.data && templates.data.length > 0 ? (
          <FilterMenu
            label={
              templateId
                ? templates.data.find((tpl) => tpl.objectId === templateId)?.name ?? t("documents.filters.template")
                : t("documents.filters.anyTemplate")
            }
            items={[
              { label: t("documents.filters.anyTemplate"), onSelect: () => setParam({ template: undefined }) },
              ...templates.data.map((tpl) => ({
                label: tpl.name,
                onSelect: () => setParam({ template: tpl.objectId })
              }))
            ]}
          />
        ) : null}
        {/* Below lg the rail is gone, so the tree moves into a sheet. */}
        <button
          type="button"
          onClick={() => setFolderSheet(true)}
          className="lg:hidden inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium border border-line bg-surface text-ink-2 hover:border-line-strong max-w-48"
        >
          <FolderTree className="size-3.5 shrink-0" strokeWidth={1.6} />
          <span className="truncate">{folderId ? folderName : t("documents.folders.title")}</span>
          <ChevronDown className="size-3.5 shrink-0" strokeWidth={1.6} />
        </button>
        {!railOpen ? (
          <Button
            size="sm"
            className="max-lg:hidden"
            icon={<FolderTree className="size-3.5" strokeWidth={1.6} />}
            onClick={() => setRailOpen(true)}
          >
            {t("documents.rail.show")}
          </Button>
        ) : null}
        <Button
          size="sm"
          icon={<Columns3 className="size-3.5" strokeWidth={1.6} />}
          onClick={() => setColumnsOpen(true)}
          className="max-md:hidden"
        >
          {t("documents.columns.title")}
        </Button>
      </div>

      {selected.size > 0 ? (
        <div className="mx-4 md:mx-6 mb-2 min-h-11 rounded-md bg-ink text-ground flex items-center gap-2 px-3 py-1 flex-wrap">
          <span className="text-[13px] font-semibold num">{t("common.hints.selected", { count: selected.size })}</span>
          <span className="w-px h-5 bg-ground/20 mx-1" />
          <BulkButton kbd="R" onClick={() => actions.remind(selectedDocs)}>
            {t("common.actions.remind")}
          </BulkButton>
          <BulkButton
            onClick={() => {
              if (selectedDocs.length > 5) {
                toast.show(t("documents.toast.tooManyDownloads"), t("documents.toast.tooManyDownloadsBody"));
                return;
              }
              selectedDocs.forEach((d) => actions.download(d, "signed"));
            }}
          >
            {t("common.actions.download")}
          </BulkButton>
          <BulkButton onClick={() => actions.askMove(selectedDocs)}>{t("documents.actions.moveToFolder")}</BulkButton>
          <BulkButton
            danger
            onClick={() => actions.askVoid(selectedDocs.filter((d) => d.status === "in_progress" || d.status === "expired"))}
          >
            {t("documents.actions.void")}
          </BulkButton>
          <BulkButton danger onClick={() => actions.askDelete(selectedDocs)}>
            {t("common.actions.delete")}
          </BulkButton>
          <button
            type="button"
            className="ml-auto text-[12px] text-ground/60 hover:text-ground flex items-center gap-1.5"
            onClick={() => setSelected(new Set())}
          >
            <Kbd className="border-ground/25 bg-transparent text-ground/70">Esc</Kbd>
            {t("documents.hints.toClear")}
          </button>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-4 md:px-6 pb-6">
        {/* Measured for column fitting; sized like the Card itself so the math matches the row. */}
        <div ref={tableRef} aria-hidden className="h-0 overflow-hidden" />
        {list.isLoading ? (
          <Card className="overflow-hidden">
            <SkeletonRows template={gridTemplate} columns={shown.length} />
          </Card>
        ) : list.isError ? (
          <Card className="overflow-hidden">
            <EmptyState
              title={t("documents.empty.errorTitle")}
              body={(list.error as Error)?.message ?? t("documents.errors.serverSilent")}
              action={<Button onClick={() => list.refetch()}>{t("common.actions.tryAgain")}</Button>}
            />
          </Card>
        ) : documents.length === 0 ? (
          <Card className="overflow-hidden">
            <EmptyState
              title={
                search
                  ? t("documents.empty.noMatchTitle", { query: search })
                  : folderId
                    ? t("documents.empty.folderTitle")
                    : t("documents.empty.title")
              }
              body={search ? t("documents.empty.noMatchBody") : t("documents.empty.body")}
              action={
                search ? (
                  <Button onClick={() => setParam({ q: undefined })}>{t("documents.empty.clearSearch")}</Button>
                ) : (
                  <Button
                    variant="primary"
                    icon={<Upload className="size-3.5" strokeWidth={1.6} />}
                    onClick={() => navigate(folderId ? `/send?folder=${folderId}` : "/send")}
                  >
                    {t("documents.actions.uploadDocument")}
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <>
            {/* Table, 768 and up. */}
            <Card className="overflow-hidden hidden md:block">
              <div
                className="h-[34px] grid items-center gap-3 px-3 bg-surface-2 border-b border-line"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <Checkbox
                  checked={tristate(selected.size, documents.length)}
                  label={t("documents.a11y.selectAllOnPage")}
                  onChange={(v) => setSelected(v ? new Set(documents.map((d) => d.objectId)) : new Set())}
                />
                <Cap>{t("documents.table.document")}</Cap>
                {shown.map((c) => (
                  <Cap key={c.id}>{t(c.labelKey)}</Cap>
                ))}
                <span />
              </div>
              {documents.map((doc, i) => (
                <Row
                  key={doc.objectId}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  doc={doc}
                  columns={shown}
                  template={gridTemplate}
                  selected={selected.has(doc.objectId)}
                  active={cursor === i}
                  onToggle={() => {
                    toggleOne(doc.objectId);
                    setAnchor(i);
                  }}
                  onOpen={() => openDoc(doc)}
                  onFocusRow={() => setCursor(i)}
                  onDragStart={() => setDragIds(selected.has(doc.objectId) ? [...selected] : [doc.objectId])}
                  onDragEnd={() => setDragIds([])}
                  templateName={doc.templateName ?? (doc.templateId ? templateNames.get(doc.templateId) : undefined)}
                  menuItems={actions.menuItems(doc)}
                />
              ))}
            </Card>

            {/* Stacked cards, below 768. */}
            <div className="md:hidden flex flex-col gap-2">
              {documents.map((doc) => (
                <DocumentCard
                  key={doc.objectId}
                  doc={doc}
                  selected={selected.has(doc.objectId)}
                  onToggle={() => toggleOne(doc.objectId)}
                  onOpen={() => openDoc(doc)}
                  menuItems={actions.menuItems(doc)}
                />
              ))}
            </div>
          </>
        )}

        <div className="mt-3 flex items-center gap-3 text-[12px] text-muted-2 flex-wrap">
          <span className="num">
            {t("documents.pager.range", { from: num(from), to: num(to), total: num(total) })}
          </span>
          <Button
            size="sm"
            disabled={page <= 1}
            icon={<ChevronLeft className="size-3.5" strokeWidth={1.6} />}
            onClick={() => setParam({ page: String(page - 1) })}
          >
            {t("documents.pager.prev")}
          </Button>
          <Button
            size="sm"
            disabled={to >= total}
            iconRight={<ChevronRight className="size-3.5" strokeWidth={1.6} />}
            onClick={() => setParam({ page: String(page + 1) })}
          >
            {t("common.actions.next")}
          </Button>
          {list.isFetching && !list.isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          <span className="ml-auto hidden lg:flex items-center gap-2">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> {t("common.hints.move")}
            <Kbd>X</Kbd> {t("common.hints.select")}
            <Kbd>⇧X</Kbd> {t("documents.hints.range")}
            <Kbd>↵</Kbd> {t("common.hints.open")}
            <Kbd>R</Kbd> {t("documents.hints.remind")}
            <span className="text-faint">{t("documents.hints.drag")}</span>
          </span>
        </div>
      </div>

      <Dialog
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        title={t("documents.columns.title")}
        description={t("documents.columns.description")}
        width={420}
        footer={
          <>
            <Button onClick={() => setVisibleColumns(DEFAULT_COLUMNS)}>{t("common.actions.reset")}</Button>
            <Button variant="primary" onClick={() => setColumnsOpen(false)}>
              {t("common.actions.done")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          {COLUMNS.map((c) => (
            <label key={c.id} className="flex items-center gap-2.5 text-[13px]">
              <Checkbox
                checked={c.fixed || visibleColumns.includes(c.id)}
                disabled={c.fixed}
                label={t(c.labelKey)}
                onChange={(v) =>
                  setVisibleColumns((cols) => (v ? [...cols, c.id] : cols.filter((id) => id !== c.id)))
                }
              />
              <span className={cn(c.fixed && "text-muted-2")}>
                {c.fixed ? t("documents.columns.labelFixed", { label: t(c.labelKey) }) : t(c.labelKey)}
              </span>
            </label>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={folderSheet}
        onClose={() => setFolderSheet(false)}
        title={t("documents.folders.title")}
        description={t("documents.folders.sheetDescription")}
        width={420}
        footer={<Button onClick={() => setFolderSheet(false)}>{t("common.actions.done")}</Button>}
        className="max-h-[80vh]"
      >
        <div className="-mx-3 max-h-[52vh]">
          <FolderRail
            folderId={folderId}
            onSelect={(id) => {
              selectFolder(id);
              setFolderSheet(false);
            }}
          />
        </div>
      </Dialog>

      {actions.dialogs}
      </div>
    </div>
  );
}

function FilterMenu({
  label,
  items
}: {
  label: string;
  items: Array<{ label: React.ReactNode; onSelect: () => void }>;
}) {
  return (
    <Menu
      align="left"
      items={items}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium border border-line bg-surface text-ink-2 hover:border-line-strong max-w-48"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0" strokeWidth={1.6} />
        </button>
      )}
    />
  );
}

function BulkButton({
  children,
  onClick,
  kbd,
  danger
}: {
  children: React.ReactNode;
  onClick: () => void;
  kbd?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 px-2.5 rounded-md text-[12px] font-semibold inline-flex items-center gap-1.5 hover:bg-ground/10",
        danger ? "text-danger-on-ink" : "text-ground"
      )}
    >
      {children}
      {kbd ? <Kbd className="border-ground/25 bg-transparent text-ground/70">{kbd}</Kbd> : null}
    </button>
  );
}

function SkeletonRows({ template, columns }: { template: string; columns: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[46px] grid items-center gap-3 px-3 border-b border-line-soft last:border-0"
          style={{ gridTemplateColumns: template }}
        >
          <span />
          <span className="h-3 rounded bg-line-soft animate-pulse" style={{ width: `${50 + ((i * 13) % 40)}%` }} />
          {Array.from({ length: columns }).map((__, j) => (
            <span key={j} className="h-3 rounded bg-line-soft animate-pulse" />
          ))}
          <span />
        </div>
      ))}
    </>
  );
}

interface RowProps {
  doc: Document;
  columns: ColumnDef[];
  template: string;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onFocusRow: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Resolved separately: list rows only carry the template pointer. */
  templateName?: string;
  menuItems: ReturnType<ReturnType<typeof useDocumentActions>["menuItems"]>;
}

function Row({
  doc,
  columns,
  template,
  selected,
  active,
  onToggle,
  onOpen,
  onFocusRow,
  onDragStart,
  onDragEnd,
  templateName,
  menuItems,
  ref
}: RowProps & { ref?: React.Ref<HTMLDivElement> }) {
  const { t } = useTranslation();
  const signed = doc.recipients.filter((r) => r.state === "signed").length;
  const pill = statusPill(doc);
  const soon = expiresSoon(doc);

  const cell = (id: string) => {
    switch (id) {
      case "recipients":
        return doc.recipients.length ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <AvatarStack people={doc.recipients.map((r) => ({ name: r.name, email: r.email }))} size={20} max={3} />
          </span>
        ) : (
          <span className="text-muted-2">{t("common.state.none")}</span>
        );
      case "status":
        return (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={pill.tone} dot>
              {t(pill.labelKey)}
            </Pill>
            {doc.recipients.length > 0 && doc.status !== "draft" ? (
              <span className="num text-[11px] text-muted-2">
                {t("documents.table.signedRatio", { signed: num(signed), total: num(doc.recipients.length) })}
              </span>
            ) : null}
          </span>
        );
      case "owner":
        return <span className="truncate text-muted">{doc.ownerName || doc.ownerEmail || "-"}</span>;
      case "folder":
        return <span className="truncate text-muted">{doc.folderName ?? t("documents.folders.driveRoot")}</span>;
      case "updated":
        return <span className="num text-muted">{whenShort(doc.updatedAt)}</span>;
      case "expires":
        return doc.expiryDate ? (
          <span className={cn("num", soon ? "text-danger font-semibold" : "text-muted")}>{untilShort(doc.expiryDate)}</span>
        ) : (
          <span className="text-muted-2">-</span>
        );
      case "created":
        return <span className="num text-muted">{whenShort(doc.createdAt)}</span>;
      case "template":
        return <span className="truncate text-muted">{templateName ?? "-"}</span>;
      default:
        return null;
    }
  };

  return (
    <div
      ref={ref}
      onMouseEnter={onFocusRow}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox will not start a drag without payload.
        e.dataTransfer.setData("text/plain", doc.objectId);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "h-[46px] grid items-center gap-3 px-3 border-b border-line-soft last:border-0 text-[13px]",
        active && "bg-accent-tint",
        selected && "bg-accent-soft"
      )}
      style={{ gridTemplateColumns: template }}
    >
      <Checkbox checked={selected} onChange={onToggle} label={t("documents.a11y.selectRow", { name: doc.name })} />
      <button type="button" onClick={onOpen} className="text-left min-w-0 focus-visible:outline-offset-4">
        <div className="font-semibold truncate">{doc.name}</div>
        <div className="font-mono text-[10px] text-muted-2 truncate">
          {doc.objectId}
          {doc.pageCount
            ? ` · ${t("common.count.page", { count: doc.pageCount })}`
            : ` · ${t("common.count.field", { count: doc.fields.length })}`}
        </div>
      </button>
      {columns.map((c) => (
        <div key={c.id} className="min-w-0 truncate">
          {cell(c.id)}
        </div>
      ))}
      <Menu
        items={menuItems}
        trigger={(p) => (
          <button
            type="button"
            {...p}
            aria-label={t("documents.a11y.rowActions", { name: doc.name })}
            className="text-muted-2 hover:text-ink p-1 -mr-1"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.6} />
          </button>
        )}
      />
    </div>
  );
}

/**
 * The same row, stacked, for viewports below 768px where the grid cannot fit.
 * Name, status, recipients and the time it last moved, plus the same ⋯ menu.
 */
function DocumentCard({
  doc,
  selected,
  onToggle,
  onOpen,
  menuItems
}: {
  doc: Document;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  menuItems: ReturnType<ReturnType<typeof useDocumentActions>["menuItems"]>;
}) {
  const { t } = useTranslation();
  const signed = doc.recipients.filter((r) => r.state === "signed").length;
  const pill = statusPill(doc);
  const soon = expiresSoon(doc);

  return (
    <Card className={cn("p-3 flex gap-3", selected && "bg-accent-soft border-accent-line")}>
      <div className="pt-0.5">
        <Checkbox checked={selected} onChange={onToggle} label={t("documents.a11y.selectRow", { name: doc.name })} />
      </div>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="text-left w-full min-w-0">
          <div className="text-[14px] font-semibold leading-snug break-words">{doc.name}</div>
          <div className="font-mono text-[10px] text-muted-2 truncate mt-0.5">{doc.objectId}</div>
        </button>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Pill tone={pill.tone} dot>
            {t(pill.labelKey)}
          </Pill>
          {doc.recipients.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <AvatarStack people={doc.recipients.map((r) => ({ name: r.name, email: r.email }))} size={18} max={3} />
              {doc.status !== "draft" ? (
                <span className="num text-[11px] text-muted-2">
                  {t("documents.table.signedRatio", { signed: num(signed), total: num(doc.recipients.length) })}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-[12px] text-muted-2">{t("documents.card.noRecipients")}</span>
          )}
        </div>
        <div className="mt-1.5 text-[12px] text-muted num flex items-center gap-2 flex-wrap">
          <span>{t("documents.card.updated", { when: whenShort(doc.updatedAt) })}</span>
          {doc.expiryDate ? (
            <span className={cn(soon && "text-danger font-semibold")}>
              · {t("documents.card.expires", { when: untilShort(doc.expiryDate) })}
            </span>
          ) : null}
          {doc.folderName ? <span className="truncate">· {doc.folderName}</span> : null}
        </div>
      </div>
      <Menu
        items={menuItems}
        trigger={(p) => (
          <button
            type="button"
            {...p}
            aria-label={t("documents.a11y.rowActions", { name: doc.name })}
            className="text-muted-2 hover:text-ink p-1 -mr-1 -mt-1 self-start min-h-11 min-w-11 flex items-center justify-center"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.6} />
          </button>
        )}
      />
    </Card>
  );
}
