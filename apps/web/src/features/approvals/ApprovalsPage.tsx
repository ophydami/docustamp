import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button, Card, EmptyState, Pill, Tabs, type TabItem } from "@/components/ui";
import { cn } from "@/lib/cn";
import { num, whenShort } from "@/lib/format";
import { useEmailVerification } from "@/features/settings/api";
import { VerifyEmailCard } from "@/features/settings/VerifyEmailCard";
import { useApprovals } from "./api";
import { agentLabel, approvalPill, senderLabel } from "./parts";
import type { Approval, ApprovalFilter } from "./types";

/** Column track shared by the header and every row (768px and up; below that rows stack). */
const GRID =
  "hidden md:grid grid-cols-[minmax(0,1fr)_120px_96px] @min-[700px]:grid-cols-[minmax(0,1fr)_200px_100px_120px_96px] gap-3 items-center px-3.5";
/** Cells that only exist in the wider tier. Keep in step with GRID. */
const WIDE = "hidden @min-[700px]:block";

/**
 * Approvals: a connected app wants to sign a document someone else sent you,
 * and asks here first. Pending ones need you; All keeps the history of what
 * was signed, declined or expired. Each row opens the full request.
 */
export default function ApprovalsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ApprovalFilter>("pending");
  const pending = useApprovals("pending");
  const all = useApprovals("all");
  const verification = useEmailVerification();
  const query = tab === "pending" ? pending : all;
  const rows = query.data ?? [];
  const pendingCount = pending.data?.length ?? 0;
  const needsVerify = verification.data?.verified === false && pendingCount > 0;

  const tabs: TabItem<ApprovalFilter>[] = [
    {
      value: "pending",
      label: t("approvals.tabs.pending"),
      count: pending.data ? num(pendingCount) : undefined,
      countTone: "accent"
    },
    { value: "all", label: t("approvals.tabs.all"), count: all.data ? num(all.data.length) : undefined }
  ];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin">
      <div className="px-4 py-4 lg:px-6 lg:py-5 flex flex-col gap-4 [&>*]:shrink-0">
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">{t("approvals.intro")}</p>

        {needsVerify ? <VerifyEmailCard variant="inline" reason={t("approvals.verifyReason")} className="max-w-[560px]" /> : null}

        <Tabs items={tabs} value={tab} onChange={setTab} />

        <Card role="table" className="@container overflow-hidden">
          <div
            role="row"
            className={cn("h-[34px] border-b border-line font-mono text-[10px] uppercase tracking-[.06em] text-muted", GRID)}
          >
            <span>{t("approvals.table.document")}</span>
            <span className={WIDE}>{t("approvals.table.app")}</span>
            <span className={WIDE}>{t("approvals.table.requested")}</span>
            <span>{t("approvals.table.status")}</span>
            <span className="text-right">{t("approvals.table.action")}</span>
          </div>

          {query.isLoading ? (
            <SkeletonRows />
          ) : query.isError ? (
            <EmptyState
              title={t("approvals.errors.loadFailed")}
              body={query.error instanceof Error ? query.error.message : t("common.errors.generic")}
              action={
                <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void query.refetch()}>
                  {t("common.actions.tryAgain")}
                </Button>
              }
            />
          ) : rows.length ? (
            rows.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} onOpen={() => navigate(`/approvals/${approval.id}`)} />
            ))
          ) : (
            <EmptyState
              title={t(tab === "pending" ? "approvals.empty.pendingTitle" : "approvals.empty.allTitle")}
              body={t("approvals.empty.body")}
              action={<Button onClick={() => navigate("/settings/api")}>{t("approvals.empty.manageApps")}</Button>}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function ApprovalRow({ approval, onOpen }: { approval: Approval; onOpen: () => void }) {
  const { t } = useTranslation();
  const pill = approvalPill(approval.status, t);
  const pending = approval.status === "pending";
  const sender = senderLabel(approval.document);
  const action = (
    <Button
      size="xs"
      variant={pending ? "primary" : "default"}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {pending ? t("approvals.actions.review") : t("common.actions.open")}
    </Button>
  );

  return (
    <>
      <div role="row" onClick={onOpen} className="md:hidden border-b border-line last:border-b-0 px-4 py-3 flex flex-col gap-2 text-[13px]">
        <div className="min-w-0">
          <span className="block font-medium text-ink truncate">{approval.document.title}</span>
          <span className="block text-[11.5px] text-muted truncate">
            {sender ? t("approvals.row.from", { sender }) : null}
          </span>
        </div>
        <span className="font-mono text-[11.5px] text-ink-2 truncate">{agentLabel(approval.agent)}</span>
        <div className="flex items-center gap-2 min-w-0">
          <Pill tone={pill.tone} dot>
            {pill.text}
          </Pill>
          <span className="num text-[12px] text-muted">{whenShort(approval.createdAt)}</span>
          <span className="ml-auto shrink-0">{action}</span>
        </div>
      </div>

      <div
        role="row"
        onClick={onOpen}
        className={cn(
          "h-[52px] border-b border-line last:border-b-0 cursor-pointer text-[13px] hover:bg-surface-2",
          GRID,
          pending && "shadow-[inset_2px_0_0_var(--color-accent)]"
        )}
      >
        <div className="min-w-0">
          <div className="font-medium text-ink truncate">{approval.document.title}</div>
          <div className="text-[11.5px] text-muted truncate">{sender ? t("approvals.row.from", { sender }) : null}</div>
        </div>
        <span className={cn(WIDE, "font-mono text-[11.5px] text-ink-2 truncate")} title={agentLabel(approval.agent)}>
          {agentLabel(approval.agent)}
        </span>
        <span className={cn(WIDE, "num text-[12px] text-muted")}>{whenShort(approval.createdAt)}</span>
        <span className="min-w-0">
          <Pill tone={pill.tone} dot className="max-w-full">
            <span className="truncate">{pill.text}</span>
          </Pill>
        </span>
        <div className="flex justify-end">{action}</div>
      </div>
    </>
  );
}

function SkeletonRows() {
  return (
    <div className="animate-pulse" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          <div className="md:hidden border-b border-line-soft px-4 py-3 flex flex-col gap-2.5">
            <span className="h-3 w-2/3 rounded bg-line-soft" />
            <span className="h-2.5 w-1/2 rounded bg-line-soft" />
            <span className="h-5 w-24 rounded-full bg-line-soft" />
          </div>
          <div className={cn("h-[52px] border-b border-line-soft", GRID)}>
            <span className="flex flex-col gap-1.5">
              <span className="h-3 w-2/3 rounded bg-line-soft" />
              <span className="h-2.5 w-1/3 rounded bg-line-soft" />
            </span>
            <span className={cn(WIDE, "h-3 w-32 rounded bg-line-soft")} />
            <span className={cn(WIDE, "h-3 w-12 rounded bg-line-soft")} />
            <span className="h-5 w-20 rounded-full bg-line-soft" />
            <span className="h-6 w-14 rounded-md bg-line-soft justify-self-end" />
          </div>
        </div>
      ))}
    </div>
  );
}
