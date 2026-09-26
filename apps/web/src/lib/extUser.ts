import { useQuery } from "@tanstack/react-query";
import { cloud } from "./parse";
import { rememberProfileLanguage } from "./i18n";
import { useAuth } from "@/app/auth";

/**
 * The `contracts_Users` "extended user" row for the signed-in user, as plain JSON
 * (fetched over raw HTTP, so no Parse.Object unwrapping). Fields follow the
 * server's naming; see docs/BACKEND_API.md §2.7 and §3.3.
 */
export interface ExtUser {
  objectId: string;
  Name?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  JobTitle?: string;
  UserRole?: string; // e.g. "contracts_Admin", "contracts_User", "contracts_OrgAdmin", "contracts_Editor"
  Timezone?: string;
  Language?: string;
  DateFormat?: string;
  ProfilePic?: string;
  IsDisabled?: boolean;
  EmailCount?: number;
  DocumentCount?: number;
  TourStatus?: unknown;
  TenantId?: { objectId: string; TenantName?: string; Domain?: string; Logo?: string; ThemeColor?: string; [k: string]: unknown };
  UserId?: { objectId: string; username?: string; email?: string; [k: string]: unknown };
  OrganizationId?: { objectId: string; Name?: string; [k: string]: unknown };
  TeamIds?: Array<{ objectId: string; Name?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export const extUserKey = ["extUser"] as const;

/**
 * `getUserDetails` answers the caller's own row, or the empty string when there
 * is none. The row it returns is stripped of the columns the browser has no
 * business holding: the API token hash and its metadata, the delete-account OTP
 * columns, the webhook URL and the Google refresh token. The API token hash
 * never leaves the server; the plaintext token is shown once, by
 * `generateapitoken`, and never again.
 */
export async function fetchExtUser(): Promise<ExtUser | null> {
  const r = await cloud<ExtUser | "" | null>("getUserDetails");
  if (!r || typeof r !== "object") return null;
  // The account's own language, applied unless this device has an explicit choice.
  rememberProfileLanguage(typeof r.Language === "string" ? r.Language : undefined);
  return r;
}

/** Cached extended user. `null` when the row does not exist yet. */
export function useExtUser() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...extUserKey, user?.id],
    queryFn: fetchExtUser,
    enabled: !!user,
    staleTime: 5 * 60_000
  });
}

export function isAdminRole(role?: string) {
  return role === "contracts_Admin" || role === "contracts_OrgAdmin";
}
