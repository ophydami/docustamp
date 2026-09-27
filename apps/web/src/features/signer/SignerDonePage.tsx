import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { Check, Download, ExternalLink } from "lucide-react";
import { Button, Card, Cap, Pill, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { freshUrl, toSignerDocument, useSignerDocument } from "./api";
import type { SignerParty } from "./types";
import { Wordmark } from "./components/Wordmark";
import { DisclosureDialog } from "./components/DisclosureDialog";
import { dateMedium, timeShort } from "@/lib/format";
import { SOURCE_URL } from "@/lib/source";

interface DoneState {
  docName?: string;
  signerName?: string;
  signedAt?: string;
  nextSignerName?: string;
  /**
   * Whether the next signer's request mail went out. Undefined when none was
   * owed (the document is not sequential, or this was the last signer).
   */
  nextSignerNotified?: boolean;
  senderName?: string;
  senderEmail?: string;
  completed?: boolean;
  signers?: Array<{ name: string; email?: string; signed: boolean }>;
  redirectUrl?: string;
}

/** Matches the old signer's five-tick countdown before it hands over the tab. */
const REDIRECT_SECONDS = 5;

/** Host of a redirect target, for the button label. Falsy when it is not a URL. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The screen a signer lands on straight after signing. */
export default function SignerDonePage() {
  const { t } = useTranslation();
  const { docId } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  /** Per-signer signing token, carried over from the signing page. */
  const signingToken = search.get("t") ?? undefined;
  const { user } = useAuth();
  const state = (location.state ?? {}) as DoneState;

  const [downloading, setDownloading] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [countdown, setCountdown] = useState(REDIRECT_SECONDS);
  const [cancelled, setCancelled] = useState(false);

  const { data: raw } = useSignerDocument(docId, signingToken);
  const doc = useMemo(() => (raw ? toSignerDocument(raw, null) : null), [raw]);

  /**
   * `RedirectUrl` on the document (§3.5). The old signer counts down five
   * seconds inside the completion panel with a cancel link, then hands the tab
   * over with `window.open(url, "_self")` and no query parameters
   * (`PdfRequestFiles.jsx` -> `openInNewTab`). Only a fresh signature arms it:
   * someone reopening this page later gets the button instead.
   */
  const redirectUrl = state.redirectUrl ?? doc?.redirectUrl;
  const autoRedirect = !!redirectUrl && !!state.signedAt && !cancelled;

  useEffect(() => {
    if (!autoRedirect || !redirectUrl) return;
    if (countdown <= 0) {
      window.open(redirectUrl, "_self", "noopener,noreferrer");
      return;
    }
    const timer = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [autoRedirect, countdown, redirectUrl]);

  const docName = state.docName ?? doc?.name ?? t("signer.done.yourDocument");
  const senderName = state.senderName ?? doc?.ownerName ?? t("signer.doc.theSender");
  const senderEmail = state.senderEmail ?? doc?.ownerEmail;
  const signedAt = state.signedAt ? new Date(state.signedAt) : new Date();

  const parties: SignerParty[] = doc?.signers.filter((s) => !s.isPrefill) ?? [];
  const listed: Array<{ name: string; signed: boolean }> = parties.length
    ? parties.map((s) => ({ name: s.name, signed: s.state === "signed" }))
    : (state.signers ?? []).map((s) => ({ name: s.name, signed: s.signed }));

  const nextName = state.nextSignerName ?? listed.find((s) => !s.signed)?.name;
  const completed = doc?.isCompleted ?? state.completed ?? !nextName;
  const signedUrl = doc?.fileUrl;

  const download = async () => {
    if (!signedUrl || !docId) return;
    setDownloading(true);
    try {
      window.open(await freshUrl(signedUrl, docId, signingToken), "_blank", "noopener");
    } catch (e) {
      toast.error(t("signer.toast.downloadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-ground">
      <div className="mx-auto w-full max-w-[560px] px-5 py-8 sm:py-12">
        <Wordmark asLink />

        <div className="mt-8 flex items-center justify-center size-14 rounded-full bg-accent-soft text-accent">
          <Check className="size-7" strokeWidth={2} />
        </div>
        <h1 className="mt-5 font-semibold text-[26px] leading-[1.1] text-ink tracking-[-.015em]">{t("signer.done.title")}</h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-muted">
          <Trans
            i18nKey="signer.done.recorded"
            values={{
              document: docName,
              time: timeShort(signedAt),
              date: dateMedium(signedAt)
            }}
            components={{ 1: <span className="text-ink font-medium" /> }}
          />
        </p>

        <Card className="mt-6 p-5">
          <Cap className="text-muted-2">{t("signer.done.nextUp")}</Cap>
          {listed.length ? (
            <ul className="mt-3 flex flex-col">
              {listed.map((s, i) => (
                <li key={`${s.name}-${i}`} className="flex items-center gap-2.5 h-10 border-b border-line last:border-b-0">
                  <span
                    className={`size-5 shrink-0 rounded-full flex items-center justify-center ${
                      s.signed ? "bg-accent-soft text-accent" : "bg-paper text-muted-2"
                    }`}
                  >
                    {s.signed ? <Check className="size-3" strokeWidth={2.4} /> : <span className="size-1.5 rounded-full bg-current" />}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[13px] text-ink-2">{s.name}</span>
                  <Pill tone={s.signed ? "accent" : "neutral"}>
                    {s.signed ? t("common.status.signed") : t("signer.status.pill.waiting")}
                  </Pill>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-3.5 text-[13px] leading-relaxed text-muted">
            {completed
              ? t("signer.done.waitingOnEveryone")
              : t("signer.done.waitingOnNext", { name: nextName ?? t("signer.done.waitingOnSomeone") })}
          </p>
          {state.nextSignerNotified === false ? (
            <p className="mt-2 text-[13px] leading-relaxed text-danger">
              {t("signer.done.nextSignerNotNotified", {
                name: state.nextSignerName ?? nextName ?? t("signer.done.waitingOnSomeone")
              })}
            </p>
          ) : null}
        </Card>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {signedUrl ? (
            <Button
              variant="primary"
              icon={<Download className="size-3.5" strokeWidth={1.6} />}
              onClick={() => void download()}
              loading={downloading}
              className="min-h-11 sm:min-h-0"
            >
              {t("signer.done.downloadCopy")}
            </Button>
          ) : (
            <p className="text-[13px] text-muted">{t("signer.done.sealing")}</p>
          )}
          {senderEmail ? (
            <a href={`mailto:${senderEmail}?subject=${encodeURIComponent(t("signer.email.aboutSubject", { document: docName }))}`}>
              <Button className="min-h-11 sm:min-h-0">{t("signer.done.emailSender", { name: senderName })}</Button>
            </a>
          ) : null}
        </div>

        {autoRedirect ? (
          <p className="mt-4 text-[12px] text-muted" aria-live="polite">
            {t("signer.done.redirect", { target: hostOf(redirectUrl) ?? senderName, seconds: countdown })}{" "}
            <button type="button" onClick={() => setCancelled(true)} className="text-accent hover:underline">
              {t("common.actions.cancel")}
            </button>
          </p>
        ) : redirectUrl ? (
          <div className="mt-4">
            <Button
              iconRight={<ExternalLink className="size-3.5" strokeWidth={1.6} />}
              onClick={() => window.open(redirectUrl, "_self", "noopener,noreferrer")}
              className="min-h-11 sm:min-h-0"
            >
              {t("signer.done.continueTo", { target: hostOf(redirectUrl) ?? t("signer.done.senderSite") })}
            </Button>
          </div>
        ) : null}

        {!user ? (
          <Card className="mt-8 p-5 bg-accent-tint border-accent-line">
            <h2 className="font-semibold text-[16px] leading-tight text-ink tracking-[-.015em]">{t("signer.done.accountTitle")}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t("signer.done.accountBody")}</p>
            <Link to="/signup" className="no-underline">
              <Button variant="primary" className="mt-3.5 min-h-11 sm:min-h-0" iconRight={<ExternalLink className="size-3.5" strokeWidth={1.6} />}>
                {t("signer.done.accountCta")}
              </Button>
            </Link>
          </Card>
        ) : null}

        <footer className="mt-10 pt-4 border-t border-line flex items-center gap-3 text-[11px] text-muted-2">
          <button type="button" onClick={() => setShowDisclosure(true)} className="hover:text-accent">
            {t("signer.done.disclosure")}
          </button>
          <span aria-hidden>·</span>
          <Link to="/verify" className="text-muted-2 hover:text-accent">
            {t("signer.done.verifyLink")}
          </Link>
          <span aria-hidden>·</span>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="text-muted-2 hover:text-accent">
            {t("auth.footer.source")}
          </a>
        </footer>
      </div>

      <DisclosureDialog open={showDisclosure} onClose={() => setShowDisclosure(false)} senderEmail={senderEmail} />
    </div>
  );
}
