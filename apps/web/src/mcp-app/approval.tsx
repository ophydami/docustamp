import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Cap, Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { askAssistant, callTool, openUrl, tellModel } from "./bridge";
import { agentName, approvalStatusOf, isNumeric, overallOf, severityOf, shortDate, stamp, valueText } from "./format";
import { Banner, N, PagePreview } from "./ui";
import { RefreshButton, type ViewContext } from "./views";
import type { Approval, ApprovalData, ApprovalValue, ContractReview, NameCheck, SavedImages } from "./types";

/*
  A request from the user's agent to sign a document someone else sent them
  (sign_document answered `view: 'approval'`). The card shows what will be
  signed, what goes into the user's fields and the AI's read of the terms,
  then lets the user decide.

  Approving from the card needs the single-use approval code the host handed
  this page in the tool result's `_meta` (App.tsx keeps it in memory). It is
  sent nowhere but app_decide_approval. Hosts where the model could read that
  code get `chatApproval: false` and approve in DocuStamp instead.
*/

const FLAGS_SHOWN = 3;

const TYPE_LABEL: Record<string, string> = {
  signature: "Signature",
  initials: "Initials",
  name: "Name",
  email: "Email",
  company: "Company",
  "job title": "Job title",
  date: "Date",
  text: "Text",
  number: "Number",
  checkbox: "Checkbox",
  radio: "Choice",
  dropdown: "Choice",
  cells: "Boxes"
};

type Decision = "approve" | "decline";

/** app_decide_approval and app_approval answer `{ approval }`; a bare approval is read too. */
function approvalOf(result: { approval?: Approval } & Partial<Approval>): Approval | null {
  if (result?.approval) return result.approval;
  return result?.id && result.status ? (result as Approval) : null;
}

/** The approval's page in DocuStamp. `appUrl` may be that page already, or just the site. */
function approvalUrl(data: ApprovalData): string | undefined {
  const raw = data.appUrl?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "") return `${url.origin}/approvals/${encodeURIComponent(data.approval.id)}`;
    if (path === "/approvals") return `${url.origin}/approvals/${encodeURIComponent(data.approval.id)}`;
    return raw;
  } catch {
    return raw;
  }
}

/** The first page with one of the user's fields, where the preview opens. */
function firstPage(values: ApprovalValue[]): number {
  const pages = values.map((v) => Number(v.page)).filter((n) => n > 0);
  return pages.length ? Math.min(...pages) : 1;
}

function agentShort(approval: Approval): string {
  return approval.agent?.name?.trim() || "Your assistant";
}

/** What the user says in the chat after deciding on the card, so the model carries on. */
function chatFollowUp(approval: Approval): string | null {
  const title = approval.document.title;
  const ref = `document id ${approval.document.id}`;
  if (approval.status === "signed") return `I approved. DocuStamp signed "${title}" for me (${ref}).`;
  if (approval.status === "declined") return `I declined. Do not sign "${title}" (${ref}).`;
  if (approval.status === "failed")
    return `I approved "${title}" (${ref}), but DocuStamp could not sign it: ${approval.error || "no reason given."}`;
  return null;
}

/** What the model is told, quietly, when the user decided in DocuStamp instead. */
function webOutcome(approval: Approval): string | null {
  const title = approval.document.title;
  const ref = `document id ${approval.document.id}, approval ${approval.id}`;
  if (approval.status === "signed") return `The user approved in DocuStamp and DocuStamp signed "${title}" for them (${ref}).`;
  if (approval.status === "declined") return `The user declined in DocuStamp: do not sign "${title}" (${ref}).`;
  if (approval.status === "failed")
    return `The user approved "${title}" in DocuStamp (${ref}), but signing failed: ${approval.error || "no reason given."}`;
  if (approval.status === "expired")
    return `The request to sign "${title}" expired: the document changed or is no longer open for signing (${ref}).`;
  return null;
}

/** Deciding, and noticing a decision made in DocuStamp while the card was on screen. */
function useApproval(
  ctx: ViewContext,
  data: ApprovalData,
  nonce: string | null,
  onChanged: (approval: Approval) => void
) {
  const { app, ext } = ctx;
  const approval = data.approval;
  const [busy, setBusy] = useState<"" | Decision>("");
  const [error, setError] = useState("");
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [decidedElsewhere, setDecidedElsewhere] = useState(false);
  const decidedHere = useRef(false);
  const lastStatus = useRef(approval.status);

  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = approval.status;
    if (was !== "pending" || approval.status === "pending" || decidedHere.current) return;
    setDecidedElsewhere(approval.status !== "expired");
    const text = webOutcome(approval);
    if (text) void tellModel(ext, text);
  }, [approval, ext]);

  async function say(text: string) {
    try {
      await askAssistant(app, ext, text);
    } catch {
      await tellModel(ext, text);
    }
  }

  async function decide(decision: Decision) {
    if (!nonce) return;
    setBusy(decision);
    setError("");
    try {
      const next = approvalOf(
        await callTool(app, "app_decide_approval", { approvalId: approval.id, nonce, decision })
      );
      if (!next) throw new Error("DocuStamp did not say how it went. Check the approval in DocuStamp.");
      decidedHere.current = true;
      onChanged(next);
      const text = chatFollowUp(next);
      if (text) await say(text);
    } catch (err) {
      setError((err as Error).message);
      // It may have been decided in DocuStamp meanwhile: show where it stands now.
      try {
        const now = approvalOf(await callTool(app, "app_approval", { approvalId: approval.id }));
        if (now) onChanged(now);
      } catch {
        // Keep what is on screen.
      }
    } finally {
      setBusy("");
      setConfirmDecline(false);
    }
  }

  return {
    busy,
    error,
    confirmDecline,
    setConfirmDecline,
    decidedElsewhere,
    approve: () => void decide("approve"),
    decline: () => void decide("decline"),
    continueInChat: () => {
      const text = chatFollowUp(approval);
      if (text) void say(text.replace(/^I approved\. /, "I approved in DocuStamp. "));
    }
  };
}

type ApprovalState = ReturnType<typeof useApproval>;

/**
 * The signature and initials the user saved, which approving stamps, from the
 * app-only app_approval_images as data urls: this page loads nothing from the
 * network itself, and the server marks those values `savedImage` rather than
 * handing the model a link to the user's signature. Nothing to fetch
 * when none is saved (the name is typed) or once the request is decided.
 */
function useSavedImages(ctx: ViewContext, approval: Approval): SavedImages {
  const [images, setImages] = useState<SavedImages>({});
  const wanted = approval.status === "pending" && approval.values.some((v) => v.savedImage || v.imageUrl);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    callTool<SavedImages>(ctx.app, "app_approval_images", { approvalId: approval.id })
      .then((next) => live && setImages(next && typeof next === "object" ? next : {}))
      .catch(() => live && setImages({}));
    return () => {
      live = false;
    };
  }, [ctx.app, approval.id, wanted]);
  return wanted ? images : {};
}

/* ------------------------------------------------------------------ pieces */

function ApprovalPill({ status, className }: { status: string; className?: string }) {
  const s = approvalStatusOf(status);
  return (
    <Pill tone={s.tone} dot className={className}>
      {s.label}
    </Pill>
  );
}

/** The agent, as the record will name it: "ChatGPT (chatgpt.com)", in mono. */
function AgentTag({ approval }: { approval: Approval }) {
  return <span className="font-mono text-[11.5px] text-ink">{agentName(approval.agent)}</span>;
}

function sender(approval: Approval): string {
  const { senderName, senderCompany, senderEmail } = approval.document;
  const who = senderName || senderEmail || "Someone";
  return senderCompany && senderCompany !== who ? `${who}, ${senderCompany}` : who;
}

function ValuesList({ approval, images = {} }: { approval: Approval; images?: SavedImages }) {
  const title =
    approval.status === "pending"
      ? "What your agent will fill in"
      : approval.status === "signed"
        ? "What your agent filled in"
        : "What your agent would fill in";
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <Cap>{title}</Cap>
        <span className="num text-[11px] text-muted-2">{approval.values.length}</span>
      </div>
      {approval.values.length ? (
        <dl className="m-0 mt-1.5 flex flex-col">
          {approval.values.map((v, i) => {
            const text = valueText(v.value);
            const blank = v.value === "" || v.value === null || v.value === undefined;
            const image = v.type === "signature" || v.type === "initials" ? images[v.type] : undefined;
            return (
              <div
                key={`${v.key}-${i}`}
                className="flex items-baseline gap-3 border-b border-line-soft py-1.5 last:border-0"
              >
                <dt className="w-[38%] shrink-0 truncate text-[12px] text-muted" title={v.label || v.key}>
                  {v.label || TYPE_LABEL[v.type] || v.key}
                </dt>
                <dd
                  className={cn(
                    "m-0 min-w-0 flex-1 break-words text-[12.5px]",
                    blank ? "text-muted-2" : "text-ink",
                    !blank && isNumeric(v.type, text) && "num",
                    image && "self-center"
                  )}
                >
                  {image ? (
                    <span className="paper-white inline-flex rounded-sm border border-line-soft px-1.5 py-0.5">
                      <img
                        src={image}
                        alt={v.type === "initials" ? "Your saved initials" : "Your saved signature"}
                        className="block h-8 max-w-[160px] object-contain"
                      />
                    </span>
                  ) : (
                    text
                  )}
                </dd>
                {v.page ? <span className="num shrink-0 text-[11px] text-muted-2">p.{v.page}</span> : null}
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-muted">Only your signature.</p>
      )}
    </div>
  );
}

/** "Cameron Brooks" or "Cameron Brooks and Jordan Ellis": the printed names that are not the user. */
function otherNames(check: NameCheck): string {
  const names = check.printed.filter((p) => !p.matches).map((p) => p.name);
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The document prints someone else's name for the user's party. The agent
 * always signs as the account holder, so approving is the user saying they
 * sign for that party anyway.
 */
function NameWarning({ approval }: { approval: Approval }) {
  const check = approval.nameCheck;
  if (check?.status !== "mismatch") return null;
  const page = check.printed.find((p) => !p.matches)?.page;
  return (
    <Banner tone="warn">
      This document names <span className="font-semibold">{otherNames(check)}</span>{" "}
      {check.role ? `as the ${check.role}` : "next to your signature"}, not you.
      {page ? (
        <>
          {" "}
          <span className="num whitespace-nowrap">p.{page}</span>
        </>
      ) : null}
      {approval.status === "pending" ? (
        <span className="block pt-0.5 text-[12px]">
          {agentShort(approval)} signs as {check.expected}. Approve only if you really sign for that party.
        </span>
      ) : null}
    </Banner>
  );
}

/** The AI's read of the terms: one overall pill, a summary, the first few flags with their quotes. */
function ReviewBlock({ review, compact = false }: { review: ContractReview | null; compact?: boolean }) {
  if (!review)
    return (
      <div>
        <Cap>AI review</Cap>
        <p className="mt-1.5 text-[12.5px] text-muted">No AI review for this one. Read the pages before you approve.</p>
      </div>
    );
  const overall = overallOf(review.overall);
  const flags = review.flags || [];
  const shown = flags.slice(0, FLAGS_SHOWN);
  const more = flags.length - shown.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Cap>AI review</Cap>
        <Pill tone={overall.tone} dot className="ml-auto">
          {overall.label}
        </Pill>
      </div>
      {review.instructionsAimedAtAI ? (
        <Banner tone="danger">
          This document has text written to steer AI assistants. Read it yourself before you approve.
        </Banner>
      ) : null}
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">{review.summary}</p>
      {shown.length ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {shown.map((flag, i) => {
            const s = severityOf(flag.severity);
            return (
              <li key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Pill tone={s.tone} dot className="shrink-0">
                    {s.label}
                  </Pill>
                  <span className="min-w-0 flex-1 text-[12.5px] font-medium">{flag.title}</span>
                  {flag.page ? <span className="num shrink-0 text-[11px] text-muted-2">p.{flag.page}</span> : null}
                </div>
                {!compact && flag.why ? <p className="m-0 text-[12px] leading-relaxed text-muted">{flag.why}</p> : null}
                {flag.quote ? (
                  <blockquote
                    className={cn(
                      "m-0 border-l-2 border-line-strong pl-2.5 text-[12px] leading-relaxed text-ink-2",
                      compact && "line-clamp-2"
                    )}
                  >
                    &ldquo;{flag.quote}&rdquo;
                  </blockquote>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {more > 0 ? (
        <p className="m-0 text-[12px] text-muted">
          <N>+{more}</N> more in DocuStamp
        </p>
      ) : null}
      <p className="m-0 text-[11px] text-muted-2">{review.disclaimer || "This is not legal advice."}</p>
    </div>
  );
}

/** Where a decided request ended up. */
function Outcome({ approval, a, ctx, url }: { approval: Approval; a: ApprovalState; ctx: ViewContext; url?: string }) {
  const title = approval.document.title;
  const when = approval.decidedAt ? (
    <>
      {" "}
      <span className="num whitespace-nowrap">{stamp(approval.decidedAt, ctx.locale)}</span>
    </>
  ) : null;
  let banner;
  if (approval.status === "signed")
    banner = (
      <Banner tone="success">
        <span className="font-semibold">Signed.</span> DocuStamp signed &ldquo;{title}&rdquo; for you after you approved
        {approval.decidedVia === "web" ? " in DocuStamp" : " here"}.{when}
        {approval.signatureSaved ? (
          <span className="block pt-0.5 text-[12px]">
            We saved this as your signature. You can change it any time in DocuStamp Settings &gt; My signature and
            initials.
          </span>
        ) : null}
      </Banner>
    );
  else if (approval.status === "declined")
    banner = (
      <Banner tone="neutral">
        <span className="font-semibold">Declined.</span> {agentShort(approval)} will not sign &ldquo;{title}&rdquo; for you.
        {when}
      </Banner>
    );
  else if (approval.status === "failed")
    banner = (
      <Banner tone="danger">
        <span className="font-semibold">Not signed.</span> {approval.error || "DocuStamp could not sign it."}
      </Banner>
    );
  else if (approval.status === "expired")
    banner = (
      <Banner tone="neutral">
        <span className="font-semibold">Expired.</span> The document changed or is no longer open for signing. Ask{" "}
        {agentShort(approval)} again if you still want to sign it.
      </Banner>
    );
  else banner = <Banner tone="neutral">{approvalStatusOf(approval.status).label}</Banner>;

  const openApp = approval.status === "failed" && url;
  return (
    <div className="flex flex-col gap-2">
      {banner}
      {a.decidedElsewhere || openApp ? (
        <div className="flex flex-wrap gap-2">
          {a.decidedElsewhere ? <Button onClick={a.continueInChat}>Continue in chat</Button> : null}
          {openApp ? (
            <Button
              iconRight={<ArrowUpRight className="size-3.5" strokeWidth={1.6} />}
              onClick={() => void openUrl(ctx.app, url)}
            >
              Open in DocuStamp
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Approve / Decline when this host may decide here, else the way to DocuStamp. */
function Decide({
  ctx,
  data,
  nonce,
  a,
  block = false,
  extra
}: {
  ctx: ViewContext;
  data: ApprovalData;
  nonce: string | null;
  a: ApprovalState;
  block?: boolean;
  extra?: ReactNode;
}) {
  const approval = data.approval;
  const url = approvalUrl(data);
  if (approval.status !== "pending") return <Outcome approval={approval} a={a} ctx={ctx} url={url} />;

  if (!data.chatApproval || !nonce)
    return (
      <div className="flex flex-col gap-2">
        <div className={cn("flex gap-2", block ? "flex-col" : "flex-wrap items-center")}>
          {url ? (
            <Button
              variant="primary"
              block={block}
              iconRight={<ArrowUpRight className="size-3.5" strokeWidth={1.6} />}
              onClick={() => void openUrl(ctx.app, url)}
            >
              Approve in DocuStamp
            </Button>
          ) : null}
          {extra}
        </div>
        <p className="m-0 text-[12px] leading-relaxed text-muted">
          {data.chatApproval
            ? "This card can no longer approve here. Approve in DocuStamp instead."
            : "For your safety, this app can't approve from the chat. Approve in DocuStamp, where you are signed in. This card updates when you do."}
        </p>
      </div>
    );

  const agent = agentShort(approval);
  return (
    <div className="flex flex-col gap-2">
      {a.error ? <Banner tone="danger">{a.error}</Banner> : null}
      {a.confirmDecline ? (
        <div className="flex flex-col gap-2.5 rounded-xl border border-danger-line bg-surface p-3">
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
            Decline? {agent} will not sign &ldquo;{approval.document.title}&rdquo; for you.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" loading={a.busy === "decline"} disabled={a.busy !== ""} onClick={a.decline}>
              Decline
            </Button>
            <Button variant="ghost" disabled={a.busy !== ""} onClick={() => a.setConfirmDecline(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className={cn("flex gap-2", block ? "flex-col" : "flex-wrap items-center")}>
          <Button
            variant="primary"
            block={block}
            icon={<Check className="size-3.5" strokeWidth={1.8} />}
            loading={a.busy === "approve"}
            disabled={a.busy !== ""}
            onClick={a.approve}
          >
            Approve and sign
          </Button>
          <Button variant="danger" block={block} disabled={a.busy !== ""} onClick={() => a.setConfirmDecline(true)}>
            Decline
          </Button>
          {extra}
        </div>
      )}
      {a.confirmDecline ? null : (
        <p className="m-0 text-[12px] leading-relaxed text-muted">
          Approving signs your part now. The record shows {agent} signed for you, with your approval.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ views */

/** The request as a card in the chat. */
export function ApprovalCard({
  ctx,
  data,
  nonce,
  onChanged,
  onExpand
}: {
  ctx: ViewContext;
  data: ApprovalData;
  nonce: string | null;
  onChanged: (approval: Approval) => void;
  onExpand: () => void;
}) {
  const approval = data.approval;
  const a = useApproval(ctx, data, nonce, onChanged);
  const images = useSavedImages(ctx, approval);
  const pending = approval.status === "pending";
  return (
    <div className="flex flex-col">
      <div className="flex gap-3 p-3">
        <button
          type="button"
          aria-label="View pages"
          className="w-16 shrink-0 rounded-md p-0 text-left"
          onClick={onExpand}
        >
          <PagePreview
            app={ctx.app}
            documentId={approval.document.id}
            title={approval.document.title}
            startPage={firstPage(approval.values)}
            compact
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{approval.document.title}</div>
              <div className="truncate text-[11.5px] text-muted">
                From {sender(approval)}
                {approval.createdAt ? (
                  <>
                    {" · "}
                    <N>{shortDate(approval.createdAt, ctx.locale)}</N>
                  </>
                ) : null}
              </div>
            </div>
            <ApprovalPill status={approval.status} className="shrink-0" />
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-ink-2">
            <AgentTag approval={approval} /> {pending ? "asks to sign this for you." : "asked to sign this for you."}
          </p>
        </div>
      </div>
      {approval.nameCheck?.status === "mismatch" ? (
        <div className="px-3 pb-3">
          <NameWarning approval={approval} />
        </div>
      ) : null}
      <div className="border-t border-line-soft px-3 py-2.5">
        <ValuesList approval={approval} images={images} />
      </div>
      <div className="border-t border-line-soft px-3 py-2.5">
        <ReviewBlock review={approval.review} compact />
      </div>
      <div className="border-t border-line-soft p-3">
        <Decide
          ctx={ctx}
          data={data}
          nonce={nonce}
          a={a}
          extra={
            <Button variant="ghost" className="ml-auto" onClick={onExpand}>
              View pages
            </Button>
          }
        />
      </div>
    </div>
  );
}

/** The request full screen: the pages beside the values, the review and the decision. */
export function ApprovalView({
  ctx,
  data,
  nonce,
  onChanged,
  onBack,
  onRefresh,
  refreshing
}: {
  ctx: ViewContext;
  data: ApprovalData;
  nonce: string | null;
  onChanged: (approval: Approval) => void;
  onBack?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { app, locale } = ctx;
  const approval = data.approval;
  const a = useApproval(ctx, data, nonce, onChanged);
  const images = useSavedImages(ctx, approval);
  const pending = approval.status === "pending";
  const doc = approval.document;
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-5 md:px-6">
      <div className="-mx-2 -mb-2 flex items-center justify-between">
        {onBack ? (
          <Button size="xs" variant="ghost" icon={<ChevronLeft className="size-3.5" strokeWidth={1.6} />} onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />
      </div>

      <header>
        <Cap>Signature request</Cap>
        <div className="mt-1.5 flex items-start gap-3">
          <h1 className="m-0 min-w-0 flex-1 text-[22px] font-semibold leading-tight tracking-[-.015em]">{doc.title}</h1>
          <ApprovalPill status={approval.status} className="mt-1.5" />
        </div>
        <p className="mt-2 mb-0 text-[12px] leading-relaxed text-muted">
          From {sender(approval)}
          {doc.senderEmail && doc.senderName ? (
            <>
              {" "}
              <span className="font-mono text-[11px]">{doc.senderEmail}</span>
            </>
          ) : null}
          {approval.createdAt ? (
            <>
              {" · Asked "}
              <N>{stamp(approval.createdAt, locale)}</N>
            </>
          ) : null}
          {" · "}
          <span className="font-mono text-[11px]">{doc.id}</span>
        </p>
        <p className="mt-2 mb-0 text-[12.5px] text-ink-2">
          <AgentTag approval={approval} /> {pending ? "asks to sign your part." : "asked to sign your part."}
        </p>
      </header>

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-xl border border-line bg-surface-2 p-3 md:p-4">
          <div className="mx-auto max-w-[520px]">
            <PagePreview app={app} documentId={doc.id} title={doc.title} startPage={firstPage(approval.values)} />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <NameWarning approval={approval} />
          <Card className="p-4">
            <ValuesList approval={approval} images={images} />
          </Card>
          <Card className="p-4">
            <ReviewBlock review={approval.review} />
          </Card>
          <Decide ctx={ctx} data={data} nonce={nonce} a={a} block />
        </div>
      </div>
    </div>
  );
}
