import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { Parse, cloud, customRouteBase, parseHeaders, rest } from "@/lib/parse";
import { useAuth } from "@/app/auth";
import { extUserKey } from "@/lib/extUser";
import { brandKey } from "@/lib/brand";
import { recordFileUsage } from "@/lib/fileUsage";
import type {
  AgentRules,
  DocumentExportRow,
  MailTemplates,
  SignatureRecord,
  TeamMember,
  TeamRecord,
  Tenant
} from "./types";

export const settingsKeys = {
  tenant: (userId?: string) => ["settings", "tenant", userId] as const,
  signature: (userId?: string) => ["settings", "signature", userId] as const,
  members: (orgId?: string) => ["settings", "members", orgId] as const,
  teams: () => ["settings", "teams"] as const,
  sessions: () => ["settings", "sessions"] as const
};

/** The Express routes (`/deleteuser/...`) live beside the Parse mount (@/lib/parse). */
const API_ROOT = customRouteBase();

/* ------------------------------------------------------------------ tenant */

/**
 * `gettenant` returns a whitelisted view of the tenant row, or `{}` when the
 * caller has no tenant yet (it throws rather than answering a string sentinel
 * now, so a real failure arrives as a CloudError). A row without an objectId is
 * not a row, so it becomes null.
 */
export function useTenant() {
  const { user } = useAuth();
  return useQuery({
    queryKey: settingsKeys.tenant(user?.id),
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Tenant | null> => {
      // `userId` is ignored server-side (the tenant comes from the caller's own
      // row); it is still sent for older servers that read it.
      const res = await cloud<Partial<Tenant> | Record<string, never>>("gettenant", {
        userId: user?.id
      });
      if (!res || typeof res !== "object") return null;
      return typeof res.objectId === "string" ? (res as Tenant) : null;
    }
  });
}

/** Invalidate the cached tenant, and the brand shown in the app chrome with it. */
export function useInvalidateTenant() {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ["settings", "tenant"] });
    await qc.invalidateQueries({ queryKey: brandKey });
  };
}

/** The branding half of partners_Tenant, as `updatetenant` accepts it (§4.1). */
export interface TenantBranding {
  TenantName?: string;
  Logo?: string;
  EmailSenderName?: string;
  EmailFooter?: string;
  HidePoweredBy?: boolean;
  ReplyTo?: string;
}

/**
 * Admin-only write. The server refuses a non-admin with code 119 and any key
 * that is not an editable workspace setting with 105.
 */
export async function updateTenantBranding(tenantId: string, details: TenantBranding) {
  return cloud<Tenant>("updatetenant", { tenantId, details });
}

/* -------------------------------------------------------------- ext user IO */

/** What `updateprofile` returns: the updated row, as plain JSON. */
export type ExtUserRow = { objectId: string } & Record<string, unknown>;

/**
 * Self-service write to the caller's own contracts_Users row.
 *
 * contracts_Users is master-key only now, so this goes through the
 * `updateprofile` cloud function, which applies a whitelist of self-editable
 * keys to the caller's own row and returns it.
 */
export async function updateExtUser(patch: Record<string, unknown>) {
  return cloud<ExtUserRow>("updateprofile", { patch });
}

export interface PreferencePatch {
  Timezone?: string;
  NotifyOnSignatures?: boolean;
  SendinOrder?: boolean;
  IsTourEnabled?: boolean;
  DateFormat?: string;
  Is12HourTime?: boolean;
  IsLTVEnabled?: boolean;
  DownloadFilenameFormat?: string;
  UseNameAsSender?: boolean;
}

/**
 * `updatepreferences` writes any of the keys above and accepts a patch that
 * carries just one of them. It used to gate on SignatureType / NotifyOnSignatures
 * / Timezone alone, so this app attached a browser-guessed `Timezone` to every
 * preference write and quietly overwrote the stored zone each time; the zone is
 * now only sent when the user is actually changing it.
 */
export async function updatePreferences(patch: PreferencePatch) {
  return cloud("updatepreferences", patch as Record<string, unknown>);
}

/** Rejects when nothing is enabled, or when only `default` is enabled. */
export async function updateSignatureTypes(types: Array<{ name: string; enabled: boolean }>) {
  return cloud("updatesignaturetype", { SignatureType: types });
}

export async function setDateWidgetPreference(pref: {
  isSigningDate: boolean;
  isReadOnly: boolean;
  date?: string;
  format?: string;
}) {
  return cloud("setwidgetpreferences", { dateWidget: pref });
}

/** Invalidate the cached contracts_Users row after any profile/preference write. */
export function useInvalidateExtUser() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: extUserKey });
}

/* ----------------------------------------------------------------- uploads */

/**
 * Upload through Parse.File, then swap the raw URL for a signed one exactly
 * like the old client did (§8.2). Local `/files/` URLs need the token or they
 * 400; S3 URLs come back unchanged.
 */
export async function uploadImage(file: File): Promise<string> {
  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  const parseFile = new Parse.File(safeName, file);
  const saved = await parseFile.save();
  const raw = saved?.url();
  if (!raw) throw new Error(i18next.t("settings.errors.uploadNoUrl"));
  let url = raw;
  if (raw.includes("/files/")) {
    const signed = await cloud<{ url?: string }>("fileupload", { url: raw });
    url = signed?.url ?? raw;
  }
  // Counted against the workspace quota by the server (see @/lib/fileUsage).
  void recordFileUsage(url, file.size);
  return url;
}

/** Redraw an image file onto a canvas at most `max` px on its long edge. */
export async function compressImage(file: File, max = 400, mime = "image/png"): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) return file;
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  return new File([blob], file.name.replace(/\.\w+$/, "") + "." + ext, { type: mime });
}

/** `_User.ProfilePic` is a plain URL string, presigned again on read. */
export async function saveUserAccount(patch: { name?: string; phone?: string; ProfilePic?: string }) {
  const current = Parse.User.current();
  if (!current) throw new Error(i18next.t("settings.errors.notSignedIn"));
  if (patch.name !== undefined) current.set("name", patch.name);
  if (patch.phone !== undefined) current.set("phone", patch.phone);
  if (patch.ProfilePic !== undefined) current.set("ProfilePic", patch.ProfilePic);
  await current.save();
}

/* --------------------------------------------------------------- signature */

export function useSignature() {
  const { user } = useAuth();
  return useQuery({
    queryKey: settingsKeys.signature(user?.id),
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<SignatureRecord | null> => {
      const res = await cloud<SignatureRecord | undefined | "">("getdefaultsignature", { userId: user?.id });
      return res && typeof res === "object" && res.objectId ? res : null;
    }
  });
}

/** `savesignature` only writes the keys it is given, so partial saves are safe. */
export function useSaveSignature() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; signature?: string; initials?: string; title?: string }) => {
      return cloud<SignatureRecord>("savesignature", {
        userId: user?.id,
        ...(input.id ? { id: input.id } : {}),
        ...(input.signature ? { signature: input.signature } : {}),
        ...(input.initials ? { initials: input.initials } : {}),
        ...(input.title ? { title: input.title } : {})
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "signature"] })
  });
}

/* -------------------------------------------------------------------- team */

export function useTeamMembers(organizationId?: string) {
  return useQuery({
    queryKey: settingsKeys.members(organizationId),
    enabled: !!organizationId,
    staleTime: 60_000,
    queryFn: async (): Promise<TeamMember[]> => {
      const res = await cloud<TeamMember[] | null>("getuserlistbyorg", { organizationId });
      return Array.isArray(res) ? res : [];
    }
  });
}

export function useTeams(enabled: boolean) {
  return useQuery({
    queryKey: settingsKeys.teams(),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TeamRecord[]> => {
      const res = await cloud<TeamRecord[] | null>("getteams", { active: true });
      return Array.isArray(res) ? res : [];
    }
  });
}

export interface AddUserInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  /** Short role name: the server prefixes it with `contracts_`. Admin is refused. */
  role: "OrgAdmin" | "Editor" | "User";
  team: string;
  tenantId: string;
  organizationId: string;
  company?: string;
  timezone?: string;
}

/**
 * `passwordIgnored` is true when the address already had a sign-in with no
 * profile (someone who was only ever a signer): the server links that account
 * into the workspace and leaves its credentials alone, so the password typed
 * here was not set.
 */
export async function addUser(input: AddUserInput) {
  return cloud<TeamMember & { passwordIgnored?: boolean }>("adduser", {
    name: input.name,
    email: input.email,
    phone: input.phone ?? "",
    password: input.password,
    role: input.role,
    team: input.team,
    tenantId: input.tenantId,
    organization: { objectId: input.organizationId, ...(input.company ? { company: input.company } : {}) },
    ...(input.timezone ? { timezone: input.timezone } : {})
  });
}

/** Admin-only. Refuses the caller's own account and other admins. */
export async function resetUserPassword(userId: string, password: string) {
  return cloud<{ status: string; message: string }>("resetpassword", { userId, password });
}

/**
 * Admin-only writes on someone else's contracts_Users row (§2.9). The class is
 * master-key only, so both go through `updateteammember`, which checks the
 * caller is an admin of the same tenant and returns the updated row.
 */
export async function setMemberDisabled(extUserId: string, disabled: boolean) {
  return cloud<ExtUserRow>("updateteammember", { extUserId, isDisabled: disabled });
}

export async function setMemberRole(extUserId: string, role: string) {
  return cloud<ExtUserRow>("updateteammember", { extUserId, role });
}

/** Express route, not a cloud function. Reads the raw `sessiontoken` header. */
export async function deleteMember(userObjectId: string): Promise<string> {
  const res = await fetch(`${API_ROOT}/deleteuser/${userObjectId}`, {
    method: "POST",
    headers: parseHeaders()
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(json.message ?? i18next.t("settings.errors.deleteFailed", { status: res.status }));
  return json.message ?? i18next.t("settings.team.toast.removedFallback");
}

/* ---------------------------------------------------------------- security */

/**
 * Verify the current password by signing in again, then save the new one and
 * adopt the session token the save returns (mirrors the old client).
 */
export async function changePassword(email: string, currentPassword: string, newPassword: string) {
  await Parse.User.logIn(email, currentPassword);
  const current = Parse.User.current();
  if (!current) throw new Error(i18next.t("settings.errors.notSignedIn"));
  current.set("password", newPassword);
  const saved = await current.save();
  const token = (saved.toJSON() as { sessionToken?: string }).sessionToken;
  if (token) await Parse.User.become(token);
}

/**
 * Setting a password without knowing the current one: an account that signed
 * in with an emailed code or Google has none it knows. The server mails a
 * 6-digit code to the account's own address, then stores the password, ends
 * every session and hands a new session token back.
 */
export async function sendPasswordCode() {
  return cloud<{ sent: boolean; email: string }>("sendpasswordcode");
}

export async function setPasswordWithCode(otp: string, password: string) {
  return cloud<{ sessionToken: string }>("setpasswordwithcode", { otp, password });
}

export interface SessionRow {
  objectId: string;
  createdAt?: string;
  expiresAt?: string;
  installationId?: string;
  /** How the session was started: "password", "masterkey" (an emailed code or a signing link), "google". */
  signedInWith?: string;
  current: boolean;
}

/** Parse only lets a user read their own `_Session` rows; some servers refuse. */
export function useSessions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: settingsKeys.sessions(),
    enabled: !!user,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<SessionRow[]> => {
      const q = new Parse.Query(Parse.Session);
      q.descending("createdAt");
      q.limit(50);
      const rows = await q.find();
      const currentToken = Parse.User.current()?.getSessionToken();
      return rows.map((s) => {
        const expires = s.get("expiresAt") as Date | undefined;
        const installationId = s.get("installationId") as string | undefined;
        const createdWith = s.get("createdWith") as { authProvider?: string } | undefined;
        return {
          objectId: s.id ?? "",
          createdAt: s.createdAt?.toISOString(),
          expiresAt: expires instanceof Date ? expires.toISOString() : undefined,
          installationId,
          signedInWith: createdWith?.authProvider,
          current: (s.get("sessionToken") as string | undefined) === currentToken
        };
      });
    }
  });
}

export async function revokeSession(objectId: string) {
  const s = new Parse.Session();
  s.id = objectId;
  await s.destroy();
}

/* ------------------------------------------------------- account deletion */

/** Emails a confirmation link; only works for the tenant admin (§2.10). */
export async function requestAccountDeletion(userId: string) {
  return cloud<string>("senddeleterequest", { userId });
}

/* --------------------------------------------------------- mail templates */

/**
 * Writes the four template keys onto partners_Tenant, which is where the mail
 * builders read them from (document, then tenant, then the sender's own row,
 * then built-in). Admin only: there is no member write path any more, since the
 * cloud function that stored the same keys on the caller's contracts_Users row
 * had no caller left.
 */
export async function updateTenantTemplates(tenantId: string, details: MailTemplates) {
  return cloud("updatetenant", { tenantId, details });
}

/* ---------------------------------------------------------------- storage */

/**
 * Bytes this workspace has uploaded, as tracked by partners_TenantCredits.
 *
 * A read with the caller's session, which is all the quota display needs. The
 * matching writes are the server's (`recordfileusage`, see @/lib/fileUsage);
 * nothing in this app writes these two classes any more.
 */
export function useStorageUsage(tenantId?: string) {
  return useQuery({
    queryKey: ["settings", "storage", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<number | null> => {
      const res = await rest<{ results?: Array<{ usedStorage?: number }> }>("classes/partners_TenantCredits", {
        query: {
          where: JSON.stringify({
            PartnersTenant: { __type: "Pointer", className: "partners_Tenant", objectId: tenantId }
          })
        }
      });
      const row = res.results?.[0];
      return typeof row?.usedStorage === "number" ? row.usedStorage : null;
    }
  });
}

/* --------------------------------------------------------------- document */

/** Report ids that together cover every document this user owns (§9). */
const OWNED_REPORTS = ["ByHuevtCFY", "1MwEuxLEkF", "kQUoW4hUXz", "UPr2Fm5WY3", "zNqBHXHsYH"];

export async function fetchAllOwnedDocuments(): Promise<DocumentExportRow[]> {
  const seen = new Map<string, DocumentExportRow>();
  for (const reportId of OWNED_REPORTS) {
    // `getReport` throws on a failure now; a non-array answer would only be an
    // empty bucket from an older server.
    const rows = await cloud<DocumentExportRow[]>("getReport", { reportId, limit: 500, skip: 0 });
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (row?.objectId && !seen.has(row.objectId)) seen.set(row.objectId, row);
  }
  return [...seen.values()];
}

/* --------------------------------------------------------------- API tokens */

export interface ApiTokenInfo {
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export const apiTokenKey = ["settings", "apiToken"] as const;

/**
 * `getapitoken` → `{ token: { prefix, createdAt, lastUsedAt } | null }`. The
 * stored hash never leaves the server: `getapitoken` describes the token and
 * `getUserDetails` excludes `ApiTokenHash` from the row it returns, so the only
 * time the app sees the token itself is the one-off plaintext that
 * `generateapitoken` answers with.
 */
export function useApiToken() {
  return useQuery({
    queryKey: apiTokenKey,
    queryFn: () => cloud<{ token: ApiTokenInfo | null }>("getapitoken"),
    staleTime: 60_000
  });
}

/** `generateapitoken` returns the raw token exactly once. Rotating replaces the old one. */
export function useGenerateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cloud<{ token: string; prefix: string; createdAt: string }>("generateapitoken"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: apiTokenKey })
  });
}

export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cloud<{ revoked: boolean }>("revokeapitoken"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: apiTokenKey })
  });
}

/* ------------------------------------------------------------ connected apps */

/** One app connected through "Sign in with DocuStamp" (OAuth), as `listoauthgrants` describes it. */
export interface OAuthGrantInfo {
  id: string;
  clientName: string;
  /** Where the app sent the user back to, e.g. `chatgpt.com`. The part an app cannot fake. */
  redirectHost: string;
  scopes: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
  /**
   * "Can sign for me" is on for this app. Missing on a server without agent
   * signing, which is how the card knows to leave the switch out.
   */
  canSign?: boolean;
  /** When signing was last turned on, as an ISO string. */
  signingEnabledAt?: string | null;
}

export const oauthGrantsKey = ["settings", "oauthGrants"] as const;

export function useOAuthGrants() {
  return useQuery({
    queryKey: oauthGrantsKey,
    queryFn: () => cloud<{ grants: OAuthGrantInfo[] }>("listoauthgrants"),
    staleTime: 60_000
  });
}

/** Disconnect: the app's tokens stop working at once. */
export function useRevokeOAuthGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => cloud<{ revoked: boolean }>("revokeoauthgrant", { grantId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: oauthGrantsKey })
  });
}

/**
 * `setoauthgrantsigning { id, enabled }` turns "Can sign for me" on or off for
 * one connected app. Turning it on needs a verified email; the server refuses
 * otherwise and says how to verify.
 */
export function useSetOAuthGrantSigning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      cloud<{ id: string; canSign: boolean; signingEnabledAt: string | null }>("setoauthgrantsigning", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: oauthGrantsKey })
  });
}

/* ------------------------------------------------------- email verification */

/** `getemailverification` -> whether the account's email address is proven to be its own. */
export interface EmailVerification {
  email: string;
  verified: boolean;
}

export const emailVerificationKey = ["settings", "emailVerification"] as const;

/**
 * An app can only sign for someone whose email is verified (a one-time
 * 6-digit code). `retry: false` so a server without the function answers
 * quickly with an error, which callers read as "not available here".
 */
export function useEmailVerification(enabled = true) {
  return useQuery({
    queryKey: emailVerificationKey,
    queryFn: () => cloud<EmailVerification>("getemailverification"),
    enabled,
    retry: false,
    staleTime: 60_000
  });
}

/**
 * Emails a 6-digit code to the account's address. The server rate limits it,
 * and answers `{ sent: false, verified: true }` when the address is already
 * verified (another tab, or an emailed-code sign-in), which refreshes the state.
 */
export function useSendEmailVerification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cloud<{ sent: boolean; email: string; verified?: boolean }>("sendemailverification"),
    onSuccess: (res) => {
      if (res?.verified) void qc.invalidateQueries({ queryKey: emailVerificationKey });
    }
  });
}

/** Checks the code. On success the verified state and the connected apps refresh. */
export function useVerifyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (otp: string) => cloud<{ verified: boolean }>("verifyemail", { otp }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: emailVerificationKey });
      await qc.invalidateQueries({ queryKey: oauthGrantsKey });
    }
  });
}

/* ------------------------------------------------------- rules for your AI */

export const agentRulesKey = ["settings", "agentRules"] as const;

/** What an account has before anyone sets its rules (server: defaultRules). */
export function defaultAgentRules(): AgentRules {
  return {
    autoSign: { enabled: false, documentTypes: ["nda"], maxValueUsd: 0, trustedSenderDomains: [] },
    alwaysAsk: { autoRenewal: true, personalGuarantee: true, nonCompete: true, paymentTerms: true },
    sendOnlyTo: [],
    updatedAt: null,
    updatedBy: null
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The rules in one shape, whether the function answers `{ rules }` or the
 * rules themselves, with defaults for anything an older server leaves out.
 */
function toAgentRules(raw: unknown): AgentRules {
  const base = defaultAgentRules();
  const outer = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const src = (outer.rules && typeof outer.rules === "object" ? outer.rules : outer) as Partial<AgentRules>;
  const auto = (src.autoSign ?? {}) as Partial<AgentRules["autoSign"]>;
  const ask = (src.alwaysAsk ?? {}) as Partial<AgentRules["alwaysAsk"]>;
  const max = Number(auto.maxValueUsd);
  return {
    autoSign: {
      enabled: auto.enabled === true,
      documentTypes: Array.isArray(auto.documentTypes)
        ? (strings(auto.documentTypes) as AgentRules["autoSign"]["documentTypes"])
        : base.autoSign.documentTypes,
      maxValueUsd: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0,
      trustedSenderDomains: strings(auto.trustedSenderDomains)
    },
    alwaysAsk: {
      autoRenewal: ask.autoRenewal !== false,
      personalGuarantee: ask.personalGuarantee !== false,
      nonCompete: ask.nonCompete !== false,
      paymentTerms: ask.paymentTerms !== false
    },
    sendOnlyTo: strings(src.sendOnlyTo),
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : null,
    updatedBy:
      src.updatedBy && typeof src.updatedBy === "object"
        ? { name: String(src.updatedBy.name ?? ""), email: String(src.updatedBy.email ?? "") }
        : null
  };
}

/**
 * `getagentrules` -> the account's rules. `retry: false` so a server without
 * rules answers quickly with an error, which the API page reads as "leave the
 * rules card out".
 */
export function useAgentRules() {
  const { user } = useAuth();
  return useQuery({
    queryKey: agentRulesKey,
    enabled: !!user,
    queryFn: async () => toAgentRules(await cloud<unknown>("getagentrules")),
    retry: false,
    staleTime: 30_000
  });
}

/** `setagentrules { rules }`: the editable part. The server stamps who changed them and when. */
export async function saveAgentRules(rules: Pick<AgentRules, "autoSign" | "alwaysAsk" | "sendOnlyTo">): Promise<AgentRules> {
  return toAgentRules(await cloud<unknown>("setagentrules", { rules }));
}
