import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button, EmptyState, toast } from "@/components/ui";
import { useHotkeys } from "@/lib/hotkeys";
import { useEditorDoc, usePdfBytes, useSavePlaceholders } from "./api";
import { useCurrentPage, useElementWidth, usePdfDocument } from "./EditorPdf";
import { KEY_TO_TYPE, PAGE_MARGIN, SIGNING_TYPES, WIDGET_BY_TYPE } from "./constants";
import { detectFields } from "./autoDetect";
import { clampToPage } from "./geometry";
import { fromPlaceholders, signerLabel, toPlaceholders } from "./model";
import { createField, duplicateField, round2 } from "./widgets";
import { useEditorHistory } from "./useEditorState";
import { Canvas, type FieldGeometry } from "./components/Canvas";
import { Palette } from "./components/Palette";
import { Properties } from "./components/Properties";
import { RolesDialog } from "./components/RolesDialog";
import { Thumbnails } from "./components/Thumbnails";
import { TopBar, type SaveStatus } from "./components/TopBar";
import type { EditorField, EditorMode, PageSize, SignerRow, WidgetType } from "./types";

const EMPTY = { fields: [] as EditorField[], signers: [] as SignerRow[] };
/** CSS px per PDF point at 100% zoom (72pt/inch rendered at 96dpi). */
const PX_PER_PT = 96 / 72;
const AUTOSAVE_MS = 2000;

export default function EditorPage({ mode = "document" }: { mode?: EditorMode }) {
  const { t } = useTranslation();
  const params = useParams();
  const navigate = useNavigate();
  const id = mode === "template" ? params.templateId : params.docId;

  const docQuery = useEditorDoc(mode, id);
  const doc = docQuery.data;
  const bytesQuery = usePdfBytes(mode, id, doc?.url);
  const pdf = usePdfDocument(bytesQuery.data);
  const save = useSavePlaceholders(mode, id);

  const history = useEditorHistory(EMPTY);
  const { commit, reset: resetHistory, undo, redo, revision } = history;
  const { fields, signers } = history.snapshot;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeSignerId, setActiveSignerId] = useState<number | null>(null);
  const [armedType, setArmedType] = useState<WidgetType | null>(null);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [savedRevision, setSavedRevision] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);

  const pageEls = useRef(new Map<number, HTMLElement>());
  const hoverRef = useRef<{ page: number; x: number; y: number } | null>(null);
  const warnedRef = useRef(false);
  const loadedFor = useRef<string | null>(null);

  const rootWidth = useElementWidth(scrollRoot);
  const currentPage = useCurrentPage(scrollRoot, pdf.pages.length);
  const readOnly = preview || doc?.isCompleted === true || doc?.isDeclined === true;

  // ---- load -------------------------------------------------------------
  useEffect(() => {
    // Wait for the mount-time refetch so cached Placeholders from an earlier visit
    // are not loaded over what the send flow saved since.
    if (!doc || !id || docQuery.isFetching) return;
    const token = `${mode}:${id}`;
    if (loadedFor.current === token) return;
    loadedFor.current = token;
    const loaded = fromPlaceholders(doc, mode);
    resetHistory(loaded);
    setSavedRevision(-1);
    const first = loaded.signers.find((s) => !s.isPrefill) ?? loaded.signers[0];
    setActiveSignerId(first?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, docQuery.isFetching, id, mode]);

  // The first reset bumps the revision; treat that as "saved" so a freshly opened
  // document does not immediately write itself back.
  useEffect(() => {
    if (savedRevision === -1) setSavedRevision(revision);
  }, [savedRevision, revision]);

  // ---- derived ----------------------------------------------------------
  const maxPageWidth = useMemo(() => pdf.pages.reduce((m, p) => Math.max(m, p.width), 1), [pdf.pages]);
  const scaleFor = useCallback(
    (_page: PageSize) => {
      if (zoom !== null) return zoom * PX_PER_PT;
      const avail = Math.max(320, rootWidth - 60);
      return Math.min(3, Math.max(0.2, avail / maxPageWidth));
    },
    [zoom, rootWidth, maxPageWidth]
  );

  const unassigned = fields.filter((f) => f.signerId === null).length;
  const selected = fields.filter((f) => selectedIds.includes(f.id));
  const single = selected.length === 1 ? selected[0] : null;
  const singleIndex = single ? fields.findIndex((f) => f.id === single.id) : -1;

  const status: SaveStatus = save.isPending
    ? "saving"
    : saveFailed
      ? "error"
      : revision === savedRevision
        ? "saved"
        : "dirty";

  // ---- mutations --------------------------------------------------------
  const setFields = useCallback(
    (updater: (list: EditorField[]) => EditorField[], mergeKey?: string) => {
      commit((s) => ({ ...s, fields: updater(s.fields) }), mergeKey);
    },
    [commit]
  );

  const placeField = useCallback(
    (type: WidgetType, page: number, x: number, y: number) => {
      if (readOnly) return;
      const info = pdf.pages.find((p) => p.number === page);
      if (!info) return;
      const signer = signers.find((s) => s.id === activeSignerId);
      const spec = WIDGET_BY_TYPE[type];
      const count = fields.filter((f) => f.signerId === (signer?.id ?? null) && f.widget.type === type).length + 1;
      const zIndex = fields.filter((f) => f.page === page).reduce((m, f) => Math.max(m, f.widget.zIndex ?? 1), 0) + 1;
      const field = createField({ type, page, x, y, scale: scaleFor(info), zIndex, count, signer });
      const rect = clampToPage({ x, y, w: spec.width, h: field.widget.Height }, info);
      field.widget.xPosition = round2(rect.x);
      field.widget.yPosition = round2(rect.y);
      setFields((list) => [...list, field]);
      setSelectedIds([field.id]);
    },
    [activeSignerId, fields, pdf.pages, readOnly, scaleFor, setFields, signers]
  );

  const commitGeometry = useCallback(
    (updates: FieldGeometry[]) => {
      if (readOnly) return;
      const byId = new Map(updates.map((u) => [u.id, u]));
      setFields((list) =>
        list.map((f) => {
          const u = byId.get(f.id);
          if (!u) return f;
          const resized = u.w !== f.widget.Width || u.h !== f.widget.Height;
          return {
            ...f,
            widget: {
              ...f.widget,
              xPosition: round2(u.x),
              yPosition: round2(u.y),
              Width: round2(u.w),
              Height: round2(u.h),
              IsResize: resized ? true : f.widget.IsResize
            }
          };
        })
      );
    },
    [readOnly, setFields]
  );

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (readOnly || !selectedIds.length) return;
      setFields(
        (list) =>
          list.map((f) => {
            if (!selectedIds.includes(f.id)) return f;
            const info = pdf.pages.find((p) => p.number === f.page);
            const next = { x: f.widget.xPosition + dx, y: f.widget.yPosition + dy, w: f.widget.Width, h: f.widget.Height };
            const r = info ? clampToPage(next, info) : next;
            return { ...f, widget: { ...f.widget, xPosition: round2(r.x), yPosition: round2(r.y) } };
          }),
        `nudge:${selectedIds.join(",")}`
      );
    },
    [pdf.pages, readOnly, selectedIds, setFields]
  );

  const removeSelected = useCallback(() => {
    if (readOnly || !selectedIds.length) return;
    setFields((list) => list.filter((f) => !selectedIds.includes(f.id)));
    setSelectedIds([]);
  }, [readOnly, selectedIds, setFields]);

  const duplicateSelected = useCallback(() => {
    if (readOnly || !selectedIds.length) return;
    const copies: EditorField[] = [];
    for (const f of fields) {
      if (!selectedIds.includes(f.id)) continue;
      const info = pdf.pages.find((p) => p.number === f.page);
      const wanted = { x: f.widget.xPosition + 10, y: f.widget.yPosition + 10, w: f.widget.Width, h: f.widget.Height };
      const r = info ? clampToPage(wanted, info) : wanted;
      copies.push(duplicateField(f, { x: r.x, y: r.y }));
    }
    if (!copies.length) return;
    setFields((list) => [...list, ...copies]);
    setSelectedIds(copies.map((c) => c.id));
  }, [fields, pdf.pages, readOnly, selectedIds, setFields]);

  const copyToEveryPage = useCallback(() => {
    if (!single || readOnly) return;
    const source = pdf.pages.find((p) => p.number === single.page);
    if (!source) return;
    const copies: EditorField[] = [];
    for (const target of pdf.pages) {
      if (target.number === single.page) continue;
      // Rescale between page sizes and keep a 10pt margin, as PlaceholderCopy does.
      const w = single.widget.Width * (target.width / source.width);
      const h = single.widget.Height * (target.height / source.height);
      const x = Math.min(Math.max(single.widget.xPosition * (target.width / source.width), 10), target.width - w - 10);
      const y = Math.min(Math.max(single.widget.yPosition * (target.height / source.height), 10), target.height - h - 10);
      const copy = duplicateField(single, { page: target.number, x, y });
      copy.widget.Width = round2(w);
      copy.widget.Height = round2(h);
      copies.push(copy);
    }
    if (!copies.length) {
      toast.show(t("editor.toast.onlyOnePage.title"), t("editor.toast.onlyOnePage.body"));
      return;
    }
    setFields((list) => [...list, ...copies]);
    toast.success(t("editor.toast.copiedToPages", { count: copies.length }));
  }, [pdf.pages, readOnly, setFields, single, t]);

  const updateField = useCallback(
    (next: EditorField, mergeKey?: string) => {
      setFields((list) => list.map((f) => (f.id === next.id ? next : f)), mergeKey);
    },
    [setFields]
  );

  const saveRoles = useCallback(
    (nextSigners: SignerRow[]) => {
      const kept = new Set(nextSigners.map((s) => s.id));
      commit((s) => ({
        signers: nextSigners,
        fields: s.fields.map((f) => (f.signerId !== null && !kept.has(f.signerId) ? { ...f, signerId: null } : f))
      }));
      if (activeSignerId === null || !kept.has(activeSignerId)) {
        setActiveSignerId(nextSigners.find((s) => !s.isPrefill)?.id ?? nextSigners[0]?.id ?? null);
      }
    },
    [activeSignerId, commit]
  );

  // ---- autosave ---------------------------------------------------------
  const persist = useCallback(async () => {
    // `preview` must not block autosave, but a completed or declined document must.
    if (!id || doc?.isCompleted || doc?.isDeclined) return false;
    // Snapshot the revision we are about to write, so edits made while the request
    // is in flight still leave the document marked dirty.
    const writing = revision;
    try {
      await save.mutateAsync(toPlaceholders(signers, fields));
      setSavedRevision(writing);
      setSaveFailed(false);
      return true;
    } catch (err) {
      setSaveFailed(true);
      toast.error(t("editor.toast.saveFailed"), err instanceof Error ? err.message : undefined);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, fields, revision, id, signers, t]);

  // Held in a ref so unrelated re-renders (selection, hover) never restart the timer.
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  useEffect(() => {
    if (!id || revision === savedRevision || savedRevision === -1) return;
    const t = window.setTimeout(() => void persistRef.current(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [revision, savedRevision, id]);

  // ---- actions ----------------------------------------------------------
  const goToPage = useCallback(
    (n: number) => {
      const el = pageEls.current.get(n);
      if (!el || !scrollRoot) return;
      const top = el.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop;
      scrollRoot.scrollTo({ top: top - 12, behavior: "smooth" });
    },
    [scrollRoot]
  );

  const runAutoDetect = useCallback(async () => {
    if (!pdf.doc || readOnly) return;
    setDetecting(true);
    try {
      const found = await detectFields(pdf.doc, pdf.pages);
      const signer = signers.find((s) => s.id === activeSignerId);
      const created: EditorField[] = [];
      const counts = new Map<WidgetType, number>();
      for (const f of found) {
        const overlaps = fields.some(
          (e) =>
            e.page === f.page &&
            Math.abs(e.widget.xPosition - f.x) < 12 &&
            Math.abs(e.widget.yPosition - f.y) < 12
        );
        if (overlaps) continue;
        const base = fields.filter((x) => x.signerId === (signer?.id ?? null) && x.widget.type === f.type).length;
        const n = (counts.get(f.type) ?? 0) + 1;
        counts.set(f.type, n);
        const info = pdf.pages.find((p) => p.number === f.page);
        const field = createField({
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          scale: info ? scaleFor(info) : 1,
          zIndex: 1,
          count: base + n,
          signer
        });
        field.widget.Width = round2(f.width);
        field.widget.Height = round2(f.height);
        if (f.label) field.widget.options.hint = f.label.replace(/[:_\-\s]+$/, "").slice(0, 40);
        created.push(field);
      }
      if (!created.length) {
        toast.show(t("editor.toast.noFieldsDetected.title"), t("editor.toast.noFieldsDetected.body"));
        return;
      }
      setFields((list) => [...list, ...created]);
      setSelectedIds(created.map((c) => c.id));
      toast.success(t("editor.toast.fieldsAdded", { count: created.length }), t("editor.toast.fieldsAddedBody"));
    } catch (err) {
      toast.error(t("editor.toast.autoDetectFailed"), err instanceof Error ? err.message : undefined);
    } finally {
      setDetecting(false);
    }
  }, [activeSignerId, fields, pdf.doc, pdf.pages, readOnly, scaleFor, setFields, signers, t]);

  const onPrimary = useCallback(async () => {
    if (!id) return;
    if (unassigned > 0) {
      toast.error(t("editor.toast.stillUnassigned", { count: unassigned }), t("editor.toast.stillUnassignedBody"));
      return;
    }
    const missing = signers
      .filter((s) => !s.isPrefill)
      .filter((s) => !fields.some((f) => f.signerId === s.id && SIGNING_TYPES.includes(f.widget.type)));
    if (missing.length && !warnedRef.current) {
      warnedRef.current = true;
      toast.show(
        t("editor.toast.noSignatureField", { names: missing.map((s) => signerLabel(s, t)).join(", ") }),
        t("editor.toast.noSignatureFieldBody")
      );
      return;
    }
    const ok = await persist();
    if (!ok) return;
    if (mode === "template") {
      toast.success(t("editor.toast.templateSaved"));
      navigate("/templates");
    } else {
      navigate(`/send/${id}?step=4`);
    }
  }, [fields, id, mode, navigate, persist, signers, t, unassigned]);

  const onBack = useCallback(() => {
    navigate(mode === "template" ? "/templates" : `/send/${id}?step=2`);
  }, [id, mode, navigate]);

  // ---- keyboard ---------------------------------------------------------
  const typing = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
  };

  useHotkeys(
    {
      escape: () => {
        setArmedType(null);
        setSelectedIds([]);
      },
      backspace: (e) => {
        e.preventDefault();
        removeSelected();
      },
      delete: (e) => {
        e.preventDefault();
        removeSelected();
      },
      "mod+d": (e) => {
        if (typing()) return;
        e.preventDefault();
        duplicateSelected();
      },
      "mod+z": (e) => {
        if (typing()) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      },
      "mod+s": (e) => {
        e.preventDefault();
        void persist();
      },
      arrowup: (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(0, e.shiftKey ? -10 : -1);
      },
      "shift+arrowup": (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(0, -10);
      },
      arrowdown: (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(0, e.shiftKey ? 10 : 1);
      },
      "shift+arrowdown": (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(0, 10);
      },
      arrowleft: (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(e.shiftKey ? -10 : -1, 0);
      },
      "shift+arrowleft": (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(-10, 0);
      },
      arrowright: (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(e.shiftKey ? 10 : 1, 0);
      },
      "shift+arrowright": (e) => {
        if (!selectedIds.length) return;
        e.preventDefault();
        nudge(10, 0);
      },
      s: () => quickPlace("s"),
      d: () => quickPlace("d"),
      t: () => quickPlace("t")
    },
    [removeSelected, duplicateSelected, nudge, selectedIds, undo, redo, persist, placeField, currentPage]
  );

  function quickPlace(key: string) {
    const type = KEY_TO_TYPE[key];
    if (!type || readOnly) return;
    setArmedType(type);
    const at = hoverRef.current;
    const spec = WIDGET_BY_TYPE[type];
    if (at) {
      placeField(type, at.page, at.x - spec.width / 2, at.y - spec.height / 2);
    } else {
      placeField(type, currentPage, PAGE_MARGIN, PAGE_MARGIN);
    }
  }

  useEffect(() => {
    warnedRef.current = false;
  }, [revision]);

  // ---- render -----------------------------------------------------------
  // The gap between "bytes arrived" and "pdf.js has parsed them" is one render, so
  // fold it into the loading state rather than flashing the error view.
  const parsing = Boolean(bytesQuery.data) && !pdf.doc && !pdf.error;
  if (docQuery.isLoading || bytesQuery.isLoading || pdf.loading || parsing) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-2">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  const loadError = docQuery.error ?? bytesQuery.error ?? pdf.error;
  if (loadError || !doc || !pdf.doc) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          title={t("editor.load.errorTitle")}
          body={loadError instanceof Error ? loadError.message : t("editor.load.errorBody")}
          action={
            <Button onClick={() => navigate(mode === "template" ? "/templates" : "/documents")}>
              {t("editor.load.goBack")}
            </Button>
          }
        />
      </div>
    );
  }

  const locked = doc.isCompleted || doc.isDeclined;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ground">
      <TopBar
        name={doc.name}
        isTemplate={mode === "template"}
        status={status}
        onBack={onBack}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={undo}
        onRedo={redo}
        zoom={zoom}
        onZoom={setZoom}
        snap={snap}
        onSnap={setSnap}
        onAutoDetect={() => void runAutoDetect()}
        detecting={detecting}
        unassigned={unassigned}
        preview={preview}
        onPreview={setPreview}
        onPrimary={() => void onPrimary()}
        primaryLabel={mode === "template" ? t("editor.actions.saveTemplate") : t("common.actions.continue")}
        primaryBusy={save.isPending}
        disabled={locked}
      />

      {locked ? (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-warn-soft text-warn-ink text-[12px] border-b border-line">
          <AlertTriangle className="size-3.5" strokeWidth={1.6} />
          {doc.isDeclined ? t("editor.banner.declined") : t("editor.banner.completed")}
        </div>
      ) : doc.sent ? (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-warn-soft text-warn-ink text-[12px] border-b border-line">
          <AlertTriangle className="size-3.5" strokeWidth={1.6} />
          {t("editor.banner.sent")}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 flex">
        <Palette
          signers={signers}
          activeSignerId={activeSignerId}
          onActiveSigner={setActiveSignerId}
          onEditRoles={mode === "template" ? () => setRolesOpen(true) : undefined}
          armedType={armedType}
          onArm={setArmedType}
          disabled={readOnly || locked}
        />

        <Thumbnails
          pages={pdf.pages}
          fields={fields}
          signers={signers}
          current={currentPage}
          onGoTo={goToPage}
          doc={pdf.doc}
        />

        <Canvas
          doc={pdf.doc}
          pages={pdf.pages}
          scaleFor={scaleFor}
          fields={fields}
          signers={signers}
          selectedIds={selectedIds}
          snap={snap}
          preview={readOnly || locked}
          armedType={armedType}
          scrollRoot={scrollRoot}
          setScrollRoot={setScrollRoot}
          pageRef={(n, el) => {
            if (el) pageEls.current.set(n, el);
            else pageEls.current.delete(n);
          }}
          onSelect={setSelectedIds}
          onCommitGeometry={commitGeometry}
          onPlace={placeField}
          hoverRef={hoverRef}
        />

        {single ? (
          <Properties
            field={single}
            index={singleIndex}
            total={fields.length}
            signers={signers}
            onChange={updateField}
            onDelete={removeSelected}
            onCopyToPages={copyToEveryPage}
            disabled={readOnly || locked}
          />
        ) : (
          <aside className="w-[300px] shrink-0 bg-surface border-l border-line flex items-center justify-center p-6">
            <p className="text-[12px] text-muted-2 text-center leading-relaxed">
              {selected.length > 1
                ? t("editor.selection.many", { count: selected.length, key: "⌫" })
                : t("editor.selection.none")}
            </p>
          </aside>
        )}
      </div>

      <RolesDialog
        open={rolesOpen}
        onClose={() => setRolesOpen(false)}
        signers={signers}
        fields={fields}
        onSave={saveRoles}
      />
    </div>
  );
}
