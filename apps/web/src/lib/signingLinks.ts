/**
 * Signing links for senders.
 *
 * A guest signing link is `${origin}/login/${base64("docId/email/contactId/token")}`.
 * The 4th segment is a per-signer token minted by the server (HMAC over docId +
 * contactId), so the browser cannot build a working link on its own: it has to
 * ask for one with the `getsigninglinks` cloud function, which only the document
 * owner (or a tenant admin) may call.
 *
 * `fallbackSigningLink` is the old, token-less builder. It is kept for the one
 * case where `getsigninglinks` fails: a link without a token still opens for a
 * signer who can log in, and it is better than showing nothing. Every fallback
 * logs a console warning so the cause is visible.
 */
import { cloud } from "@/lib/parse";

export interface SigningLink {
  email: string;
  name?: string;
  contactId?: string;
  /** Absolute `/login/<base64>` URL, token included. */
  url: string;
  /** The raw token, in case a caller needs to build a `/sign/...?t=` URL itself. */
  signingToken?: string;
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

/** The pre-token link shape. Only used when `getsigninglinks` is unavailable. */
export function fallbackSigningLink(docId: string, email: string, contactId?: string): string {
  const payload = contactId ? `${docId}/${email}/${contactId}` : `${docId}/${email}`;
  return `${window.location.origin}/login/${toBase64(payload)}`;
}

/**
 * Ask the server for this document's per-recipient signing links. Never throws:
 * an empty list means "fall back to the local builder", and the reason is
 * warned about on the console.
 */
export async function loadSigningLinks(docId: string): Promise<SigningLink[]> {
  if (!docId) return [];
  try {
    const res = await cloud<{ links?: SigningLink[] } | SigningLink[] | null>("getsigninglinks", { docId });
    const links = Array.isArray(res) ? res : Array.isArray(res?.links) ? res.links : [];
    return links.filter((l): l is SigningLink => !!l && typeof l.url === "string" && !!l.url);
  } catch (err) {
    console.warn("getsigninglinks failed, falling back to a token-less signing link", err);
    return [];
  }
}

/** Match a recipient to their link by contact id, then by email. */
export function pickSigningLink(
  links: SigningLink[],
  recipient: { contactId?: string; objectId?: string; email?: string }
): SigningLink | undefined {
  const contactId = recipient.contactId || recipient.objectId;
  if (contactId) {
    const byId = links.find((l) => l.contactId && l.contactId === contactId);
    if (byId) return byId;
  }
  const email = recipient.email?.trim().toLowerCase();
  if (email) return links.find((l) => l.email?.trim().toLowerCase() === email);
  return undefined;
}

/** The recipient's link, or the token-less fallback when the server had none. */
export function signingLinkFor(
  links: SigningLink[],
  docId: string,
  recipient: { contactId?: string; objectId?: string; email?: string }
): string {
  const match = pickSigningLink(links, recipient);
  if (match) return match.url;
  console.warn("no signing link returned for recipient, using a token-less link", recipient.email ?? "");
  return fallbackSigningLink(docId, recipient.email ?? "", recipient.contactId || recipient.objectId);
}
