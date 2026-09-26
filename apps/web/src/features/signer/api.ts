/**
 * Data layer for the signer experience.
 *
 * Everything goes through `cloud()` from @/lib/parse, which sends both
 * session-token header spellings (`X-Parse-Session-Token` and `sessiontoken`)
 * because `getDocument` and friends read the lowercase one directly
 * (docs/BACKEND_API.md §1.5).
 *
 * `getDocument` throws a typed Parse error rather than answering `{ error }`
 * with HTTP 200, and `cloud()` re-throws every failure as a CloudError, so the
 * OTP gate ("You don't have access of this document!") arrives here as one.
 */

import { useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { APP_ID, cloud, CloudError, SERVER_URL, rest } from "@/lib/parse";
import type {
  RawContact,
  RawDocument,
  RawPage,
  RawPlaceholder,
  RawWidget,
  SavedSignature,
  SignerDocument,
  SignerField,
  SignerIdentity,
  SignerParty,
  WidgetType
} from "./types";
import { DEFAULT_DATE_FORMAT, defaultSize, isKnownWidget, normalizeWidgetType } from "./widgets";

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isoOf(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "iso" in v) {
    const iso = (v as { iso?: unknown }).iso;
    return typeof iso === "string" ? iso : undefined;
  }
  return undefined;
}

function pointerId(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { objectId?: unknown };
  return typeof o.objectId === "string" ? o.objectId : undefined;
}

const PLACEHOLDER_COLORS = ["#0f6e56", "#6b5bd6", "#b07a12", "#b5412e", "#2f6f9f", "#8a5e0a"];

/** The OTP gate is identified by its message: the code it throws is generic. */
export function isOtpGate(err: unknown): boolean {
  return err instanceof CloudError && /don't have access of this document/i.test(err.message);
}

/* ------------------------------------------------------------------ *
 * Placeholder / widget normalisation
 * ------------------------------------------------------------------ */

/**
 * Self-sign documents store `Placeholders` as a flat `[{ pageNumber, pos }]`
 * with no signer wrapper (§7.2). Everything else wraps pages in `placeHolder`.
 */
export function isFlatPlaceholders(placeholders: RawPlaceholder[]): boolean {
  if (!placeholders.length) return false;
  const hasSigners = placeholders.some((p) => p.signerPtr || p.Role === "prefill" || p.signerObjId);
  const hasNested = placeholders.some((p) => Array.isArray(p.placeHolder));
  return !hasSigners && !hasNested;
}

function pagesOf(entry: RawPlaceholder): RawPage[] {
  if (Array.isArray(entry.placeHolder)) return entry.placeHolder;
  if (Array.isArray(entry.pos)) return [{ pageNumber: entry.pageNumber ?? 1, pos: entry.pos }];
  return [];
}

function toField(
  w: RawWidget,
  page: number,
  placeholderIndex: number,
  pageIndex: number,
  posIndex: number,
  party: { name: string; email?: string; color: string },
  mine: boolean
): SignerField | null {
  const type = normalizeWidgetType(w.type);
  if (!isKnownWidget(type)) return null;
  const o = w.options ?? {};
  const size = defaultSize(type);
  const response = o.response as string | number[] | undefined;
  return {
    key: typeof w.key === "number" ? w.key : Number(w.key) || 0,
    type: type as WidgetType,
    page,
    placeholderIndex,
    pageIndex,
    posIndex,
    mine,
    signerName: party.name,
    signerEmail: party.email,
    color: party.color,
    // §7.3: signature widgets are mandatory whatever `status` says.
    required: type === "signature" || o.status !== "optional",
    readOnly: o.isReadOnly === true,
    hideLabel: o.isHideLabel === true,
    name: o.name,
    hint: o.hint,
    values: Array.isArray(o.values) ? o.values : [],
    layout: o.layout === "horizontal" ? "horizontal" : "vertical",
    cellCount: typeof o.cellCount === "number" ? o.cellCount : 5,
    fontSize: typeof o.fontSize === "number" ? o.fontSize : 12,
    fontColor: typeof o.fontColor === "string" ? o.fontColor : (w.fontColor ?? "black"),
    rotation: typeof o.rotation === "number" ? o.rotation : 0,
    validation: o.validation,
    response: response === "" ? undefined : response,
    defaultValue: o.defaultValue as string | number[] | undefined,
    x: Number(w.xPosition) || 0,
    y: Number(w.yPosition) || 0,
    w: Number(w.Width) || size.w,
    h: Number(w.Height) || size.h,
    placedScale: Number(w.scale) || 1
  };
}

/* ------------------------------------------------------------------ *
 * Document normalisation
 * ------------------------------------------------------------------ */

/**
 * The signing page does NOT use the shared seat rule in @/lib/recipients, on
 * purpose. Two things differ here:
 *  - prefill seats are kept, and every index below is the raw `Placeholders`
 *    index, because that is what the signing link's `placeholderIndex` points
 *    at: renumbering would bind the signer to somebody else's fields.
 *  - a contact is resolved by id only (`signerObjId`, else `signerPtr`), never
 *    by position. An unbound seat has to stay unbound: `mine` is decided by the
 *    index, and inventing a contact for it would show a stranger's name on the
 *    fields this person is about to sign.
 */
export function toSignerDocument(raw: RawDocument, identity: SignerIdentity | null): SignerDocument {
  const placeholders = Array.isArray(raw.Placeholders) ? raw.Placeholders : [];
  const audit = Array.isArray(raw.AuditTrail) ? raw.AuditTrail : [];
  const contacts = Array.isArray(raw.Signers) ? raw.Signers : [];
  const flat = isFlatPlaceholders(placeholders);

  const contactById = new Map<string, RawContact>();
  for (const c of contacts) if (c?.objectId) contactById.set(c.objectId, c);

  const signedContactIds = new Set<string>();
  const signedAtById = new Map<string, string>();
  for (const a of audit) {
    if (a.Activity !== "Signed") continue;
    const id = a.UserPtr?.objectId;
    if (!id) continue;
    signedContactIds.add(id);
    const at = isoOf(a.SignedOn);
    if (at) signedAtById.set(id, at);
  }

  const ownerName = raw.ExtUserPtr?.Name ?? raw.CreatedBy?.name ?? i18next.t("signer.doc.theSender");
  const ownerEmail = raw.ExtUserPtr?.Email ?? raw.CreatedBy?.email ?? raw.CreatedBy?.username ?? "";

  const signers: SignerParty[] = [];
  const fields: SignerField[] = [];

  placeholders.forEach((entry, placeholderIndex) => {
    const isPrefill = entry.Role === "prefill";
    const contactId = entry.signerObjId || pointerId(entry.signerPtr);
    const contact = contactId ? contactById.get(contactId) : undefined;
    const color = entry.blockColor && entry.blockColor !== "transparent"
      ? entry.blockColor
      : PLACEHOLDER_COLORS[placeholderIndex % PLACEHOLDER_COLORS.length];

    const name = flat
      ? (identity?.name ?? ownerName)
      : (contact?.Name ??
          entry.Name ??
          entry.email ??
          entry.Role ??
          i18next.t("signer.party.numbered", { position: placeholderIndex + 1 }));
    const email = flat ? (identity?.email ?? ownerEmail) : (contact?.Email ?? entry.email);

    const mine = flat
      ? true
      : identity
        ? identity.placeholderIndex === placeholderIndex
        : false;

    let fieldCount = 0;
    pagesOf(entry).forEach((pg, pageIndex) => {
      const pos = Array.isArray(pg.pos) ? pg.pos : [];
      pos.forEach((w, posIndex) => {
        const f = toField(w, pg.pageNumber ?? 1, placeholderIndex, pageIndex, posIndex, { name, email, color }, mine && !isPrefill);
        if (f) {
          fields.push(f);
          fieldCount++;
        }
      });
    });

    if (!flat) {
      const signed = contactId ? signedContactIds.has(contactId) : false;
      signers.push({
        order: placeholderIndex,
        contactId,
        role: entry.Role ?? i18next.t("signer.party.roleNumbered", { position: placeholderIndex + 1 }),
        name,
        email,
        color,
        state: signed ? "signed" : "waiting",
        signedAt: contactId ? signedAtById.get(contactId) : undefined,
        fieldCount,
        isPrefill
      });
    }
  });

  // Whose turn it is: the first non-prefill party that has not signed.
  const pending = signers.filter((s) => !s.isPrefill && s.state !== "signed");
  if (pending.length) pending[0].state = "turn";

  if (raw.IsDeclined) {
    const declinedId = pointerId(raw.DeclineBy);
    for (const s of signers) {
      if (s.state !== "signed" && (!declinedId || s.contactId === declinedId)) {
        s.state = "declined";
        break;
      }
    }
  }

  const sigTypes = Array.isArray(raw.SignatureType)
    ? raw.SignatureType.filter((t) => t?.enabled).map((t) => t.name)
    : [];

  return {
    objectId: raw.objectId,
    name: raw.Name ?? i18next.t("signer.doc.untitled"),
    note: raw.Note,
    description: raw.Description,
    fileUrl: raw.SignedUrl || raw.URL,
    originalUrl: raw.URL,
    certificateUrl: raw.CertificateUrl,
    documentHash: raw.DocumentHash,
    isCompleted: raw.IsCompleted === true,
    isDeclined: raw.IsDeclined === true,
    declineReason: raw.DeclineReason,
    declinedByName: signers.find((s) => s.state === "declined")?.name,
    isSignYourself: raw.IsSignyourself === true || flat,
    sendInOrder: raw.SendinOrder === true,
    // Strict order only means anything under `SendinOrder`. Older documents
    // (and any client that wrote the two independently) can carry a stray
    // `SendInOrderStrict: true` with `SendinOrder` off, which would otherwise
    // hold a signer at "waiting your turn" on a document nobody ordered.
    sendInOrderStrict: raw.SendinOrder === true && raw.SendInOrderStrict === true,
    isEnableOTP: raw.IsEnableOTP === true,
    allowModifications: raw.AllowModifications === true,
    expiryDate: isoOf(raw.ExpiryDate),
    sentAt: isoOf(raw.DocSentAt),
    createdAt: raw.createdAt,
    ownerName,
    ownerEmail,
    ownerExtUserId: raw.ExtUserPtr?.objectId,
    dateFormat: raw.DateFormat ?? raw.ExtUserPtr?.DateFormat ?? DEFAULT_DATE_FORMAT,
    signatureTypes: sigTypes,
    penColors: Array.isArray(raw.PenColors) ? raw.PenColors : [],
    redirectUrl: raw.RedirectUrl,
    signers,
    fields,
    raw
  };
}

/* ------------------------------------------------------------------ *
 * Cloud calls
 * ------------------------------------------------------------------ */

/**
 * Every guest-facing call takes the per-signer signing token from the link
 * (`/sign/:docId/:contactId?t=...`). The server accepts it as `signingToken`
 * and treats it as proof that the caller is that one signer on that one
 * document; a signed-in owner needs no token, so it stays optional.
 */
function withToken(
  params: Record<string, unknown>,
  signingToken?: string
): Record<string, unknown> {
  return signingToken ? { ...params, signingToken } : params;
}

export async function fetchDocument(docId: string, signingToken?: string): Promise<RawDocument> {
  const doc = await cloud<RawDocument>("getDocument", withToken({ docId }, signingToken));
  if (!doc || typeof doc !== "object" || !doc.objectId) {
    throw new CloudError(i18next.t("signer.errors.invalidLink"));
  }
  return doc;
}

/**
 * Resolve the contact we are signing as. Non-OTP documents can use `getcontact`
 * (which the signing token authorises); OTP documents need a REST read so the
 * session token is applied (§6.8 step 4).
 */
export async function fetchContact(
  contactId: string,
  viaRest: boolean,
  opts: { docId?: string; signingToken?: string } = {}
): Promise<RawContact | null> {
  if (viaRest) {
    const res = await rest<{ results?: RawContact[] }>("classes/contracts_Contactbook", {
      query: { where: JSON.stringify({ objectId: contactId }), limit: "1" }
    });
    return res.results?.[0] ?? null;
  }
  const c = await cloud<RawContact | null>(
    "getcontact",
    withToken({ contactId, ...(opts.docId ? { docId: opts.docId } : {}) }, opts.signingToken)
  );
  return c && typeof c === "object" ? c : null;
}

/** Binds a guest's email to a placeholder and creates the contact if needed (§6.7). */
export async function linkContactToDoc(
  docId: string,
  email: string,
  name?: string,
  signingToken?: string
): Promise<string> {
  const r = await cloud<{ contactId?: string }>(
    "linkcontacttodoc",
    withToken({ docId, email, ...(name ? { name } : {}) }, signingToken)
  );
  if (!r?.contactId) throw new CloudError(i18next.t("signer.errors.emailNotMatched"));
  return r.contactId;
}

/** Appends a `Viewed` entry to the audit trail. Fire and forget. */
export async function markViewed(docId: string, contactId: string, signingToken?: string): Promise<void> {
  await cloud(
    "triggerevent",
    withToken({ event: "viewed", contactId, body: { objectId: docId } }, signingToken)
  ).catch(() => undefined);
}

export async function fetchSavedSignature(userId: string): Promise<SavedSignature | null> {
  const r = await cloud<{ objectId?: string; ImageURL?: string; Initials?: string; Stamp?: string } | null>(
    "getdefaultsignature",
    { userId }
  ).catch(() => null);
  if (!r || typeof r !== "object") return null;
  if (!r.ImageURL && !r.Initials && !r.Stamp) return null;
  return { objectId: r.objectId, imageUrl: r.ImageURL, initials: r.Initials, stamp: r.Stamp };
}

/** Fresh presigned URL. Local-storage tokens expire in 200s, so re-fetch before download (§8.3). */
export async function freshUrl(url: string, docId?: string, signingToken?: string): Promise<string> {
  const r = await cloud<string>(
    "getsignedurl",
    withToken({ url, ...(docId ? { docId } : {}) }, signingToken)
  );
  return typeof r === "string" && r ? r : url;
}

export async function sendOtp(email: string, docId: string, signingToken?: string): Promise<void> {
  await cloud("SendOTPMailV1", withToken({ email, docId }, signingToken));
}

export interface OtpLoginResult {
  objectId: string;
  sessionToken: string;
}

/**
 * The one auth call made deliberately without a session token (§2.5), so it does
 * not go through `cloud()`. Returns string sentinels instead of error codes.
 */
export async function verifyOtp(email: string, otp: string): Promise<OtpLoginResult> {
  const res = await fetch(`${SERVER_URL}/functions/AuthLoginAsMail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Parse-Application-Id": APP_ID },
    body: JSON.stringify({ email, otp })
  });
  const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (json.error) throw new CloudError(json.error);
  const r = json.result;
  if (typeof r === "string") {
    if (r === "Invalid Otp") throw new CloudError(i18next.t("signer.otp.errors.wrongCode"));
    if (r === "user not found!") throw new CloudError(i18next.t("signer.otp.errors.noAccount"));
    throw new CloudError(i18next.t("signer.otp.errors.notVerified"));
  }
  const ok = r as OtpLoginResult | null;
  if (!ok?.sessionToken) throw new CloudError(i18next.t("signer.otp.errors.notVerified"));
  return ok;
}

export interface SignPdfParams {
  /** base64 of the whole stamped PDF, with no `data:` prefix. */
  pdfFile: string;
  docId: string;
  /** `contracts_Contactbook` objectId. Omitted when the owner signs their own doc (§6.4). */
  userId?: string;
  /** base64 PNG of the signature, used on the completion certificate. */
  signature?: string;
  /** Per-signer token from the signing link, when the caller is a guest. */
  signingToken?: string;
}

export interface SignPdfResult {
  /** base64 of the signed PDF the server stored. */
  data: string;
  /**
   * Signing link for the next signer under `SendinOrder`, when the server
   * minted one. The client cannot mint signing tokens, so without this the
   * next-signer mail it composes can only carry a token-less link.
   */
  nextSignerUrl?: string;
}

export async function signPdf(p: SignPdfParams): Promise<SignPdfResult> {
  const r = await cloud<{ status?: string; data?: string; nextSignerUrl?: string }>(
    "signPdf",
    withToken(
      {
        pdfFile: p.pdfFile,
        docId: p.docId,
        ...(p.userId ? { userId: p.userId } : {}),
        isCustomCompletionMail: false,
        ...(p.signature ? { signature: p.signature } : {})
        // No `activity`: the audit-trail entry is server-controlled (PDF.js
        // hardcodes 'Signed'), and sending one made the call read as if the
        // client picked what the trail records.
      },
      p.signingToken
    )
  );
  return { data: r?.data ?? "", nextSignerUrl: r?.nextSignerUrl };
}

/**
 * Persist the widgets the signer placed themselves, right before `signPdf`.
 *
 * This used to be a raw REST write on `contracts_Document`, which a guest can no
 * longer do now the class is locked down. `saveplaceholders` is the cloud
 * function that replaces it: it takes the signing token, checks the caller may
 * write this document and saves `Placeholders` (plus `IsSignyourself`).
 *
 * The old `AllowModifications` recipient path saved nothing at all, so its extra
 * widgets only ever existed in the flattened bytes; writing them here keeps the
 * document record honest without changing what `signPdf` receives.
 */
export async function saveMyPlaceholders(
  docId: string,
  placeholders: RawPlaceholder[],
  opts: { selfSign?: boolean; signingToken?: string } = {}
): Promise<void> {
  await cloud<{ ok?: boolean }>(
    "saveplaceholders",
    withToken(
      { docId, placeholders, ...(opts.selfSign ? { isSignyourself: true } : {}) },
      opts.signingToken
    )
  );
}

export async function declineDocument(
  docId: string,
  reason: string,
  userId: string,
  signingToken?: string
): Promise<void> {
  await cloud("declinedoc", withToken({ docId, reason, userId }, signingToken));
}

/**
 * Sequential sending: ask the server to mail the next signer. The server renders
 * the request mail itself and mints that recipient's signing link, so the page
 * never composes the email or the link (a signing token only proves "I am this
 * signer", so it may request exactly this one template). Resolves to false
 * when the mail could not be sent.
 */
export async function notifyNextSigner(opts: {
  docId: string;
  recipient: string;
  signingToken?: string;
}): Promise<boolean> {
  try {
    await cloud("sendmailv3", {
      docId: opts.docId,
      template: "next_signer",
      recipient: opts.recipient,
      ...(opts.signingToken ? { signingToken: opts.signingToken } : {})
    });
    return true;
  } catch (e) {
    console.warn("next-signer mail failed", e);
    return false;
  }
}

export async function generateCertificate(docId: string): Promise<string | undefined> {
  const r = await cloud<{ CertificateUrl?: string }>("generatecertificate", { docId }).catch(() => null);
  return r?.CertificateUrl || undefined;
}

/* ------------------------------------------------------------------ *
 * React Query wrappers
 * ------------------------------------------------------------------ */

export const signerKeys = {
  doc: (docId: string) => ["signer", "document", docId] as const
};

export function useSignerDocument(docId: string | undefined, signingToken?: string, enabled = true) {
  return useQuery({
    queryKey: signerKeys.doc(docId ?? ""),
    queryFn: () => fetchDocument(docId as string, signingToken),
    enabled: !!docId && enabled,
    retry: false,
    staleTime: 30_000
  });
}
