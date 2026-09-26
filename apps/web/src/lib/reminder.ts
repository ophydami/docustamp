import i18next from "i18next";
import { CloudError, cloud } from "@/lib/parse";

/**
 * The one way this app chases a signature: the `sendreminder` cloud function
 * (server: cloud/parsefunction/sendReminder.js).
 *
 * It decides who still owes a signature, honours SendinOrder (only the signer
 * whose turn it is gets mailed), sends the document's own request template and
 * records `Reminders` + `LastReminderAt` on the document.
 *
 * Its deliberate refusals all carry a message written for the user, which
 * callers show as-is, under three codes: 141 (SCRIPT_FAILED) for a document it
 * will not chase (completed, declined, archived, expired, never sent), 119
 * (OPERATION_FORBIDDEN) when the caller is neither the owner nor an admin of
 * the document's tenant, and 155 (REQUEST_LIMIT_EXCEEDED) while the
 * per-document cooldown is still running. See REFUSAL_CODES below.
 */

/** Why one recipient was not mailed. */
export interface RemindSkip {
  email: string;
  /** `already_signed` | `no_email` | `not_their_turn` | `mail_failed` */
  reason: string;
}

export interface RemindOutcome {
  sent: string[];
  skipped: RemindSkip[];
}

/** Totals for one or many documents, ready for `remindSummary`. */
export interface RemindTotals {
  /** How many documents were attempted. */
  documents: number;
  sent: string[];
  skipped: RemindSkip[];
  failed: RemindFailure[];
}

export interface RemindFailure {
  /** Document name, so a bulk remind can say which one was refused. */
  name: string;
  message: string;
  /** Parse error code; one of REFUSAL_CODES when the server said no on purpose. */
  code?: number;
}

/**
 * The codes `sendreminder` uses for a deliberate refusal, as opposed to
 * something going wrong. 141 is the one it throws most (already completed,
 * declined, archived, expired, never sent); the mapping used to know only
 * about 119, so every one of those read as a system failure.
 */
const REFUSAL_CODES = new Set([
  141, // SCRIPT_FAILED: this document will not be chased
  119, // OPERATION_FORBIDDEN: not the owner, not an admin of its tenant
  155 // REQUEST_LIMIT_EXCEEDED: reminded too recently
]);

/** Server reason code to the key of its human wording. */
const REASON_KEY: Record<string, string> = {
  already_signed: "common.reminder.reason.alreadySigned",
  no_email: "common.reminder.reason.noEmail",
  not_their_turn: "common.reminder.reason.notTheirTurn",
  mail_failed: "common.reminder.reason.mailFailed"
};

function reasonText(reason: string) {
  const key = REASON_KEY[reason];
  return key ? i18next.t(key) : reason.replace(/_/g, " ");
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** Remind everyone who still owes a signature on one document. */
export async function sendReminder(docId: string): Promise<RemindOutcome> {
  const res = await cloud<Partial<RemindOutcome> | null>("sendreminder", { docId });
  return { sent: res?.sent ?? [], skipped: res?.skipped ?? [] };
}

/**
 * Remind several documents with a small pool so a bulk action does not open one
 * request per selected row at once. Per-document failures are collected, never
 * thrown, so one refusal cannot cancel the rest.
 */
export async function remindMany(
  docs: Array<{ id: string; name: string }>,
  limit = 4
): Promise<RemindTotals> {
  const totals: RemindTotals = { documents: docs.length, sent: [], skipped: [], failed: [] };
  let next = 0;

  async function worker() {
    while (next < docs.length) {
      const doc = docs[next++];
      try {
        const out = await sendReminder(doc.id);
        totals.sent.push(...out.sent);
        totals.skipped.push(...out.skipped);
      } catch (err) {
        totals.failed.push({
          name: doc.name,
          message: errorMessage(err),
          code: err instanceof CloudError ? err.code : undefined
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, docs.length) }, worker));
  return totals;
}

/** Totals for a single document, so one summary function serves every caller. */
export function totalsOf(outcome: RemindOutcome): RemindTotals {
  return { documents: 1, sent: outcome.sent, skipped: outcome.skipped, failed: [] };
}

/**
 * Toast copy for an outcome: "Reminder sent to jane@acme.co",
 * "Reminded 2 people, 1 skipped (not their turn)". Translated at call time.
 */
export function remindSummary(t: RemindTotals): { title: string; detail?: string } {
  const n = t.sent.length;
  const reasons = [...new Set(t.skipped.map((s) => reasonText(s.reason)))].join(", ");
  const skipClause = t.skipped.length
    ? i18next.t("common.reminder.skipped", { count: t.skipped.length, reasons })
    : "";
  const detail: string[] = [];

  let title: string;
  if (n === 0) {
    title = i18next.t(t.failed.length ? "common.reminder.noneSent" : "common.reminder.nobodyToRemind");
    if (!skipClause && !t.failed.length) detail.push(i18next.t("common.reminder.everyoneSigned"));
  } else if (n === 1) {
    title = i18next.t("common.reminder.sentToOne", { email: t.sent[0] });
  } else {
    title =
      t.documents > 1
        ? i18next.t("common.reminder.remindedAcross", { count: t.documents, people: n })
        : i18next.t("common.reminder.reminded", { count: n });
  }

  if (skipClause) {
    if (n > 1) title = i18next.t("common.reminder.titleWithSkips", { title, skipped: skipClause });
    else detail.push(skipClause);
  }
  if (t.failed.length) {
    detail.push(
      i18next.t("common.reminder.failedDocuments", {
        count: t.failed.length,
        message: t.failed[0].message
      })
    );
  }

  return { title, detail: detail.length ? detail.join(". ") : undefined };
}

/**
 * Toast title for a refused reminder. A REFUSAL_CODES code is the server saying
 * no on purpose, and its message is written for the user, so callers show it
 * verbatim as the toast body under the softer "Not sent" title. Anything else
 * really is a failure.
 */
export function remindErrorTitle(code?: number): string {
  const deliberate = code !== undefined && REFUSAL_CODES.has(code);
  return i18next.t(deliberate ? "common.reminder.notSentTitle" : "common.reminder.couldNotSendTitle");
}

/** Toast copy for a thrown reminder. */
export function remindError(err: unknown): { title: string; detail: string } {
  return {
    title: remindErrorTitle(err instanceof CloudError ? err.code : undefined),
    detail: errorMessage(err)
  };
}
