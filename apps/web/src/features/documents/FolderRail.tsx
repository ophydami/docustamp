import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Inbox,
  Loader2,
  MoreHorizontal
} from "lucide-react";
import { Button, Dialog, Menu, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useAuth } from "@/app/auth";
import { useExtUser } from "@/lib/extUser";
import {
  subtreeIds,
  useCreateFolder,
  useDeleteFolder,
  useDrive,
  useFolderContents,
  useMoveFolder,
  useRenameFolder,
  type FolderWithCount
} from "./api";

const EXPANDED_KEY = "sign.documents.folders.expanded";

interface TreeNode extends FolderWithCount {
  children: TreeNode[];
  depth: number;
}

/**
 * Nest the flat folder list. A folder whose parent is missing (archived, or
 * outside the page we fetched) is treated as a root so it never disappears.
 */
function buildTree(folders: FolderWithCount[]): TreeNode[] {
  const byId = new Map(folders.map((f) => [f.objectId, { ...f, children: [], depth: 0 } as TreeNode]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const stamp = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      n.depth = depth;
      stamp(n.children, depth + 1);
    }
  };
  stamp(roots, 0);
  return roots;
}

/** Every folder from the root down to `folderId`, for the breadcrumb. */
export function folderPath(folders: FolderWithCount[], folderId: string | undefined): FolderWithCount[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.objectId, f]));
  const path: FolderWithCount[] = [];
  const seen = new Set<string>();
  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.objectId)) {
    seen.add(cur.objectId);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
  } catch {
    // ignore unreadable preferences
  }
  return [];
}

export interface FolderRailProps {
  /** Currently open folder, or undefined for "All documents". */
  folderId?: string;
  onSelect: (folderId: string | undefined) => void;
  /** Called when documents are dropped on a folder in the rail. */
  onDropDocuments?: (folderId: string | null, docIds: string[]) => void;
  /** Ids of the rows the user is dragging, empty when nothing is being dragged. */
  draggingIds?: string[];
}

/**
 * The drive, as a tree. Folders are `contracts_Document` rows with
 * `Type: "Folder"` (§3.5); everything here goes through `./api`, which keeps
 * the legacy drive's semantics (rename is a `Name` PUT, delete is `IsArchive`).
 */
export function FolderRail({ folderId, onSelect, onDropDocuments, draggingIds = [] }: FolderRailProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const me = useMemo(() => ({ userId: user?.id, email: user?.email }), [user?.id, user?.email]);
  const drive = useDrive(me);
  const extUser = useExtUser();

  const folders = drive.data?.folders ?? [];
  const tree = useMemo(() => buildTree(folders), [folders]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readExpanded()));
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<FolderWithCount | null>(null);
  const [deleting, setDeleting] = useState<FolderWithCount | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);

  const create = useCreateFolder();
  const renameFolder = useRenameFolder();

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  // Keep the path to the open folder unfolded. Re-running on every refetch is
  // harmless: the update is skipped when the path is already open.
  useEffect(() => {
    if (!folderId || !folders.length) return;
    const path = folderPath(folders, folderId).slice(0, -1).map((f) => f.objectId);
    if (!path.length) return;
    setExpanded((prev) => (path.every((id) => prev.has(id)) ? prev : new Set([...prev, ...path])));
  }, [folderId, folders]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submitCreate = (name: string, parentId: string | null) => {
    if (!name.trim() || !user?.id) {
      setCreatingIn(undefined);
      return;
    }
    create.mutate(
      { name, parentId: parentId ?? undefined, userId: user.id, extUserId: extUser.data?.objectId },
      {
        onSuccess: () => {
          toast.success(t("documents.toast.folderCreated"), name.trim());
          if (parentId) setExpanded((prev) => new Set([...prev, parentId]));
          setCreatingIn(undefined);
        },
        onError: (e: Error) => {
          setCreatingIn(undefined);
          toast.error(t("documents.toast.folderCreateFailed"), e.message);
        }
      }
    );
  };

  const submitRename = (folder: FolderWithCount, name: string) => {
    setRenaming(null);
    if (!name.trim() || name.trim() === folder.name) return;
    renameFolder.mutate(
      { folderId: folder.objectId, name },
      {
        onSuccess: () => toast.success(t("documents.toast.folderRenamed"), name.trim()),
        onError: (e: Error) => toast.error(t("documents.toast.folderRenameFailed"), e.message)
      }
    );
  };

  const dragging = draggingIds.length > 0;
  const drop = (target: string | null) => {
    setDropTarget(undefined);
    if (dragging && onDropDocuments) onDropDocuments(target, draggingIds);
  };

  const renderNode = (node: TreeNode) => {
    const open = expanded.has(node.objectId);
    const isRenaming = renaming === node.objectId;
    return (
      <li key={node.objectId}>
        <div
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            setDropTarget(node.objectId);
          }}
          onDragLeave={() => setDropTarget((t) => (t === node.objectId ? undefined : t))}
          onDrop={(e) => {
            if (!dragging) return;
            e.preventDefault();
            drop(node.objectId);
          }}
          className={cn(
            "group h-7 rounded-md flex items-center gap-1 pr-1 text-[13px]",
            folderId === node.objectId ? "bg-surface-3 text-ink font-semibold" : "text-ink-2 hover:bg-surface-3/70",
            dropTarget === node.objectId && "ring-1 ring-accent bg-accent-tint text-ink"
          )}
          style={{ paddingLeft: 4 + node.depth * 12 }}
        >
          <button
            type="button"
            aria-label={
              open
                ? t("documents.a11y.collapseFolder", { name: node.name })
                : t("documents.a11y.expandFolder", { name: node.name })
            }
            onClick={() => toggle(node.objectId)}
            className={cn("p-0.5 shrink-0", node.children.length ? "opacity-70 hover:opacity-100" : "invisible")}
          >
            {open ? (
              <ChevronDown className="size-3.5" strokeWidth={1.6} />
            ) : (
              <ChevronRight className="size-3.5" strokeWidth={1.6} />
            )}
          </button>
          {isRenaming ? (
            <InlineInput
              defaultValue={node.name}
              onCommit={(v) => submitRename(node, v)}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => onSelect(node.objectId)}
                className="flex-1 min-w-0 flex items-center gap-1.5 text-left h-full"
              >
                {folderId === node.objectId ? (
                  <FolderOpen className="size-3.5 shrink-0" strokeWidth={1.6} />
                ) : (
                  <FolderIcon className="size-3.5 shrink-0 text-muted-2" strokeWidth={1.6} />
                )}
                <span className="truncate">{node.name}</span>
              </button>
              <span className={cn("num text-[11px] shrink-0", folderId === node.objectId ? "text-ink-2" : "text-muted")}>
                {node.count}
              </span>
              <Menu
                items={[
                  { label: t("common.actions.open"), onSelect: () => onSelect(node.objectId) },
                  { label: t("documents.folders.newInside"), onSelect: () => setCreatingIn(node.objectId) },
                  "separator",
                  { label: t("common.actions.rename"), onSelect: () => setRenaming(node.objectId) },
                  { label: t("documents.folders.moveTo"), onSelect: () => setMoving(node) },
                  "separator",
                  { label: t("common.actions.delete"), danger: true, onSelect: () => setDeleting(node) }
                ]}
                trigger={(p) => (
                  <button
                    type="button"
                    {...p}
                    aria-label={t("documents.a11y.folderActions", { name: node.name })}
                    className={cn(
                      "p-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                      folderId === node.objectId && "opacity-70"
                    )}
                  >
                    <MoreHorizontal className="size-3.5" strokeWidth={1.6} />
                  </button>
                )}
              />
            </>
          )}
        </div>
        {creatingIn === node.objectId ? (
          <div style={{ paddingLeft: 20 + node.depth * 12 }} className="py-1">
            <InlineInput
              placeholder={t("documents.folders.namePlaceholder")}
              busy={create.isPending}
              onCommit={(v) => submitCreate(v, node.objectId)}
              onCancel={() => setCreatingIn(undefined)}
            />
          </div>
        ) : null}
        {open && node.children.length ? <ul>{node.children.map(renderNode)}</ul> : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 pt-4 pb-2 flex items-center gap-2">
        <span className="text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium">
          {t("documents.folders.title")}
        </span>
        <button
          type="button"
          aria-label={t("documents.folders.new")}
          title={t("documents.folders.new")}
          onClick={() => setCreatingIn(null)}
          className="ml-auto text-muted-2 hover:text-ink p-0.5"
        >
          <FolderPlus className="size-4" strokeWidth={1.6} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-2 pb-3">
        <div
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            setDropTarget(null);
          }}
          onDragLeave={() => setDropTarget((t) => (t === null ? undefined : t))}
          onDrop={(e) => {
            if (!dragging) return;
            e.preventDefault();
            drop(null);
          }}
          className={cn(
            "h-7 rounded-md flex items-center gap-1.5 px-2 text-[13px]",
            !folderId ? "bg-surface-3 text-ink font-semibold" : "text-ink-2 hover:bg-surface-3/70",
            dropTarget === null && "ring-1 ring-accent bg-accent-tint text-ink"
          )}
        >
          <button type="button" onClick={() => onSelect(undefined)} className="flex-1 min-w-0 flex items-center gap-1.5 text-left h-full">
            <Inbox className="size-3.5 shrink-0" strokeWidth={1.6} />
            <span className="truncate">{t("documents.folders.allDocuments")}</span>
          </button>
          <span className={cn("num text-[11px]", !folderId ? "text-ink-2" : "text-muted")}>
            {drive.data ? drive.data.total : "-"}
          </span>
        </div>

        {creatingIn === null ? (
          <div className="px-2 py-1">
            <InlineInput
              placeholder={t("documents.folders.namePlaceholder")}
              busy={create.isPending}
              onCommit={(v) => submitCreate(v, null)}
              onCancel={() => setCreatingIn(undefined)}
            />
          </div>
        ) : null}

        {drive.isLoading ? (
          <p className="px-2 py-3 text-[12px] text-muted-2 flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" /> {t("common.state.loading")}
          </p>
        ) : drive.isError ? (
          <p className="px-2 py-3 text-[12px] text-danger">{t("documents.folders.loadError")}</p>
        ) : tree.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-2 leading-relaxed">{t("documents.folders.empty")}</p>
        ) : (
          <ul className="mt-1">{tree.map(renderNode)}</ul>
        )}
      </div>

      <MoveFolderDialog
        folder={moving}
        folders={folders}
        onClose={() => setMoving(null)}
      />
      <DeleteFolderDialog folder={deleting} onClose={() => setDeleting(null)} onDeleted={() => {
        if (deleting && folderId === deleting.objectId) onSelect(deleting.parentId);
      }} />
    </div>
  );
}

/* --------------------------------------------------------------- inline input */

function InlineInput({
  defaultValue = "",
  placeholder,
  busy,
  onCommit,
  onCancel
}: {
  defaultValue?: string;
  placeholder?: string;
  busy?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter commits, and so does clicking away. Only one of them may win, or a
  // slow create would be submitted twice.
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={busy}
      maxLength={250}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      className="w-full h-6 px-1.5 rounded-[6px] bg-surface border border-accent text-[13px] text-ink focus:outline-none"
    />
  );
}

/* ------------------------------------------------------------------- dialogs */

function MoveFolderDialog({
  folder,
  folders,
  onClose
}: {
  folder: FolderWithCount | null;
  folders: FolderWithCount[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const move = useMoveFolder();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (folder) setTarget(folder.parentId ?? null);
  }, [folder]);

  // A folder cannot move into itself or into anything below it.
  const tree = useMemo(() => {
    const blocked = folder ? subtreeIds(folders, folder.objectId) : new Set<string>();
    return buildTree(folders.filter((f) => !blocked.has(f.objectId)));
  }, [folders, folder]);

  const renderNode = (node: TreeNode): React.ReactNode => (
    <li key={node.objectId}>
      <button
        type="button"
        onClick={() => setTarget(node.objectId)}
        style={{ paddingLeft: 8 + node.depth * 14 }}
        className={cn(
          "w-full h-8 pr-2 rounded-md flex items-center gap-1.5 text-left text-[13px]",
          target === node.objectId ? "bg-surface-3 text-ink font-semibold" : "hover:bg-surface-3/70 text-ink-2"
        )}
      >
        <FolderIcon className="size-3.5 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{node.name}</span>
      </button>
      {node.children.length ? <ul>{node.children.map(renderNode)}</ul> : null}
    </li>
  );

  return (
    <Dialog
      open={!!folder}
      onClose={onClose}
      title={t("documents.dialog.moveFolder.title")}
      description={folder ? t("documents.dialog.moveFolder.description", { name: folder.name }) : undefined}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button
            variant="primary"
            loading={move.isPending}
            disabled={!folder || target === (folder.parentId ?? null)}
            onClick={() => {
              if (!folder) return;
              move.mutate(
                { folderId: folder.objectId, parentId: target },
                {
                  onSuccess: () => {
                    toast.success(t("documents.toast.folderMoved"), folder.name);
                    onClose();
                  },
                  onError: (e: Error) => toast.error(t("documents.toast.folderMoveFailed"), e.message)
                }
              );
            }}
          >
            {t("documents.actions.move")}
          </Button>
        </>
      }
    >
      <ul className="max-h-72 overflow-auto scroll-thin -mx-1">
        <li>
          <button
            type="button"
            onClick={() => setTarget(null)}
            className={cn(
              "w-full h-8 px-2 rounded-md flex items-center gap-1.5 text-left text-[13px]",
              target === null ? "bg-surface-3 text-ink font-semibold" : "hover:bg-surface-3/70 text-ink-2"
            )}
          >
            <Inbox className="size-3.5 shrink-0" strokeWidth={1.6} />
            {t("documents.folders.allDocumentsTopLevel")}
          </button>
        </li>
        {tree.map(renderNode)}
      </ul>
    </Dialog>
  );
}

function DeleteFolderDialog({
  folder,
  onClose,
  onDeleted
}: {
  folder: FolderWithCount | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const contents = useFolderContents(folder?.objectId);
  const del = useDeleteFolder();
  const parentLabel = folder?.parentId
    ? t("documents.folders.parentAbove")
    : t("documents.folders.allDocuments");
  const docsInside = contents.data?.documents ?? 0;
  const subfoldersInside = contents.data?.subfolders ?? 0;
  const inside = docsInside + subfoldersInside;

  return (
    <Dialog
      open={!!folder}
      onClose={onClose}
      title={t("documents.dialog.deleteFolder.title")}
      description={folder?.name}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button
            variant="primary"
            className="bg-danger border-danger hover:bg-danger hover:border-danger"
            loading={del.isPending || contents.isLoading}
            onClick={() => {
              if (!folder) return;
              del.mutate(
                { folderId: folder.objectId, parentId: folder.parentId },
                {
                  onSuccess: () => {
                    toast.success(
                      t("documents.toast.folderDeleted"),
                      t("documents.toast.folderDeletedBody", { target: parentLabel })
                    );
                    onDeleted();
                    onClose();
                  },
                  onError: (e: Error) => toast.error(t("documents.toast.folderDeleteFailed"), e.message)
                }
              );
            }}
          >
            {t("documents.dialog.deleteFolder.confirm")}
          </Button>
        </>
      }
    >
      {contents.isLoading ? (
        <p className="text-[13px] text-muted-2 flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> {t("documents.dialog.deleteFolder.checking")}
        </p>
      ) : inside === 0 ? (
        <p className="text-[13px] text-ink-2">{t("documents.dialog.deleteFolder.emptyBody")}</p>
      ) : (
        <p className="text-[13px] text-ink-2 leading-relaxed">
          {subfoldersInside
            ? t("documents.dialog.deleteFolder.bodyWithSubfolders", {
                documents: t("common.count.document", { count: docsInside }),
                subfolders: t("documents.count.subfolder", { count: subfoldersInside }),
                target: parentLabel
              })
            : t("documents.dialog.deleteFolder.body", {
                documents: t("common.count.document", { count: docsInside }),
                target: parentLabel
              })}
        </p>
      )}
    </Dialog>
  );
}
