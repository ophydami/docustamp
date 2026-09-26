import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check, Copy, FileStack, Forward, FolderInput, Link2, Loader2 } from "lucide-react";
import { Button, Dialog, Field, Input, Select, Textarea, toast, type MenuItem } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { remindError, remindErrorTitle, remindSummary } from "@/lib/reminder";
import { loadSigningLinks, signingLinkFor, type SigningLink } from "@/lib/signingLinks";
import {
  downloadDocument,
  useDeleteDocuments,
  useDrive,
  useDuplicateDocument,
  useMoveDocuments,
  useRemind,
  useVoidDocuments,
  type DownloadKind
} from "./api";
import { ForwardDialog } from "./ForwardDialog";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog";
import type { Document } from "./types";

export interface DocumentActions {
  remind: (docs: Document[]) => void;
  download: (doc: Document, kind: DownloadKind) => void;
  duplicate: (doc: Document) => void;
  askMove: (docs: Document[]) => void;
  askVoid: (docs: Document[]) => void;
  askDelete: (docs: Document[]) => void;
  askForward: (doc: Document) => void;
  askSaveAsTemplate: (doc: Document) => void;
  shareLinks: (doc: Document) => void;
  /** Row / top-bar overflow menu for a single document. */
  menuItems: (doc: Document, opts?: { omitOpen?: boolean }) => (MenuItem | "separator")[];
  /** Render this once per page: all confirmation dialogs live here. */
  dialogs: ReactNode;
  busy: boolean;
}

/**
 * Every mutating action a document row or the detail header can take, with the
 * confirmation dialogs that go with them. Shared by the list and detail pages
 * so the ⋯ menu behaves identically in both.
 */
export function useDocumentActions(opts: { onRemoved?: (ids: string[]) => void } = {}): DocumentActions {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const me = useMemo(() => ({ userId: user?.id, email: user?.email }), [user?.id, user?.email]);
  const drive = useDrive(me);

  const del = useDeleteDocuments();
  const move = useMoveDocuments();
  const voidDocs = useVoidDocuments();
  const duplicateDoc = useDuplicateDocument();
  const remindMut = useRemind();

  const [downloading, setDownloading] = useState(false);
  const [moveTargets, setMoveTargets] = useState<Document[] | null>(null);
  const [moveFolder, setMoveFolder] = useState("");
  const [voidTargets, setVoidTargets] = useState<Document[] | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<Document[] | null>(null);
  const [shareDoc, setShareDoc] = useState<Document | null>(null);
  const [shareLinkList, setShareLinkList] = useState<SigningLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [forwardDoc, setForwardDoc] = useState<Document | null>(null);
  const [templateDoc, setTemplateDoc] = useState<Document | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const onRemoved = opts.onRemoved;

  /**
   * One link per recipient, resolved once per fetch rather than per render so a
   * missing link is warned about once.
   */
  const shareLinkMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!shareDoc || shareLinksLoading) return map;
    for (const r of shareDoc.recipients) {
      map.set(
        r.objectId || r.email,
        signingLinkFor(shareLinkList, shareDoc.objectId, { objectId: r.objectId, email: r.email })
      );
    }
    return map;
  }, [shareDoc, shareLinkList, shareLinksLoading]);

  const remind = useCallback(
    (docs: Document[]) => {
      if (!docs.length) return;
      remindMut.mutate(
        { docs },
        {
          onSuccess: (totals) => {
            const { title, detail } = remindSummary(totals);
            const only = totals.failed.length === 1 ? totals.failed[0] : undefined;
            if (totals.sent.length) toast.success(title, detail);
            else if (only) toast.error(remindErrorTitle(only.code), only.message);
            else toast.show(title, detail);
          },
          onError: (e: Error) => {
            const { title, detail } = remindError(e);
            toast.error(title, detail);
          }
        }
      );
    },
    [remindMut]
  );

  const download = useCallback((doc: Document, kind: DownloadKind) => {
    setDownloading(true);
    downloadDocument(doc, kind)
      .then(() => toast.success(t("documents.toast.downloadStarted"), doc.name))
      .catch((e: Error) => toast.error(t("documents.toast.downloadFailed"), e.message))
      .finally(() => setDownloading(false));
  }, [t]);

  const duplicate = useCallback(
    (doc: Document) => {
      duplicateDoc.mutate(doc.objectId, {
        onSuccess: (res) => {
          toast.success(t("documents.toast.duplicated"), t("documents.toast.duplicatedBody", { name: doc.name }));
          if (res?.objectId) navigate(`/documents/${res.objectId}`);
        },
        onError: (e: Error) => toast.error(t("documents.toast.duplicateFailed"), e.message)
      });
    },
    [duplicateDoc, navigate, t]
  );

  const askMove = useCallback((docs: Document[]) => {
    if (!docs.length) return;
    setMoveFolder(docs[0].folderId ?? "");
    setMoveTargets(docs);
  }, []);

  const askVoid = useCallback((docs: Document[]) => {
    if (!docs.length) return;
    setVoidReason("");
    setVoidTargets(docs);
  }, []);

  const askDelete = useCallback((docs: Document[]) => {
    if (!docs.length) return;
    setDeleteTargets(docs);
  }, []);

  const shareLinks = useCallback((doc: Document) => {
    setCopied(null);
    setShareLinkList([]);
    setShareDoc(doc);
  }, []);

  /**
   * Signing links carry a per-signer token only the server can mint, so the
   * share dialog asks for them (`getsigninglinks`) instead of building them.
   */
  const shareDocId = shareDoc?.objectId;
  useEffect(() => {
    if (!shareDocId) return;
    let cancelled = false;
    setShareLinksLoading(true);
    void loadSigningLinks(shareDocId)
      .then((links) => {
        if (!cancelled) setShareLinkList(links);
      })
      .finally(() => {
        if (!cancelled) setShareLinksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shareDocId]);

  const askForward = useCallback((doc: Document) => setForwardDoc(doc), []);
  const askSaveAsTemplate = useCallback((doc: Document) => setTemplateDoc(doc), []);

  const copy = useCallback((key: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      })
      .catch(() => toast.error(t("documents.toast.copyLinkFailed"), t("documents.toast.clipboardBlocked")));
  }, [t]);

  const menuItems = useCallback(
    (doc: Document, opts?: { omitOpen?: boolean }): (MenuItem | "separator")[] => {
      const sent = doc.status !== "draft";
      // `forwarddoc` and `saveastemplate` both match on `CreatedBy == caller`.
      const notMine = !!doc.createdById && !!user?.id && doc.createdById !== user.id;
      const items: (MenuItem | "separator")[] = [];
      if (!opts?.omitOpen) {
        items.push({ label: t("common.actions.open"), onSelect: () => navigate(`/documents/${doc.objectId}`), kbd: "↵" });
      }
      if (doc.needsYou) {
        items.push({
          label: t("documents.actions.reviewAndSign"),
          onSelect: () =>
            navigate(
              doc.isSignYourself
                ? `/sign-yourself/${doc.objectId}`
                : `/sign/${doc.objectId}/${doc.myContactId ?? ""}`
            )
        });
      }
      if (doc.status === "draft") {
        items.push({ label: t("documents.actions.continueInEditor"), onSelect: () => navigate(`/send/${doc.objectId}`) });
      }
      items.push("separator");
      items.push({
        label: t("documents.actions.remindOthers"),
        kbd: "R",
        disabled: doc.status !== "in_progress",
        onSelect: () => remind([doc])
      });
      items.push({
        label: doc.isCompleted ? t("documents.actions.downloadSigned") : t("documents.actions.downloadCurrent"),
        disabled: !doc.signedUrl && !doc.url,
        onSelect: () => download(doc, "signed")
      });
      items.push({
        label: t("documents.actions.downloadOriginal"),
        disabled: !doc.url,
        onSelect: () => download(doc, "original")
      });
      if (doc.isCompleted) {
        items.push({
          label: t("documents.actions.downloadCompletionCertificate"),
          onSelect: () => download(doc, "certificate")
        });
      }
      if (sent && doc.recipients.length > 0) {
        items.push({
          label: t("documents.actions.copyShareLink"),
          icon: <Link2 className="size-3.5" strokeWidth={1.6} />,
          onSelect: () => shareLinks(doc)
        });
      }
      // `forwarddoc` mails the signed PDF and only the owner may call it (§4.3).
      if (doc.isCompleted) {
        items.push({
          label: t("documents.actions.forwardCopy"),
          icon: <Forward className="size-3.5" strokeWidth={1.6} />,
          disabled: notMine,
          onSelect: () => askForward(doc)
        });
      }
      items.push("separator");
      items.push({ label: t("common.actions.duplicate"), disabled: doc.isSignYourself, onSelect: () => duplicate(doc) });
      if (doc.fields.length > 0) {
        items.push({
          label: t("documents.actions.saveAsTemplate"),
          icon: <FileStack className="size-3.5" strokeWidth={1.6} />,
          disabled: notMine,
          onSelect: () => askSaveAsTemplate(doc)
        });
      }
      items.push({
        label: t("documents.actions.moveToFolder"),
        icon: <FolderInput className="size-3.5" strokeWidth={1.6} />,
        onSelect: () => askMove([doc])
      });
      items.push("separator");
      if (doc.status === "in_progress" || doc.status === "expired") {
        items.push({ label: t("documents.actions.void"), danger: true, onSelect: () => askVoid([doc]) });
      }
      items.push({ label: t("common.actions.delete"), danger: true, onSelect: () => askDelete([doc]) });
      return items;
    },
    [t, navigate, user?.id, remind, download, duplicate, askMove, askVoid, askDelete, askForward, askSaveAsTemplate, shareLinks]
  );

  const folderList = drive.data?.folders ?? [];

  const dialogs = (
    <>
      <Dialog
        open={!!moveTargets}
        onClose={() => setMoveTargets(null)}
        title={t("documents.actions.moveToFolder")}
        description={
          moveTargets && moveTargets.length > 1
            ? t("documents.dialog.move.description", { count: moveTargets.length })
            : moveTargets?.[0]?.name
        }
        width={460}
        footer={
          <>
            <Button onClick={() => setMoveTargets(null)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="primary"
              loading={move.isPending}
              onClick={() => {
                const ids = (moveTargets ?? []).map((d) => d.objectId);
                move.mutate(
                  { ids, folderId: moveFolder || null },
                  {
                    onSuccess: () => {
                      toast.success(
                        t("documents.toast.moved", { count: ids.length }),
                        moveFolder
                          ? folderList.find((f) => f.objectId === moveFolder)?.name
                          : t("documents.toast.movedToRoot")
                      );
                      setMoveTargets(null);
                    },
                    onError: (e: Error) => toast.error(t("documents.toast.moveFailed"), e.message)
                  }
                );
              }}
            >
              {t("documents.actions.move")}
            </Button>
          </>
        }
      >
        <Field label={t("documents.fields.folder")} hint={t("documents.dialog.move.hint")}>
          <Select value={moveFolder} onChange={(e) => setMoveFolder(e.target.value)}>
            <option value="">{t("documents.dialog.move.rootOption")}</option>
            {folderList.map((f) => (
              <option key={f.objectId} value={f.objectId}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        {drive.isLoading ? (
          <p className="mt-3 text-[12px] text-muted-2 flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" /> {t("documents.dialog.move.loadingFolders")}
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={!!voidTargets}
        onClose={() => setVoidTargets(null)}
        title={t("documents.dialog.void.title")}
        description={t("documents.dialog.void.description")}
        width={480}
        footer={
          <>
            <Button onClick={() => setVoidTargets(null)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="primary"
              className="bg-danger border-danger hover:bg-danger hover:border-danger"
              loading={voidDocs.isPending}
              onClick={() => {
                const ids = (voidTargets ?? []).map((d) => d.objectId);
                if (!user?.id) return;
                voidDocs.mutate(
                  { ids, reason: voidReason.trim() || t("documents.dialog.void.defaultReason"), userId: user.id },
                  {
                    onSuccess: () => {
                      toast.success(t("documents.toast.voided", { count: ids.length }));
                      setVoidTargets(null);
                      onRemoved?.(ids);
                    },
                    onError: (e: Error) => toast.error(t("documents.toast.voidFailed"), e.message)
                  }
                );
              }}
            >
              {t("documents.dialog.void.confirm", { count: voidTargets?.length ?? 1 })}
            </Button>
          </>
        }
      >
        <Field label={t("documents.fields.reason")} hint={t("documents.dialog.void.reasonHint")}>
          <Textarea
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder={t("documents.dialog.void.reasonPlaceholder")}
          />
        </Field>
      </Dialog>

      <Dialog
        open={!!deleteTargets}
        onClose={() => setDeleteTargets(null)}
        title={t("documents.dialog.delete.title", { count: deleteTargets?.length ?? 1 })}
        description={t("documents.dialog.delete.description")}
        width={460}
        footer={
          <>
            <Button onClick={() => setDeleteTargets(null)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="primary"
              className="bg-danger border-danger hover:bg-danger hover:border-danger"
              loading={del.isPending}
              onClick={() => {
                const ids = (deleteTargets ?? []).map((d) => d.objectId);
                del.mutate(ids, {
                  onSuccess: () => {
                    toast.success(t("documents.toast.deleted", { count: ids.length }));
                    setDeleteTargets(null);
                    onRemoved?.(ids);
                  },
                  onError: (e: Error) => toast.error(t("documents.toast.deleteFailed"), e.message)
                });
              }}
            >
              {t("common.actions.delete")}
            </Button>
          </>
        }
      >
        <ul className="text-[13px] text-ink-2 flex flex-col gap-1 max-h-40 overflow-auto scroll-thin">
          {(deleteTargets ?? []).slice(0, 12).map((d) => (
            <li key={d.objectId} className="truncate">
              {d.name}
            </li>
          ))}
          {deleteTargets && deleteTargets.length > 12 ? (
            <li className="text-muted-2">{t("documents.dialog.delete.andMore", { count: deleteTargets.length - 12 })}</li>
          ) : null}
        </ul>
      </Dialog>

      <Dialog
        open={!!shareDoc}
        onClose={() => setShareDoc(null)}
        title={t("documents.dialog.share.title")}
        description={t("documents.dialog.share.description")}
        width={560}
        footer={<Button onClick={() => setShareDoc(null)}>{t("common.actions.done")}</Button>}
      >
        <div className="flex flex-col gap-2">
          {(shareDoc?.recipients ?? []).map((r) => {
            const link = shareLinkMap.get(r.objectId || r.email) ?? "";
            return (
              <div key={r.objectId || r.email} className="flex items-center gap-2">
                <div className="w-40 shrink-0 min-w-0">
                  <div className="text-[13px] truncate">{r.name || r.email}</div>
                  <div className="text-[11px] text-muted-2 truncate">{r.email}</div>
                </div>
                <Input
                  readOnly
                  value={shareLinksLoading ? "" : link}
                  className="font-mono text-[11px]"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  size="sm"
                  disabled={shareLinksLoading}
                  icon={
                    copied === (r.objectId || r.email) ? (
                      <Check className="size-3.5" strokeWidth={1.6} />
                    ) : (
                      <Copy className="size-3.5" strokeWidth={1.6} />
                    )
                  }
                  onClick={() => copy(r.objectId || r.email, link)}
                >
                  {copied === (r.objectId || r.email) ? t("common.actions.copied") : t("common.actions.copy")}
                </Button>
              </div>
            );
          })}
          {shareDoc && shareDoc.recipients.length === 0 ? (
            <p className="text-[13px] text-muted">{t("documents.dialog.share.noRecipients")}</p>
          ) : null}
        </div>
      </Dialog>

      <ForwardDialog doc={forwardDoc} onClose={() => setForwardDoc(null)} />
      <SaveAsTemplateDialog doc={templateDoc} onClose={() => setTemplateDoc(null)} />
    </>
  );

  return {
    remind,
    download,
    duplicate,
    askMove,
    askVoid,
    askDelete,
    askForward,
    askSaveAsTemplate,
    shareLinks,
    menuItems,
    dialogs,
    busy:
      downloading ||
      del.isPending ||
      move.isPending ||
      voidDocs.isPending ||
      duplicateDoc.isPending ||
      remindMut.isPending
  };
}

/** Small helper used by both pages for the "select all on page" checkbox. */
export function tristate(selected: number, total: number): boolean | "mixed" {
  if (selected === 0) return false;
  if (selected >= total) return true;
  return "mixed";
}
