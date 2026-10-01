import { useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { ArrowUpRight, ChevronLeft, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Cap, Card, EmptyState } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import { askAssistant, callTool, openUrl, tellModel } from "./bridge";
import { Banner, DocRowItem, DocSubline, N, PagePreview, RecipientRow, Skel, RowsSkeleton, StatusPill } from "./ui";
import { shortDate, signedCount } from "./format";
import type { DocRow, DocumentData, HomeData, ListData } from "./types";

export interface ViewContext {
  app: App;
  ext: OpenAIExtensions | null;
  locale?: string;
}

const icon = (Icon: typeof Send) => <Icon className="size-3.5" strokeWidth={1.6} />;

/* ------------------------------------------------------------------ actions */

type Busy = "" | "send" | "remind" | "extend" | "void";

/**
 * What a document's buttons do. Every action goes through the ordinary tool
 * (send_document, send_reminder...), then the view reloads the document and
 * tells the model what the user did, so the conversation stays in step.
 */
function useDocumentActions(ctx: ViewContext, data: DocumentData, onChanged: (next: DocumentData) => void) {
  const { app, ext } = ctx;
  const doc = data.document;
  const [busy, setBusy] = useState<Busy>("");
  const [result, setResult] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);

  async function run(kind: Busy, work: () => Promise<string>) {
    setBusy(kind);
    setResult(null);
    try {
      const done = await work();
      onChanged(
        await callTool<DocumentData>(app, "app_document", {
          documentId: doc.objectId
        })
      );
      setResult({ tone: "success", text: done });
      await tellModel(
        ext,
        `${done} (${doc.name}, document id ${doc.objectId}; done by the user in the DocuStamp app.)`
      );
    } catch (err) {
      setResult({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy("");
      setConfirmVoid(false);
    }
  }

  return {
    busy,
    result,
    confirmVoid,
    setConfirmVoid,
    send: () =>
      run("send", async () => {
        await callTool(app, "send_document", { documentId: doc.objectId });
        return `Sent for signature to ${doc.signers.map((s) => s.name || s.email).join(", ")}.`;
      }),
    remind: () =>
      run("remind", async () => {
        await callTool(app, "send_reminder", { documentId: doc.objectId });
        return "Reminder sent to everyone who has not signed yet.";
      }),
    extend: () =>
      run("extend", async () => {
        await callTool(app, "extend_expiry", {
          documentId: doc.objectId,
          days: 7
        });
        return "Deadline moved to 7 days from today.";
      }),
    voidIt: () =>
      run("void", async () => {
        await callTool(app, "void_document", { documentId: doc.objectId });
        return "Voided. The signing links no longer work.";
      }),
    fixInChat: () =>
      askAssistant(
        app,
        ext,
        `Fix what stops the draft "${doc.name}" (document id ${doc.objectId}) from being sent, then show it to me again.`
      )
  };
}

/* ------------------------------------------------------------------ document */

export function DocumentView({
  ctx,
  data,
  onBack,
  onChanged
}: {
  ctx: ViewContext;
  data: DocumentData;
  onBack?: () => void;
  onChanged: (next: DocumentData) => void;
}) {
  const { app, locale } = ctx;
  const doc = data.document;
  const a = useDocumentActions(ctx, data, onChanged);
  const isDraft = doc.status === "draft";
  const live = doc.status === "in_progress";
  const ready = Boolean(data.review?.readyToSend);
  const { signed, total } = signedCount(doc.signers);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-5 md:px-6">
      {onBack ? (
        <Button size="xs" variant="ghost" className="-ml-2 self-start" icon={icon(ChevronLeft)} onClick={onBack}>
          Documents
        </Button>
      ) : null}

      <header>
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight tracking-[-.015em]">{doc.name}</h1>
          <StatusPill status={doc.status} className="mt-1.5" />
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          <span className="font-mono text-[11px]">{doc.objectId}</span>
          {doc.sentAt ? (
            <>
              {" · Sent "}
              <N>{shortDate(doc.sentAt, locale)}</N>
            </>
          ) : null}
          {live && doc.expiresAt ? (
            <>
              {" · Due "}
              <N>{shortDate(doc.expiresAt, locale)}</N>
            </>
          ) : null}
          {doc.status === "completed" ? (
            <>
              {" · Completed "}
              <N>{shortDate(doc.completedAt || doc.updatedAt, locale)}</N>
            </>
          ) : null}
          {isDraft ? (
            <>
              {" · "}
              <N>{doc.fieldCount ?? 0}</N> fields
            </>
          ) : (
            <>
              {" · "}
              <N>{signed}</N> of <N>{total}</N> signed
            </>
          )}
        </p>
        {doc.status === "declined" ? (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            Declined{doc.declineReason ? `: ${doc.declineReason}` : "."}
          </p>
        ) : null}
      </header>

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-line bg-surface-2 p-3 md:p-4">
          <div className="mx-auto max-w-[520px]">
            <PagePreview
              app={app}
              documentId={doc.objectId}
              title={doc.name}
              source={doc.status === "completed" ? "signed" : "original"}
              startPage={data.previewPage}
            />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {isDraft && data.review ? (
            ready ? (
              <Banner tone="success">Ready to send. Check the pages, then send it.</Banner>
            ) : (
              <Card className="p-4">
                <div className="flex items-baseline gap-2">
                  <Cap>Before it can be sent</Cap>
                  <span className="num text-[11px] text-muted-2">{data.review.errors.length}</span>
                </div>
                <ul className="mt-2.5 flex flex-col gap-1.5 text-[12.5px] text-danger">
                  {data.review.errors.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-danger" />
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )
          ) : null}
          {isDraft && data.review?.warnings.length ? (
            <Banner tone="warn">{data.review.warnings.map((w) => w.message).join(" ")}</Banner>
          ) : null}

          <Card className="p-4">
            <div className="flex items-baseline gap-2">
              <Cap>{isDraft ? "Recipients" : "Signers"}</Cap>
              <span className="num text-[11px] text-muted-2">{total}</span>
            </div>
            <div className="mt-2 flex flex-col">
              {total ? (
                doc.signers.map((s, i) => (
                  <RecipientRow key={`${s.email}-${i}`} signer={s} draft={isDraft} locale={locale} />
                ))
              ) : (
                <p className="py-2 text-[13px] text-muted">No recipients yet.</p>
              )}
            </div>
          </Card>

          {a.result ? <Banner tone={a.result.tone}>{a.result.text}</Banner> : null}

          <div className="flex flex-col gap-2">
            {isDraft && data.canWrite ? (
              ready ? (
                <Button
                  variant="primary"
                  block
                  icon={icon(Send)}
                  loading={a.busy === "send"}
                  disabled={a.busy !== ""}
                  onClick={() => void a.send()}
                >
                  Send for signature
                </Button>
              ) : (
                <Button variant="primary" block onClick={() => void a.fixInChat()}>
                  Fix in chat
                </Button>
              )
            ) : null}

            {live && data.canWrite ? (
              <>
                <Button
                  variant="primary"
                  block
                  loading={a.busy === "remind"}
                  disabled={a.busy !== ""}
                  onClick={() => void a.remind()}
                >
                  Send a reminder
                </Button>
                <Button block loading={a.busy === "extend"} disabled={a.busy !== ""} onClick={() => void a.extend()}>
                  Extend deadline by 7 days
                </Button>
                {a.confirmVoid ? (
                  <div className="flex flex-col gap-2.5 rounded-xl border border-danger-line bg-surface p-3">
                    <p className="text-[12.5px] leading-relaxed text-ink-2">
                      Void this document? The signing links stop working and the people who have not signed are told it
                      was withdrawn.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        loading={a.busy === "void"}
                        disabled={a.busy !== ""}
                        onClick={() => void a.voidIt()}
                      >
                        Void document
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => a.setConfirmVoid(false)}>
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="danger" block onClick={() => a.setConfirmVoid(true)}>
                    Void document
                  </Button>
                )}
              </>
            ) : null}

            {doc.status === "completed" && doc.urls?.signed ? (
              <Button variant="primary" block onClick={() => void openUrl(app, doc.urls?.signed)}>
                Download signed PDF
              </Button>
            ) : null}
            {doc.status === "completed" && doc.urls?.certificate ? (
              <Button block onClick={() => void openUrl(app, doc.urls?.certificate)}>
                Completion certificate
              </Button>
            ) : null}

            {!data.canWrite && (isDraft || live) ? (
              <p className="text-[12px] text-muted">
                This connection can only read. Reconnect DocuStamp and allow changes to send or remind.
              </p>
            ) : null}

            {doc.urls?.app ? (
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 self-start text-[12.5px] text-accent hover:text-accent-deep"
                onClick={() => void openUrl(app, doc.urls?.app)}
              >
                Open in DocuStamp
                <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocumentSkeleton() {
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-5 md:px-6" role="status" aria-label="Loading">
      <div className="flex flex-col gap-2.5">
        <Skel className="h-6 w-1/2" />
        <Skel className="h-3 w-1/3" />
      </div>
      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
        <Skel className="aspect-[8.5/11] w-full rounded-xl" />
        <div className="flex flex-col gap-4">
          <Skel className="h-28 w-full rounded-xl" />
          <Skel className="h-8 w-full" />
        </div>
      </div>
    </div>
  );
}

/** One document as a card in the chat: at most one main and one second action. */
export function DocumentCard({
  ctx,
  data,
  onExpand,
  onChanged
}: {
  ctx: ViewContext;
  data: DocumentData;
  onExpand: () => void;
  onChanged: (next: DocumentData) => void;
}) {
  const { app, locale } = ctx;
  const doc = data.document;
  const a = useDocumentActions(ctx, data, onChanged);
  const isDraft = doc.status === "draft";
  const ready = Boolean(data.review?.readyToSend);

  let main: { label: string; run: () => void; busy?: boolean } | null = null;
  if (data.canWrite && isDraft && ready)
    main = {
      label: "Send for signature",
      run: () => void a.send(),
      busy: a.busy === "send"
    };
  else if (data.canWrite && isDraft) main = { label: "Fix in chat", run: () => void a.fixInChat() };
  else if (data.canWrite && doc.status === "in_progress")
    main = {
      label: "Send a reminder",
      run: () => void a.remind(),
      busy: a.busy === "remind"
    };
  else if (doc.status === "completed" && doc.urls?.signed)
    main = {
      label: "Download signed PDF",
      run: () => void openUrl(app, doc.urls?.signed)
    };

  return (
    <div className="flex gap-3 p-3">
      <div className="w-16 shrink-0">
        <PagePreview
          app={app}
          documentId={doc.objectId}
          title={doc.name}
          source={doc.status === "completed" ? "signed" : "original"}
          startPage={data.previewPage}
          compact
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{doc.name}</div>
            <div className="truncate text-[11.5px] text-muted">
              <DocSubline doc={doc} locale={locale} />
            </div>
          </div>
          <StatusPill status={doc.status} className="shrink-0" />
        </div>
        {isDraft && data.review && !ready ? (
          <p className="text-[12px] text-danger">{data.review.errors[0]?.message ?? "Not ready to send yet."}</p>
        ) : null}
        {a.result ? <Banner tone={a.result.tone}>{a.result.text}</Banner> : null}
        <div className="mt-auto flex flex-wrap gap-2">
          {main ? (
            <Button size="sm" variant="primary" loading={main.busy} disabled={a.busy !== ""} onClick={main.run}>
              {main.label}
            </Button>
          ) : null}
          <Button size="sm" onClick={onExpand}>
            {isDraft ? "Review pages" : "Open"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ lists */

type Tab = "waiting" | "drafts" | "completed";

const EMPTY: Record<Tab, { title: string; body: string }> = {
  waiting: {
    title: "Nothing in progress",
    body: "Documents you send show up here until everyone has signed."
  },
  drafts: {
    title: "No drafts",
    body: "Ask in the chat to prepare a document for signature."
  },
  completed: {
    title: "Nothing completed yet",
    body: "Signed documents show up here with their certificate."
  }
};

function count(n: number, limit: number) {
  return n >= limit ? `${limit}+` : n;
}

/** The sidebar app: every document, by where it stands. */
export function HomeView({ ctx, data, onOpen }: { ctx: ViewContext; data: HomeData; onOpen: (doc: DocRow) => void }) {
  const [tab, setTab] = useState<Tab>(data.waiting.length || !data.drafts.length ? "waiting" : "drafts");
  const rows = data[tab];
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-5 md:px-6">
      <header className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 text-[20px] font-semibold leading-tight tracking-[-.015em]">Documents</h1>
        {data.canWrite ? (
          <Button
            variant="primary"
            icon={icon(Plus)}
            onClick={() => void askAssistant(ctx.app, ctx.ext, "I want to send a document for signature.")}
          >
            New document
          </Button>
        ) : null}
      </header>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "waiting",
            label: "In progress",
            count: count(data.waiting.length, data.limit)
          },
          {
            value: "drafts",
            label: "Drafts",
            count: count(data.drafts.length, data.limit)
          },
          {
            value: "completed",
            label: "Completed",
            count: count(data.completed.length, data.limit)
          }
        ]}
        right={
          data.appUrl ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:text-accent-deep"
              onClick={() => void openUrl(ctx.app, `${data.appUrl}/documents`)}
            >
              All in DocuStamp
              <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
            </button>
          ) : undefined
        }
      />

      <Card className="overflow-hidden">
        {rows.length ? (
          rows.map((doc) => <DocRowItem key={doc.objectId} doc={doc} onOpen={onOpen} locale={ctx.locale} />)
        ) : (
          <EmptyState title={EMPTY[tab].title} body={EMPTY[tab].body} className="py-12" />
        )}
      </Card>
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-5 md:px-6">
      <Skel className="h-6 w-40" />
      <Skel className="h-4 w-72" />
      <Card className="overflow-hidden">
        <RowsSkeleton />
      </Card>
    </div>
  );
}

function Section({
  title,
  rows,
  empty,
  ctx,
  onOpen
}: {
  title: string;
  rows: DocRow[];
  empty: string;
  ctx: ViewContext;
  onOpen: (doc: DocRow) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1.5">
        <Cap>{title}</Cap>
        <span className="num text-[11px] text-muted-2">{rows.length}</span>
      </div>
      {rows.length ? (
        rows.map((doc) => <DocRowItem key={doc.objectId} doc={doc} onOpen={onOpen} locale={ctx.locale} />)
      ) : (
        <p className="px-3 pb-3 text-[12.5px] text-muted">{empty}</p>
      )}
    </Card>
  );
}

/** The panel beside a conversation: drafts to check first, then what is in progress. */
export function PanelView({ ctx, data, onOpen }: { ctx: ViewContext; data: HomeData; onOpen: (doc: DocRow) => void }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Section
        title="Drafts"
        rows={data.drafts}
        empty="No drafts. Ask in the chat to prepare one."
        ctx={ctx}
        onOpen={onOpen}
      />
      <Section
        title="In progress"
        rows={data.waiting}
        empty="Nothing is waiting on signers."
        ctx={ctx}
        onOpen={onOpen}
      />
    </div>
  );
}

const FILTER_TITLE: Record<ListData["filter"], string> = {
  waiting: "In progress",
  draft: "Drafts",
  completed: "Completed",
  all: "Recent documents"
};

/** A short list as a card in the chat, with one way into the full app. */
export function ListCard({
  ctx,
  data,
  onOpen,
  onOpenAll
}: {
  ctx: ViewContext;
  data: ListData;
  onOpen: (doc: DocRow) => void;
  onOpenAll: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1.5">
        <Cap>{FILTER_TITLE[data.filter]}</Cap>
        <span className="num text-[11px] text-muted-2">
          {data.items.length}
          {data.more ? "+" : ""}
        </span>
      </div>
      {data.items.length ? (
        data.items.map((doc) => <DocRowItem key={doc.objectId} doc={doc} onOpen={onOpen} locale={ctx.locale} />)
      ) : (
        <p className="px-3 pb-2 text-[12.5px] text-muted">No documents here.</p>
      )}
      <div className="border-t border-line-soft px-3 py-2.5">
        <Button size="sm" onClick={onOpenAll}>
          {data.more ? "See all in DocuStamp" : "Open DocuStamp"}
        </Button>
      </div>
    </div>
  );
}

/** The sidebar app's summary when the model shows it inline: counts and one way in. */
export function HomeCard({ data, onOpen }: { data: HomeData; onOpen: () => void }) {
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">Documents</div>
        <div className="text-[11.5px] text-muted">
          <N>{data.waiting.length}</N> in progress · <N>{data.drafts.length}</N> drafts · <N>{data.completed.length}</N>{" "}
          completed
        </div>
      </div>
      <Button size="sm" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}
