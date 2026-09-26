/**
 * Auth API for the Parse backend. See docs/BACKEND_API.md section 2.
 *
 * Server shapes handled in here (each is repeated at its call site):
 *  - `getUserDetails` returns three different shapes: the full contracts_Users
 *    row, `{objectId}` when passed an email, or the empty string "" when there
 *    is no row. We normalise to `ExtUser | null`.
 *  - `usersignup` / `addadmin` throw typed Parse errors when something goes
 *    wrong, so `cloud()` surfaces a real failure as a CloudError and a resolved
 *    call always carries a result object.
 *  - The one answered (not thrown) refusal both give is
 *    `{ message: "User already exist" }` when the address already has an
 *    account: `detail` says why the caller could not simply be signed in, and a
 *    `sessionToken` comes with it when the typed password did prove ownership.
 *  - `AuthLoginAsMail` (OTP verify) reports failure with the plain strings
 *    "Invalid Otp" / "user not found!" / "Result not found" inside `result`,
 *    not as an error envelope, so `cloud()` resolves happily on failure.
 *  - `checkadminexist` returns the strings "exist" / "not_exist".
 *  - `getDocument` throws when the document is OTP protected and the caller has
 *    no read ACL. `cloud()` re-throws it as a CloudError, which is how the
 *    signing page detects "this link needs a code".
 */
import i18next from "i18next";
import { Parse, cloud, CloudError } from "@/lib/parse";
import type { ExtUser } from "@/lib/extUser";

/** IANA zone stored on contracts_Users.Timezone; certificate stamps are rendered in it. */
export const browserTimezone: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The server lowercases and strips whitespace from every email it stores. */
export function normalizeEmail(value: string): string {
  return value.toLowerCase().replace(/\s/g, "");
}

/* ------------------------------------------------------------------ errors */

export function errorCode(e: unknown): number | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "number") return c;
  }
  return undefined;
}

export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (errorCode(e) === Parse.Error.CONNECTION_FAILED) return true;
  const m = e instanceof Error ? e.message : "";
  return /failed to fetch|network|load failed|xmlhttprequest/i.test(m);
}

/** Human copy for a failed `Parse.User.logIn`. */
export function loginErrorMessage(e: unknown): string {
  if (isNetworkError(e)) return i18next.t("auth.errors.cannotReachServer");
  switch (errorCode(e)) {
    case Parse.Error.OBJECT_NOT_FOUND: // 101, what Parse returns for a bad password too
      return i18next.t("auth.errors.badCredentials");
    case Parse.Error.EMAIL_NOT_FOUND: // 205
      return i18next.t("auth.errors.emailNotVerified");
    case 1001:
      return i18next.t("auth.errors.notAllowed");
    case Parse.Error.INVALID_SESSION_TOKEN: // 209
      return i18next.t("auth.errors.sessionExpired");
    default:
      return errorMessage(e, i18next.t("auth.errors.signInFailed"));
  }
}

/* --------------------------------------------------------- extended user */

export type ExtUserState =
  | { status: "ready"; extUser: ExtUser }
  | { status: "missing" }
  | { status: "disabled"; extUser: ExtUser };

/**
 * Load the signed-in user's contracts_Users row.
 * `missing` means the account has no profile/tenant yet (fresh Google sign-in,
 * or a _User created as a side effect of being a contact) and must complete the
 * onboarding step before the app is usable.
 */
export async function loadExtUser(): Promise<ExtUserState> {
  const r = await cloud<ExtUser | "" | null>("getUserDetails");
  if (!r || typeof r !== "object" || !r.objectId) return { status: "missing" };
  if (r.IsDisabled === true) return { status: "disabled", extUser: r };
  return { status: "ready", extUser: r };
}

/* --------------------------------------------------------------- signup */

export interface ProfileInput {
  name: string;
  email: string;
  /**
   * When the email already has an account, this is what the server tries to
   * log in with: it matches, or the signup is refused as "already exists".
   */
  password?: string;
  phone?: string;
  company: string;
  jobTitle: string;
}

export interface SignupResult {
  message: string;
  /**
   * Why the account could not just be signed in, on the "already exists"
   * answer: a wrong password, an account with no password (Google sign-in), or
   * a session held for somebody else.
   */
  detail?: string;
  sessionToken?: string;
  /**
   * Legacy shape. Nothing on the server answers with this any more (a failure
   * is a thrown Parse error, which `cloud()` never resolves), but reading it
   * costs nothing and keeps an older server working.
   */
  error?: string;
}

/** Unauthenticated. `"exist"` once any contracts_Admin has been created. */
export async function adminExists(): Promise<boolean> {
  return (await cloud<string>("checkadminexist")) === "exist";
}

/**
 * Create `_User` + `partners_Tenant` + `contracts_Users` in one call.
 *
 * The first account of an install has to go through `addadmin` so it also gets
 * an organization and an "All Users" team and the contracts_Admin role; every
 * account after that goes through `usersignup` as contracts_User.
 *
 * When a `_User` with this email already exists the server answers
 * "User already exist" (see isAlreadyExists) rather than throwing, and the
 * answer carries a `sessionToken` whenever the caller proved they own the
 * account: they already held a session for that exact `_User`, or the password
 * they typed logged in. With a token the caller is signed into the account they
 * already had; without one the UI sends the person to sign in. Contacts get a
 * shadow `_User` from the contactbook afterSave trigger, so an email that has
 * only ever been a signer follows the same path.
 *
 * Anything else that goes wrong is a thrown Parse error (a bad role, the
 * signup rate limit, a failed organisation/team bootstrap), so it reaches the
 * caller as a CloudError with the server's own message.
 */
export async function createAccount(
  input: ProfileInput & { asAdmin?: boolean }
): Promise<SignupResult> {
  const asAdmin = input.asAdmin === true;
  const userDetails = {
    name: input.name.trim(),
    email: normalizeEmail(input.email),
    ...(input.password ? { password: input.password } : {}),
    ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
    company: input.company.trim(),
    jobTitle: input.jobTitle.trim(),
    role: asAdmin ? "contracts_Admin" : "contracts_User",
    timezone: browserTimezone
  };
  return await cloud<SignupResult>(asAdmin ? "addadmin" : "usersignup", { userDetails });
}

/**
 * True for the "already registered" answer both signup functions give.
 *
 * The wording lives in `message` ("User already exist" from both, or
 * "An administrator already exists on this installation..." from `addadmin`).
 * `detail` is the server's reason for not signing the caller in and is matched
 * too, so a future rephrasing that only lands there is still recognised.
 * `error` is the legacy field and is only a fallback.
 */
export function isAlreadyExists(res: SignupResult): boolean {
  const text = [res.detail, res.message, res.error]
    .filter((v): v is string => typeof v === "string" && v !== "")
    .join(" ");
  return /already exist/i.test(text);
}

/**
 * Make sure the signed-in user has a contracts_Users row, creating it (and a
 * tenant) from `profile` when it is missing. Returns the row, plus the session
 * token the server minted if it had to create one (the caller must `become` it,
 * because `/loginAs` issues a brand new session).
 */
export async function ensureExtUser(
  profile: ProfileInput
): Promise<{ extUser: ExtUser | null; sessionToken?: string }> {
  const state = await loadExtUser();
  if (state.status === "ready") return { extUser: state.extUser };
  if (state.status === "disabled") {
    throw new CloudError(i18next.t("auth.errors.accountDisabled"));
  }
  const asAdmin = !(await adminExists());
  const res = await createAccount({ ...profile, asAdmin });
  if (!res.sessionToken && isAlreadyExists(res)) {
    // Row appeared between our read and the write; just read it back.
    const again = await loadExtUser();
    return { extUser: again.status === "ready" ? again.extUser : null };
  }
  return { extUser: null, sessionToken: res.sessionToken };
}

/* ------------------------------------------------------- password reset */

/**
 * Stock Parse `requestPasswordReset`. The reset itself happens on Parse
 * Server's own hosted page, there is no in-app reset-with-token route.
 * Parse answers 205 when no account has that email; we do not leak that.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await Parse.User.requestPasswordReset(normalizeEmail(email));
}

/* -------------------------------------------------------------- OTP flow */

/** Emails a 6 digit code. `docId` lets the server bill the mail to the sender. */
export async function requestOtp(params: { email: string; docId?: string }): Promise<void> {
  const answer = await cloud<string>("SendOTPMailV1", {
    email: normalizeEmail(params.email),
    ...(params.docId ? { docId: params.docId } : {})
  });
  if (answer !== "Otp send") {
    throw new CloudError(
      typeof answer === "string" && answer ? answer : i18next.t("auth.errors.codeSendFailed")
    );
  }
}

export interface OtpUser {
  objectId: string;
  sessionToken: string;
  email?: string;
  name?: string;
}

/**
 * Verify the emailed code. Deliberately unauthenticated: the server looks the
 * code up in `defaultdata_Otp` and mints a session with the master key.
 * Codes are 6 digits, one row per email, expire after 10 minutes and lock after 5 wrong guesses.
 */
export async function verifyOtp(params: { email: string; otp: string }): Promise<OtpUser> {
  const result = await cloud<OtpUser | string>("AuthLoginAsMail", {
    email: normalizeEmail(params.email),
    otp: params.otp.trim()
  });
  if (typeof result === "string" || !result) {
    if (result === "Invalid Otp") throw new CloudError(i18next.t("auth.errors.codeInvalid"));
    if (result === "user not found!") throw new CloudError(i18next.t("auth.errors.noAccountForEmail"));
    throw new CloudError(i18next.t("auth.errors.codeVerifyFailed"));
  }
  if (!result.sessionToken) throw new CloudError(i18next.t("auth.errors.codeVerifyFailed"));
  return result;
}

/* ------------------------------------------------------ guest signing link */

export interface GuestLinkPayload {
  docId: string;
  email: string;
  contactId?: string;
  /**
   * Per-signer signing token, bound to (docId, contactId) and signed by the
   * server. Every guest cloud call passes it as `signingToken`.
   */
  signingToken?: string;
  /** The string "false" when the sender handed the link out and suppressed mail. */
  sendmail?: string;
}

/**
 * Decode the `/login/:base64url` param. The payload is
 * `btoa("<docId>/<signerEmail>/<contactBookId>/<signingToken>")`; older links
 * stop after the contact id (or even the email), and older quick-send links put
 * the literal "false"/"true" in the 4th slot to suppress the next-signer mail.
 * The two are told apart by value: a token is never "false" or "true".
 * Returns null when it is not a link we can read.
 */
export function decodeGuestLink(base64url: string): GuestLinkPayload | null {
  let decoded: string;
  try {
    // Tolerate URL-safe base64 as well as the classic btoa output.
    const normal = base64url.replace(/-/g, "+").replace(/_/g, "/");
    decoded = atob(normal);
  } catch {
    return null;
  }
  const parts = decoded.split("/");
  const docId = parts[0]?.trim();
  const email = parts[1] ? normalizeEmail(parts[1]) : "";
  if (!docId || !email || !EMAIL_RE.test(email)) return null;

  const fourth = parts[3]?.trim() || undefined;
  const fifth = parts[4]?.trim() || undefined;
  const isFlag = (v?: string) => v === "false" || v === "true";
  return {
    docId,
    email,
    contactId: parts[2]?.trim() || undefined,
    signingToken: isFlag(fourth) ? undefined : fourth,
    sendmail: isFlag(fourth) ? fourth : isFlag(fifth) ? fifth : undefined
  };
}

export interface GuestDoc {
  objectId: string;
  Name?: string;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  ExtUserPtr?: { Name?: string; Email?: string; Company?: string };
}

/**
 * Resolve (or create) the contracts_Contactbook row for this signer and splice
 * it into the document's Signers/Placeholders. Needed when the link has no
 * contact id.
 */
export async function linkContactToDoc(params: {
  docId: string;
  email: string;
  name?: string;
  signingToken?: string;
}): Promise<string> {
  const res = await cloud<{ contactId?: string }>("linkcontacttodoc", {
    docId: params.docId,
    email: normalizeEmail(params.email),
    ...(params.name ? { name: params.name } : {}),
    ...(params.signingToken ? { signingToken: params.signingToken } : {})
  });
  if (!res?.contactId) throw new CloudError(i18next.t("auth.errors.requestNotOpenable"));
  return res.contactId;
}

export type GuestDocState =
  | { status: "open"; doc: GuestDoc }
  | { status: "needsCode" }
  | { status: "gone"; message: string };

/**
 * Try to read the document as the current caller. A thrown CloudError means
 * either the document is OTP protected (so the signer must verify a code) or it
 * is archived / not visible. We can only tell the two apart by the message.
 */
export async function loadGuestDoc(docId: string, signingToken?: string): Promise<GuestDocState> {
  try {
    const doc = await cloud<GuestDoc>("getDocument", {
      docId,
      ...(signingToken ? { signingToken } : {})
    });
    return { status: "open", doc };
  } catch (e) {
    const msg = errorMessage(e, "");
    if (/deleted|not found|required parameters/i.test(msg)) {
      return { status: "gone", message: i18next.t("auth.errors.documentUnavailable") };
    }
    return { status: "needsCode" };
  }
}

/* --------------------------------------------------------------- Google */

export const GOOGLE_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/** Read `sub` / `email` / `name` out of a Google ID token without verifying it. */
export function decodeGoogleCredential(jwt: string): GoogleIdentity | null {
  const body = jwt.split(".")[1];
  if (!body) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { sub?: string; email?: string; name?: string };
    if (!claims.sub || !claims.email) return null;
    return { sub: claims.sub, email: normalizeEmail(claims.email), name: claims.name ?? "" };
  } catch {
    return null;
  }
}

/**
 * Sign in through the Parse `google` auth adapter, which the server registers
 * with GOOGLE_CLIENT_ID. Parse validates the ID token with Google and requires
 * `authData.id` to be the token's `sub`. A brand new account has no
 * contracts_Users row, so the caller must run the onboarding step afterwards.
 */
export async function loginWithGoogleCredential(jwt: string): Promise<string> {
  const identity = decodeGoogleCredential(jwt);
  if (!identity) throw new CloudError(i18next.t("auth.errors.googleUnusableToken"));
  const user = await Parse.User.logInWith("google", {
    authData: { id: identity.sub, id_token: jwt }
  });
  if (!user.getEmail()) user.set("email", identity.email);
  if (!user.get("name") && identity.name) user.set("name", identity.name);
  if (user.dirty()) await user.save(null, { sessionToken: user.getSessionToken() }).catch(() => undefined);
  const token = user.getSessionToken();
  if (!token) throw new CloudError(i18next.t("auth.errors.googleNoSession"));
  return token;
}
