import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { cloud, rest } from "@/lib/parse";
import { signerPlaceholders, toSeats } from "@/lib/recipients";
import { sendReminder } from "@/lib/reminder";
import { useAuth } from "@/app/auth";
import { useExtUser } from "@/lib/extUser";
import type { ActivityEntry, DocumentRecord, Recipient } from "./types";

/**
 * Where the inbox gets its data.
 *
 * `getReport` (BACKEND_API §9) is the only endpoint that expresses the status
 * buckets we need: its canned `where` clauses already encode draft / needs your
 * sign / in progress / completed / declined / expired, including the
 * `Signers $inQuery {UserId == me}` join that a client-side Parse.Query cannot
 * do against contracts_Contactbook without a second round trip. We fetch the
 * six buckets in parallel (skip 0, limit 200, ordered -updatedAt by the server)
 * and merge them into one list; counts are the bucket sizes.
 *
 * Two caveats the server forces on us:
 *  - §9.1: the "need your sign" report cannot express "and I have not signed
 *    yet", so those rows are filtered again here.
 *  - §11.12: DocumentAfterFind presigns the first 200 objects of a result, and
 *    these buckets are fetched at exactly that limit, so `URL` / `SignedUrl`
 *    on these rows are normally fetchable. They still age out (~200 s for
 *    local storage), and `window.open` gives no failure to retry from, so
 *    opening a PDF re-reads the document through `getDocument` first.
 */
const REPORTS = {
  drafts: "ByHuevtCFY",
  needsYou: "4Hhwbp482K",
  inProgress: "1MwEuxLEkF",
  completed: "kQUoW4hUXz",
  declined: "UPr2Fm5WY3",
  expired: "zNqBHXHsYH"
} as const;

type Bucket = keyof typeof REPORTS;

/** Rows past this are not fetched, so counts saturate here. */
export const PAGE_LIMIT = 200;

export interface Me {
  userId: string;
  email: string;
  extUserId?: string;
}

// ---------------------------------------------------------------- raw shapes

type RawDate = { __type?: string; iso?: string } | string;

interface RawContact {
  objectId?: string;
  Name?: string;
  Email?: string;
  Phone?: string;
  UserId?: { objectId?: string };
}

interface RawPlaceholder {
  Id?: number;
  Role?: string;
  email?: string;
  signerObjId?: string;
  signerPtr?: RawContact;
  placeHolder?: Array<{ pageNumber?: number }>;
}

interface RawAudit {
  UserPtr?: RawContact;
  Activity?: string;
  SignedOn?: RawDate;
  ViewedOn?: RawDate;
}

interface RawExtUser {
  objectId?: string;
  Name?: string;
  Email?: string;
}

interface RawDoc {
  objectId: string;
  Name?: string;
  Note?: string;
  URL?: string;
  SignedUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  DocSentAt?: RawDate;
  ExpiryDate?: RawDate;
  LastReminderAt?: RawDate;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  DeclineReason?: string;
  IsSignyourself?: boolean;
  SendinOrder?: boolean;
  Signers?: RawContact[];
  Placeholders?: RawPlaceholder[];
  AuditTrail?: RawAudit[];
  OpenStats?: Record<string, { count?: number; firstAt?: string; lastAt?: string }>;
  ExtUserPtr?: RawExtUser;
}

function iso(d: RawDate | undefined): string | undefined {
  if (!d) return undefined;
  const raw = typeof d === "string" ? d : d.iso;
  if (!raw) return undefined;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

function sameContact(entry: RawAudit, contactId?: string, email?: string) {
  const p = entry.UserPtr;
  if (!p) return false;
  if (contactId && p.objectId === contactId) return true;
  if (email && p.Email && p.Email.toLowerCase() === email) return true;
  return false;
}

// ------------------------------------------------------------------ mapping

/** Convert one getReport / getDocument row into a DocumentRecord. */
export function toDocument(raw: RawDoc, me: Me): DocumentRecord {
  const audit = Array.isArray(raw.AuditTrail) ? raw.AuditTrail : [];
  // Seats, their contacts and the "prefill" filter come from the shared rule in
  // @/lib/recipients, so the inbox and the documents page never name different
  // people for the same seat. `fallbackToSigners` is the inbox's own case: a
  // legacy row with no placeholders still lists its signers.
  const placeholders = signerPlaceholders(raw.Placeholders);
  const allSeats = toSeats<RawContact, RawPlaceholder>(raw.Placeholders, raw.Signers, {
    fallbackToSigners: true
  });

  // A placeholder with neither a bound contact nor an address is not a person:
  // self-sign documents and untouched drafts keep such seats for the owner's own
  // fields, and rendering them produced a nameless "?" recipient.
  const seats = allSeats.filter((seat) => !!seat.contact?.objectId || !!seat.email);

  const recipients: Recipient[] = seats.map((seat, i) => {
    const email = (seat.email ?? seat.contact?.Email ?? "").toLowerCase();
    const contactId = seat.contact?.objectId;
    const signed = audit.find((a) => a.Activity === "Signed" && sameContact(a, contactId, email));
    const viewed = audit.find((a) => a.Activity === "Viewed" && sameContact(a, contactId, email));
    const openStat = contactId ? raw.OpenStats?.[contactId] : undefined;
    return {
      order: i + 1,
      contactId,
      userId: seat.contact?.UserId?.objectId,
      name: seat.contact?.Name ?? email,
      email,
      role: seat.role,
      isMe: seat.contact?.UserId?.objectId === me.userId || (!!email && email === me.email),
      signedAt: iso(signed?.SignedOn) ?? (signed ? iso(signed.ViewedOn) : undefined),
      viewedAt: iso(viewed?.ViewedOn),
      openCount: openStat?.count ?? 0,
      lastOpenedAt: iso(openStat?.lastAt)
    };
  });

  const pages = placeholders
    .flatMap((p) => p.placeHolder ?? [])
    .map((p) => p.pageNumber ?? 0)
    .filter((n) => n > 0);
  const pageCount = pages.length ? Math.max(...pages) : undefined;

  const signedDates = audit
    .filter((a) => a.Activity === "Signed")
    .map((a) => iso(a.SignedOn))
    .filter((d): d is string => !!d)
    .sort();

  const expiryDate = iso(raw.ExpiryDate);
  const isDraft = !raw.SignedUrl;
  const isCompleted = raw.IsCompleted === true;
  const isDeclined = raw.IsDeclined === true;
  const isExpired =
    !isDraft && !isCompleted && !isDeclined && !!expiryDate && new Date(expiryDate) < new Date();

  const owner = raw.ExtUserPtr;
  const ownerEmail = owner?.Email?.toLowerCase();
  const isMine = me.extUserId ? owner?.objectId === me.extUserId : ownerEmail === me.email;
  const isSelfSign = raw.IsSignyourself === true;

  // Self-signed documents carry no Signers, so the owner is the only recipient.
  if (isSelfSign && !recipients.length) {
    recipients.push({
      order: 1,
      name: owner?.Name ?? owner?.Email ?? i18next.t("inbox.you"),
      email: ownerEmail ?? (isMine ? me.email : ""),
      isMe: isMine,
      signedAt: isCompleted ? (signedDates[signedDates.length - 1] ?? raw.updatedAt) : undefined
    });
  }

  const mine = recipients.find((r) => r.isMe);
  const open = !isDraft && !isCompleted && !isDeclined && !isExpired;
  let needsMe = false;
  if (open) {
    if (mine && !mine.signedAt) {
      // With SendinOrder the earlier signers must be done first (§6.5).
      needsMe = !raw.SendinOrder || recipients.slice(0, mine.order - 1).every((r) => r.signedAt);
    } else if (!recipients.length && isMine) {
      // Self-sign document waiting on its owner.
      needsMe = true;
    }
  }

  // A finished document is waiting on nobody, whatever the audit trail says.
  const pending = isCompleted || isDeclined ? [] : recipients.filter((r) => !r.signedAt);
  const nextSigner = raw.SendinOrder ? pending[0] : pending.length === 1 ? pending[0] : undefined;

  const activity: ActivityEntry[] = audit
    .map((a) => ({
      at: iso(a.SignedOn) ?? iso(a.ViewedOn),
      who: a.UserPtr?.Name ?? a.UserPtr?.Email ?? i18next.t("inbox.activity.someone"),
      what: a.Activity ?? i18next.t("inbox.activity.updated")
    }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  const status = isDeclined
    ? "declined"
    : isCompleted
      ? "completed"
      : isDraft
        ? "draft"
        : isExpired
          ? "expired"
          : needsMe
            ? "needsYou"
            : "waiting";

  return {
    id: raw.objectId,
    name: raw.Name ?? i18next.t("inbox.untitled"),
    note: raw.Note,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date().toISOString(),
    sentAt: iso(raw.DocSentAt),
    expiryDate,
    lastReminderAt: iso(raw.LastReminderAt),
    completedAt: isCompleted ? (signedDates[signedDates.length - 1] ?? raw.updatedAt) : undefined,
    status,
    isDraft,
    isCompleted,
    isDeclined,
    isExpired,
    isSelfSign,
    isMine,
    needsMe,
    sendInOrder: raw.SendinOrder === true,
    declineReason: raw.DeclineReason,
    recipients,
    signedCount: recipients.filter((r) => r.signedAt).length,
    pageCount,
    myContactId: mine?.contactId,
    nextSigner,
    activity,
    owner: {
      extUserId: owner?.objectId,
      name: owner?.Name,
      email: owner?.Email
    },
    url: raw.URL,
    signedUrl: raw.SignedUrl
  };
}

// ------------------------------------------------------------------ queries

export interface InboxData {
  docs: DocumentRecord[];
  counts: Record<Bucket, number>;
  /** A bucket hit the fetch limit, so counts and trends beyond it are unknown. */
  truncated: Record<Bucket, boolean>;
}

async function fetchBucket(reportId: string): Promise<RawDoc[]> {
  const rows = await cloud<RawDoc[] | Record<string, unknown>>("getReport", {
    reportId,
    skip: 0,
    limit: PAGE_LIMIT
  });
  return Array.isArray(rows) ? rows : [];
}

async function fetchInbox(me: Me): Promise<InboxData> {
  const keys = Object.keys(REPORTS) as Bucket[];
  const results = await Promise.all(keys.map((k) => fetchBucket(REPORTS[k])));

  const byId = new Map<string, DocumentRecord>();
  const counts = {} as Record<Bucket, number>;
  const truncated = {} as Record<Bucket, boolean>;

  keys.forEach((bucket, i) => {
    const rows = results[i];
    truncated[bucket] = rows.length >= PAGE_LIMIT;
    let docs = rows.map((r) => toDocument(r, me));
    if (bucket === "needsYou") {
      // The report cannot express "and I have not signed it yet" (§9.1).
      docs = docs.filter((d) => d.needsMe);
    }
    counts[bucket] = docs.length;
    for (const d of docs) {
      const existing = byId.get(d.id);
      if (existing) {
        // A document can arrive from two buckets (owner who is also a signer);
        // keep the richer first mapping but never lose the "needs you" flag.
        if (d.needsMe && !existing.needsMe) {
          byId.set(d.id, { ...existing, needsMe: true, status: "needsYou", myContactId: d.myContactId });
        }
      } else {
        byId.set(d.id, d);
      }
    }
  });

  const docs = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { docs, counts, truncated };
}

export function useMe(): { me: Me | null; ready: boolean } {
  const { user } = useAuth();
  const ext = useExtUser();
  if (!user) return { me: null, ready: false };
  return {
    me: {
      userId: user.id,
      email: (ext.data?.Email ?? user.email ?? user.username ?? "").toLowerCase(),
      extUserId: ext.data?.objectId
    },
    ready: ext.isFetched
  };
}

export function useInbox(me: Me | null, ready: boolean) {
  return useQuery({
    queryKey: ["inbox", me?.userId, me?.extUserId],
    queryFn: () => fetchInbox(me as Me),
    enabled: !!me && ready,
    staleTime: 30_000,
    refetchOnWindowFocus: true
  });
}

/**
 * Full record for one document. This is a single-object read, so the afterFind
 * trigger runs and `URL` / `SignedUrl` come back signed and fetchable (§8.4).
 */
export function useDocumentDetail(docId: string | undefined, me: Me | null) {
  return useQuery({
    queryKey: ["inbox", "document", docId],
    enabled: !!docId && !!me,
    staleTime: 30_000,
    queryFn: async () => {
      const raw = await cloud<RawDoc>("getDocument", { docId });
      if (!raw?.objectId) throw new Error(i18next.t("inbox.errors.documentUnavailable"));
      return toDocument(raw, me as Me);
    }
  });
}

// ---------------------------------------------------------------- mutations

/**
 * Reminders go through the `sendreminder` cloud function: it picks the
 * recipients (honouring SendinOrder), mails the document's own request
 * template and stamps `LastReminderAt`, which the list and inspector read back.
 */
export function useRemind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ doc }: { doc: DocumentRecord }) => sendReminder(doc.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    }
  });
}

/**
 * ExpiryDate is only computed on insert (§11.14), so moving it is a plain REST
 * write on contracts_Document, which only the owner should do.
 */
export function useExtendExpiry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ doc, days }: { doc: DocumentRecord; days: number }) => {
      const from = doc.expiryDate ? new Date(doc.expiryDate) : new Date();
      const next = new Date(from.getTime() + days * 86_400_000);
      await rest(`classes/contracts_Document/${doc.id}`, {
        method: "PUT",
        body: { ExpiryDate: { __type: "Date", iso: next.toISOString() } }
      });
      return next;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    }
  });
}

/** Declined documents cannot be revived; `recreatedoc` clones them clean (§4.3). */
export function useRecreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (docId: string) => {
      const res = await cloud<{ objectId?: string }>("recreatedoc", { docId });
      if (!res?.objectId) throw new Error(i18next.t("inbox.errors.recreateFailed"));
      return res.objectId;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    }
  });
}

/**
 * Opens the signed PDF. The list row usually carries a presigned url already,
 * but `window.open` cannot report a dead link, so this re-reads the document
 * and opens the url the afterFind trigger has just signed.
 */
export function useDownload() {
  return useMutation({
    mutationFn: async (docId: string) => {
      const raw = await cloud<RawDoc>("getDocument", { docId });
      const url = raw?.SignedUrl ?? raw?.URL;
      if (!url) throw new Error(i18next.t("inbox.errors.noFile"));
      window.open(url, "_blank", "noopener");
    }
  });
}
