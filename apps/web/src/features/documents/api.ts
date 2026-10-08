/**
 * Documents feature data layer.
 *
 * Reads go straight at the Parse REST class API for the list (the canned
 * `getReport` buckets cannot express folder / template / date filters, and
 * `contracts_Document.find` only requires authentication, with object ACLs
 * doing the scoping for us) and at the `getDocument` cloud function for the
 * detail page (it resolves signed file URLs, which list queries do not, see
 * docs/BACKEND_API.md §8.4 and §11.12).
 *
 * All Parse JSON is mapped to the plain types in `./types` right here.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { cloud, rest } from "@/lib/parse";
import { toSeats } from "@/lib/recipients";
import { remindMany, type RemindTotals } from "@/lib/reminder";
import type {
  AuditEvent,
  BucketCounts,
  DocField,
  DocFilter,
  DocStatus,
  Document,
  DocumentOpens,
  DocumentPage,
  DocumentQuery,
  Folder,
  ParseDate,
  Recipient,
  Signer,
  SignerState,
  TemplateOption
} from "./types";

const CLASS = "contracts_Document";

/** Fallback role colours, matching the palette the editor hands out. */
const ROLE_COLORS = ["#1447e6", "#6b5bd6", "#e17100", "#c8000a", "#009966", "#9a4a00"];

/* ------------------------------------------------------------------ raw JSON */

interface RawPtr {
  objectId?: string;
  className?: string;
  __type?: string;
}

interface RawContact extends RawPtr {
  Name?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  JobTitle?: string;
  UserId?: RawPtr;
}

interface RawWidgetOptions {
  name?: string;
  status?: string;
  response?: unknown;
  defaultValue?: unknown;
}

interface RawWidget {
  key?: number;
  type?: string;
  xPosition?: number;
  yPosition?: number;
  Width?: number;
  Height?: number;
  options?: RawWidgetOptions;
  SignUrl?: string;
}

interface RawPlaceholderPage {
  pageNumber?: number;
  pos?: RawWidget[];
}

interface RawPlaceholder {
  Id?: number;
  Role?: string;
  blockColor?: string;
  signerObjId?: string;
  email?: string;
  Name?: string;
  placeHolder?: RawPlaceholderPage[];
  signerPtr?: RawContact;
}

interface RawOpenStat {
  count?: number;
  firstAt?: string;
  lastAt?: string;
}

interface RawAudit {
  UserPtr?: RawContact;
  Activity?: string;
  SignedOn?: ParseDate | string;
  ViewedOn?: ParseDate | string;
  ipAddress?: string;
  Signature?: string;
}

interface RawDoc {
  objectId: string;
  Name?: string;
  /** The written-document source (docs/TEXT_DOCUMENTS.md); only its presence matters here. */
  Content?: unknown;
  Note?: string;
  Description?: string;
  URL?: string;
  SignedUrl?: string;
  CertificateUrl?: string;
  DocumentHash?: string;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  DeclineReason?: string;
  IsSignyourself?: boolean;
  SentToOthers?: boolean;
  SendinOrder?: boolean;
  SendInOrderStrict?: boolean;
  AutomaticReminders?: boolean;
  RemindOnceInEvery?: number;
  TimeToCompleteDays?: number;
  IsEnableOTP?: boolean;
  IsTourEnabled?: boolean;
  AllowModifications?: boolean;
  NotifyOnSignatures?: boolean;
  RedirectUrl?: string;
  ExpiryDate?: ParseDate;
  DocSentAt?: ParseDate;
  createdAt?: string;
  updatedAt?: string;
  Placeholders?: RawPlaceholder[];
  Signers?: RawContact[];
  AuditTrail?: RawAudit[];
  /** Per-contact open counts, kept by the server on every signing-page open. */
  OpenStats?: Record<string, RawOpenStat>;
  Folder?: { objectId?: string; Name?: string };
  CreatedBy?: RawPtr & { name?: string; email?: string; username?: string };
  /** Only the pointer on list rows; `getDocument` resolves it to the full row. */
  ExtUserPtr?: RawPtr & { Name?: string; Email?: string; Phone?: string; Company?: string };
  /** Same: pointer on list rows, resolved object on `getDocument`. */
  TemplateId?: { objectId?: string; Name?: string };
  Type?: string;
  SenderName?: string;
  SenderMail?: string;
  Chain?: { templateId?: string; templateName?: string; name?: string };
  ChainResult?: { status?: string; documentId?: string; error?: string; at?: string };
  ChainedFrom?: { objectId?: string };
}

interface RestList<T> {
  results?: T[];
  count?: number;
}

/* -------------------------------------------------------------------- mapping */

function iso(v: ParseDate | string | undefined | null): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  return v.iso;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

const IMAGE_WIDGETS = new Set(["signature", "stamp", "initials", "image", "draw"]);

function isImageValue(v: string | undefined): v is string {
  return !!v && (v.startsWith("data:") || v.startsWith("http"));
}

function computeStatus(raw: RawDoc, expiry?: string): DocStatus {
  if (raw.IsDeclined) return "declined";
  if (raw.IsCompleted) return "completed";
  if (!raw.SignedUrl) return "draft";
  if (expiry && new Date(expiry).getTime() < Date.now()) return "expired";
  return "in_progress";
}

function toSigner(c: RawContact | undefined, fallbackEmail?: string): Signer {
  return {
    objectId: c?.objectId ?? "",
    name: c?.Name ?? "",
    email: c?.Email ?? fallbackEmail ?? "",
    phone: c?.Phone,
    company: c?.Company,
    jobTitle: c?.JobTitle,
    userId: c?.UserId?.objectId
  };
}

interface Viewer {
  userId?: string;
  email?: string;
}

/** Turn one Parse document row into the plain `Document` the UI consumes. */
export function toDocument(raw: RawDoc, me: Viewer): Document {
  const expiryDate = iso(raw.ExpiryDate);
  const status = computeStatus(raw, expiryDate);
  const audit = raw.AuditTrail ?? [];
  // Seats and their contacts come from the shared rule in @/lib/recipients, so
  // this page and the inbox always name the same person for the same seat.
  const seats = toSeats<RawContact, RawPlaceholder>(raw.Placeholders, raw.Signers);
  const placeholders = seats.map((seat) => seat.placeholder as RawPlaceholder);

  const recipients: Recipient[] = seats.map(({ placeholder: p, contact, index }) => {
    const base = toSigner(contact, p?.email);
    const entries = audit.filter(
      (a) =>
        (base.objectId && a.UserPtr?.objectId === base.objectId) ||
        (base.email && a.UserPtr?.Email?.toLowerCase() === base.email.toLowerCase())
    );
    const signedEntry = entries.find((a) => a.Activity === "Signed");
    const viewedEntry = entries.find((a) => a.Activity === "Viewed");
    const openStat = base.objectId ? raw.OpenStats?.[base.objectId] : undefined;
    let state: SignerState = signedEntry ? "signed" : viewedEntry ? "viewed" : "waiting";
    if (raw.IsDeclined && !signedEntry) state = "declined";
    return {
      ...base,
      order: index,
      role: p?.Role ?? `Role ${index + 1}`,
      color:
        p?.blockColor && p.blockColor !== "transparent" ? p.blockColor : ROLE_COLORS[index % ROLE_COLORS.length],
      state,
      signedAt: iso(signedEntry?.SignedOn),
      viewedAt: iso(viewedEntry?.ViewedOn),
      openCount: openStat?.count ?? 0,
      firstOpenedAt: iso(openStat?.firstAt),
      lastOpenedAt: iso(openStat?.lastAt),
      declineReason: raw.IsDeclined && !signedEntry ? raw.DeclineReason : undefined,
      fieldCount: (p?.placeHolder ?? []).reduce((n, page) => n + (page?.pos?.length ?? 0), 0)
    };
  });

  // Self-signed documents carry a placeholder seat with no contact behind it.
  // Show the owner as the single recipient instead of an empty "?" seat, and
  // drop any other seat that has neither a contact nor an email.
  const ownerSigner: Signer = {
    objectId: raw.ExtUserPtr?.objectId ?? raw.CreatedBy?.objectId ?? "",
    name: raw.SenderName ?? raw.ExtUserPtr?.Name ?? raw.CreatedBy?.name ?? "",
    email: raw.SenderMail ?? raw.ExtUserPtr?.Email ?? raw.CreatedBy?.email ?? raw.CreatedBy?.username ?? "",
    userId: raw.CreatedBy?.objectId
  };
  if (raw.IsSignyourself) {
    const signedEntry = audit.find((a) => a.Activity === "Signed");
    recipients.splice(0, recipients.length, {
      ...ownerSigner,
      order: 0,
      role: "Owner",
      color: ROLE_COLORS[0],
      state: signedEntry || raw.IsCompleted ? "signed" : "waiting",
      signedAt: iso(signedEntry?.SignedOn),
      openCount: 0,
      fieldCount: recipients.reduce((n, r) => n + r.fieldCount, 0)
    });
  } else {
    for (let i = recipients.length - 1; i >= 0; i--) {
      if (!recipients[i].objectId && !recipients[i].email) recipients.splice(i, 1);
    }
  }

  // Mark whose turn it is under sequential sending.
  if (raw.SendinOrder) {
    const next = recipients.find((r) => r.state === "waiting" || r.state === "viewed");
    if (next && status === "in_progress") next.state = "turn";
  } else if (status === "in_progress") {
    recipients.forEach((r) => {
      if (r.state === "waiting" || r.state === "viewed") r.state = "turn";
    });
  }

  const fields: DocField[] = [];
  placeholders.forEach((p, index) => {
    const recipient = recipients[index];
    (p.placeHolder ?? []).forEach((page) => {
      (page?.pos ?? []).forEach((w) => {
        const rawValue = str(w.options?.response) ?? w.SignUrl ?? str(w.options?.defaultValue);
        const image = IMAGE_WIDGETS.has(w.type ?? "") && isImageValue(rawValue) ? rawValue : undefined;
        fields.push({
          key: w.key ?? Math.random(),
          type: w.type ?? "text",
          page: page.pageNumber ?? 1,
          required: (w.options?.status ?? "required") === "required",
          name: w.options?.name,
          signerObjId: recipient?.objectId,
          signerName: recipient?.name || recipient?.email || p.Role || i18next.t("documents.fallback.unassigned"),
          signerEmail: recipient?.email,
          color: recipient?.color ?? ROLE_COLORS[index % ROLE_COLORS.length],
          value: image ? undefined : rawValue,
          image,
          x: w.xPosition ?? 0,
          y: w.yPosition ?? 0,
          w: w.Width ?? 150,
          h: w.Height ?? 60
        });
      });
    });
  });

  const events: AuditEvent[] = audit.map((a, i) => ({
    id: `${a.UserPtr?.objectId ?? "x"}-${a.Activity ?? "?"}-${i}`,
    activity: a.Activity ?? i18next.t("documents.fallback.activity"),
    at: iso(a.SignedOn) ?? iso(a.ViewedOn),
    ip: a.ipAddress,
    actorName: a.UserPtr?.Name ?? a.UserPtr?.Email ?? i18next.t("documents.fallback.someone"),
    actorEmail: a.UserPtr?.Email,
    signature: a.Signature
  }));

  const mine = recipients.find(
    (r) =>
      (me.userId && r.userId === me.userId) ||
      (me.email && r.email && r.email.toLowerCase() === me.email.toLowerCase())
  );
  const openForSigning = status === "in_progress";
  const blockedByOrder =
    // Strict order is only enforced under SendinOrder; see send/api.ts.
    !!raw.SendinOrder &&
    !!raw.SendInOrderStrict &&
    !!mine &&
    recipients.slice(0, mine.order).some((r) => r.state !== "signed");

  const maxPage = fields.reduce((n, f) => Math.max(n, f.page), 0);

  return {
    objectId: raw.objectId,
    name: raw.Name ?? i18next.t("documents.fallback.untitledDocument"),
    note: raw.Note,
    description: raw.Description,
    url: raw.URL,
    signedUrl: raw.SignedUrl,
    certificateUrl: raw.CertificateUrl,
    documentHash: raw.DocumentHash,
    status,
    isCompleted: !!raw.IsCompleted,
    isDeclined: !!raw.IsDeclined,
    declineReason: raw.DeclineReason,
    isSignYourself: !!raw.IsSignyourself,
    sentToOthers: !!raw.SentToOthers,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? raw.createdAt ?? "",
    sentAt: iso(raw.DocSentAt),
    expiryDate,
    // On list rows ExtUserPtr is an unresolved pointer, so the owner shown in the
    // table comes from the CreatedBy `_User` include; getDocument fills in the rest.
    ownerName: raw.SenderName ?? raw.ExtUserPtr?.Name ?? raw.CreatedBy?.name,
    ownerEmail: raw.SenderMail ?? raw.ExtUserPtr?.Email ?? raw.CreatedBy?.email ?? raw.CreatedBy?.username,
    extUserId: raw.ExtUserPtr?.objectId,
    createdById: raw.CreatedBy?.objectId,
    folderId: raw.Folder?.objectId,
    folderName: raw.Folder?.Name,
    templateId: raw.TemplateId?.objectId,
    templateName: raw.TemplateId?.Name,
    chain: raw.Chain?.templateId
      ? {
          templateId: raw.Chain.templateId,
          templateName: raw.Chain.templateName,
          name: raw.Chain.name
        }
      : undefined,
    chainResult:
      raw.ChainResult?.status === "sent" || raw.ChainResult?.status === "failed"
        ? {
            status: raw.ChainResult.status,
            documentId: raw.ChainResult.documentId,
            error: raw.ChainResult.error,
            at: raw.ChainResult.at
          }
        : undefined,
    chainedFromId: raw.ChainedFrom?.objectId,
    written: !!raw.Content && typeof raw.Content === "object",
    pageCount: maxPage || undefined,
    recipients,
    fields,
    audit: events,
    settings: {
      timeToCompleteDays: raw.TimeToCompleteDays,
      expiryDate,
      automaticReminders: !!raw.AutomaticReminders,
      remindOnceInEvery: raw.RemindOnceInEvery,
      isEnableOTP: !!raw.IsEnableOTP,
      notifyOnSignatures: !!raw.NotifyOnSignatures,
      allowModifications: !!raw.AllowModifications,
      isTourEnabled: !!raw.IsTourEnabled,
      sendInOrder: !!raw.SendinOrder,
      sendInOrderStrict: !!raw.SendinOrder && !!raw.SendInOrderStrict,
      redirectUrl: raw.RedirectUrl
    },
    needsYou: openForSigning && !!mine && mine.state !== "signed" && !blockedByOrder,
    myContactId: mine?.objectId || undefined,
    blockedByOrder
  };
}

/* --------------------------------------------------------------- where builders */

type Where = Record<string, unknown>;

function datePointer(d: Date) {
  return { __type: "Date", iso: d.toISOString() };
}

function userPointer(objectId: string) {
  return { __type: "Pointer", className: "_User", objectId };
}

function docPointer(objectId: string) {
  return { __type: "Pointer", className: CLASS, objectId };
}

/** The `where` clause for one filter chip, before folder/date/template narrowing. */
export function bucketWhere(filter: DocFilter, me: Viewer, owner: "anyone" | "me"): Where {
  const now = datePointer(new Date());
  const where: Where = { Type: { $ne: "Folder" }, IsArchive: { $ne: true } };
  const ownedByMe = owner === "me" && me.userId;

  switch (filter) {
    case "needs_you":
      Object.assign(where, {
        SignedUrl: { $exists: true },
        IsCompleted: { $ne: true },
        IsDeclined: { $ne: true },
        Placeholders: { $exists: true },
        ExpiryDate: { $gt: now },
        Signers: me.userId
          ? {
              $inQuery: {
                where: { UserId: userPointer(me.userId) },
                className: "contracts_Contactbook"
              }
            }
          : { $exists: true }
      });
      return where;
    case "in_progress":
      Object.assign(where, {
        SignedUrl: { $exists: true },
        IsCompleted: { $ne: true },
        IsDeclined: { $ne: true },
        ExpiryDate: { $gt: now }
      });
      break;
    case "completed":
      Object.assign(where, { IsCompleted: true, IsDeclined: { $ne: true } });
      break;
    case "declined":
      Object.assign(where, { IsDeclined: true });
      break;
    case "expired":
      Object.assign(where, {
        SignedUrl: { $exists: true },
        IsCompleted: { $ne: true },
        IsDeclined: { $ne: true },
        ExpiryDate: { $lt: now }
      });
      break;
    case "draft":
      Object.assign(where, {
        SignedUrl: { $exists: false },
        IsCompleted: { $ne: true },
        IsDeclined: { $ne: true }
      });
      break;
    case "all":
    default:
      break;
  }
  if (ownedByMe) where.CreatedBy = userPointer(me.userId as string);
  return where;
}

function applyNarrowing(where: Where, q: DocumentQuery): Where {
  const out: Where = { ...where };
  if (q.folderId) out.Folder = docPointer(q.folderId);
  if (q.templateId) {
    out.TemplateId = { __type: "Pointer", className: "contracts_Template", objectId: q.templateId };
  }
  if (q.date !== "any") {
    const days = Number(q.date);
    out.updatedAt = { $gte: datePointer(new Date(Date.now() - days * 86_400_000)) };
  }
  if (q.search?.trim()) {
    out.Name = { $regex: escapeRegex(q.search.trim()), $options: "i" };
  }
  if (q.view === "expiring") {
    // "Expiring this week": still open, expiry inside the next 7 days.
    out.ExpiryDate = { $gt: datePointer(new Date()), $lt: datePointer(new Date(Date.now() + 7 * 86_400_000)) };
    out.IsCompleted = { $ne: true };
    out.IsDeclined = { $ne: true };
    out.SignedUrl = { $exists: true };
  }
  return out;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LIST_KEYS = [
  "Name",
  "Note",
  "URL",
  "SignedUrl",
  "CertificateUrl",
  "IsCompleted",
  "IsDeclined",
  "DeclineReason",
  "IsSignyourself",
  "SentToOthers",
  "SendinOrder",
  "SendInOrderStrict",
  "ExpiryDate",
  "DocSentAt",
  "TimeToCompleteDays",
  "AutomaticReminders",
  "RemindOnceInEvery",
  "IsEnableOTP",
  "IsTourEnabled",
  "AllowModifications",
  "NotifyOnSignatures",
  "RedirectUrl",
  "Placeholders",
  "AuditTrail",
  "OpenStats",
  "Type",
  "SenderName",
  "SenderMail",
  "Signers.Name",
  "Signers.Email",
  "Signers.UserId",
  "Folder.Name",
  "CreatedBy.name",
  "CreatedBy.email",
  "CreatedBy.username",
  // Bare pointers only. `contracts_Users.find` and `contracts_Template.find` are
  // closed to clients (§3.1) and Parse runs an `include` as a find on the target
  // class, so asking for `ExtUserPtr.Name` or `TemplateId.Name` fails the whole
  // query with error 119. Note a dotted key implies the include on its own
  // (RestQuery's "keysForInclude"), so the dotted forms cannot be used either.
  "ExtUserPtr",
  "TemplateId"
].join(",");

/** `_User` and `contracts_Contactbook` are the only pointer targets clients may find. */
const LIST_INCLUDE = "Signers,Folder,CreatedBy";

/* ---------------------------------------------------------------- list queries */

export const documentKeys = {
  all: ["documents"] as const,
  list: (q: DocumentQuery, me: Viewer) => ["documents", "list", q, me.userId] as const,
  counts: (me: Viewer, q: DocumentQuery) =>
    [
      "documents",
      "counts",
      me.userId,
      { owner: q.owner, date: q.date, templateId: q.templateId, folderId: q.folderId, search: q.search, view: q.view }
    ] as const,
  detail: (id: string) => ["documents", "detail", id] as const,
  folders: (me: Viewer) => ["documents", "folders", me.userId] as const,
  templates: () => ["documents", "templateOptions"] as const
};

export async function fetchDocuments(q: DocumentQuery, me: Viewer): Promise<DocumentPage> {
  const where = applyNarrowing(bucketWhere(q.filter, me, q.owner), q);
  const res = await rest<RestList<RawDoc>>(`classes/${CLASS}`, {
    query: {
      where: JSON.stringify(where),
      keys: LIST_KEYS,
      include: LIST_INCLUDE,
      order: "-updatedAt",
      limit: String(q.perPage),
      skip: String((q.page - 1) * q.perPage),
      count: "1"
    }
  });
  let documents = (res.results ?? []).map((r) => toDocument(r, me));
  // The canned "needs your signature" query cannot express "and I have not
  // signed it yet" (BACKEND_API §9.1), so drop the ones already signed here.
  if (q.filter === "needs_you") documents = documents.filter((d) => d.needsYou);
  return { documents, total: res.count ?? documents.length };
}

export function useDocuments(q: DocumentQuery, me: Viewer) {
  return useQuery({
    queryKey: documentKeys.list(q, me),
    queryFn: () => fetchDocuments(q, me),
    enabled: !!me.userId,
    placeholderData: (prev) => prev
  });
}

async function countWhere(where: Where): Promise<number> {
  const res = await rest<RestList<RawDoc>>(`classes/${CLASS}`, {
    query: { where: JSON.stringify(where), limit: "0", count: "1" }
  });
  return res.count ?? 0;
}

const BUCKETS: DocFilter[] = ["all", "needs_you", "in_progress", "completed", "declined", "expired", "draft"];

/**
 * One count per filter chip, narrowed by everything except the chip itself.
 * The "needs you" count is a slight over-count: the server query cannot express
 * "and I have not signed yet" (§9.1), which only the row-level filter can.
 */
export function useBucketCounts(me: Viewer, q: DocumentQuery) {
  return useQuery({
    queryKey: documentKeys.counts(me, q),
    enabled: !!me.userId,
    queryFn: async (): Promise<BucketCounts> => {
      const entries = await Promise.all(
        BUCKETS.map(
          async (b) =>
            [b, await countWhere(applyNarrowing(bucketWhere(b, me, q.owner), { ...q, filter: b }))] as const
        )
      );
      return Object.fromEntries(entries) as unknown as BucketCounts;
    }
  });
}

/* -------------------------------------------------------------------- folders */

interface RawFolder {
  objectId: string;
  Name?: string;
  Folder?: { objectId?: string };
}

export interface FolderWithCount extends Folder {
  count: number;
}

export interface Drive {
  /** Every folder the signed-in user owns, flat, sorted by name. */
  folders: FolderWithCount[];
  /** Documents not in any folder. */
  rootCount: number;
  /** Every document, folders excluded. */
  total: number;
}

const FOLDER_LIMIT = 200;
/** One page of documents is enough to tally folder counts for a normal drive. */
const TALLY_LIMIT = 1000;

const folderWhere = (me: Viewer): Where => ({
  Type: "Folder",
  IsArchive: { $ne: true },
  ...(me.userId ? { CreatedBy: userPointer(me.userId) } : {})
});

/**
 * The whole drive: folders are `contracts_Document` rows with `Type: "Folder"`
 * and a `Folder` pointer at their parent (§3.5, §3.10). Root folders have no
 * `Folder`.
 *
 * The legacy `getDrive` cloud function is gone: it paged one folder at a time
 * and inflated every row with `ExtUserPtr.TenantId`, while the rail needs the
 * whole tree and a count per folder. The semantics below are the same (mine,
 * not archived).
 *
 * Counts come from one pass over the document list rather than one count query
 * per folder; only a drive with more documents than a single page falls back to
 * counting each folder separately.
 */
export function useDrive(me: Viewer) {
  return useQuery({
    queryKey: documentKeys.folders(me),
    enabled: !!me.userId,
    staleTime: 60_000,
    queryFn: async (): Promise<Drive> => {
      const res = await rest<RestList<RawFolder>>(`classes/${CLASS}`, {
        query: {
          where: JSON.stringify(folderWhere(me)),
          keys: "Name,Folder",
          order: "Name",
          limit: String(FOLDER_LIMIT)
        }
      });
      const folders = (res.results ?? []).map((f) => ({
        objectId: f.objectId,
        name: f.Name ?? i18next.t("documents.fallback.untitledFolder"),
        parentId: f.Folder?.objectId
      }));

      const docWhere: Where = { Type: { $ne: "Folder" }, IsArchive: { $ne: true } };
      const docs = await rest<RestList<{ objectId: string; Folder?: { objectId?: string } }>>(`classes/${CLASS}`, {
        query: { where: JSON.stringify(docWhere), keys: "Folder", limit: String(TALLY_LIMIT), count: "1" }
      });
      const rows = docs.results ?? [];
      const total = docs.count ?? rows.length;

      if (total > rows.length) {
        // More documents than we sampled: fall back to an exact count per folder.
        const counts = await Promise.all(
          folders.map((f) => countWhere({ ...docWhere, Folder: docPointer(f.objectId) }))
        );
        return {
          folders: folders.map((f, i) => ({ ...f, count: counts[i] })),
          rootCount: await countWhere({ ...docWhere, Folder: { $exists: false } }),
          total
        };
      }

      const tally = new Map<string, number>();
      let rootCount = 0;
      for (const r of rows) {
        const id = r.Folder?.objectId;
        if (!id) rootCount += 1;
        else tally.set(id, (tally.get(id) ?? 0) + 1);
      }
      return {
        folders: folders.map((f) => ({ ...f, count: tally.get(f.objectId) ?? 0 })),
        rootCount,
        total
      };
    }
  });
}

/* ------------------------------------------------------------ folder mutations */

function extUserPointer(objectId: string) {
  return { __type: "Pointer", className: "contracts_Users", objectId };
}

/** Folder rows carry exactly what the legacy drive wrote (§3.11). */
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { name: string; parentId?: string; userId: string; extUserId?: string }) => {
      const name = v.name.trim();
      if (!name) throw new Error(i18next.t("documents.errors.folderNameRequired"));
      if (name.length > 250) throw new Error(i18next.t("documents.errors.folderNameTooLong"));
      const dupe = await rest<RestList<{ objectId: string }>>(`classes/${CLASS}`, {
        query: {
          where: JSON.stringify({
            Name: name,
            Type: "Folder",
            IsArchive: { $ne: true },
            CreatedBy: userPointer(v.userId),
            ...(v.parentId ? { Folder: docPointer(v.parentId) } : { Folder: { $exists: false } })
          }),
          limit: "1"
        }
      });
      if ((dupe.results ?? []).length) throw new Error(i18next.t("documents.errors.folderExists", { name }));
      return rest<{ objectId: string }>(`classes/${CLASS}`, {
        method: "POST",
        body: {
          Name: name,
          Type: "Folder",
          CreatedBy: userPointer(v.userId),
          ...(v.extUserId ? { ExtUserPtr: extUserPointer(v.extUserId) } : {}),
          ...(v.parentId ? { Folder: docPointer(v.parentId) } : {})
        }
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ folderId, name }: { folderId: string; name: string }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error(i18next.t("documents.errors.folderNameRequired"));
      return rest(`classes/${CLASS}/${folderId}`, { method: "PUT", body: { Name: trimmed } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

/** Descendants of `folderId`, itself included, so a move cannot form a cycle. */
export function subtreeIds(folders: Folder[], folderId: string): Set<string> {
  const out = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.objectId)) {
        out.add(f.objectId);
        grew = true;
      }
    }
  }
  return out;
}

export function useMoveFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, parentId }: { folderId: string; parentId: string | null }) =>
      rest(`classes/${CLASS}/${folderId}`, {
        method: "PUT",
        body: { Folder: parentId ? docPointer(parentId) : { __op: "Delete" } }
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

export interface FolderContents {
  documents: number;
  subfolders: number;
}

/** What a folder holds, so the delete confirmation can say what will happen. */
export function useFolderContents(folderId: string | undefined) {
  return useQuery({
    queryKey: ["documents", "folderContents", folderId],
    enabled: !!folderId,
    queryFn: async (): Promise<FolderContents> => {
      const where = { IsArchive: { $ne: true }, Folder: docPointer(folderId as string) };
      const [documents, subfolders] = await Promise.all([
        countWhere({ ...where, Type: { $ne: "Folder" } }),
        countWhere({ ...where, Type: "Folder" })
      ]);
      return { documents, subfolders };
    }
  });
}

/**
 * Delete a folder. Nothing is ever really deleted (§3.1), so this archives the
 * folder row. The legacy drive simply refused to delete a folder that still had
 * anything in it; we keep the documents safe the same way, by re-parenting
 * everything inside to the folder's own parent (the drive root for a top-level
 * folder) before archiving, so no document is ever archived by accident.
 */
export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ folderId, parentId }: { folderId: string; parentId?: string }) => {
      const body = parentId ? { Folder: docPointer(parentId) } : { Folder: { __op: "Delete" } };
      for (;;) {
        const page = await rest<RestList<{ objectId: string }>>(`classes/${CLASS}`, {
          query: {
            where: JSON.stringify({ IsArchive: { $ne: true }, Folder: docPointer(folderId) }),
            keys: "objectId",
            limit: "100"
          }
        });
        const children = page.results ?? [];
        if (!children.length) break;
        await Promise.all(children.map((c) => rest(`classes/${CLASS}/${c.objectId}`, { method: "PUT", body })));
      }
      return rest(`classes/${CLASS}/${folderId}`, { method: "PUT", body: { IsArchive: true } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

/* ------------------------------------------------------------ template options */

interface RawTemplateRow {
  objectId: string;
  Name?: string;
}

/**
 * `contracts_Template.find` is denied to clients (§3.1), so the template filter
 * list comes from the `getReport` templates bucket. It is optional: when the
 * report errors (it throws for users with no `contracts_Users` row, §9) we just
 * hide the filter.
 */
export function useTemplateOptions() {
  return useQuery({
    queryKey: documentKeys.templates(),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<TemplateOption[]> => {
      const rows = await cloud<RawTemplateRow[]>("getReport", {
        reportId: "6TeaPr321t",
        limit: 200,
        skip: 0
      });
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r?.objectId)
        .map((r) => ({ objectId: r.objectId, name: r.Name ?? i18next.t("documents.fallback.untitledTemplate") }));
    }
  });
}

/* ---------------------------------------------------------------------- detail */

export function useDocument(docId: string | undefined, me: Viewer) {
  return useQuery({
    queryKey: documentKeys.detail(docId ?? ""),
    enabled: !!docId,
    queryFn: async () => {
      const raw = await cloud<RawDoc>("getDocument", { docId });
      return toDocument(raw, me);
    }
  });
}

/* ----------------------------------------------------------------------- opens */

interface RawOpen {
  objectId?: string;
  at?: string;
  contactId?: string;
  name?: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}

interface RawOpens {
  total?: number;
  opens?: RawOpen[];
}

/** Every open of the signing link, newest first. Owner only; the server refuses anyone else. */
export function useDocumentOpens(docId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...documentKeys.detail(docId ?? ""), "opens"] as const,
    enabled: !!docId && enabled,
    retry: false,
    queryFn: async (): Promise<DocumentOpens> => {
      const r = await cloud<RawOpens>("getdocumentopens", { docId, limit: 100 });
      return {
        total: r?.total ?? 0,
        opens: (r?.opens ?? []).map((o, i) => ({
          id: o.objectId ?? `${o.contactId ?? "x"}-${i}`,
          at: iso(o.at),
          contactId: o.contactId ?? "",
          name: o.name ?? "",
          email: o.email ?? "",
          ip: o.ip,
          userAgent: o.userAgent
        }))
      };
    }
  });
}

/* ------------------------------------------------------------------- downloads */

export type DownloadKind = "signed" | "original" | "certificate";

function urlFor(doc: Document, kind: DownloadKind): string | undefined {
  if (kind === "certificate") return doc.certificateUrl;
  if (kind === "original") return doc.url;
  return doc.signedUrl ?? doc.url;
}

function fileNameFor(doc: Document, kind: DownloadKind) {
  const base = doc.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "-");
  if (kind === "certificate") return i18next.t("documents.fileName.certificate", { base });
  if (kind === "original") return `${base}.pdf`;
  return doc.isCompleted ? i18next.t("documents.fileName.signed", { base }) : `${base}.pdf`;
}

/**
 * Resolve a fresh signed URL and hand the file to the browser. DocumentAfterFind
 * presigns the first 200 objects of any result (§11.12), so a row usually
 * carries a usable url already, but local-storage tokens expire after ~200 s and
 * a download has no error path to retry from, so this one always re-signs.
 */
export async function downloadDocument(doc: Document, kind: DownloadKind): Promise<void> {
  let url = urlFor(doc, kind);
  if (!url) {
    throw new Error(
      kind === "certificate" ? i18next.t("documents.errors.noCertificate") : i18next.t("documents.errors.noFile")
    );
  }
  if (kind === "certificate" && doc.isCompleted && !doc.certificateUrl) {
    const gen = await cloud<{ CertificateUrl?: string }>("generatecertificate", { docId: doc.objectId });
    if (gen?.CertificateUrl) url = gen.CertificateUrl;
  }
  const fresh = await cloud<string>("getsignedurl", { url, docId: doc.objectId }).catch(() => url as string);
  const href = typeof fresh === "string" && fresh ? fresh : url;
  const res = await fetch(href);
  if (!res.ok) throw new Error(i18next.t("documents.errors.fileServer", { status: res.status }));
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileNameFor(doc, kind);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/**
 * A viewable URL for the PDF viewer on the detail page.
 *
 * `getDocument` runs DocumentAfterFind, so the url on the row is already
 * presigned and the viewer can use it as it is. `refresh` is what the viewer
 * asks for after it failed to load: the token had aged out (~200 s for local
 * storage), or the row came from a result past the trigger's 200-object cap.
 */
export async function resolveViewUrl(doc: Document, refresh = false): Promise<string | undefined> {
  const url = doc.signedUrl ?? doc.url;
  if (!url || !refresh) return url;
  try {
    const signed = await cloud<string>("getsignedurl", { url, docId: doc.objectId });
    return typeof signed === "string" && signed ? signed : url;
  } catch {
    return url;
  }
}

export function useViewUrl(doc: Document | undefined, refresh = false) {
  return useQuery({
    queryKey: ["documents", "viewUrl", doc?.objectId, doc?.signedUrl ?? doc?.url, refresh],
    enabled: !!doc && !!(doc.signedUrl ?? doc.url),
    staleTime: 120_000,
    queryFn: () => resolveViewUrl(doc as Document, refresh)
  });
}

/* ------------------------------------------------------------------- mutations */

function restPut(objectId: string, body: Record<string, unknown>) {
  return rest(`classes/${CLASS}/${objectId}`, { method: "PUT", body });
}

/** Soft delete. Nothing can actually be deleted through the REST API (§3.1). */
export function useDeleteDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => restPut(id, { IsArchive: true })));
      return ids;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

/**
 * Void ("revoke") a sent document. The backend has no dedicated void function:
 * the owner voids by calling `declinedoc` with their own `_User` id, which is
 * exactly what the legacy Revoke action did.
 */
export function useVoidDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, reason, userId }: { ids: string[]; reason: string; userId: string }) => {
      for (const docId of ids) {
        await cloud("declinedoc", { docId, reason, userId });
      }
      return ids;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

export function useMoveDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, folderId }: { ids: string[]; folderId: string | null }) => {
      const body = folderId ? { Folder: docPointer(folderId) } : { Folder: { __op: "Delete" } };
      await Promise.all(ids.map((id) => restPut(id, body)));
      return ids;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

export function useDuplicateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => cloud<{ objectId: string }>("recreatedoc", { docId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all })
  });
}

/* --------------------------------------------------------------------- forward */

/** `forwarddoc` refuses more than this, and only the owner may call it (§4.3). */
export const MAX_FORWARD_RECIPIENTS = 10;

/** One address `forwarddoc` could not reach, with the provider's reason. */
export interface ForwardFailure {
  email: string;
  reason?: string;
}

/**
 * What `forwarddoc` answers on a run that reached at least one address.
 * A run that reached nobody is thrown instead, so `sent` is never empty here.
 */
export interface ForwardResult {
  sent: string[];
  failed: ForwardFailure[];
  message?: string;
}

/**
 * Email a copy of the signed PDF to people who are not on the document.
 * `forwarddoc` takes `{ docId, recipients: string[] }` and nothing else: the
 * subject and body are built server-side, so there is no covering note to send.
 *
 * It mails one message per address and keeps going past a provider error, so a
 * partial failure comes back as a success with a non-empty `failed`; the caller
 * has to say who was missed. Only a run that reached nobody throws.
 */
export function useForwardDocument() {
  return useMutation({
    mutationFn: async ({ docId, recipients }: { docId: string; recipients: string[] }): Promise<ForwardResult> => {
      if (!recipients.length) throw new Error(i18next.t("documents.forward.needOne"));
      if (recipients.length > MAX_FORWARD_RECIPIENTS) {
        throw new Error(i18next.t("documents.forward.limit", { count: MAX_FORWARD_RECIPIENTS }));
      }
      const res = await cloud<Partial<ForwardResult> | undefined>("forwarddoc", { docId, recipients });
      const failed = Array.isArray(res?.failed)
        ? res.failed.filter((f): f is ForwardFailure => !!f && typeof f.email === "string")
        : [];
      // An older server answered `{ status: "success" }` and nothing else; treat
      // that as "everyone we asked for was reached".
      const sent = Array.isArray(res?.sent)
        ? res.sent.filter((e): e is string => typeof e === "string")
        : recipients.filter((e) => !failed.some((f) => f.email === e));
      return { sent, failed, message: typeof res?.message === "string" ? res.message : undefined };
    }
  });
}

/* ------------------------------------------------------------ save as template */

interface RawTemplate {
  objectId?: string;
  Name?: string;
  Placeholders?: RawPlaceholder[];
}

export interface SavedTemplate {
  objectId: string;
  name: string;
  roles: string[];
}

/**
 * `saveastemplate` takes only `{ docId }`: it copies the document, strips every
 * response and default, and unbinds each signer (`signerObjId: ''`,
 * `signerPtr: {}`) while keeping their `Role` label. Name and role labels are
 * therefore adjusted afterwards with a plain REST PUT, the same way the drive
 * renames a document (§3.11). Those two follow-ups are best effort: the
 * template already exists either way, so a failure only means it kept the
 * document's own name.
 */
export function useSaveAsTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docId,
      name,
      keepSignerRoles
    }: {
      docId: string;
      name: string;
      keepSignerRoles: boolean;
    }): Promise<SavedTemplate> => {
      const raw = await cloud<RawTemplate>("saveastemplate", { docId });
      const templateId = raw?.objectId;
      if (!templateId) throw new Error(i18next.t("documents.errors.noTemplateReturned"));

      const placeholders = Array.isArray(raw.Placeholders) ? raw.Placeholders : [];
      const roleName = (i: number) => i18next.t("documents.template.roleNumber", { index: i + 1 });
      const roles = keepSignerRoles
        ? placeholders.map((p, i) => p.Role || roleName(i))
        : placeholders.map((_, i) => roleName(i));

      const body: Record<string, unknown> = {};
      const trimmed = name.trim();
      if (trimmed && trimmed !== raw.Name) body.Name = trimmed.slice(0, 250);
      if (!keepSignerRoles && placeholders.length) {
        body.Placeholders = placeholders.map((p, i) => ({ ...p, Role: roles[i] }));
      }
      if (Object.keys(body).length) {
        await rest(`classes/contracts_Template/${templateId}`, { method: "PUT", body }).catch(() => undefined);
      }
      return { objectId: templateId, name: trimmed || raw.Name || i18next.t("documents.fallback.untitledTemplate"), roles };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] })
  });
}

/* ------------------------------------------------------------- contact lookup */

export interface ContactSuggestion {
  objectId: string;
  name: string;
  email: string;
}

/**
 * Typeahead over the owner's own contact book. `getsigners` ORs a `Name` and
 * `Email` regex scoped to `CreatedBy == me` (§4.5); `contracts_Contactbook` is
 * one of the few classes a client may `find`, but the cloud function keeps the
 * scoping consistent with the rest of the app.
 */
export function useContactSuggestions(search: string) {
  const term = search.trim();
  return useQuery({
    queryKey: ["documents", "contactSearch", term.toLowerCase()],
    enabled: term.length >= 2,
    staleTime: 30_000,
    queryFn: async (): Promise<ContactSuggestion[]> => {
      const rows = await cloud<RawContact[]>("getsigners", { search: term });
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r?.Email)
        .map((r) => ({
          objectId: r.objectId ?? (r.Email as string),
          name: r.Name ?? "",
          email: (r.Email as string).toLowerCase()
        }));
    }
  });
}

export interface SettingsPatch {
  timeToCompleteDays?: number;
  expiryDate?: string;
  automaticReminders?: boolean;
  remindOnceInEvery?: number;
  isEnableOTP?: boolean;
  notifyOnSignatures?: boolean;
  allowModifications?: boolean;
}

/**
 * Settings live on the document row and are written directly (§3.11).
 * `ExpiryDate` is only derived from `TimeToCompleteDays` on insert (§11.14), so
 * changing the window also writes the new expiry date explicitly.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId, patch, createdAt }: { docId: string; patch: SettingsPatch; createdAt: string }) => {
      const body: Record<string, unknown> = {};
      if (patch.timeToCompleteDays !== undefined) {
        body.TimeToCompleteDays = patch.timeToCompleteDays;
        const from = createdAt ? new Date(createdAt) : new Date();
        body.ExpiryDate = datePointer(new Date(from.getTime() + patch.timeToCompleteDays * 86_400_000));
      }
      if (patch.expiryDate !== undefined) body.ExpiryDate = datePointer(new Date(patch.expiryDate));
      if (patch.automaticReminders !== undefined) body.AutomaticReminders = patch.automaticReminders;
      if (patch.remindOnceInEvery !== undefined) body.RemindOnceInEvery = patch.remindOnceInEvery;
      if (patch.isEnableOTP !== undefined) body.IsEnableOTP = patch.isEnableOTP;
      if (patch.notifyOnSignatures !== undefined) body.NotifyOnSignatures = patch.notifyOnSignatures;
      if (patch.allowModifications !== undefined) body.AllowModifications = patch.allowModifications;
      return restPut(docId, body);
    },
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: documentKeys.detail(v.docId) });
      qc.invalidateQueries({ queryKey: documentKeys.all });
    }
  });
}

/**
 * Set or clear the follow-up chain. Only meaningful while the document can
 * still complete; the server ignores a chain on completed/declined rows (it
 * only fires from the completion path) and the UI hides the editor there.
 */
export function useSetChain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docId,
      chain
    }: {
      docId: string;
      chain: { templateId: string; templateName?: string; name?: string } | null;
    }) =>
      restPut(docId, {
        Chain: chain
          ? {
              templateId: chain.templateId,
              ...(chain.templateName ? { templateName: chain.templateName } : {}),
              ...(chain.name?.trim() ? { name: chain.name.trim().slice(0, 250) } : {})
            }
          : { __op: "Delete" }
      }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: documentKeys.detail(v.docId) });
    }
  });
}

/* -------------------------------------------------------------------- reminders */

/**
 * Reminders are the `sendreminder` cloud function, one call per document with a
 * small pool so a bulk remind does not fire off one request per selected row at
 * once. The server decides who still owes a signature, honours SendinOrder and
 * refuses documents it will not chase with code 141 (119 for a caller who may
 * not remind this document, 155 while the cooldown runs), so nothing is
 * filtered here: lib/reminder.ts turns each refusal into its own toast.
 */
export function useRemind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docs }: { docs: Document[] }): Promise<RemindTotals> =>
      remindMany(docs.map((d) => ({ id: d.objectId, name: d.name }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["documents"] });
    }
  });
}

/* -------------------------------------------------------------------- CSV */

/** Status keys in `common`, for the exported Status column. */
const CSV_STATUS: Record<DocStatus, string> = {
  draft: "common.status.draft",
  in_progress: "common.status.inProgress",
  completed: "common.status.completed",
  declined: "common.status.declined",
  expired: "common.status.expired"
};

/** Built per export so the headers follow the active language. */
function csvColumns(): Array<[string, (d: Document) => string]> {
  return [
    [i18next.t("documents.csv.documentId"), (d) => d.objectId],
    [i18next.t("documents.csv.name"), (d) => d.name],
    [i18next.t("documents.csv.status"), (d) => i18next.t(CSV_STATUS[d.status])],
    [i18next.t("documents.csv.owner"), (d) => d.ownerName ?? d.ownerEmail ?? ""],
    [i18next.t("documents.csv.folder"), (d) => d.folderName ?? ""],
    [i18next.t("documents.csv.template"), (d) => d.templateName ?? ""],
    [i18next.t("documents.csv.recipients"), (d) => d.recipients.map((r) => r.email).join("; ")],
    [
      i18next.t("documents.csv.signed"),
      (d) => `${d.recipients.filter((r) => r.state === "signed").length}/${d.recipients.length}`
    ],
    [i18next.t("documents.csv.created"), (d) => d.createdAt],
    [i18next.t("documents.csv.updated"), (d) => d.updatedAt],
    [i18next.t("documents.csv.sent"), (d) => d.sentAt ?? ""],
    [i18next.t("documents.csv.expires"), (d) => d.expiryDate ?? ""]
  ];
}

export function documentsToCsv(docs: Document[]): string {
  const columns = csvColumns();
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = columns.map(([label]) => cell(label)).join(",");
  const rows = docs.map((d) => columns.map(([, get]) => cell(get(d) ?? "")).join(","));
  return [head, ...rows].join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
