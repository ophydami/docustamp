import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { Parse, cloud, rest } from "@/lib/parse";
import { remindMany, type RemindTotals } from "@/lib/reminder";
import type {
  Contact,
  ContactActivity,
  ContactDoc,
  ContactInput,
  ContactStats,
  DocStatus
} from "./types";

/* ------------------------------------------------------------------ */
/* Parse value helpers                                                 */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** objectId out of a pointer, whether the SDK decoded it or not. */
function ptrId(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { id?: unknown; objectId?: unknown };
  return typeof o.id === "string" ? o.id : typeof o.objectId === "string" ? o.objectId : undefined;
}

/**
 * AuditTrail mixes date shapes: `SignedOn` is a Parse Date, `ViewedOn` is a raw
 * ISO string (BACKEND_API.md §6.3 and quirk 3).
 */
function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (v && typeof v === "object") {
    const iso = (v as { iso?: unknown }).iso;
    if (typeof iso === "string") return toDate(iso);
  }
  return undefined;
}

function currentUserPointer() {
  const me = Parse.User.current();
  if (!me) throw new Error(i18next.t("contacts.errors.notSignedIn"));
  return me;
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

const CONTACT_CLASS = "contracts_Contactbook";
const PAGE = 500; // Parse Server maxLimit
const MAX_CONTACTS = 2000;

function toContact(o: Parse.Object): Contact {
  return {
    objectId: o.id ?? "",
    name: str(o.get("Name")) ?? "",
    email: str(o.get("Email")) ?? "",
    phone: str(o.get("Phone")),
    company: str(o.get("Company")),
    jobTitle: str(o.get("JobTitle")),
    userId: ptrId(o.get("UserId")),
    createdAt: o.createdAt?.toISOString(),
    updatedAt: o.updatedAt?.toISOString()
  };
}

export const contactsKey = ["contacts"] as const;

/**
 * Every contact the signed-in user owns. The book is small enough to hold in
 * memory, which is what makes company grouping and the counts below exact.
 */
async function fetchContacts(): Promise<Contact[]> {
  const me = currentUserPointer();
  const out: Contact[] = [];
  for (let skip = 0; skip < MAX_CONTACTS; skip += PAGE) {
    const q = new Parse.Query(CONTACT_CLASS);
    q.equalTo("CreatedBy", me);
    q.notEqualTo("IsDeleted", true);
    q.ascending("Name");
    q.limit(PAGE);
    q.skip(skip);
    const rows = await q.find();
    out.push(...rows.map(toContact));
    if (rows.length < PAGE) break;
  }
  return out;
}

export function useContacts() {
  return useQuery({ queryKey: contactsKey, queryFn: fetchContacts });
}

/* ------------------------------------------------------------------ */
/* Documents each contact appears on                                   */
/* ------------------------------------------------------------------ */

interface RawDoc {
  objectId: string;
  name: string;
  status: DocStatus;
  sentAt?: Date;
  updatedAt?: Date;
  declineByUserId?: string;
  signerIds: string[];
  /** contactId -> latest Signed / Viewed moment on this document. */
  signedBy: Map<string, Date>;
  viewedBy: Map<string, Date>;
}

function docStatus(o: Parse.Object): DocStatus {
  if (o.get("IsDeclined") === true) return "declined";
  if (o.get("IsCompleted") === true) return "completed";
  if (!str(o.get("SignedUrl"))) return "draft";
  const expiry = toDate(o.get("ExpiryDate"));
  if (expiry && expiry.getTime() < Date.now()) return "expired";
  return "waiting";
}

function toRawDoc(o: Parse.Object): RawDoc {
  const signers = (o.get("Signers") as unknown[] | undefined) ?? [];
  const audit = (o.get("AuditTrail") as unknown[] | undefined) ?? [];
  const signedBy = new Map<string, Date>();
  const viewedBy = new Map<string, Date>();

  for (const raw of audit) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const who = ptrId(e.UserPtr);
    if (!who) continue;
    const activity = str(e.Activity);
    if (activity === "Signed") {
      const at = toDate(e.SignedOn) ?? toDate(e.ViewedOn);
      if (at && (signedBy.get(who)?.getTime() ?? 0) < at.getTime()) signedBy.set(who, at);
    } else if (activity === "Viewed") {
      const at = toDate(e.ViewedOn) ?? toDate(e.SignedOn);
      if (at && (viewedBy.get(who)?.getTime() ?? 0) < at.getTime()) viewedBy.set(who, at);
    }
  }

  return {
    objectId: o.id ?? "",
    name: str(o.get("Name")) ?? i18next.t("contacts.doc.untitled"),
    status: docStatus(o),
    sentAt: toDate(o.get("DocSentAt")),
    updatedAt: o.updatedAt,
    declineByUserId: ptrId(o.get("DeclineBy")),
    signerIds: signers.map(ptrId).filter((v): v is string => !!v),
    signedBy,
    viewedBy
  };
}

const DAY = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function statsFor(contact: Contact, docs: RawDoc[]): ContactStats {
  const mine = docs.filter((d) => d.signerIds.includes(contact.objectId));
  const list: ContactDoc[] = [];
  const events: ContactActivity[] = [];
  const durations: number[] = [];
  let pending = 0;
  let signedCount = 0;

  for (const d of mine) {
    const signed = d.signedBy.get(contact.objectId);
    const viewed = d.viewedBy.get(contact.objectId);
    const declined =
      d.status === "declined" && !!contact.userId && d.declineByUserId === contact.userId;
    const open = d.status === "waiting" && !signed;
    if (open) pending += 1;
    if (signed) {
      signedCount += 1;
      if (d.sentAt) durations.push(signed.getTime() - d.sentAt.getTime());
    }

    if (signed) events.push({ kind: "signed", at: signed.toISOString(), stale: false });
    if (viewed && (!signed || viewed > signed)) {
      events.push({
        kind: "viewed",
        at: viewed.toISOString(),
        stale: !signed && Date.now() - viewed.getTime() > DAY
      });
    }
    if (declined && d.updatedAt) {
      events.push({ kind: "declined", at: d.updatedAt.toISOString(), stale: false });
    }
    if (d.sentAt) events.push({ kind: "sent", at: d.sentAt.toISOString(), stale: false });

    list.push({
      objectId: d.objectId,
      name: d.name,
      status: d.status,
      at: (signed ?? viewed ?? d.sentAt ?? d.updatedAt)?.toISOString(),
      pending: open
    });
  }

  list.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  events.sort((a, b) => b.at.localeCompare(a.at));

  return {
    docs: list,
    total: list.length,
    pending,
    activity: events[0] ?? null,
    medianSignMs: median(durations),
    signedCount
  };
}

export const contactDocsKey = ["contacts", "documents"] as const;

/**
 * One query for the whole contact book: `Signers` is an array of pointers, so a
 * single `containedIn` covers everyone. Capped at 500 rows (Parse maxLimit);
 * past that the per-contact counts under-report and we say so in the UI.
 */
async function fetchContactStats(contacts: Contact[]) {
  if (!contacts.length) return { stats: new Map<string, ContactStats>(), capped: false };
  const CB = Parse.Object.extend(CONTACT_CLASS);
  const pointers = contacts.map((c) => CB.createWithoutData(c.objectId));

  const q = new Parse.Query("contracts_Document");
  q.containedIn("Signers", pointers);
  q.notEqualTo("IsArchive", true);
  q.notEqualTo("Type", "Folder");
  q.select(
    "Name",
    "Signers",
    "AuditTrail",
    "IsCompleted",
    "IsDeclined",
    "DeclineBy",
    "SignedUrl",
    "DocSentAt",
    "ExpiryDate"
  );
  q.descending("updatedAt");
  q.limit(PAGE);
  const rows = await q.find();
  const docs = rows.map(toRawDoc);

  const stats = new Map<string, ContactStats>();
  for (const c of contacts) stats.set(c.objectId, statsFor(c, docs));
  return { stats, capped: rows.length >= PAGE };
}

export function useContactStats(contacts: Contact[] | undefined) {
  const ids = (contacts ?? []).map((c) => c.objectId).join(",");
  return useQuery({
    queryKey: [...contactDocsKey, ids],
    queryFn: () => fetchContactStats(contacts ?? []),
    enabled: !!contacts
  });
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

interface SavedContact {
  objectId?: string;
  Email?: string;
}

export async function saveContact(input: ContactInput, tenantId?: string) {
  return cloud<SavedContact | undefined>("savecontact", {
    name: input.name,
    email: input.email,
    phone: input.phone ?? "",
    company: input.company ?? "",
    jobTitle: input.jobTitle ?? "",
    ...(tenantId ? { tenantId } : {})
  });
}

export function useCreateContact(tenantId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ContactInput) => saveContact(input, tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey })
  });
}

/**
 * `editcontact` now edits the row in place and keeps its objectId, so
 * documents that point at the contact follow the edit. It only re-points
 * `UserId` (and rewrites the ACL) when the email address changes.
 */
export function useEditContact(tenantId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, input }: { contactId: string; input: ContactInput }) =>
      cloud<SavedContact>("editcontact", {
        contactId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? "",
        company: input.company ?? "",
        jobTitle: input.jobTitle ?? "",
        // Omitted while useTenant is still resolving: editcontact sets the
        // TenantId pointer from whatever it is given, so an empty string would
        // store a partners_Tenant pointer with an empty objectId and drop the
        // contact's tenant association.
        ...(tenantId ? { tenantId } : {})
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey })
  });
}

/** Nothing is deletable through the REST API; contacts soft-delete (§3.1). */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) =>
      rest(`classes/${CONTACT_CLASS}/${contactId}`, { method: "PUT", body: { IsDeleted: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey })
  });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Imports one row at a time through `savecontact`, so the server's duplicate
 * check runs per contact. The legacy bulk endpoint skipped that check and
 * marked the rows IsImported instead; it has been removed.
 */
export async function importContacts(
  rows: ContactInput[],
  tenantId: string | undefined,
  onProgress: (done: number) => void
) {
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const res = await saveContact(rows[i], tenantId);
      if (res?.objectId) created += 1;
      else failed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|duplicate/i.test(msg)) skipped += 1;
      else {
        failed += 1;
        if (errors.length < 3) errors.push(`${rows[i].email}: ${msg}`);
      }
    }
    onProgress(i + 1);
  }
  return { created, skipped, failed, errors };
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

/**
 * Chase this contact's outstanding documents through the `sendreminder` cloud
 * function, a few at a time. The server owns the mail and the recipient list,
 * so a document where someone else is next in a sequential order reports that
 * person as skipped rather than mailing this contact out of turn.
 */
export function sendReminders(docs: ContactDoc[]): Promise<RemindTotals> {
  return remindMany(docs.map((d) => ({ id: d.objectId, name: d.name })));
}
