import { useTranslation } from "react-i18next";
import { AlertTriangle, Sparkles } from "lucide-react";
import { Cap, Card, Pill } from "@/components/ui";
import { num, whenShort } from "@/lib/format";
import { OVERALL, SEVERITY } from "./parts";
import type { Review } from "./types";

/** "Page 3" as a small mono link that turns the preview to that page. */
function PageLink({ page, onPage }: { page?: number; onPage?: (page: number) => void }) {
  const { t } = useTranslation();
  if (!page) return null;
  return (
    <button
      type="button"
      onClick={() => onPage?.(page)}
      className="num shrink-0 text-[11px] text-muted hover:text-accent"
      aria-label={t("approvals.preview.goToPage", { page })}
    >
      {t("approvals.preview.pageShort", { page: num(page) })}
    </button>
  );
}

function Quote({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <blockquote className="border-l-2 border-line-strong pl-3 text-[12px] leading-relaxed text-ink-2">
      &ldquo;{text}&rdquo;
    </blockquote>
  );
}

/**
 * The AI's read of the terms, shown before the person approves: an overall
 * pill, a summary, what to look at (flags with quotes), the key terms and who
 * the parties are. It always ends with the "not legal advice" line.
 */
export function ReviewPanel({
  review,
  pending,
  onPage
}: {
  review: Review | null;
  /** Still waiting on a decision, so a missing review comes with "read it yourself". */
  pending?: boolean;
  onPage?: (page: number) => void;
}) {
  const { t } = useTranslation();

  if (!review) {
    return (
      <Card className="px-5 py-4 flex items-start gap-3">
        <Sparkles className="size-4 mt-0.5 shrink-0 text-muted" strokeWidth={1.6} />
        <p className="text-[13px] leading-relaxed text-muted">
          {t("approvals.review.none")}
          {pending ? ` ${t("approvals.review.noneHint")}` : null}
        </p>
      </Card>
    );
  }

  const overall = OVERALL[review.overall] ?? OVERALL.review;
  const meta = [review.model, review.reviewedAt ? whenShort(review.reviewedAt) : ""].filter(Boolean).join(" · ");

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 pt-4 pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold leading-tight tracking-[-.015em]">
            <Sparkles className="size-4 text-muted" strokeWidth={1.6} />
            {t("approvals.review.title")}
          </h2>
          {meta ? <span className="num truncate text-[11px] text-muted">{meta}</span> : null}
        </div>
        <Pill tone={overall.tone} dot className="mt-0.5">
          {t(overall.key)}
        </Pill>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        {review.instructionsAimedAtAI ? (
          <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.8} />
            <p className="text-[12.5px] leading-relaxed text-danger">{t("approvals.review.aimedAtAi")}</p>
          </div>
        ) : null}

        {review.summary ? <p className="text-[13px] leading-relaxed text-ink-2">{review.summary}</p> : null}

        {review.flags.length > 0 ? (
          <section className="flex flex-col gap-2">
            <Cap>{t("approvals.review.flags")}</Cap>
            <ul className="flex flex-col divide-y divide-line-soft rounded-lg border border-line">
              {review.flags.map((flag, i) => {
                const sev = SEVERITY[flag.severity] ?? SEVERITY.info;
                return (
                  <li key={`${flag.title}-${i}`} className="flex flex-col gap-1.5 px-3.5 py-3">
                    <div className="flex items-start gap-2">
                      <Pill tone={sev.tone} dot className="mt-px shrink-0">
                        {t(sev.key)}
                      </Pill>
                      <span className="min-w-0 flex-1 text-[13px] font-semibold text-ink">{flag.title}</span>
                      <PageLink page={flag.page} onPage={onPage} />
                    </div>
                    {flag.why ? <p className="text-[12.5px] leading-relaxed text-muted">{flag.why}</p> : null}
                    <Quote text={flag.quote} />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {review.keyTerms.length > 0 ? (
          <section className="flex flex-col gap-2">
            <Cap>{t("approvals.review.keyTerms")}</Cap>
            <dl className="flex flex-col divide-y divide-line-soft rounded-lg border border-line">
              {review.keyTerms.map((term, i) => (
                <div key={`${term.label}-${i}`} className="flex flex-col gap-1 px-3.5 py-2.5">
                  <div className="flex items-baseline gap-3">
                    <dt className="w-[38%] shrink-0 text-[12px] text-muted">{term.label}</dt>
                    <dd className="min-w-0 flex-1 text-[13px] text-ink">{term.value}</dd>
                    <PageLink page={term.page} onPage={onPage} />
                  </div>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {review.parties.length > 0 ? (
          <section className="flex flex-col gap-2">
            <Cap>{t("approvals.review.parties")}</Cap>
            <ul className="flex flex-col gap-1">
              {review.parties.map((party, i) => (
                <li key={`${party.name}-${i}`} className="flex items-baseline gap-2 text-[13px]">
                  <span className="font-medium text-ink">{party.name}</span>
                  {party.role ? <span className="text-[12px] text-muted">{party.role}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="border-t border-line-soft px-5 py-3 text-[11.5px] text-muted">
        {/* The server's disclaimer is English; the page says the same thing in the reader's language. */}
        {t("approvals.review.disclaimer")}
      </div>
    </Card>
  );
}
