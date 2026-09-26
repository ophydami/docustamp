/**
 * Suggestions computed from the sender's own history.
 *
 * Nothing here is invented: it is a frequency count over the signers of the
 * documents this user has already sent (the in-progress and completed reports),
 * matched on the email domain of the recipients typed so far.
 */
import type { HistoryDoc } from "./api";
import { emailDomain } from "./types";

export interface SuggestedRecipient {
  name: string;
  email: string;
  count: number;
}

export interface HistorySuggestion {
  domain: string;
  recipients: SuggestedRecipient[];
  /** The expiry this user usually gives documents involving that domain. */
  expiryDays?: number;
  sampleSize: number;
}

export function computeSuggestion(
  history: HistoryDoc[] | undefined,
  currentEmails: string[]
): HistorySuggestion | null {
  if (!history?.length) return null;
  const domains = new Set(currentEmails.map(emailDomain).filter(Boolean));
  if (!domains.size) return null;

  const taken = new Set(currentEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const counts = new Map<string, SuggestedRecipient>();
  const expiries: number[] = [];
  let matchedDocs = 0;
  let matchedDomain = "";

  for (const doc of history) {
    const hit = doc.signers.some((s) => domains.has(emailDomain(s.email)));
    if (!hit) continue;
    matchedDocs++;
    if (!matchedDomain) {
      const first = doc.signers.find((s) => domains.has(emailDomain(s.email)));
      matchedDomain = first ? emailDomain(first.email) : "";
    }
    if (doc.expiryDays) expiries.push(doc.expiryDays);
    for (const s of doc.signers) {
      const email = s.email.trim().toLowerCase();
      if (!email || taken.has(email)) continue;
      const existing = counts.get(email);
      if (existing) existing.count += 1;
      else counts.set(email, { name: s.name, email, count: 1 });
    }
  }

  if (!matchedDocs) return null;
  const recipients = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  const expiryDays = mode(expiries);
  if (!recipients.length && expiryDays === undefined) return null;
  return { domain: matchedDomain, recipients, expiryDays, sampleSize: matchedDocs };
}

function mode(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 1;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  });
  return best;
}
