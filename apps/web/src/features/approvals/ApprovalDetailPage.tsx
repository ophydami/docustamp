import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, ArrowUpRight, Bot, CheckCircle2, ChevronLeft, ChevronRight, Clock, PenLine, XCircle } from "lucide-react";
import { Button, Cap, Card, Dialog, EmptyState, Pill, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num, whenShort } from "@/lib/format";
import { useSignInBrand } from "@/lib/brand";
import { useEmailVerification } from "@/features/settings/api";
import { VerifyEmailCard } from "@/features/settings/VerifyEmailCard";
import { useApproval, useApprovalPage, useDecideApproval } from "./api";
import { ReviewPanel } from "./ReviewPanel";
import { agentLabel, approvalPill, fieldTypeLabel, formatValue, isNumericValue, mismatchedNames, senderLabel, stampOf } from "./parts";
import type { Approval, ApprovalDecision, ApprovalValue, NameCheck, RuleReason } from "./types";

/**
 * One sign approval: the page as it stands, what the agent will fill in, the
 * AI's read of the terms, and Approve and sign / Decline, each behind a
 * confirm step. Once decided it shows the outcome and links to the document.
 * When the document prints someone else's name for the person's party, an
 * amber warning says so above everything else. The approval email links here.
 */
export default function ApprovalDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const q = useApproval(id);
  const decide = useDecideApproval();
  const verification = useEmailVerification();
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<ApprovalDecision | null>(null);

  const approval = q.data;

  if (q.isLoading) return <DetailSkeleton />;

  if (q.isError || !approval) {
    return (
      <div className="flex-1 flex flex-col">
        <Header title={t("app.nav.approvals")} onBack={() => navigate("/approvals")} />
        <EmptyState
          className="flex-1"
          title={t("approvals.errors.notFoundTitle")}
          body={q.error instanceof Error ? q.error.message : t("approvals.errors.notFoundBody")}
          action={<Button onClick={() => navigate("/approvals")}>{t("approvals.actions.backToList")}</Button>}
        />
      </div>
    );
  }

  const pending = approval.status === "pending";
  const pill = approvalPill(approval.status, t);
  const agent = agentLabel(approval.agent);
  const sender = senderLabel(approval.document);
  const unverified = verification.data?.verified === false;
  const pageCount = Math.max(1, approval.document.pageCount || 1);
  const nameCheck = approval.nameCheck?.status === "mismatch" ? approval.nameCheck : null;
  // Only when the person's rules are on: with them off, everything comes here and there is no "why".
  const ruleReasons = approval.ruleCheck?.enabled ? (approval.ruleCheck.reasons ?? []).filter((r) => r?.text) : [];

  async function onDecide(decision: ApprovalDecision) {
    if (!approval) return;
    try {
      const result = await decide.mutateAsync({ id: approval.id, decision });
      setConfirm(null);
      if (result?.status === "signed") toast.success(t("approvals.toast.signed"), t("approvals.toast.signedBody", { agent: approval.agent.name }));
      else if (result?.status === "declined") toast.show(t("approvals.toast.declined"));
      else if (result?.status === "failed") toast.error(t("approvals.toast.failed"), result.error ?? undefined);
    } catch (err) {
      setConfirm(null);
      toast.error(t("approvals.toast.failed"), (err as Error).message);
    }
  }

  const actions = pending ? (
    <>
      <Button
        size="sm"
        variant="danger"
        icon={<XCircle className="size-3.5" strokeWidth={1.6} />}
        disabled={decide.isPending}
        onClick={() => setConfirm("decline")}
      >
        {t("approvals.actions.decline")}
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon={<PenLine className="size-3.5" strokeWidth={1.6} />}
        disabled={decide.isPending || unverified}
        onClick={() => setConfirm("approve")}
      >
        {t("approvals.actions.approve")}
      </Button>
    </>
  ) : (
    <Link to={`/documents/${approval.document.id}`}>
      <Button size="sm" iconRight={<ArrowUpRight className="size-3.5" strokeWidth={1.6} />}>
        {t("approvals.actions.openDocument")}
      </Button>
    </Link>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Header title={approval.document.title} onBack={() => navigate("/approvals")}>
        {actions}
      </Header>

      {/* Side by side from 1024 up; below that the page stacks above the details. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden scroll-thin">
        <PagePreview approvalId={approval.id} page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />

        <div className="flex-1 min-w-0 lg:overflow-auto scroll-thin">
          <div className="max-w-[760px] px-4 md:px-6 pt-5 pb-8 flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight tracking-[-.015em]">
                  {approval.document.title}
                </h1>
                <Pill tone={pill.tone} dot className="mt-1.5">
                  {pill.text}
                </Pill>
              </div>
              <p className="text-[12px] leading-relaxed text-muted">
                {sender ? <span>{t("approvals.row.from", { sender })}</span> : null}
                {approval.document.senderEmail ? <span> · {approval.document.senderEmail}</span> : null}
                <span> · {t("common.count.page", { count: pageCount })}</span>
                <span>
                  {" · "}
                  <Trans
                    i18nKey="approvals.detail.requested"
                    values={{ when: whenShort(approval.createdAt) }}
                    components={[<span key="when" className="num" />]}
                  />
                </span>
              </p>
              <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5">
                <Bot className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.6} />
                <p className="text-[13px] leading-relaxed text-ink-2">
                  <Trans
                    i18nKey={pending ? "approvals.detail.agentAsks" : "approvals.detail.agentAsked"}
                    values={{ agent }}
                    components={[<span key="agent" className="font-mono text-[12px] text-ink" />]}
                  />
                </p>
              </div>
            </div>

            {nameCheck ? <NameMismatch check={nameCheck} pending={pending} onPage={setPage} /> : null}

            {ruleReasons.length ? <RuleReasons reasons={ruleReasons} pending={pending} /> : null}

            {!pending ? <Outcome approval={approval} /> : null}

            {pending && unverified ? <VerifyEmailCard variant="inline" reason={t("approvals.verifyReason")} /> : null}

            <section className="flex flex-col gap-2">
              <Cap>
                {t(
                  pending
                    ? "approvals.values.title"
                    : approval.status === "signed"
                      ? "approvals.values.titleSigned"
                      : "approvals.values.titleNotSigned"
                )}
              </Cap>
              <Card className="overflow-hidden">
                {approval.values.length ? (
                  <ul className="divide-y divide-line-soft">
                    {approval.values.map((v) => (
                      <li key={v.key} className="flex items-baseline gap-3 px-4 py-2.5">
                        <div className="flex w-[40%] shrink-0 flex-col">
                          <span className="truncate text-[13px] text-ink">{v.label || fieldTypeLabel(v.type, t)}</span>
                          <span className="text-[11px] text-muted">{fieldTypeLabel(v.type, t)}</span>
                        </div>
                        <span
                          className={cn(
                            "min-w-0 flex-1 break-words text-[13px] text-ink-2",
                            isNumericValue(v) && "num",
                            v.imageUrl && "self-center"
                          )}
                        >
                          {v.imageUrl ? <SavedImage value={v} /> : formatValue(v.value, t)}
                        </span>
                        {v.page ? (
                          <button
                            type="button"
                            onClick={() => setPage(v.page as number)}
                            className="num shrink-0 text-[11px] text-muted hover:text-accent"
                            aria-label={t("approvals.preview.goToPage", { page: v.page })}
                          >
                            {t("approvals.preview.pageShort", { page: num(v.page) })}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-3 text-[13px] text-muted">{t("approvals.values.none")}</p>
                )}
              </Card>
            </section>

            <section className="flex flex-col gap-2">
              <Cap>{t("approvals.review.section")}</Cap>
              <ReviewPanel review={approval.review} pending={pending} onPage={setPage} />
            </section>

            {pending ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <span className="mr-auto text-[12px] text-muted">{t("approvals.detail.footerHint")}</span>
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Dialog
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        title={t("approvals.confirm.approveTitle")}
        description={t("approvals.confirm.approveBody", { agent: approval.agent.name, title: approval.document.title })}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<PenLine className="size-3.5" strokeWidth={1.6} />}
              loading={decide.isPending}
              onClick={() => void onDecide("approve")}
            >
              {t("approvals.actions.approve")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {nameCheck ? (
            <p className="rounded-md bg-warn-soft px-3 py-2 text-[12px] leading-relaxed text-warn-ink">
              {t("approvals.nameCheck.confirm", { expected: nameCheck.expected, names: mismatchedNames(nameCheck) })}
            </p>
          ) : null}
          <p className="text-[12px] leading-relaxed text-muted">{t("approvals.confirm.approveNote")}</p>
        </div>
      </Dialog>

      <Dialog
        open={confirm === "decline"}
        onClose={() => setConfirm(null)}
        title={t("approvals.confirm.declineTitle")}
        description={t("approvals.confirm.declineBody", { agent: approval.agent.name })}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="danger" loading={decide.isPending} onClick={() => void onDecide("decline")}>
              {t("approvals.actions.decline")}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

function Header({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-[52px] shrink-0 bg-surface border-b border-line flex items-center gap-3 px-4 py-1.5 flex-wrap">
      <button type="button" onClick={onBack} aria-label={t("approvals.actions.backToList")} className="text-muted hover:text-ink p-1 -ml-1">
        <ArrowLeft className="size-4" strokeWidth={1.6} />
      </button>
      <nav className="text-[13px] text-muted-2 flex items-center gap-1.5 min-w-0">
        <Link to="/approvals" className="hover:text-ink text-muted-2">
          {t("app.nav.approvals")}
        </Link>
        <span>/</span>
        <span className="text-ink truncate max-w-[12rem] xl:max-w-[26rem]">{title}</span>
      </nav>
      {children ? <div className="ml-auto flex items-center gap-2 flex-wrap">{children}</div> : null}
    </div>
  );
}

/**
 * "This document names Cameron Brooks as the Tenant, not you." The agent
 * always signs as the account holder, so the page and the signature would
 * disagree; approving is the person's confirmation that they sign for that
 * party anyway. Amber, the warning tint, with the page it is printed on.
 */
function NameMismatch({ check, pending, onPage }: { check: NameCheck; pending: boolean; onPage: (page: number) => void }) {
  const { t } = useTranslation();
  const page = check.printed.find((p) => !p.matches)?.page;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-warn-soft px-3.5 py-2.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <p className="text-[13px] leading-relaxed text-warn-ink">
          <Trans
            i18nKey={check.role ? "approvals.nameCheck.mismatch" : "approvals.nameCheck.mismatchNoRole"}
            values={{ names: mismatchedNames(check), role: check.role }}
            components={[<span key="names" className="font-semibold" />]}
          />
        </p>
        {pending ? (
          <p className="text-[12px] leading-relaxed text-warn-ink">{t("approvals.nameCheck.hint", { expected: check.expected })}</p>
        ) : null}
      </div>
      {page ? (
        <button
          type="button"
          onClick={() => onPage(page)}
          className="num shrink-0 text-[11px] text-warn-ink hover:underline underline-offset-2"
          aria-label={t("approvals.preview.goToPage", { page })}
        >
          {t("approvals.preview.pageShort", { page: num(page) })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Why the person's rules sent this here instead of letting the agent sign it:
 * "It's over your $25,000 limit", "It renews automatically". The sentences are
 * the server's; the link goes to the rules.
 */
function RuleReasons({ reasons, pending }: { reasons: RuleReason[]; pending: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="rule-reasons-title">
      <div className="flex items-baseline justify-between gap-3">
        <Cap id="rule-reasons-title">{t(pending ? "approvals.rules.title" : "approvals.rules.titleDecided")}</Cap>
        <Link to="/settings/rules" className="text-[12px] font-medium text-accent hover:underline underline-offset-2">
          {t("approvals.rules.edit")}
        </Link>
      </div>
      <Card className="px-4 py-3">
        <ul className="flex flex-col gap-1.5">
          {reasons.map((r, i) => (
            <li key={`${r.code}-${i}`} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
              <span className="mt-[8px] size-1 shrink-0 rounded-full bg-muted-2" aria-hidden />
              <span className="min-w-0">{r.text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** What happened, once the request is no longer pending, with the way back to the document. */
function Outcome({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  // The product the person approved in ("DocuStamp"), not their workspace name.
  const product = useSignInBrand();
  const when = stampOf(approval.decidedAt);
  const docLink = (
    <Link to={`/documents/${approval.document.id}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline underline-offset-2">
      {t("approvals.actions.openDocument")}
      <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
    </Link>
  );

  const tones = {
    signed: { box: "border-transparent bg-success-soft", icon: <CheckCircle2 className="size-4 text-success" strokeWidth={1.8} />, title: "text-success-ink" },
    declined: { box: "border-line bg-surface-2", icon: <XCircle className="size-4 text-muted" strokeWidth={1.8} />, title: "text-ink" },
    failed: { box: "border-danger-line bg-danger-soft", icon: <XCircle className="size-4 text-danger" strokeWidth={1.8} />, title: "text-danger" },
    expired: { box: "border-line bg-surface-2", icon: <Clock className="size-4 text-muted" strokeWidth={1.8} />, title: "text-ink" }
  } as const;
  if (approval.status === "pending") return null;
  const tone = tones[approval.status];

  let title = "";
  let body: ReactNode = null;
  if (approval.status === "signed") {
    title = t("approvals.outcome.signedTitle");
    body = (
      <>
        <span className="block">
          {approval.decidedVia === "chat"
            ? t("approvals.outcome.signedBodyChat", { agent: approval.agent.name })
            : t("approvals.outcome.signedBodyWeb", { agent: approval.agent.name, product: product.name })}
        </span>
        {approval.signatureSaved ? (
          <span className="block">{t("approvals.outcome.signatureSaved", { product: product.name })}</span>
        ) : null}
      </>
    );
  } else if (approval.status === "declined") {
    title = t("approvals.outcome.declinedTitle");
    body = t("approvals.outcome.declinedBody");
  } else if (approval.status === "failed") {
    title = t("approvals.outcome.failedTitle");
    body = (
      <>
        {approval.error ? <span className="block">{approval.error}</span> : null}
        <span className="block">{t("approvals.outcome.failedBody")}</span>
      </>
    );
  } else {
    title = t("approvals.outcome.expiredTitle");
    body = t("approvals.outcome.expiredBody");
  }

  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", tone.box)}>
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("text-[13px] font-semibold", tone.title)}>{title}</span>
          {when ? <span className="num text-[11.5px] text-muted">{when}</span> : null}
        </div>
        <div className="text-[12.5px] leading-relaxed text-ink-2">{body}</div>
        <div className="pt-0.5">{docLink}</div>
      </div>
    </div>
  );
}

/**
 * The signature or initials the person saved, which approving stamps, on white
 * paper in both themes like the page itself. The link is short-lived, so an
 * image that no longer loads falls back to the name.
 */
function SavedImage({ value }: { value: ApprovalValue }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  if (!value.imageUrl || broken) return <>{formatValue(value.value, t)}</>;
  return (
    <span className="paper-white inline-flex rounded-sm border border-line-soft px-2 py-1">
      <img
        src={value.imageUrl}
        alt={t(value.type === "initials" ? "approvals.values.savedInitials" : "approvals.values.savedSignature")}
        className="block h-9 max-w-[180px] object-contain"
        onError={() => setBroken(true)}
      />
    </span>
  );
}

/** The page images from `getsignapprovalpage`, one at a time with a pager. */
function PagePreview({
  approvalId,
  page,
  pageCount,
  onPage
}: {
  approvalId: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const image = useApprovalPage(approvalId, page, pageCount);

  return (
    <div className="w-full lg:w-[560px] shrink-0 border-b lg:border-b-0 lg:border-r border-line flex flex-col bg-paper h-[60vh] lg:h-auto">
      <div className="h-11 shrink-0 bg-surface border-b border-line flex items-center gap-2 px-4">
        <span className="font-mono text-[11px] text-muted">
          {t("approvals.preview.page", { current: num(page), total: num(pageCount) })}
        </span>
        <span className="ml-auto flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("approvals.preview.previous")}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            icon={<ChevronLeft className="size-3.5" />}
          />
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("approvals.preview.next")}
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
            icon={<ChevronRight className="size-3.5" />}
          />
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-5 py-5 flex justify-center">
        {image.isLoading ? (
          <div aria-hidden className="w-full max-w-[460px] aspect-[8.5/11] rounded-sm bg-surface shadow-[var(--shadow-page)] animate-pulse" />
        ) : image.isError || !image.data?.image ? (
          <EmptyState
            title={t("approvals.preview.failedTitle")}
            body={t("approvals.preview.failedBody")}
            action={
              <Button size="sm" onClick={() => void image.refetch()}>
                {t("common.actions.tryAgain")}
              </Button>
            }
          />
        ) : (
          <img
            src={image.data.image}
            alt={t("approvals.preview.alt", { page })}
            className="paper-white w-full max-w-[460px] h-fit rounded-sm shadow-[var(--shadow-page)]"
          />
        )}
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex-1 min-h-0 flex flex-col" aria-hidden>
      <div className="h-[52px] shrink-0 bg-surface border-b border-line" />
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row animate-pulse">
        <div className="w-full lg:w-[560px] shrink-0 border-b lg:border-b-0 lg:border-r border-line bg-paper h-[50vh] lg:h-auto px-5 py-16 flex justify-center">
          <div className="w-full max-w-[460px] aspect-[8.5/11] rounded-sm bg-surface" />
        </div>
        <div className="flex-1 px-6 pt-6 flex flex-col gap-3">
          <span className="h-5 w-1/2 rounded bg-line-soft" />
          <span className="h-3 w-1/3 rounded bg-line-soft" />
          <span className="mt-4 h-24 w-full max-w-[700px] rounded-lg bg-line-soft" />
          <span className="h-40 w-full max-w-[700px] rounded-lg bg-line-soft" />
        </div>
      </div>
    </div>
  );
}
