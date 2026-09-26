import { useQuery } from "@tanstack/react-query";
import { Parse, cloud } from "./parse";

/** Tenant branding: a display name, the workspace name and a logo URL. */
export interface Brand {
  name: string;
  /** The workspace's own name, when it has one. Null on the fallback brand. */
  tenantName: string | null;
  logoUrl: string | null;
}

/** Used before the call resolves, when no tenant matches the host, and on failure. */
export const FALLBACK_BRAND: Brand = { name: "DocuStamp", tenantName: null, logoUrl: null };

const ONE_HOUR = 60 * 60_000;

/**
 * `getlogobydomain` is unauthenticated and maps `window.location.host` to a row
 * in `partners_Tenant`. See docs/BACKEND_API.md section 2.8. It answers
 * `{ logo, favicon, appname, tenantName, hidePoweredBy, footer, user }`; `logo`
 * is "" when the host has no tenant, and `user: "not_exist"` means no tenant
 * exists at all (first-run bootstrap).
 */
interface LogoByDomain {
  logo?: string;
  favicon?: string;
  appname?: string;
  tenantName?: string;
  user?: "exist" | "not_exist";
}

/**
 * `appname` is the tenant's `TenantName` when the workspace has been named, and
 * otherwise the server-wide `APP_NAME` (apps/server/Utils.js). Servers from
 * before the rename still answer the old "OpenSign™" default, which is treated
 * as unset.
 */
function brandName(appname?: string): string {
  const value = appname?.trim();
  if (!value || /^opensign/i.test(value)) return FALLBACK_BRAND.name;
  return value;
}

/** Prefix key: invalidating it drops both the by-domain and the signed-in brand. */
export const brandKey = ["brand"] as const;

async function fetchDomainBrand(): Promise<Brand> {
  try {
    const r = await cloud<LogoByDomain | null>("getlogobydomain", {
      domain: window.location.host
    });
    const tenantName = r?.tenantName?.trim();
    return {
      name: brandName(r?.appname),
      tenantName: tenantName || null,
      logoUrl: r?.logo?.trim() || null
    };
  } catch {
    // Branding is decoration: an unreachable or unconfigured server just means
    // the default wordmark, never an error on the sign-in screen.
    return FALLBACK_BRAND;
  }
}

interface TenantRow {
  objectId?: string;
  TenantName?: string;
  Logo?: string;
}

/**
 * `gettenant` is the authenticated view of the same row, and it is what the
 * Branding screen writes to, so a signed-in user sees their own workspace even
 * when the host does not match the tenant's `Domain`. It answers a whitelisted
 * object or `{}`, never a string sentinel, and throws on a real failure.
 */
async function fetchTenantBrand(userId: string): Promise<Brand | null> {
  try {
    const res = await cloud<TenantRow | null>("gettenant", { userId });
    if (!res || typeof res !== "object") return null;
    const tenantName = res.TenantName?.trim();
    const logoUrl = res.Logo?.trim();
    if (!tenantName && !logoUrl) return null;
    return {
      name: tenantName || FALLBACK_BRAND.name,
      tenantName: tenantName || null,
      logoUrl: logoUrl || null
    };
  } catch {
    return null;
  }
}

/**
 * Tenant logo and name, cached for an hour and never failing. The signed-in
 * workspace wins over the host lookup; `useInvalidateTenant` in the settings
 * feature drops both after a Branding save.
 */
export function useBrand(): Brand {
  const userId = Parse.User.current()?.id;
  const domain = useQuery({
    queryKey: [...brandKey, "domain", window.location.host],
    queryFn: fetchDomainBrand,
    staleTime: ONE_HOUR,
    gcTime: ONE_HOUR,
    retry: false,
    refetchOnWindowFocus: false
  });
  const tenant = useQuery({
    queryKey: [...brandKey, "tenant", userId],
    queryFn: () => fetchTenantBrand(userId as string),
    enabled: !!userId,
    staleTime: ONE_HOUR,
    gcTime: ONE_HOUR,
    retry: false,
    refetchOnWindowFocus: false
  });
  return tenant.data ?? domain.data ?? FALLBACK_BRAND;
}
