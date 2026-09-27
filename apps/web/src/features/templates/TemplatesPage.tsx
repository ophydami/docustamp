import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Search, Upload } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  toast
} from "@/components/ui";
import { useHotkeys } from "@/lib/hotkeys";
import { useExtUser } from "@/lib/extUser";
import {
  PdfPasswordError,
  useCreateTemplate,
  useTeams,
  useTemplateMutations,
  useTemplateUsage,
  useTemplates
} from "./api";
import { ACCEPT, NewTemplateCard } from "./NewTemplateCard";
import { TemplateCard } from "./TemplateCard";
import type { TFunction } from "i18next";
import type { Template, TemplateScope, TemplateSort } from "./types";

function scopeOptions(t: TFunction): { value: TemplateScope; label: string }[] {
  return [
    { value: "all", label: t("templates.scopes.all") },
    { value: "mine", label: t("templates.scopes.mine") },
    { value: "shared", label: t("templates.scopes.shared") }
  ];
}

function sortOptions(t: TFunction): { value: TemplateSort; label: string }[] {
  return [
    { value: "used", label: t("templates.sort.used") },
    { value: "updated", label: t("templates.sort.updated") },
    { value: "name", label: t("templates.sort.name") }
  ];
}

export default function TemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const list = useTemplates();
  const usage = useTemplateUsage();
  const ext = useExtUser();
  const { rename, archive, duplicate, shareWithTeams } = useTemplateMutations();
  const create = useCreateTemplate();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TemplateScope>("all");
  const [sort, setSort] = useState<TemplateSort>("updated");
  const [rawCursor, setCursor] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const [sharing, setSharing] = useState<Template | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const usageMap = usage.data?.byTemplate;
  const templates = list.data;
  const myExtId = ext.data?.objectId;
  // getteams resolves teams through the caller's organisation, and the old app
  // hid team sharing from plain users. Match both conditions.
  const canShare =
    !!ext.data?.OrganizationId?.objectId && ext.data?.UserRole !== "contracts_User";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (templates ?? []).filter((row) => {
      if (q && !row.name.toLowerCase().includes(q) && !row.folder.toLowerCase().includes(q)) return false;
      if (!myExtId || scope === "all") return true;
      const mine = row.ownerId === myExtId;
      return scope === "mine" ? mine : !mine;
    });
    const by = {
      used: (a: Template, b: Template) =>
        (usageMap?.[b.id] ?? 0) - (usageMap?.[a.id] ?? 0) || b.updatedAt.localeCompare(a.updatedAt),
      updated: (a: Template, b: Template) => b.updatedAt.localeCompare(a.updatedAt),
      name: (a: Template, b: Template) => a.name.localeCompare(b.name)
    }[sort];
    return [...rows].sort(by);
  }, [templates, query, scope, sort, usageMap, myExtId]);

  // Clamp during render instead of in an effect, so a shrinking list cannot
  // leave the cursor pointing past the end for a frame.
  const cursor = visible.length ? Math.min(rawCursor, visible.length - 1) : 0;
  const current = visible[cursor];

  // Once usage numbers land, "most used" becomes the more useful default order.
  const sortTouched = useRef(false);
  useEffect(() => {
    if (!sortTouched.current && usageMap && Object.keys(usageMap).length) setSort("used");
  }, [usageMap]);

  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-card="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const scopes = useMemo(() => scopeOptions(t), [t]);
  const sorts = useMemo(() => sortOptions(t), [t]);

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const startCreate = useCallback(
    (file: File, pwd?: string) => {
      const extUserId = ext.data?.objectId;
      if (!extUserId) {
        toast.error(t("templates.toast.profileNotReady.title"), t("templates.toast.profileNotReady.body"));
        return;
      }
      create.mutate(
        { file, extUserId, password: pwd },
        {
          onSuccess: (templateId) => {
            setPending(null);
            setPassword("");
            navigate(`/templates/${templateId}/edit`);
          },
          onError: (err: Error) => {
            if (err instanceof PdfPasswordError) {
              setPending(file);
              setPassword("");
              return;
            }
            setPending(null);
            toast.error(t("templates.toast.createFailed"), err.message);
          }
        }
      );
    },
    [create, ext.data?.objectId, navigate, t]
  );

  const startSend = useCallback((row: Template) => navigate(`/send?template=${row.id}`), [navigate]);
  const bulkSend = useCallback((row: Template) => navigate(`/send?mode=bulk&template=${row.id}`), [navigate]);
  const edit = useCallback((row: Template) => navigate(`/templates/${row.id}/edit`), [navigate]);

  useHotkeys(
    {
      j: () => setCursor((c) => Math.min(c + 1, Math.max(0, visible.length - 1))),
      k: () => setCursor((c) => Math.max(c - 1, 0)),
      enter: () => current && startSend(current),
      e: () => current && edit(current),
      n: (e) => {
        e.preventDefault();
        openPicker();
      }
    },
    [visible.length, current, startSend, edit, openPicker]
  );

  const onDuplicate = (row: Template) =>
    duplicate.mutate(row.id, {
      onSuccess: () =>
        toast.success(t("templates.toast.duplicated.title"), t("templates.toast.duplicated.body", { name: row.name })),
      onError: (err: Error) => toast.error(t("templates.toast.duplicateFailed"), err.message)
    });

  const onRename = (row: Template, name: string) => {
    setRenamingId(null);
    const next = name.trim();
    if (!next || next === row.name) return;
    rename.mutate(
      { id: row.id, name: next },
      { onError: (err: Error) => toast.error(t("templates.toast.renameFailed"), err.message) }
    );
  };

  const onDelete = (row: Template) => {
    setDeleting(null);
    archive.mutate(row.id, {
      onSuccess: () =>
        toast.success(t("templates.toast.deleted.title"), t("templates.toast.deleted.body", { name: row.name })),
      onError: (err: Error) => toast.error(t("templates.toast.deleteFailed"), err.message)
    });
  };

  const total = templates?.length ?? 0;
  const quarter = usage.data?.thisQuarter;
  const subtitle = [
    t("common.count.template", { count: total }),
    quarter !== undefined ? t("templates.meta.sendsThisQuarter", { count: quarter }) : null
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex-1 min-h-0 overflow-auto scroll-thin px-4 py-4 lg:px-6 lg:py-5 flex flex-col gap-4 [&>*]:shrink-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1 pt-1.5">
          <span className="text-[13px] text-muted">
            {list.isLoading ? t("common.state.loading") : subtitle}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0">
          <Button icon={<Upload className="size-3.5" strokeWidth={1.6} />} onClick={openPicker}>
            {t("templates.actions.import")}
          </Button>
          <Button variant="primary" kbd="N" onClick={openPicker}>
            {t("templates.actions.new")}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("templates.search.placeholder")}
          aria-label={t("templates.search.label")}
          left={<Search className="size-3.5" strokeWidth={1.6} />}
          className="w-full sm:w-[260px]"
        />
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {scopes.map((s) => (
            <Chip key={s.value} active={scope === s.value} onClick={() => setScope(s.value)}>
              {s.label}
            </Chip>
          ))}
          <span className="w-px h-5 bg-line mx-1" />
          <Menu
            items={sorts.map((s) => ({
              label: s.label,
              onSelect: () => {
                sortTouched.current = true;
                setSort(s.value);
              }
            }))}
            trigger={(p) => (
              <Button size="sm" iconRight={<ChevronDown className="size-3.5" strokeWidth={1.6} />} {...p}>
                {t("templates.sort.label", { sort: sorts.find((s) => s.value === sort)?.label ?? "" })}
              </Button>
            )}
          />
        </div>
      </div>

      {list.isError ? (
        <Card className="p-6 flex flex-col items-start gap-3">
          <span className="text-[13px] text-ink-2">
            {t("templates.errors.listFailed", { message: (list.error as Error).message })}
          </span>
          <Button size="sm" onClick={() => list.refetch()}>
            {t("common.actions.tryAgain")}
          </Button>
        </Card>
      ) : list.isLoading ? (
        <Grid ref={gridRef}>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </Grid>
      ) : total === 0 ? (
        <EmptyState
          title={t("templates.empty.title")}
          body={t("templates.empty.body")}
          action={
            <Button variant="primary" onClick={openPicker}>
              {t("templates.actions.new")}
            </Button>
          }
        />
      ) : (
        <>
          <Grid ref={gridRef}>
            {visible.map((row, i) => (
              <div key={row.id} data-card={i}>
                <TemplateCard
                  template={row}
                  selected={i === cursor}
                  uses={usageMap ? (usageMap[row.id] ?? 0) : undefined}
                  renaming={renamingId === row.id}
                  onSelect={() => setCursor(i)}
                  onUse={() => startSend(row)}
                  onBulkSend={() => bulkSend(row)}
                  onEdit={() => edit(row)}
                  onStartRename={() => setRenamingId(row.id)}
                  onRename={(name) => onRename(row, name)}
                  onCancelRename={() => setRenamingId(null)}
                  onDuplicate={() => onDuplicate(row)}
                  onShare={
                    canShare && row.ownerId && row.ownerId === myExtId ? () => setSharing(row) : undefined
                  }
                  onDelete={() => setDeleting(row)}
                />
              </div>
            ))}
            <NewTemplateCard busy={create.isPending} onPick={openPicker} onFile={(f) => startCreate(f)} />
          </Grid>
          {visible.length === 0 ? (
            <span className="text-[13px] text-muted -mt-1">{t("templates.empty.noMatch")}</span>
          ) : null}
        </>
      )}

      <div className="mt-auto pt-3 flex gap-4 text-[11px] text-muted-2">
        <span>J K {t("common.hints.move")}</span>
        <span>Enter {t("templates.hints.use")}</span>
        <span>E {t("templates.hints.edit")}</span>
        <span>N {t("templates.hints.new")}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) startCreate(f);
        }}
      />

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t("templates.dialog.delete.title")}
        description={
          deleting ? t("templates.dialog.delete.description", { name: deleting.name }) : undefined
        }
        width={440}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t("common.actions.cancel")}</Button>
            <Button variant="danger" onClick={() => deleting && onDelete(deleting)}>
              {t("templates.dialog.delete.confirm")}
            </Button>
          </>
        }
      />

      <ShareDialog
        key={sharing?.id ?? "no-share"}
        template={sharing}
        onClose={() => setSharing(null)}
        onSave={(teamIds) => {
          const row = sharing;
          setSharing(null);
          if (!row) return;
          shareWithTeams.mutate(
            { id: row.id, teamIds },
            {
              onSuccess: () =>
                toast.success(t("templates.toast.shared.title"), t("templates.toast.shared.body", { name: row.name })),
              onError: (err: Error) => toast.error(t("templates.toast.shareFailed"), err.message)
            }
          );
        }}
      />

      <Dialog
        open={!!pending}
        onClose={() => {
          setPending(null);
          setPassword("");
        }}
        title={t("templates.dialog.password.title")}
        description={t("templates.dialog.password.description")}
        width={440}
        footer={
          <>
            <Button
              onClick={() => {
                setPending(null);
                setPassword("");
              }}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!password}
              onClick={() => pending && startCreate(pending, password)}
            >
              {t("templates.dialog.password.confirm")}
            </Button>
          </>
        }
      >
        <Field label={t("templates.fields.password")}>
          <Input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && pending) startCreate(pending, password);
            }}
          />
        </Field>
      </Dialog>
    </div>
  );
}

function Grid({ children, ref }: { children: React.ReactNode; ref?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="h-[150px] bg-sand animate-pulse" />
      <div className="p-3 flex flex-col gap-2">
        <div className="h-3.5 w-2/3 rounded bg-paper animate-pulse" />
        <div className="h-2.5 w-1/2 rounded bg-paper animate-pulse" />
        <div className="h-7 w-full rounded-md bg-paper animate-pulse mt-2" />
      </div>
    </div>
  );
}

function ShareDialog({
  template,
  onClose,
  onSave
}: {
  template: Template | null;
  onClose: () => void;
  onSave: (teamIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const teams = useTeams(!!template);
  const [selected, setSelected] = useState<string[]>(() => template?.sharedTeams.map((team) => team.id) ?? []);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Dialog
      open={!!template}
      onClose={onClose}
      title={t("templates.dialog.share.title")}
      description={t("templates.dialog.share.description")}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button variant="primary" onClick={() => onSave(selected)} disabled={teams.isLoading}>
            {t("templates.dialog.share.confirm")}
          </Button>
        </>
      }
    >
      {teams.isLoading ? (
        <span className="text-[13px] text-muted">{t("templates.dialog.share.loading")}</span>
      ) : teams.isError ? (
        <span className="text-[13px] text-danger">
          {t("templates.dialog.share.error", { message: (teams.error as Error).message })}
        </span>
      ) : !teams.data?.length ? (
        <span className="text-[13px] text-muted">{t("templates.dialog.share.noTeams")}</span>
      ) : (
        <div className="flex flex-col">
          {teams.data.map((team) => (
            <button
              key={team.objectId}
              type="button"
              onClick={() => toggle(team.objectId)}
              className="flex items-center gap-2.5 h-10 px-1 text-left text-[13px] border-b border-line-soft last:border-0"
            >
              <Checkbox checked={selected.includes(team.objectId)} onChange={() => toggle(team.objectId)} />
              <span>{team.Name ?? t("templates.share.unnamedTeam")}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
