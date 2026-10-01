import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudError, SERVER_URL, cloud, parseHeaders } from "@/lib/parse";
import { useAuth } from "@/app/auth";
import { useBadges } from "@/lib/store";
import type { Approval, ApprovalDecision, ApprovalFilter, ApprovalPage } from "./types";

/** Everything here lives under ["approvals"], so one invalidation refreshes the lists, the detail and the badge. */
export const approvalKeys = {
  all: ["approvals"] as const,
  list: (status: ApprovalFilter) => ["approvals", "list", status] as const,
  detail: (id: string) => ["approvals", "detail", id] as const,
  page: (id: string, page: number) => ["approvals", "page", id, page] as const
};

/**
 * `cloud()` for functions that answer an Approval itself. An Approval carries
 * its own `error` (why a signing failed), and `cloud()` reads a string `error`
 * in a result as the call failing, so a failed approval would look like a
 * missing one. This only treats a Parse error envelope as a failure.
 */
async function approvalCall<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SERVER_URL}/functions/${name}`, {
    method: "POST",
    headers: parseHeaders(),
    body: JSON.stringify(params)
  });
  const json = (await res.json().catch(() => ({}))) as { result?: T; error?: unknown; code?: number };
  if (!res.ok || json.error !== undefined) {
    throw new CloudError(typeof json.error === "string" ? json.error : `${name} failed: HTTP ${res.status}`, json.code);
  }
  return json.result as T;
}

async function fetchApprovals(status: ApprovalFilter): Promise<Approval[]> {
  const res = await cloud<{ approvals?: Approval[] }>("listsignapprovals", { status });
  return Array.isArray(res?.approvals) ? res.approvals : [];
}

/** `listsignapprovals { status }`, newest first as the server sends them. */
export function useApprovals(status: ApprovalFilter) {
  return useQuery({
    queryKey: approvalKeys.list(status),
    queryFn: () => fetchApprovals(status),
    staleTime: 15_000
  });
}

/** `getsignapproval { id }`. A pending one is checked again every 20 seconds, in case the chat decided it. */
export function useApproval(id: string | undefined) {
  return useQuery({
    queryKey: approvalKeys.detail(id ?? ""),
    queryFn: () => approvalCall<Approval>("getsignapproval", { id }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 20_000 : false)
  });
}

function fetchPage(id: string, page: number) {
  return cloud<ApprovalPage>("getsignapprovalpage", { id, page });
}

/**
 * `getsignapprovalpage { id, page }` -> a PNG data URL. Pages do not change
 * while the request is open, so they stay cached, and the next page is
 * fetched ahead so paging feels instant.
 */
export function useApprovalPage(id: string | undefined, page: number, pageCount: number) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: approvalKeys.page(id ?? "", page),
    queryFn: () => fetchPage(id as string, page),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
    retry: 1
  });

  useEffect(() => {
    if (!id || !query.data || page >= pageCount) return;
    void qc.prefetchQuery({
      queryKey: approvalKeys.page(id, page + 1),
      queryFn: () => fetchPage(id, page + 1),
      staleTime: 10 * 60_000
    });
  }, [id, page, pageCount, query.data, qc]);

  return query;
}

/** `decidesignapproval { id, decision }` -> the approval as it now stands (signed, declined or failed). */
export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: ApprovalDecision }) =>
      approvalCall<Approval>("decidesignapproval", input),
    onSuccess: (approval) => {
      if (approval?.id) qc.setQueryData(approvalKeys.detail(approval.id), approval);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
      // The document itself moved on (signed for you), so the inbox and documents are stale too.
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["documents"] });
    }
  });
}

/**
 * Keeps the sidebar's Approvals count in step with the pending list. Mounted
 * once by the app shell's sidebar. A server without approvals answers with an
 * error, which leaves the count at zero and stops the polling.
 */
export function useApprovalsBadge() {
  const { user } = useAuth();
  const setBadges = useBadges((s) => s.setBadges);
  const pending = useQuery({
    queryKey: approvalKeys.list("pending"),
    queryFn: () => fetchApprovals("pending"),
    enabled: Boolean(user),
    staleTime: 15_000,
    retry: false,
    refetchInterval: (q) => (q.state.status === "error" ? false : 60_000)
  });
  const count = pending.data?.length ?? 0;
  useEffect(() => {
    setBadges({ approvals: count });
  }, [count, setBadges]);
}
