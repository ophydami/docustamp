/**
 * Reports data access.
 *
 * There is no analytics endpoint on this backend, so we page `contracts_Document`
 * with the Parse SDK and compute everything client-side (see compute.ts).
 * Reads are ACL-scoped, so a user sees their own documents plus any document
 * they are a signer on (BACKEND_API.md §6.6), which is what makes the
 * "Everyone" owner filter meaningful when it appears.
 */
import { useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { cloud, Parse } from "@/lib/parse";
import { useAuth } from "@/app/auth";
import type { AuditEvent, DateRange, DocRow, OpenStat, SignerRef } from "./types";
import { previousRange } from "./compute";

const CLASS = "contracts_Document";
/** Parse Server is configured with `maxLimit: 500`. */
const PAGE = 500;
/** The page cap; the UI says so when it is hit. */
export const MAX_DOCS = 3000;

/** The `getReport` bucket that lists templates (BACKEND_API.md §9). */
const TEMPLATES_REPORT = "6TeaPr321t";

/**
 * `keys` sent to the server. Dotted keys pull the named field off an included
 * pointer, and Parse Server turns any dotted key into an `include` on its own,
 * so a dotted key is only safe when the target class allows `find`. That rules
 * out `ExtUserPtr.*` (contracts_Users) and `TemplateId.*` (contracts_Template),
 * whose find CLP is closed to clients: asking for them fails the whole query
 * with error 119. Both stay here as bare pointers, which is enough for their ids.
 *
 * `AuditTrail` has to be fetched whole, and it is the heavy part of the payload:
 * it is an array of plain objects whose `Signed` entries each carry a base64
 * signature image. A sub-field projection is not available to any client:
 * RestQuery collapses every key to its root field before it reaches the
 * database (`findOptions.keys = this.keys.map(key => key.split('.')[0])`), and
 * `excludeKeys` is filtered the same way, so asking for `AuditTrail.Activity`
 * returns the whole trail. Trimming this needs the server: an aggregate that
 * returns the counts and timestamps this page computes, or PDF.js not writing
 * the signature image into the trail entry in the first place.
 */
const KEYS = [
  "Name",
  "SignedUrl",
  "DocSentAt",
  "ExpiryDate",
  "IsCompleted",
  "IsDeclined",
  "IsSignyourself",
  "IsArchive",
  "Type",
  "AuditTrail",
  "OpenStats",
  "DeclineBy",
  "Signers",
  "Signers.Name",
  "Signers.Email",
  "Signers.UserId",
  "CreatedBy",
  "CreatedBy.name",
  "CreatedBy.email",
  "CreatedBy.username",
  "ExtUserPtr",
  "TemplateId"
];

type Unknowns = Record<string, unknown>;

/** Read a field from either a Parse.Object or an already-plain record. */
function field(o: unknown, key: string): unknown {
  if (!o || typeof o !== "object") return undefined;
  const maybe = o as { get?: (k: string) => unknown };
  if (typeof maybe.get === "function") return maybe.get(key);
  return (o as Unknowns)[key];
}

function idOf(o: unknown): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const p = o as { id?: string; objectId?: string };
  return p.id ?? p.objectId;
}

/** AuditTrail mixes Date objects (`SignedOn`) and ISO strings (`ViewedOn`). */
function toDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === "object" && "iso" in (v as Unknowns)) return toDate((v as { iso: unknown }).iso);
  return undefined;
}

function toSigners(v: unknown): SignerRef[] {
  if (!Array.isArray(v)) return [];
  const out: SignerRef[] = [];
  for (const s of v) {
    const objectId = idOf(s);
    if (!objectId) continue;
    out.push({
      objectId,
      name: String(field(s, "Name") ?? ""),
      email: String(field(s, "Email") ?? ""),
      userId: idOf(field(s, "UserId"))
    });
  }
  return out;
}

function toAudit(v: unknown): AuditEvent[] {
  if (!Array.isArray(v)) return [];
  const out: AuditEvent[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Unknowns;
    const activity = String(e.Activity ?? "");
    if (!activity) continue;
    out.push({
      activity,
      actorId: idOf(e.UserPtr),
      at: toDate(e.SignedOn) ?? toDate(e.ViewedOn)
    });
  }
  return out;
}

function toOpens(v: unknown): Record<string, OpenStat> {
  const out: Record<string, OpenStat> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [contactId, raw] of Object.entries(v as Unknowns)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Unknowns;
    const count = Math.max(0, Math.trunc(Number(s.count)) || 0);
    if (!count) continue;
    out[contactId] = { count, firstAt: toDate(s.firstAt), lastAt: toDate(s.lastAt) };
  }
  return out;
}

export function toDocRow(o: Parse.Object, templateNames?: Map<string, string>): DocRow {
  const createdAt = o.createdAt ?? new Date();
  const updatedAt = o.updatedAt ?? createdAt;
  const audit = toAudit(o.get("AuditTrail"));
  const isCompleted = o.get("IsCompleted") === true;
  const signedUrl = o.get("SignedUrl");
  const sentAt = toDate(o.get("DocSentAt")) ?? (signedUrl ? createdAt : undefined);

  const signedAts = audit.filter((a) => a.activity === "Signed" && a.at).map((a) => (a.at as Date).getTime());
  const viewedAts = audit.filter((a) => a.activity === "Viewed" && a.at).map((a) => (a.at as Date).getTime());
  const completedAt = isCompleted
    ? new Date(signedAts.length ? Math.max(...signedAts) : updatedAt.getTime())
    : undefined;

  // ExtUserPtr and TemplateId are unresolved pointers (their classes are not
  // findable by clients), so only their ids are readable here. The member name
  // comes from the CreatedBy `_User` include, the template name from the report.
  const extUser = o.get("ExtUserPtr");
  const createdBy = o.get("CreatedBy");
  const templateId = idOf(o.get("TemplateId"));
  const templateName = templateId ? templateNames?.get(templateId) : undefined;

  return {
    objectId: o.id ?? "",
    name: String(o.get("Name") ?? i18next.t("reports.untitledDocument")),
    createdAt,
    updatedAt,
    sentAt,
    expiryDate: toDate(o.get("ExpiryDate")),
    isCompleted,
    isDeclined: o.get("IsDeclined") === true,
    declinedById: idOf(o.get("DeclineBy")),
    signers: toSigners(o.get("Signers")),
    audit,
    opens: toOpens(o.get("OpenStats")),
    ownerId: idOf(extUser) ?? idOf(createdBy) ?? "unknown",
    ownerName: String(field(createdBy, "name") ?? field(createdBy, "username") ?? field(createdBy, "email") ?? ""),
    templateId,
    templateName,
    completedAt,
    firstViewedAt: viewedAts.length ? new Date(Math.min(...viewedAts)) : undefined,
    timeToSignMs:
      completedAt && sentAt && completedAt.getTime() > sentAt.getTime()
        ? completedAt.getTime() - sentAt.getTime()
        : undefined
  };
}

/**
 * Template id to name. `contracts_Template.find` is denied to clients, so this
 * is the only way to name a template; it is optional, and an empty map just
 * means the template breakdown groups under "no template".
 */
async function fetchTemplateNames(): Promise<Map<string, string>> {
  const rows = await cloud<Array<{ objectId?: string; Name?: string }>>("getReport", {
    reportId: TEMPLATES_REPORT,
    limit: 200,
    skip: 0
  }).catch(() => []);
  const map = new Map<string, string>();
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    if (r?.objectId && r.Name) map.set(r.objectId, r.Name);
  }
  return map;
}

function windowQuery(from: Date, to: Date) {
  const created = new Parse.Query(CLASS);
  created.greaterThanOrEqualTo("createdAt", from);
  created.lessThanOrEqualTo("createdAt", to);
  // Anything completed inside the window was necessarily touched inside it.
  const touched = new Parse.Query(CLASS);
  touched.greaterThanOrEqualTo("updatedAt", from);
  touched.lessThanOrEqualTo("updatedAt", to);
  return Parse.Query.or(created, touched);
}

/**
 * Fetch every document that was created or touched inside `range` (plus the
 * preceding window of the same length, so the overview can say "was ...").
 * Pages of 500 up to a 3000 document cap; `truncated` tells the UI when the cap
 * was hit so it can say so instead of quietly under-reporting.
 */
export async function fetchDocs(range: DateRange, signal?: AbortSignal): Promise<{ rows: DocRow[]; truncated: boolean }> {
  const prev = previousRange(range);
  const q = windowQuery(prev.from, range.to);
  q.notEqualTo("Type", "Folder");
  q.notEqualTo("IsArchive", true);
  // Self-signed documents complete instantly and would flatten every timing
  // metric, so this report covers documents sent to other people only.
  q.notEqualTo("IsSignyourself", true);
  q.select(KEYS);
  // Only contracts_Contactbook and _User may be found by a client (§3.1).
  q.include(["Signers", "CreatedBy"]);
  q.descending("updatedAt");
  q.limit(PAGE);

  const templateNames = await fetchTemplateNames();

  const rows: DocRow[] = [];
  for (let skip = 0; skip < MAX_DOCS; skip += PAGE) {
    // Checked before the request, not after it: a page already in flight is
    // paid for in full, server work included.
    if (signal?.aborted) return { rows, truncated: true };
    q.skip(skip);
    const page = await q.find();
    for (const o of page) rows.push(toDocRow(o, templateNames));
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export const reportsKey = (from: string, to: string) => ["reports", "documents", from, to] as const;

export function useReportDocs(range: DateRange) {
  const { user } = useAuth();
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  return useQuery({
    queryKey: [...reportsKey(from, to), user?.id],
    queryFn: ({ signal }) => fetchDocs(range, signal),
    enabled: !!user,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000
  });
}
