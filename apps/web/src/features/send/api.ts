/**
 * Data access for the send flow.
 *
 * Reads go through cloud functions (`getDocument`, `getTemplate`, `getReport`,
 * `getsigners`), writes through `createdocumentfromapp` for the insert and plain
 * REST PUTs afterwards, which is what this backend expects (§3.11, §6.1).
 * Everything is converted to plain records here; components never see Parse shapes.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { CloudError, cloud, rest } from "@/lib/parse";
import { isContent, normaliseContent, type Content } from "@/features/compose/model";
import {
  DEFAULT_SETTINGS,
  type BccEntry,
  type ChainConfig,
  type ContactRecord,
  type DraftDocument,
  type PlaceholderEntry,
  type Recipient,
  type SendSettings,
  type TemplateSummary,
  parseDate,
  pointer
} from "./types";

/** Report ids are hard-coded keys on this server (§9). */
const TEMPLATES_REPORT = "6TeaPr321t";
const CONTACTS_REPORT = "contacts";
const IN_PROGRESS_REPORT = "1MwEuxLEkF";
const COMPLETED_REPORT = "kQUoW4hUXz";

type Raw = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown): boolean {
  return v === true;
}
function iso(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "iso" in v) return str((v as { iso: unknown }).iso);
  return undefined;
}

export function toContact(raw: Raw): ContactRecord {
  return {
    objectId: str(raw.objectId),
    name: str(raw.Name),
    email: str(raw.Email),
    phone: str(raw.Phone) || undefined,
    company: str(raw.Company) || undefined,
    jobTitle: str(raw.JobTitle) || undefined
  };
}

/**
 * `Bcc` comes back in one of two shapes: the plain `{ Name, Email }` objects this
 * app writes, or the `contracts_Contactbook` pointers the old form wrote, which
 * `getDocument` resolves for us because `fetchDraft` asks for `include=Bcc`.
 * An unresolved pointer has no Email and is dropped rather than shown blank.
 */
export function toBcc(value: unknown): BccEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as Raw[])
    .map((row) => ({
      objectId: str(row.objectId) || undefined,
      name: str(row.Name) || undefined,
      email: str(row.Email)
    }))
    .filter((b) => !!b.email);
}

function toPlaceholder(raw: Raw): PlaceholderEntry {
  const signerPtr = (raw.signerPtr ?? {}) as Raw;
  const signerObjId = str(raw.signerObjId) || str(signerPtr.objectId);
  return {
    Id: num(raw.Id, Math.floor(Math.random() * 1e8)),
    Role: str(raw.Role) || "Role 1",
    blockColor: str(raw.blockColor) || "#1447e6",
    signerObjId,
    signerPtr: signerObjId ? pointer("contracts_Contactbook", signerObjId) : {},
    email: str(raw.email),
    ...(str(raw.Name) ? { Name: str(raw.Name) } : {}),
    placeHolder: Array.isArray(raw.placeHolder)
      ? (raw.placeHolder as Array<{ pageNumber: number; pos: unknown[] }>)
      : []
  };
}

export function toDraft(raw: Raw): DraftDocument {
  const signers = Array.isArray(raw.Signers) ? (raw.Signers as Raw[]).map(toContact) : [];
  const remind = num(raw.RemindOnceInEvery, 0);
  return {
    objectId: str(raw.objectId),
    // Normalised on the way in: the editor emits exactly this shape, so the
    // first value it receives is the one it would emit and the caret stays put.
    content: isContent(raw.Content) ? normaliseContent(raw.Content) : undefined,
    name: str(raw.Name),
    note: str(raw.Note),
    description: str(raw.Description),
    url: str(raw.URL),
    sent: !!str(raw.SignedUrl),
    isSignyourself: bool(raw.IsSignyourself),
    placeholders: Array.isArray(raw.Placeholders) ? (raw.Placeholders as Raw[]).map(toPlaceholder) : [],
    signers,
    cc: Array.isArray(raw.Cc) ? (raw.Cc as Array<{ Name?: string; Email: string }>) : [],
    folderId: str((raw.Folder as Raw | undefined)?.objectId) || undefined,
    folderName: str((raw.Folder as Raw | undefined)?.Name) || undefined,
    settings: {
      expiryDays: num(raw.TimeToCompleteDays, DEFAULT_SETTINGS.expiryDays),
      remindEveryDays: bool(raw.AutomaticReminders) ? remind || 3 : 0,
      sendInOrder: bool(raw.SendinOrder),
      strictOrder: bool(raw.SendInOrderStrict),
      auth: bool(raw.IsEnableOTP) ? "otp" : "link",
      notifyOnSignatures: bool(raw.NotifyOnSignatures),
      allowModifications: bool(raw.AllowModifications),
      redirectUrl: str(raw.RedirectUrl),
      bcc: toBcc(raw.Bcc),
      chain: toChain(raw.Chain)
    },
    message: { subject: str(raw.RequestSubject), body: str(raw.RequestBody) },
    templateId: (raw.TemplateId as Raw | undefined)?.objectId as string | undefined,
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt)
  };
}

/* ------------------------------------------------------------------ documents */

export const draftKey = (docId: string | undefined) => ["send", "draft", docId] as const;

export async function fetchDraft(docId: string): Promise<DraftDocument> {
  // `getDocument` includes Signers and Placeholders on its own; Bcc, Cc and Folder
  // have to be asked for, and the parameter is the comma-joined REST form (§4.3).
  const raw = await cloud<Raw>("getDocument", { docId, include: "Bcc,Cc,Folder" });
  return toDraft(raw);
}

export function useDraft(docId: string | undefined) {
  return useQuery({
    queryKey: draftKey(docId),
    queryFn: () => fetchDraft(docId as string),
    enabled: !!docId,
    // The editor writes Placeholders behind this page's back and hands control
    // straight back here, so a cached draft is stale the moment we remount: always
    // refetch, and let SendPage hydrate only once the refetch has landed.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false
  });
}

export interface CreateDraftInput {
  name: string;
  url: string;
  extUserId: string;
  userId: string;
  note?: string;
  description?: string;
  templateId?: string;
  settings?: SendSettings;
  placeholders?: PlaceholderEntry[];
  signerIds?: string[];
  /** contracts_Document objectId of the Drive folder to file this under. */
  folderId?: string;
  /** Set to create the document already sent (bulk send). Otherwise it is a draft. */
  signedUrl?: string;
  /** The text a written document's PDF was rendered from (docs/TEXT_DOCUMENTS.md). */
  content?: Content;
}

/**
 * Creates the draft. A draft is a document with no SignedUrl (§6.1); that
 * absence is the only draft/sent discriminator this backend has.
 */
export async function createDraft(input: CreateDraftInput): Promise<string> {
  const s = input.settings ?? DEFAULT_SETTINGS;
  const document: Raw = {
    Name: input.name.slice(0, 250),
    URL: input.url,
    ExtUserPtr: pointer("contracts_Users", input.extUserId),
    CreatedBy: pointer("_User", input.userId),
    SentToOthers: false,
    SendinOrder: s.sendInOrder,
    // Never on its own: `SendInOrderStrict` is what the signing page and the
    // server both refuse a signature on, so a stored `true` under a document
    // that is *not* sent in order would block signers for a rule the sender
    // turned off. The toggle stays in the wizard state; only the stored value
    // is normalised.
    SendInOrderStrict: Boolean(s.sendInOrder && s.strictOrder),
    IsEnableOTP: s.auth === "otp",
    IsTourEnabled: false,
    AllowModifications: s.allowModifications,
    AutomaticReminders: s.remindEveryDays > 0,
    NotifyOnSignatures: s.notifyOnSignatures,
    TimeToCompleteDays: s.expiryDays,
    RemindOnceInEvery: s.remindEveryDays || 5,
    ...(s.redirectUrl.trim() ? { RedirectUrl: s.redirectUrl.trim() } : {}),
    ...(s.bcc.length ? { Bcc: bccPayload(s.bcc) } : {}),
    ...(input.note ? { Note: input.note.slice(0, 200) } : {}),
    ...(input.description ? { Description: input.description.slice(0, 500) } : {}),
    ...(input.templateId ? { TemplateId: pointer("contracts_Template", input.templateId) } : {}),
    ...(input.placeholders?.length ? { Placeholders: input.placeholders } : {}),
    ...(input.content ? { Content: input.content } : {}),
    ...(input.signerIds?.length
      ? { Signers: input.signerIds.map((id) => pointer("contracts_Contactbook", id)) }
      : {}),
    ...(input.signedUrl
      ? { SignedUrl: input.signedUrl, SentToOthers: true, DocSentAt: parseDate(new Date()) }
      : {})
  };
  // Note: `createdocumentfromapp` whitelists its keys, and RequestSubject /
  // RequestBody are not among them. They are written with a PUT afterwards.
  const res = await cloud<Raw>("createdocumentfromapp", { document });
  const objectId = str(res?.objectId);
  if (!objectId) throw new Error(i18next.t("send.api.documentNotCreated"));
  // `Folder` is not one of the keys `createdocumentfromapp` copies, so it is set
  // with the same follow-up PUT the rest of the non-whitelisted fields use.
  if (input.folderId) {
    await updateDocument(objectId, { Folder: pointer("contracts_Document", input.folderId) });
  }
  return objectId;
}

/** The stored `Chain` column as the wizard's ChainConfig, or null. */
export function toChain(value: unknown): ChainConfig | null {
  const raw = value as Raw | undefined;
  const templateId = str(raw?.templateId);
  if (!templateId) return null;
  return {
    templateId,
    templateName: str(raw?.templateName) || undefined,
    name: str(raw?.name) || undefined
  };
}

/**
 * The stored shape `cloud/lib/chain.js` runs on completion. Recipients are left
 * out on purpose: the server carries the completed document's signers over.
 */
function chainPayload(chain: ChainConfig): Raw {
  return {
    templateId: chain.templateId,
    ...(chain.templateName ? { templateName: chain.templateName } : {}),
    ...(chain.name?.trim() ? { name: chain.name.trim().slice(0, 250) } : {})
  };
}

/** `signPdf` reads only `.Email` off each entry (§3.5); the rest is for our own UI. */
function bccPayload(bcc: BccEntry[]): Raw[] {
  return bcc.map((b) => ({
    ...(b.objectId ? { objectId: b.objectId } : {}),
    Name: b.name ?? "",
    Email: b.email.trim().toLowerCase()
  }));
}

/** Field-level update. `createdocumentfromapp` only inserts, so updates are REST PUTs. */
export async function updateDocument(docId: string, patch: Raw): Promise<void> {
  await rest(`classes/contracts_Document/${docId}`, { method: "PUT", body: patch });
}

/** The subset of a draft that autosave persists between steps. */
export function draftPatch(args: {
  name: string;
  note: string;
  recipients: Recipient[];
  settings: SendSettings;
  message: { subject: string; body: string };
  placeholders: PlaceholderEntry[];
  createdAt?: string;
}): Raw {
  const signerIds = args.recipients
    .filter((r) => r.role === "signer" && r.contactId)
    .map((r) => r.contactId as string);
  const cc = args.recipients
    .filter((r) => r.role === "cc" && r.email)
    .map((r) => ({ Name: r.name, Email: r.email }));
  return {
    Name: args.name.slice(0, 250),
    Note: args.note.slice(0, 200),
    Placeholders: args.placeholders,
    Signers: signerIds.map((id) => pointer("contracts_Contactbook", id)),
    Cc: cc,
    SendinOrder: args.settings.sendInOrder,
    // See createDraft: strict order is only ever stored under sendInOrder.
    SendInOrderStrict: Boolean(args.settings.sendInOrder && args.settings.strictOrder),
    IsEnableOTP: args.settings.auth === "otp",
    NotifyOnSignatures: args.settings.notifyOnSignatures,
    AllowModifications: args.settings.allowModifications,
    RedirectUrl: args.settings.redirectUrl.trim(),
    Bcc: bccPayload(args.settings.bcc),
    // Explicit either way: a chain the sender removed in the wizard has to
    // leave the stored row too, not linger and fire on completion.
    Chain: args.settings.chain?.templateId
      ? chainPayload(args.settings.chain)
      : { __op: "Delete" },
    AutomaticReminders: args.settings.remindEveryDays > 0,
    RemindOnceInEvery: args.settings.remindEveryDays || 5,
    TimeToCompleteDays: args.settings.expiryDays,
    // ExpiryDate is only computed by the server on insert (§11.14), so keep it
    // in step with TimeToCompleteDays ourselves.
    ExpiryDate: parseDate(expiryFrom(args.createdAt, args.settings.expiryDays)),
    RequestSubject: args.message.subject,
    RequestBody: args.message.body
  };
}

export function expiryFrom(createdAt: string | undefined, days: number): Date {
  const base = createdAt ? new Date(createdAt) : new Date();
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Flip the document to "sent": SignedUrl present, SentToOthers true (§11.6). */
export async function markSent(docId: string, url: string): Promise<void> {
  await updateDocument(docId, {
    SignedUrl: url,
    SentToOthers: true,
    DocSentAt: parseDate(new Date())
  });
}

export async function markMailSent(docId: string, subject: string, body: string): Promise<void> {
  await updateDocument(docId, { SendMail: true, RequestSubject: subject, RequestBody: body });
}

/* -------------------------------------------------------------------- folders */

/**
 * Just the folder's name, for the "Saving into ..." line. A folder is a
 * `contracts_Document` row with `Type: "Folder"` (§3.5), so one keyed REST GET
 * is cheaper than a cloud call.
 */
export async function fetchFolderName(folderId: string): Promise<string> {
  const raw = await rest<Raw>(`classes/contracts_Document/${folderId}`, { query: { keys: "Name" } });
  return str(raw?.Name);
}

export function useFolderName(folderId: string | undefined) {
  return useQuery({
    queryKey: ["send", "folder", folderId],
    queryFn: () => fetchFolderName(folderId as string),
    enabled: !!folderId,
    staleTime: 5 * 60_000,
    retry: false
  });
}

/* ------------------------------------------------------------------ templates */

export const templatesKey = ["send", "templates"] as const;

export async function fetchTemplates(): Promise<TemplateSummary[]> {
  const rows = await cloud<Raw[]>("getReport", { reportId: TEMPLATES_REPORT, limit: 20, skip: 0 });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    objectId: str(r.objectId),
    name: str(r.Name) || i18next.t("send.api.untitledTemplate"),
    note: str(r.Note) || undefined,
    url: str(r.URL) || undefined,
    signerCount: Array.isArray(r.Placeholders)
      ? (r.Placeholders as Raw[]).filter((p) => str(p.Role) !== "prefill").length
      : 0,
    updatedAt: iso(r.updatedAt)
  }));
}

export function useTemplates(enabled: boolean) {
  return useQuery({ queryKey: templatesKey, queryFn: fetchTemplates, enabled, staleTime: 60_000 });
}

export interface TemplateDetail {
  objectId: string;
  name: string;
  note: string;
  description: string;
  url: string;
  placeholders: PlaceholderEntry[];
  signers: ContactRecord[];
  settings: SendSettings;
  message: { subject: string; body: string };
}

export async function fetchTemplate(templateId: string): Promise<TemplateDetail> {
  const raw = await cloud<Raw>("getTemplate", { templateId });
  const d = toDraft(raw);
  return {
    objectId: d.objectId,
    name: d.name,
    note: d.note,
    description: d.description,
    url: d.url,
    placeholders: d.placeholders,
    signers: d.signers,
    settings: d.settings,
    message: d.message
  };
}

export function useTemplate(templateId: string | undefined) {
  return useQuery({
    queryKey: ["send", "template", templateId],
    queryFn: () => fetchTemplate(templateId as string),
    enabled: !!templateId,
    staleTime: 60_000
  });
}

/* ------------------------------------------------------------------- contacts */

export const contactsKey = ["send", "contacts"] as const;

export async function fetchContacts(): Promise<ContactRecord[]> {
  const rows = await cloud<Raw[]>("getReport", { reportId: CONTACTS_REPORT, limit: 300, skip: 0 });
  return Array.isArray(rows) ? rows.map(toContact) : [];
}

export function useContacts(enabled = true) {
  return useQuery({ queryKey: contactsKey, queryFn: fetchContacts, enabled, staleTime: 60_000 });
}

export async function searchContacts(search: string): Promise<ContactRecord[]> {
  if (search.trim().length < 2) return [];
  const rows = await cloud<Raw[]>("getsigners", { search: search.trim() });
  return Array.isArray(rows) ? rows.map(toContact) : [];
}

export function useContactSearch(search: string) {
  return useQuery({
    queryKey: ["send", "contact-search", search.trim().toLowerCase()],
    queryFn: () => searchContacts(search),
    enabled: search.trim().length >= 2,
    staleTime: 30_000
  });
}

/**
 * Resolve a recipient to a contracts_Contactbook row, creating it when new.
 * `savecontact` throws DUPLICATE_VALUE when the email already exists for this
 * owner, so fall back to a lookup in that case (§4.5).
 */
export async function ensureContact(input: {
  name: string;
  email: string;
  phone?: string;
  tenantId?: string;
}): Promise<ContactRecord> {
  const email = input.email.trim().toLowerCase();
  try {
    const raw = await cloud<Raw>("savecontact", {
      name: input.name.trim() || email,
      email,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.tenantId ? { tenantId: input.tenantId } : {})
    });
    return toContact(raw);
  } catch (err) {
    const duplicate =
      err instanceof CloudError && (err.code === 137 || /already exist|duplicate/i.test(err.message));
    if (!duplicate) throw err;
    const found = (await searchContacts(email)).find((c) => c.email.toLowerCase() === email);
    if (!found) throw err;
    return found;
  }
}

export function useCreateContact() {
  return useMutation({ mutationFn: ensureContact });
}

/* -------------------------------------------------------------------- history */

export interface HistoryDoc {
  signers: Array<{ name: string; email: string }>;
  expiryDays?: number;
}

/**
 * Recently sent documents, used to suggest recipients and an expiry. Both
 * reports return `Signers.Name` / `Signers.Email` plus `ExpiryDate` (§9).
 */
export async function fetchHistory(): Promise<HistoryDoc[]> {
  const [inProgress, completed] = await Promise.all([
    cloud<Raw[]>("getReport", { reportId: IN_PROGRESS_REPORT, limit: 50, skip: 0 }).catch(() => []),
    cloud<Raw[]>("getReport", { reportId: COMPLETED_REPORT, limit: 50, skip: 0 }).catch(() => [])
  ]);
  const rows = [...(Array.isArray(inProgress) ? inProgress : []), ...(Array.isArray(completed) ? completed : [])];
  return rows.map((r) => {
    const created = iso(r.createdAt);
    const expiry = iso(r.ExpiryDate);
    let expiryDays: number | undefined;
    if (created && expiry) {
      const days = Math.round((new Date(expiry).getTime() - new Date(created).getTime()) / 86_400_000);
      if (days > 0 && days <= 365) expiryDays = days;
    }
    return {
      signers: (Array.isArray(r.Signers) ? (r.Signers as Raw[]) : []).map((s) => ({
        name: str(s.Name),
        email: str(s.Email)
      })),
      expiryDays
    };
  });
}

export function useHistory(enabled: boolean) {
  return useQuery({
    queryKey: ["send", "history"],
    queryFn: fetchHistory,
    enabled,
    staleTime: 5 * 60_000
  });
}

/* ----------------------------------------------------------------------- mail */

export interface MailParams {
  recipient: string;
  subject: string;
  html: string;
  from: string;
  replyto?: string;
  extUserId?: string;
}

/**
 * `sendmailv3` is the only mail endpoint in this build (§4.6).
 *
 * It answers `{ status: "success" }` and raises a Parse error on every failure
 * path, including "no mail provider configured", so a rejected message reaches
 * the caller as a thrown `CloudError` instead of being counted as delivered.
 */
export async function sendMail(params: MailParams): Promise<void> {
  await cloud<{ status?: string }>("sendmailv3", { ...params });
}

/* ----------------------------------------------------------------- bulk send */

/** Who the batch is sent as. `batchdocuments` reads these off the payload (§4.3). */
export interface BulkSender {
  userId: string;
  extUserId: string;
  name: string;
  email: string;
  company?: string;
  phone?: string;
  useNameAsSender?: boolean;
}

export interface BulkSendInput {
  sender: BulkSender;
  /** Document name, the same for every row. */
  name: string;
  url: string;
  note: string;
  description?: string;
  templateId?: string;
  settings: SendSettings;
  /** Merged by the server per recipient, so both keep their `{{var}}` markers. */
  subject: string;
  bodyTemplate: string;
  /** Template placeholders. The entry with `roleId` is bound to each row's contact. */
  placeholders: PlaceholderEntry[];
  roleId: number;
  /** One document per contact, in this order. Results come back on the same index. */
  contacts: ContactRecord[];
}

/** One recipient of a created document that the server could not email. */
export interface BatchMailFailure {
  index: number;
  email: string;
  reason: string;
}

export interface BatchRowResult {
  index: number;
  objectId?: string;
  error?: string;
  /** Set when the document was created but its request mail was not accepted. */
  mailFailed?: Array<{ email: string; reason: string }>;
}

export interface BatchSendSummary {
  total: number;
  created: number;
  failed: number;
  /** Documents that exist but whose recipient was never emailed. */
  mailFailed: BatchMailFailure[];
  results: BatchRowResult[];
}

function batchDocument(input: BulkSendInput, contact: ContactRecord): Raw {
  const s = input.settings;
  const placeholders: Raw[] = input.placeholders.map((p) =>
    p.Id === input.roleId
      ? {
          ...p,
          signerObjId: contact.objectId,
          // Not a pointer here: the server reads Email off it and builds the pointer.
          signerPtr: { objectId: contact.objectId, Name: contact.name, Email: contact.email },
          email: contact.email
        }
      : { ...p }
  );
  return {
    Name: input.name.slice(0, 250),
    URL: input.url,
    Note: input.note.slice(0, 200),
    ...(input.description ? { Description: input.description.slice(0, 500) } : {}),
    CreatedBy: pointer("_User", input.sender.userId),
    SendinOrder: s.sendInOrder,
    // See createDraft: strict order is only ever stored under sendInOrder.
    SendInOrderStrict: Boolean(s.sendInOrder && s.strictOrder),
    IsEnableOTP: s.auth === "otp",
    IsTourEnabled: false,
    AllowModifications: s.allowModifications,
    AutomaticReminders: s.remindEveryDays > 0,
    RemindOnceInEvery: s.remindEveryDays || 5,
    TimeToCompleteDays: s.expiryDays,
    NotifyOnSignatures: s.notifyOnSignatures,
    ...(s.redirectUrl.trim() ? { RedirectUrl: s.redirectUrl.trim() } : {}),
    ...(s.bcc.length ? { Bcc: bccPayload(s.bcc) } : {}),
    ...(s.chain?.templateId ? { Chain: chainPayload(s.chain) } : {}),
    // The server takes the sender, the company and the mail template from this object
    // rather than from the database, and copies TenantId.Request* onto the created
    // document as RequestSubject / RequestBody (§4.3).
    ExtUserPtr: {
      className: "contracts_Users",
      objectId: input.sender.extUserId,
      Name: input.sender.name,
      Email: input.sender.email,
      UseNameAsSender: input.sender.useNameAsSender === true,
      ...(input.sender.company ? { Company: input.sender.company } : {}),
      ...(input.sender.phone ? { Phone: input.sender.phone } : {}),
      TenantId: { RequestSubject: input.subject, RequestBody: input.bodyTemplate }
    },
    Placeholders: placeholders,
    Signers: [
      {
        objectId: contact.objectId,
        Name: contact.name,
        Email: contact.email,
        ...(contact.phone ? { Phone: contact.phone } : {})
      }
    ],
    // `objectId` on the payload is what the server turns into TemplateId (§4.3).
    ...(input.templateId ? { objectId: input.templateId } : {})
  };
}

/**
 * Bulk send: one round trip that creates every document already sent and mails its
 * first signer. `Documents` is a stringified array and the mode travels in a `type`
 * header; `cloud()` already sends the `sessiontoken` header the function reads.
 * The server derives the signing-link host from the request itself.
 */
export async function sendBatchDocuments(input: BulkSendInput): Promise<BatchSendSummary> {
  const documents = input.contacts.map((c) => batchDocument(input, c));
  const res = await cloud<Partial<BatchSendSummary>>(
    "batchdocuments",
    { Documents: JSON.stringify(documents) },
    { headers: { type: "bulksend" } }
  );
  const results: BatchRowResult[] = Array.isArray(res?.results)
    ? res.results.map((r, i) => ({
        index: typeof r?.index === "number" ? r.index : i,
        objectId: str(r?.objectId) || undefined,
        error: str(r?.error) || undefined,
        mailFailed: Array.isArray(r?.mailFailed)
          ? r.mailFailed.map((m) => ({ email: str(m?.email), reason: str(m?.reason) }))
          : undefined
      }))
    : [];
  const created = results.filter((r) => r.objectId).length;
  return {
    // Older builds of this function answered with counters only. Trust `results` when
    // it is there, fall back to the counters when it is not.
    total: num(res?.total, documents.length),
    created: results.length ? created : num(res?.created, 0),
    failed: results.length ? results.length - created : num(res?.failed, 0),
    // A document can be created and still not be emailed; the server reports the
    // recipients it could not reach rather than staying silent about them.
    mailFailed: Array.isArray(res?.mailFailed)
      ? res.mailFailed.map((m, i) => ({
          index: typeof m?.index === "number" ? m.index : i,
          email: str(m?.email),
          reason: str(m?.reason)
        }))
      : [],
    results
  };
}
