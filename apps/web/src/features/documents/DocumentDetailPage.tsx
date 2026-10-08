import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileStack,
  Forward,
  Link2,
  Loader2,
  MoreHorizontal,
  PenLine,
  ShieldCheck
} from "lucide-react";
import {
  Avatar,
  Button,
  Cap,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Kbd,
  Menu,
  Pill,
  Select,
  Tabs,
  Toggle,
  toast,
  type PillTone
} from "@/components/ui";
import { PdfViewer, useVisiblePage, type PdfPageInfo } from "@/components/pdf/PdfViewer";
import { cn } from "@/lib/cn";
import { useAuth } from "@/app/auth";
import { num, whenShort } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useDocument, useDocumentOpens, useSetChain, useUpdateSettings, useViewUrl } from "./api";
import { useTemplates } from "@/features/templates/api";
import { useDocumentActions } from "./actions";
import type { AuditEvent, DocField, Document, Recipient } from "./types";

type Tab = "overview" | "audit" | "fields" | "settings";

const NARROW_WIDTH = 440;
const FIT_WIDTH = 516;

function statusPill(doc: Document): { tone: PillTone; labelKey: string } {
  if (doc.status === "completed") return { tone: "success", labelKey: "common.status.completed" };
  if (doc.status === "declined") return { tone: "danger", labelKey: "common.status.declined" };
  if (doc.status === "expired") return { tone: "danger", labelKey: "common.status.expired" };
  if (doc.status === "draft") return { tone: "neutral", labelKey: "common.status.draft" };
  if (doc.needsYou) return { tone: "accent", labelKey: "documents.filters.needsYou" };
  return { tone: "warn", labelKey: "common.status.inProgress" };
}

function longDate(v?: string) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function stamp(v?: string) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

export default function DocumentDetailPage() {
  const { t } = useTranslation();
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const me = useMemo(() => ({ userId: user?.id, email: user?.email }), [user?.id, user?.email]);

  const q = useDocument(docId, me);
  const doc = q.data;
  const actions = useDocumentActions({ onRemoved: () => navigate("/documents") });
  // Latest actions, so the hotkey listener does not have to rebind every render.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  const [tab, setTab] = useState<Tab>("overview");
  // Field outlines default to off on a completed document: the answers are
  // flattened into the PDF and the placeholder boxes would sit on top of them.
  const [fieldsOverride, setFieldsOverride] = useState<boolean | null>(null);
  const [fit, setFit] = useState(false);
  const [pages, setPages] = useState<PdfPageInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentPage = useVisiblePage(scrollRef, pages.length);

  // Set once the viewer rejects the url the row came with, which asks for a
  // freshly signed one instead of paying for that round trip up front.
  const [staleViewUrl, setStaleViewUrl] = useState(false);
  const view = useViewUrl(doc, staleViewUrl);

  const signHref = doc
    ? doc.isSignYourself
      ? `/sign-yourself/${doc.objectId}`
      : `/sign/${doc.objectId}/${doc.myContactId ?? ""}`
    : "";

  const goSign = useCallback(() => {
    if (doc?.needsYou) navigate(signHref);
  }, [doc?.needsYou, navigate, signHref]);

  useHotkeys(
    {
      r: (e) => {
        e.preventDefault();
        if (doc) actionsRef.current.remind([doc]);
      },
      enter: (e) => {
        if ((e.target as HTMLElement)?.tagName === "BUTTON") return;
        e.preventDefault();
        goSign();
      },
      escape: () => navigate("/documents")
    },
    [doc, goSign, navigate]
  );

  if (q.isLoading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="h-[52px] bg-surface border-b border-line" />
        <div className="flex-1 flex items-center justify-center text-muted-2">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </div>
    );
  }

  if (q.isError || !doc) {
    return (
      <div className="flex-1 flex flex-col">
        <TopBarShell onBack={() => navigate("/documents")} crumbs={[t("documents.title")]} />
        <EmptyState
          className="flex-1"
          title={t("documents.detail.errorTitle")}
          body={(q.error as Error)?.message ?? t("documents.detail.errorBody")}
          action={<Button onClick={() => navigate("/documents")}>{t("documents.a11y.backToDocuments")}</Button>}
        />
      </div>
    );
  }

  const pill = statusPill(doc);
  const showFields = fieldsOverride ?? !doc.isCompleted;
  const pageCount = pages.length || doc.pageCount || 0;
  const visibleFields = doc.fields.filter((f) => f.page === currentPage);

  // Each piece is a whole phrase; they are joined by a bullet, never concatenated.
  const meta: string[] = [];
  if (pageCount) meta.push(t("common.count.page", { count: pageCount }));
  if (doc.createdAt && doc.ownerName) {
    meta.push(t("documents.detail.createdBy", { date: longDate(doc.createdAt), name: doc.ownerName }));
  } else if (doc.createdAt) {
    meta.push(t("documents.detail.created", { date: longDate(doc.createdAt) }));
  } else if (doc.ownerName) {
    meta.push(t("documents.detail.by", { name: doc.ownerName }));
  }
  if (doc.templateName) meta.push(t("documents.detail.fromTemplate", { name: doc.templateName }));
  if (doc.expiryDate) meta.push(t("documents.detail.expires", { date: longDate(doc.expiryDate) }));
  meta.push(doc.folderName ?? t("documents.folders.driveRoot"));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="min-h-[52px] shrink-0 bg-surface border-b border-line flex items-center gap-3 px-4 py-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => navigate("/documents")}
          aria-label={t("documents.a11y.backToDocuments")}
          className="text-muted hover:text-ink p-1 -ml-1"
        >
          <ArrowLeft className="size-4" strokeWidth={1.6} />
        </button>
        <nav className="text-[13px] text-muted-2 flex items-center gap-1.5 min-w-0">
          <Link to="/inbox" className="hover:text-ink text-muted-2 hidden sm:inline">
            {t("documents.nav.inbox")}
          </Link>
          <span className="hidden sm:inline">/</span>
          <Link
            to={doc.folderId ? `/documents?folder=${doc.folderId}` : "/documents"}
            className="hover:text-ink text-muted-2"
          >
            {doc.folderName ?? t("documents.folders.driveRoot")}
          </Link>
          <span>/</span>
          <span className="text-ink truncate max-w-[12rem] xl:max-w-[26rem]">{doc.name}</span>
        </nav>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            kbd="R"
            disabled={doc.status !== "in_progress"}
            onClick={() => actions.remind([doc])}
          >
            {t("documents.actions.remindOthers")}
          </Button>
          {doc.isCompleted ? (
            <Button size="sm" icon={<Forward className="size-3.5" strokeWidth={1.6} />} onClick={() => actions.askForward(doc)}>
              {t("documents.actions.forward")}
            </Button>
          ) : null}
          {doc.fields.length > 0 ? (
            <Button
              size="sm"
              className="max-xl:hidden"
              icon={<FileStack className="size-3.5" strokeWidth={1.6} />}
              onClick={() => actions.askSaveAsTemplate(doc)}
            >
              {t("documents.actions.saveAsTemplate")}
            </Button>
          ) : null}
          <Menu
            items={[
              {
                label: doc.isCompleted ? t("documents.actions.signedPdf") : t("documents.actions.currentPdf"),
                disabled: !doc.signedUrl && !doc.url,
                onSelect: () => actions.download(doc, "signed")
              },
              {
                label: t("documents.actions.original"),
                disabled: !doc.url,
                onSelect: () => actions.download(doc, "original")
              },
              ...(doc.isCompleted
                ? [
                    {
                      label: t("documents.actions.completionCertificate"),
                      onSelect: () => actions.download(doc, "certificate")
                    }
                  ]
                : [])
            ]}
            trigger={(p) => (
              <Button size="sm" {...p} iconRight={<ChevronDown className="size-3.5" strokeWidth={1.6} />}>
                {t("common.actions.download")}
              </Button>
            )}
          />
          {doc.status !== "draft" && doc.recipients.length > 0 ? (
            <Button
              size="sm"
              icon={<Link2 className="size-3.5" strokeWidth={1.6} />}
              onClick={() => actions.shareLinks(doc)}
            >
              {t("documents.dialog.share.title")}
            </Button>
          ) : null}
          <Menu
            items={actions.menuItems(doc, { omitOpen: true })}
            trigger={(p) => (
              <button
                type="button"
                {...p}
                aria-label={t("documents.a11y.moreActions")}
                className="text-muted-2 hover:text-ink p-1.5"
              >
                <MoreHorizontal className="size-4" strokeWidth={1.6} />
              </button>
            )}
          />
          {doc.needsYou ? (
            <Button variant="primary" size="sm" kbd="↵" icon={<PenLine className="size-3.5" strokeWidth={1.6} />} onClick={goSign}>
              {t("documents.actions.reviewAndSign")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Side by side from 1024 up; below that the preview stacks above the details. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden scroll-thin">
        {/* The document itself */}
        <div className="w-full lg:w-[560px] shrink-0 border-b lg:border-b-0 lg:border-r border-line flex flex-col bg-paper h-[60vh] lg:h-auto">
          <div className="h-11 shrink-0 bg-surface border-b border-line flex items-center gap-3 px-4">
            <span className="font-mono text-[11px] text-muted">
              {t("documents.viewer.page", {
                current: pageCount ? num(currentPage) : "-",
                total: pageCount ? num(pageCount) : "-"
              })}
            </span>
            <button
              type="button"
              onClick={() => setFit((f) => !f)}
              className={cn("text-[12px] font-medium", fit ? "text-accent" : "text-muted hover:text-ink")}
            >
              {t("documents.viewer.fit")}
            </button>
            <button
              type="button"
              onClick={() => setFieldsOverride(!showFields)}
              className="text-[12px] font-medium text-muted hover:text-ink"
            >
              <Trans
                i18nKey="documents.viewer.fieldsToggle"
                values={{ state: showFields ? t("documents.viewer.on") : t("documents.viewer.off") }}
                components={{ 1: <span className={showFields ? "text-accent" : "text-ink"} /> }}
              />
            </button>
            <a
              href={signHref || `/sign/${doc.objectId}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-[12px] font-medium text-muted hover:text-ink flex items-center gap-1"
            >
              {t("documents.viewer.openInSignerView")}
              <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
            </a>
          </div>

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto scroll-thin py-5">
            {view.isLoading ? (
              <div className="flex justify-center pt-10 text-muted-2">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : view.data ? (
              <PdfViewer
                src={view.data}
                pageWidth={fit ? FIT_WIDTH : NARROW_WIDTH}
                onLoad={setPages}
                onError={() => setStaleViewUrl(true)}
                renderOverlay={
                  showFields
                    ? (page, scale) => <FieldOverlay fields={doc.fields.filter((f) => f.page === page.number)} scale={scale} />
                    : undefined
                }
              />
            ) : (
              <EmptyState title={t("documents.detail.noFileTitle")} body={t("documents.detail.noFileBody")} />
            )}
          </div>
        </div>

        {/* Everything about it */}
        <div className="flex-1 min-w-0 lg:overflow-auto scroll-thin">
          <div className="px-4 md:px-6 pt-5 pb-3">
            <div className="flex items-start gap-3">
              <h1 className="font-semibold text-[22px] leading-tight min-w-0 flex-1 tracking-[-.015em]">{doc.name}</h1>
              <Pill tone={pill.tone} dot className="mt-1.5">
                {t(pill.labelKey)}
              </Pill>
            </div>
            <p className="mt-2 text-[12px] text-muted leading-relaxed">
              <span className="font-mono text-[11px]">{doc.objectId}</span>
              {meta.map((piece) => ` · ${piece}`).join("")}
            </p>
            {doc.isDeclined && doc.declineReason ? (
              <p className="mt-3 text-[13px] bg-danger-soft text-danger rounded-md px-3 py-2">
                {t("documents.detail.declined", { reason: doc.declineReason })}
              </p>
            ) : null}
          </div>

          <div className="px-4 md:px-6">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: "overview", label: t("documents.tabs.overview") },
                { value: "audit", label: t("documents.tabs.audit"), count: doc.audit.length },
                { value: "fields", label: t("documents.tabs.fields"), count: doc.fields.length },
                { value: "settings", label: t("documents.tabs.settings") }
              ]}
            />
          </div>

          <div className="p-4 md:p-6">
            {tab === "overview" ? (
              <OverviewTab doc={doc} onShare={() => actions.shareLinks(doc)} onDownloadOriginal={() => actions.download(doc, "original")} onDownloadCertificate={() => actions.download(doc, "certificate")} />
            ) : tab === "audit" ? (
              <div className="flex flex-col gap-6">
                <AuditList events={doc.audit} full />
                <OpensPanel doc={doc} />
              </div>
            ) : tab === "fields" ? (
              <FieldsTab fields={doc.fields} currentPage={currentPage} highlighted={visibleFields.length} />
            ) : (
              <SettingsTab doc={doc} />
            )}
          </div>
        </div>
      </div>

      {actions.dialogs}
    </div>
  );
}

function TopBarShell({ onBack, crumbs }: { onBack: () => void; crumbs: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="h-[52px] shrink-0 bg-surface border-b border-line flex items-center gap-3 px-4">
      <button type="button" onClick={onBack} aria-label={t("documents.a11y.back")} className="text-muted hover:text-ink p-1 -ml-1">
        <ArrowLeft className="size-4" strokeWidth={1.6} />
      </button>
      <span className="text-[13px] text-muted-2">{crumbs.join(" / ")}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- overlay */

const SHORT_TYPE_KEY: Record<string, string> = {
  signature: "documents.fieldType.signature",
  initials: "documents.fieldType.initials",
  stamp: "documents.fieldType.stamp",
  image: "documents.fieldType.image",
  draw: "documents.fieldType.draw",
  "text input": "documents.fieldType.text",
  text: "documents.fieldType.text",
  date: "documents.fieldType.date",
  name: "documents.fieldType.name",
  email: "documents.fieldType.email",
  company: "documents.fieldType.company",
  "job title": "documents.fieldType.jobTitle",
  checkbox: "documents.fieldType.checkbox",
  dropdown: "documents.fieldType.dropdown",
  "radio button": "documents.fieldType.choice",
  cells: "documents.fieldType.cells"
};

/** The widget's own type when we have no label for it: raw server data. */
function fieldTypeLabel(t: TFunction, type: string): string {
  const key = SHORT_TYPE_KEY[type];
  return key ? t(key) : type;
}

/**
 * Read-only widget rectangles over the rendered page. Coordinates are PDF
 * points from the page's top-left, so `pdfPoint * scale` gives CSS pixels
 * (docs/BACKEND_API.md §7.4).
 *
 * Signed widgets are drawn as a thin outline only: `signPdf` flattens each
 * signature into the working PDF, so the artwork is already on the page and
 * drawing it again would double it up.
 */
function FieldOverlay({ fields, scale }: { fields: DocField[]; scale: number }) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((f) => {
        const done = !!f.image || !!f.value;
        const typeLabel = fieldTypeLabel(t, f.type);
        return (
          <div
            key={f.key}
            title={t("documents.a11y.fieldFor", { type: typeLabel, name: f.signerName })}
            className={cn(
              "absolute rounded-[3px] overflow-hidden flex items-center px-1",
              done ? "border border-dashed" : "border"
            )}
            style={{
              left: f.x * scale,
              top: f.y * scale,
              width: Math.max(10, f.w * scale),
              height: Math.max(10, f.h * scale),
              borderColor: f.color,
              background: done ? "transparent" : `${f.color}22`
            }}
          >
            <span
              className="text-[8px] leading-none font-semibold truncate flex items-center gap-0.5"
              style={{ color: f.color }}
            >
              {done ? <Check className="size-2" strokeWidth={3} /> : null}
              {typeLabel}
              <span className="opacity-60"> · {f.signerName.split(" ")[0]}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ overview */

function OverviewTab({
  doc,
  onShare,
  onDownloadOriginal,
  onDownloadCertificate
}: {
  doc: Document;
  onShare: () => void;
  onDownloadOriginal: () => void;
  onDownloadCertificate: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const noneSigned = doc.recipients.every((r) => r.state !== "signed");
  const editable = doc.status === "draft";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <Card className="p-4">
          <div className="flex items-baseline gap-2">
            <Cap>{t("documents.detail.recipientsInOrder")}</Cap>
            <span className="num text-[11px] text-muted-2">{num(doc.recipients.length)}</span>
          </div>
          <div className="mt-3 flex flex-col">
            {doc.recipients.length === 0 ? (
              <p className="text-[13px] text-muted">{t("documents.detail.noRecipients")}</p>
            ) : (
              doc.recipients.map((r) => <RecipientRow key={r.objectId || r.email} recipient={r} ordered={doc.settings.sendInOrder} />)
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {doc.written && editable ? (
              <Button size="sm" onClick={() => navigate(`/send/${doc.objectId}?compose=1`)}>
                {t("documents.actions.editText")}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!editable}
              title={editable ? undefined : t("documents.detail.editRecipientsLocked")}
              onClick={() => navigate(`/send/${doc.objectId}`)}
            >
              {t("documents.actions.editRecipients")}
            </Button>
            <Button
              size="sm"
              disabled={!editable || !noneSigned}
              title={editable ? undefined : t("documents.detail.changeOrderLocked")}
              onClick={() => navigate(`/send/${doc.objectId}`)}
            >
              {t("documents.actions.changeOrder")}
            </Button>
            <Button size="sm" disabled={doc.status === "draft" || doc.recipients.length === 0} onClick={onShare}>
              {t("documents.actions.resendLink")}
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <Cap>{t("documents.actions.completionCertificate")}</Cap>
          <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
            <MetaRow
              label={t("documents.detail.documentId")}
              value={<span className="font-mono text-[11px]">{doc.objectId}</span>}
            />
            <MetaRow
              label={t("documents.detail.finalHash")}
              value={
                doc.documentHash ? (
                  <span className="font-mono text-[11px] break-all">{doc.documentHash}</span>
                ) : (
                  <span className="text-muted-2">{t("documents.detail.hashPending")}</span>
                )
              }
            />
            <MetaRow
              label={t("documents.detail.signingCertificate")}
              value={
                doc.isCompleted ? (
                  <span className="flex items-center gap-1.5 text-accent">
                    <ShieldCheck className="size-3.5" strokeWidth={1.6} />
                    {t("documents.detail.pkcs7")}
                  </span>
                ) : (
                  <span className="text-muted-2">{t("documents.detail.certPending")}</span>
                )
              }
            />
            <MetaRow
              label={t("documents.detail.statusLabel")}
              value={
                doc.isCompleted
                  ? t("documents.detail.completedOn", { date: longDate(doc.updatedAt) })
                  : doc.isDeclined
                    ? t("documents.detail.declinedNoCert")
                    : t("documents.detail.notCompleted")
              }
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate("/verify")}>
              {t("documents.actions.verifyCopy")}
            </Button>
            <Button size="sm" disabled={!doc.url} onClick={onDownloadOriginal}>
              {t("documents.actions.downloadOriginal")}
            </Button>
            {doc.isCompleted ? (
              <Button size="sm" onClick={onDownloadCertificate}>
                {t("documents.actions.downloadCertificate")}
              </Button>
            ) : null}
          </div>
        </Card>

        {doc.chain || doc.chainedFromId ? (
          <Card className="p-4">
            <Cap>{t("documents.detail.chainTitle")}</Cap>
            <div className="mt-3 flex flex-col gap-2 text-[13px] text-ink-2">
              {doc.chainedFromId ? (
                <p>
                  <Trans
                    i18nKey="documents.detail.chainedFrom"
                    components={{
                      docLink: (
                        <Link
                          to={`/documents/${doc.chainedFromId}`}
                          className="text-accent hover:underline"
                        />
                      )
                    }}
                  />
                </p>
              ) : null}
              {doc.chain ? (
                doc.chainResult ? (
                  doc.chainResult.status === "sent" && doc.chainResult.documentId ? (
                    <p>
                      <Trans
                        i18nKey="documents.detail.chainSent"
                        values={{ name: doc.chain.name || doc.chain.templateName || "" }}
                        components={{
                          docLink: (
                            <Link
                              to={`/documents/${doc.chainResult.documentId}`}
                              className="text-accent hover:underline"
                            />
                          )
                        }}
                      />
                    </p>
                  ) : (
                    <p className="text-danger">
                      {t("documents.detail.chainFailed", {
                        name: doc.chain.name || doc.chain.templateName || "",
                        error: doc.chainResult.error || ""
                      })}
                    </p>
                  )
                ) : (
                  <p>
                    {t("documents.detail.chainPending", {
                      name: doc.chain.name || doc.chain.templateName || ""
                    })}
                  </p>
                )
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Cap>{t("documents.tabs.audit")}</Cap>
          <span className="num text-[11px] text-muted-2">{num(doc.audit.length)}</span>
          {doc.isCompleted ? (
            <Button size="xs" className="ml-auto" onClick={onDownloadCertificate}>
              {t("documents.actions.exportPdf")}
            </Button>
          ) : null}
        </div>
        <div className="mt-3">
          <AuditList events={doc.audit.slice(-6)} />
        </div>
      </Card>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-36 shrink-0 text-muted-2 text-[12px]">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-2">{value}</dd>
    </div>
  );
}

const STATE_LABEL: Record<Recipient["state"], { tone: PillTone; key: string }> = {
  signed: { tone: "success", key: "documents.recipientState.signed" },
  turn: { tone: "accent", key: "documents.recipientState.turn" },
  viewed: { tone: "warn", key: "documents.recipientState.viewed" },
  waiting: { tone: "neutral", key: "documents.recipientState.waiting" },
  declined: { tone: "danger", key: "documents.recipientState.declined" }
};

function RecipientRow({ recipient, ordered }: { recipient: Recipient; ordered: boolean }) {
  const { t } = useTranslation();
  const s = STATE_LABEL[recipient.state];
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0">
      {ordered ? <span className="num text-[11px] text-muted-2 w-3">{num(recipient.order + 1)}</span> : null}
      <Avatar name={recipient.name} email={recipient.email} size={26} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{recipient.name || recipient.email}</div>
        <div className="text-[11px] text-muted-2 truncate">
          {recipient.role}
          {recipient.email ? ` · ${recipient.email}` : ""}
        </div>
        {recipient.openCount > 0 ? (
          <div className="text-[11px] text-muted-2 truncate">
            {t("documents.detail.openedTimes", {
              count: recipient.openCount,
              when: whenShort(recipient.lastOpenedAt)
            })}
          </div>
        ) : null}
      </div>
      <div className="text-right shrink-0">
        {recipient.state === "signed" ? (
          <span className="text-[12px] text-muted num">
            {t("documents.detail.signedAt", { when: stamp(recipient.signedAt) })}
          </span>
        ) : recipient.state === "declined" ? (
          <Pill tone="danger">
            {recipient.declineReason
              ? t("documents.detail.declinedWithReason", { reason: recipient.declineReason })
              : t("documents.recipientState.declined")}
          </Pill>
        ) : (
          <Pill tone={s.tone}>{t(s.key)}</Pill>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- audit trail */

const ACTIVITY_DOT: Record<string, string> = {
  Created: "var(--color-muted-2)",
  Viewed: "var(--color-warn)",
  Signed: "var(--color-accent)",
  Declined: "var(--color-danger)"
};

function AuditList({ events, full }: { events: AuditEvent[]; full?: boolean }) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return <p className="text-[13px] text-muted">{t("documents.detail.auditEmpty")}</p>;
  }
  return (
    <ol className={cn("flex flex-col", full && "bg-surface border border-line rounded-xl px-4")}>
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 py-2.5 border-b border-line-soft last:border-0">
          <span className="font-mono text-[11px] text-muted-2 w-[92px] shrink-0 pt-0.5">{stamp(e.at) || "-"}</span>
          <span
            className="size-1.5 rounded-full mt-[6px] shrink-0"
            style={{ background: ACTIVITY_DOT[e.activity] ?? "var(--color-faint)" }}
          />
          <span className="text-[13px] flex-1 min-w-0">
            <span className="font-medium">{e.actorName}</span>{" "}
            {e.activity === "Signed"
              ? t("documents.audit.signed")
              : e.activity === "Viewed"
                ? t("documents.audit.viewed")
                : t("documents.audit.other", { activity: e.activity.toLowerCase() })}
            {e.actorEmail ? <span className="text-muted-2"> {e.actorEmail}</span> : null}
          </span>
          {e.ip ? <span className="font-mono text-[11px] text-muted-2 shrink-0">{e.ip}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------------------- opens */

/**
 * Who opened the signing link and how often. The counts ride on the document
 * row; the individual opens come from the owner-only log, so a non-owner
 * viewing the page sees nothing here rather than an error.
 */
function OpensPanel({ doc }: { doc: Document }) {
  const { t } = useTranslation();
  const opens = useDocumentOpens(doc.objectId, doc.status !== "draft");
  const opened = doc.recipients.filter((r) => r.openCount > 0);
  const total = opened.reduce((n, r) => n + r.openCount, 0);
  if (opens.isError) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Cap>{t("documents.detail.opensTitle")}</Cap>
        <span className="num text-[11px] text-muted-2">{num(total)}</span>
      </div>
      {total === 0 ? (
        <p className="text-[13px] text-muted">{t("documents.detail.opensEmpty")}</p>
      ) : (
        <div className="bg-surface border border-line rounded-xl px-4">
          {opened.map((r) => (
            <div key={r.objectId || r.email} className="flex items-center gap-3 py-2.5 border-b border-line-soft last:border-0">
              <Avatar name={r.name} email={r.email} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{r.name || r.email}</div>
                <div className="text-[11px] text-muted-2 truncate">
                  {t("documents.detail.opensFirst", { when: whenShort(r.firstOpenedAt) })}
                  {" · "}
                  {t("documents.detail.opensLast", { when: whenShort(r.lastOpenedAt) })}
                </div>
              </div>
              <span className="num text-[13px] shrink-0">{t("documents.detail.opensCount", { count: r.openCount })}</span>
            </div>
          ))}
        </div>
      )}
      {opens.isLoading ? (
        <Loader2 className="size-4 animate-spin text-muted-2" />
      ) : opens.data?.opens.length ? (
        <ol className="bg-surface border border-line rounded-xl px-4 flex flex-col">
          {opens.data.opens.map((o) => (
            <li key={o.id} className="flex items-start gap-3 py-2 border-b border-line-soft last:border-0 text-[12px]">
              <span className="font-mono text-[11px] text-muted-2 w-[92px] shrink-0 pt-0.5">{stamp(o.at) || "-"}</span>
              <span className="flex-1 min-w-0 truncate">
                <span className="font-medium">{o.name || o.email}</span> {t("documents.audit.viewed")}
              </span>
              {o.ip ? <span className="font-mono text-[11px] text-muted-2 shrink-0">{o.ip}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-[11px] text-muted-2">{t("documents.detail.opensHint")}</p>
    </section>
  );
}

/* -------------------------------------------------------------------- fields */

function FieldsTab({ fields, currentPage, highlighted }: { fields: DocField[]; currentPage: number; highlighted: number }) {
  const { t } = useTranslation();
  if (fields.length === 0) {
    return <EmptyState title={t("documents.detail.noFieldsTitle")} body={t("documents.detail.noFieldsBody")} />;
  }
  return (
    <Card className="overflow-hidden">
      <div className="h-[34px] grid items-center gap-3 px-3 bg-surface-2 border-b border-line" style={{ gridTemplateColumns: "110px 1fr 56px 70px 1fr" }}>
        <Cap>{t("documents.table.type")}</Cap>
        <Cap>{t("documents.table.assignedTo")}</Cap>
        <Cap>{t("documents.table.page")}</Cap>
        <Cap>{t("documents.table.required")}</Cap>
        <Cap>{t("documents.table.value")}</Cap>
      </div>
      {fields.map((f) => (
        <div
          key={f.key}
          className={cn(
            "min-h-[42px] grid items-center gap-3 px-3 py-1.5 border-b border-line-soft last:border-0 text-[13px]",
            f.page === currentPage && highlighted > 0 && "bg-accent-tint"
          )}
          style={{ gridTemplateColumns: "110px 1fr 56px 70px 1fr" }}
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="swatch size-2 rounded-[2px] shrink-0" style={{ ["--swatch" as string]: f.color, background: "var(--swatch-on)" }} />
            <span className="truncate">{fieldTypeLabel(t, f.type)}</span>
          </span>
          <span className="truncate min-w-0">
            {f.signerName}
            {f.name ? <span className="font-mono text-[10px] text-muted-2"> {f.name}</span> : null}
          </span>
          <span className="num text-muted">{num(f.page)}</span>
          <span className="text-muted">{f.required ? t("documents.fields.required") : t("documents.fields.optional")}</span>
          <span className="min-w-0 truncate">
            {f.image ? (
              <img src={f.image} alt="" className="h-6 object-contain" />
            ) : f.value ? (
              <span className="truncate">{f.value}</span>
            ) : (
              <span className="text-muted-2">{t("documents.fields.notFilled")}</span>
            )}
          </span>
        </div>
      ))}
    </Card>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsTab({ doc }: { doc: Document }) {
  const { t } = useTranslation();
  const update = useUpdateSettings();
  const setChainMut = useSetChain();
  const templates = useTemplates();
  const editable = doc.status === "draft" || doc.status === "in_progress";
  const [expiry, setExpiry] = useState(doc.expiryDate ? doc.expiryDate.slice(0, 10) : "");
  const [reminders, setReminders] = useState(doc.settings.automaticReminders);
  const [remindEvery, setRemindEvery] = useState(String(doc.settings.remindOnceInEvery ?? 5));
  const [otp, setOtp] = useState(doc.settings.isEnableOTP);
  const [notify, setNotify] = useState(doc.settings.notifyOnSignatures);
  const [allowMods, setAllowMods] = useState(doc.settings.allowModifications);
  const [chainTplId, setChainTplId] = useState(doc.chain?.templateId ?? "");
  const [confirmOtp, setConfirmOtp] = useState(false);

  useEffect(() => {
    setExpiry(doc.expiryDate ? doc.expiryDate.slice(0, 10) : "");
    setReminders(doc.settings.automaticReminders);
    setRemindEvery(String(doc.settings.remindOnceInEvery ?? 5));
    setOtp(doc.settings.isEnableOTP);
    setNotify(doc.settings.notifyOnSignatures);
    setAllowMods(doc.settings.allowModifications);
    setChainTplId(doc.chain?.templateId ?? "");
  }, [doc]);

  const chainDirty = chainTplId !== (doc.chain?.templateId ?? "");
  const dirty =
    expiry !== (doc.expiryDate ? doc.expiryDate.slice(0, 10) : "") ||
    reminders !== doc.settings.automaticReminders ||
    remindEvery !== String(doc.settings.remindOnceInEvery ?? 5) ||
    otp !== doc.settings.isEnableOTP ||
    notify !== doc.settings.notifyOnSignatures ||
    allowMods !== doc.settings.allowModifications ||
    chainDirty;

  const save = () => {
    if (chainDirty) {
      const tpl = (templates.data ?? []).find((x) => x.id === chainTplId);
      setChainMut.mutate(
        {
          docId: doc.objectId,
          chain: chainTplId ? { templateId: chainTplId, templateName: tpl?.name } : null
        },
        { onError: (e: Error) => toast.error(t("documents.toast.settingsFailed"), e.message) }
      );
    }
    update.mutate(
      {
        docId: doc.objectId,
        createdAt: doc.createdAt,
        patch: {
          expiryDate: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : undefined,
          automaticReminders: reminders,
          remindOnceInEvery: Number(remindEvery) || 5,
          isEnableOTP: otp,
          notifyOnSignatures: notify,
          allowModifications: allowMods
        }
      },
      {
        onSuccess: () => toast.success(t("documents.toast.settingsSaved"), doc.name),
        onError: (e: Error) => toast.error(t("documents.toast.settingsFailed"), e.message)
      }
    );
  };

  return (
    <Card className="p-5 max-w-2xl">
      {!editable ? (
        <p className="mb-4 text-[12px] text-muted bg-sand rounded-md px-3 py-2">
          {t("documents.settings.readOnly", { status: t(`documents.statusLower.${doc.status}`) })}
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        <Field label={t("documents.fields.expiresOn")} hint={t("documents.settings.expiryHint")}>
          <Input type="date" value={expiry} disabled={!editable} onChange={(e) => setExpiry(e.target.value)} className="w-48" />
        </Field>

        <SettingRow
          label={t("documents.settings.automaticReminders")}
          hint={t("documents.settings.automaticRemindersHint")}
        >
          <Toggle
            checked={reminders}
            disabled={!editable}
            onChange={setReminders}
            label={t("documents.settings.automaticReminders")}
          />
        </SettingRow>

        {reminders ? (
          <Field label={t("documents.settings.remindEvery")} hint={t("documents.settings.remindEveryHint")}>
            <Input
              type="number"
              min={1}
              max={30}
              value={remindEvery}
              disabled={!editable}
              onChange={(e) => setRemindEvery(e.target.value)}
              className="w-24"
            />
          </Field>
        ) : null}

        <SettingRow label={t("documents.settings.otp")} hint={t("documents.settings.otpHint")}>
          <Toggle
            checked={otp}
            disabled={!editable}
            onChange={(v) => (v ? setConfirmOtp(true) : setOtp(false))}
            label={t("documents.settings.otpToggle")}
          />
        </SettingRow>

        <SettingRow label={t("documents.settings.notify")} hint={t("documents.settings.notifyHint")}>
          <Toggle
            checked={notify}
            disabled={!editable}
            onChange={setNotify}
            label={t("documents.settings.notifyToggle")}
          />
        </SettingRow>

        <SettingRow label={t("documents.settings.allowMods")} hint={t("documents.settings.allowModsHint")}>
          <Toggle
            checked={allowMods}
            disabled={!editable}
            onChange={setAllowMods}
            label={t("documents.settings.allowModsToggle")}
          />
        </SettingRow>

        <SettingRow label={t("documents.settings.signingOrder")} hint={t("documents.settings.signingOrderHint")}>
          <span className="text-[13px] text-muted">
            {doc.settings.sendInOrder
              ? doc.settings.sendInOrderStrict
                ? t("documents.settings.orderStrict")
                : t("documents.settings.orderSequential")
              : t("documents.settings.orderParallel")}
          </span>
        </SettingRow>

        <Field label={t("send.more.chainLabel")} hint={t("send.more.chainHint")}>
          <Select
            value={chainTplId}
            disabled={!editable}
            onChange={(e) => setChainTplId(e.target.value)}
            className="max-w-sm"
            aria-label={t("send.more.chainLabel")}
          >
            <option value="">{t("send.more.chainNone")}</option>
            {doc.chain && !(templates.data ?? []).some((x) => x.id === doc.chain?.templateId) ? (
              <option value={doc.chain.templateId}>
                {doc.chain.templateName || doc.chain.templateId}
              </option>
            ) : null}
            {(templates.data ?? []).map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {editable ? (
        <div className="mt-6 flex items-center gap-2">
          <Button variant="primary" disabled={!dirty} loading={update.isPending || setChainMut.isPending} onClick={save}>
            {t("common.actions.saveChanges")}
          </Button>
          <span className="text-[11px] text-muted-2 flex items-center gap-1.5">
            <Kbd>Esc</Kbd> {t("documents.hints.backToDocuments")}
          </span>
        </div>
      ) : null}

      <Dialog
        open={confirmOtp}
        onClose={() => setConfirmOtp(false)}
        title={t("documents.dialog.otp.title")}
        description={t("documents.dialog.otp.description")}
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmOtp(false)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setOtp(true);
                setConfirmOtp(false);
              }}
            >
              {t("documents.settings.otpToggle")}
            </Button>
          </>
        }
      />
    </Card>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink-2">{label}</div>
        {hint ? <div className="text-[11px] text-muted-2 mt-0.5">{hint}</div> : null}
      </div>
      <div className="pt-0.5 shrink-0">{children}</div>
    </div>
  );
}
