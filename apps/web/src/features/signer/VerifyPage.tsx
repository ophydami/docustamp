import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, FileUp, HelpCircle, Loader2, XCircle } from "lucide-react";
import { Button, Card, Cap, LanguageMini, Pill, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { verifyPdf, type SignatureResult, type VerifyResult } from "./verify";
import { Wordmark } from "./components/Wordmark";
import { dateMedium, dateTimeUtc } from "@/lib/format";

/**
 * Drop a signed PDF, get a verdict. Everything runs in the browser: the file is
 * never uploaded anywhere.
 */
export default function VerifyPage() {
  const { t } = useTranslation();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        toast.error(t("signer.verify.toast.notPdfTitle"), t("signer.verify.toast.notPdfBody"));
        return;
      }
      setBusy(true);
      setResult(null);
      try {
        setResult(await verifyPdf(file));
      } catch (e) {
        toast.error(t("signer.verify.toast.unreadable"), e instanceof Error ? e.message : undefined);
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-ground">
      <div className="h-[52px] sm:h-[60px] flex items-center gap-2 px-5 border-b border-line bg-surface">
        <Wordmark asLink />
        <span className="flex-1" />
        <LanguageMini className="shrink-0 [&>select]:h-11 sm:[&>select]:h-7" />
      </div>

      <div className="mx-auto w-full max-w-[680px] px-5 py-8 sm:py-12">
        <h1 className="font-semibold text-[26px] leading-[1.1] text-ink tracking-[-.015em]">{t("signer.verify.title")}</h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{t("signer.verify.intro")}</p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void run(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "mt-6 rounded-xl border-2 border-dashed px-6 py-10 flex flex-col items-center text-center transition-colors",
            dragging ? "border-accent bg-accent-tint" : "border-line-strong bg-surface"
          )}
        >
          <span className="inline-flex items-center justify-center size-11 rounded-lg bg-accent-soft text-accent">
            {busy ? <Loader2 className="size-5 animate-spin" /> : <FileUp className="size-5" strokeWidth={1.6} />}
          </span>
          <p className="mt-3.5 text-[14px] font-medium text-ink">
            {busy ? t("signer.verify.checking") : t("signer.verify.dropHere")}
          </p>
          <p className="mt-1 text-[12px] text-muted-2">{t("signer.verify.orPickOne")}</p>
          <Button
            variant="primary"
            className="mt-4 min-h-11 sm:min-h-0"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {t("signer.verify.choosePdf")}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void run(f);
            }}
          />
        </div>

        {result ? <Verdict result={result} /> : null}

        <p className="mt-10 pt-4 border-t border-line text-[11px] leading-relaxed text-muted-2">
          {t("signer.verify.footnote")} <Link to="/">{t("signer.verify.backHome")}</Link>
        </p>
      </div>
    </div>
  );
}

function Verdict({ result }: { result: VerifyResult }) {
  const { t } = useTranslation();
  const tone =
    result.status === "valid"
      ? { icon: CheckCircle2, cls: "bg-accent-soft text-accent", pill: "accent" as const, label: "valid" }
      : result.status === "invalid"
        ? { icon: XCircle, cls: "bg-danger-soft text-danger", pill: "danger" as const, label: "invalid" }
        : result.status === "unsigned"
          ? { icon: AlertTriangle, cls: "bg-warn-soft text-warn-ink", pill: "warn" as const, label: "unsigned" }
          : { icon: HelpCircle, cls: "bg-paper text-muted", pill: "neutral" as const, label: "inconclusive" };
  const Icon = tone.icon;

  return (
    <>
      <Card className="mt-6 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <span className={`inline-flex items-center justify-center size-10 rounded-lg ${tone.cls}`}>
            <Icon className="size-5" strokeWidth={1.6} />
          </span>
          <Pill tone={tone.pill}>{t(`signer.verify.status.${tone.label}`)}</Pill>
        </div>
        <h2 className="mt-4 font-semibold text-[20px] leading-tight text-ink break-words tracking-[-.015em]">{result.fileName}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{result.summary}</p>

        <dl className="mt-4 pt-4 border-t border-line grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
          <dt className="text-muted-2">{t("signer.verify.summaryLabels.size")}</dt>
          <dd className="text-ink-2 num">{t("signer.verify.kilobytes", { size: (result.byteLength / 1024).toFixed(0) })}</dd>
          <dt className="text-muted-2">{t("signer.verify.summaryLabels.signatures")}</dt>
          <dd className="text-ink-2 num">{result.signatures.length}</dd>
          <dt className="text-muted-2">{t("signer.verify.summaryLabels.sha256")}</dt>
          <dd className="font-mono text-[11px] text-ink-2 break-all">{result.fileHash}</dd>
        </dl>
      </Card>

      {result.signatures.map((s) => (
        <SignatureCard key={s.index} sig={s} />
      ))}
    </>
  );
}

function SignatureCard({ sig }: { sig: SignatureResult }) {
  const { t } = useTranslation();
  const pill = sig.status === "valid" ? "accent" : sig.status === "invalid" ? "danger" : "neutral";
  const state = sig.status === "valid" ? "intact" : sig.status === "invalid" ? "altered" : "unverified";
  return (
    <Card className="mt-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <Cap className="text-muted-2">{t("signer.verify.signatureIndex", { position: sig.index + 1 })}</Cap>
        <Pill tone={pill}>{t(`signer.verify.signatureStatus.${state}`)}</Pill>
      </div>
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">{sig.detail}</p>

      <dl className="mt-4 pt-4 border-t border-line grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-[12px]">
        <Row label={t("signer.verify.rows.signer")} value={sig.signerName} />
        <Row label={t("signer.verify.rows.email")} value={sig.signerEmail} mono />
        <Row label={t("signer.verify.rows.organization")} value={sig.organization} />
        <Row label={t("signer.verify.rows.issuedBy")} value={sig.issuerName} />
        <Row label={t("signer.verify.rows.serial")} value={sig.serialNumber} mono />
        <Row
          label={t("signer.verify.rows.signedAt")}
          value={sig.signingTime ? dateTimeUtc(sig.signingTime) : undefined}
        />
        <Row
          label={t("signer.verify.rows.certificate")}
          value={
            sig.certificateValidFrom && sig.certificateValidTo
              ? t(sig.certificateExpired ? "signer.verify.cert.rangeExpired" : "signer.verify.cert.range", {
                  from: dateMedium(sig.certificateValidFrom),
                  to: dateMedium(sig.certificateValidTo)
                })
              : undefined
          }
        />
        <Row label={t("signer.verify.rows.digest")} value={sig.digestAlgorithm} />
        <Row
          label={t("signer.verify.rows.contentCheck")}
          value={
            sig.digestMatches === undefined
              ? undefined
              : sig.digestMatches
                ? t("signer.verify.contentMatches")
                : t("signer.verify.contentMismatch")
          }
        />
        <Row
          label={t("signer.verify.rows.keyCheck")}
          value={
            sig.cryptoVerified === undefined
              ? undefined
              : sig.cryptoVerified
                ? t("signer.verify.keyVerified")
                : t("signer.verify.keyUnverified")
          }
        />
        <Row
          label={t("signer.verify.rows.coverage")}
          value={sig.coversWholeFile ? t("signer.verify.coverWhole") : t("signer.verify.coverPartial")}
        />
        <Row label={t("signer.verify.rows.documentDigest")} value={sig.documentDigest} mono />
      </dl>
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-2">{label}</dt>
      <dd className={cn("text-ink-2 break-all", mono && "font-mono text-[11px]")}>{value}</dd>
    </>
  );
}
