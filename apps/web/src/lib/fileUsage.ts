/**
 * Storage accounting (§8.7).
 *
 * Every uploaded file is counted against the workspace's quota. The browser
 * used to write those rows itself: a POST to partners_DataFiles plus a
 * read-modify-write of partners_TenantCredits.usedStorage, with the app id
 * alone. That let anyone set a tenant's usage to whatever they liked, lost
 * increments whenever two uploads overlapped, and needed the caller to know its
 * own tenant id.
 *
 * The server does it now: `recordfileusage { url, size }` requires a session,
 * resolves the tenant from the caller's own contracts_Users row and increments
 * the counter atomically. Accounting is never worth failing an upload over, so
 * a failure is warned about and swallowed.
 */
import { cloud } from "@/lib/parse";

export async function recordFileUsage(url: string, size: number): Promise<void> {
  if (!url || !Number.isFinite(size) || size <= 0) return;
  try {
    await cloud<{ ok?: boolean }>("recordfileusage", { url, size: Math.round(size) });
  } catch (err) {
    console.warn("recordfileusage failed, this upload is not counted against the storage quota", err);
  }
}
