import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button, Input, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { AuthHeading, AuthLayout, FormError } from "./AuthLayout";
import { CodeInput } from "./CodeInput";
import { useCooldown } from "./useCooldown";
import {
  decodeGuestLink,
  errorMessage,
  linkContactToDoc,
  loadGuestDoc,
  normalizeEmail,
  requestOtp,
  verifyOtp,
  type GuestLinkPayload
} from "./api";

type Step = "loading" | "invalid" | "gone" | "request" | "code";

/**
 * Guest signer entry point for `/login/:base64url`, the link that goes out in
 * the request email. The payload is
 * `btoa("<docId>/<email>/<contactId>/<signingToken>")`, and the token is handed
 * on to the signer route as `?t=` so every guest call can present it.
 * If the document is not OTP protected the signer never logs in at all and we
 * hand straight over to the signer route; otherwise they verify an emailed code
 * and the server mints a session for them.
 */
export default function GuestLoginPage() {
  const { t } = useTranslation();
  const { base64url } = useParams<{ base64url: string }>();
  const navigate = useNavigate();
  const { loginWithSessionToken } = useAuth();

  // Decoding is pure, so the "not a valid link" answer is known before we render.
  const payload: GuestLinkPayload | null = useMemo(
    () => (base64url ? decodeGuestLink(base64url) : null),
    [base64url]
  );
  const [step, setStep] = useState<Step>(payload ? "loading" : "invalid");
  const [contactId, setContactId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resend = useCooldown(45);

  const goToSigner = useCallback(
    (docId: string, contact: string, link: Pick<GuestLinkPayload, "sendmail" | "signingToken">) => {
      // `t` carries the per-signer signing token on to every guest cloud call.
      const params = new URLSearchParams();
      if (link.signingToken) params.set("t", link.signingToken);
      if (link.sendmail === "false") params.set("sendmail", "false");
      const query = params.size ? `?${params.toString()}` : "";
      navigate(`/sign/${docId}/${contact}${query}`, { replace: true });
    },
    [navigate]
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !payload) return;
    started.current = true;
    const link = payload;

    void (async () => {
      try {
        // Links sent before the contact existed carry no contact id; the server
        // resolves or creates one and splices it into the document's Signers.
        const contact =
          link.contactId ??
          (await linkContactToDoc({
            docId: link.docId,
            email: link.email,
            signingToken: link.signingToken
          }));
        setContactId(contact);

        const state = await loadGuestDoc(link.docId, link.signingToken);
        if (state.status === "open") {
          goToSigner(link.docId, contact, link);
          return;
        }
        if (state.status === "gone") {
          setNotice(state.message);
          setStep("gone");
          return;
        }
        // getDocument refused: the document has IsEnableOTP set, so this signer
        // has to verify an emailed code before they can open it.
        setStep("request");
      } catch (err) {
        setNotice(errorMessage(err, t("auth.errors.requestNotOpenable")));
        setStep("gone");
      }
    })();
  }, [payload, goToSigner, t]);

  async function sendCode() {
    if (!payload) return;
    setError(null);
    setBusy(true);
    try {
      await requestOtp({ email: payload.email, docId: payload.docId });
      setCode("");
      setStep("code");
      resend.start();
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.codeEmailFailed"));
      setError(message);
      toast.error(t("auth.toast.codeSendFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(value: string) {
    if (!payload || !contactId) return;
    setError(null);
    if (!/^\d{6}$/.test(value)) {
      setError(t("auth.errors.codeFourDigits"));
      return;
    }
    setBusy(true);
    try {
      const result = await verifyOtp({ email: payload.email, otp: value });
      await loginWithSessionToken(result.sessionToken);
      goToSigner(payload.docId, contactId, payload);
    } catch (err) {
      const message = errorMessage(err, t("auth.errors.codeVerifyFallback"));
      setError(message);
      toast.error(t("auth.toast.verificationFailed"), message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "loading") {
    return (
      <AuthLayout>
        <div className="flex items-center gap-2 text-muted-2 text-[13px]">
          <Loader2 className="size-4 animate-spin" strokeWidth={1.6} />
          {t("auth.status.openingDocument")}
        </div>
      </AuthLayout>
    );
  }

  if (step === "invalid") {
    return (
      <AuthLayout>
        <AuthHeading title={t("auth.guest.invalidTitle")}>{t("auth.guest.invalidBody")}</AuthHeading>
        <Link to="/login">
          <Button size="lg">{t("auth.actions.goToSignIn")}</Button>
        </Link>
      </AuthLayout>
    );
  }

  if (step === "gone") {
    return (
      <AuthLayout>
        <AuthHeading title={t("auth.guest.goneTitle")}>
          {notice ?? t("auth.guest.goneBody")}
        </AuthHeading>
        <Link to="/login">
          <Button size="lg">{t("auth.actions.goToSignIn")}</Button>
        </Link>
      </AuthLayout>
    );
  }

  const email = payload ? normalizeEmail(payload.email) : "";

  return (
    <AuthLayout>
      {step === "request" ? (
        <>
          <AuthHeading title={t("auth.guest.verifyTitle")}>{t("auth.guest.verifyBody")}</AuthHeading>

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
            noValidate
          >
            <FormError>{error}</FormError>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-2">
                {t("auth.fields.yourEmail")}
              </span>
              <Input value={email} readOnly disabled aria-label={t("auth.fields.yourEmail")} />
            </div>

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              {t("auth.actions.emailMeACode")}
            </Button>
          </form>
        </>
      ) : (
        <>
          <AuthHeading title={t("auth.checkEmail.title")}>
            <Trans
              i18nKey="auth.checkEmail.sentTo"
              values={{ email }}
              components={{ 1: <span className="text-ink" /> }}
            />
          </AuthHeading>

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode(code);
            }}
            noValidate
          >
            <FormError>{error}</FormError>

            <CodeInput
              value={code}
              onChange={(v) => {
                setCode(v);
                setError(null);
              }}
              onComplete={(v) => void submitCode(v)}
              disabled={busy}
              invalid={!!error}
              autoFocus
            />

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              {t("auth.actions.openDocument")}
            </Button>

            <div className="flex items-center justify-between text-[12px]">
              <button
                type="button"
                onClick={() => {
                  setStep("request");
                  setError(null);
                  setCode("");
                }}
                className="text-muted hover:text-ink"
              >
                {t("common.actions.back")}
              </button>
              <button
                type="button"
                disabled={resend.active || busy}
                onClick={() => void sendCode()}
                className="text-accent hover:text-accent-deep disabled:text-muted-2 disabled:cursor-not-allowed"
              >
                {resend.active
                  ? t("auth.actions.resendIn", { seconds: resend.left })
                  : t("auth.actions.resendCode")}
              </button>
            </div>
          </form>
        </>
      )}

      <p className="mt-8 pt-5 border-t border-line text-[12px] leading-relaxed text-muted-2">
        {t("auth.footer.guestNote")}
      </p>
    </AuthLayout>
  );
}
