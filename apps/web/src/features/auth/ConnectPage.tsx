import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { Button, Checkbox } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { useSignInBrand } from "@/lib/brand";
import { cloud } from "@/lib/parse";
import { useEmailVerification } from "@/features/settings/api";
import { VerifyEmailCard } from "@/features/settings/VerifyEmailCard";
import { AuthHeading, AuthLayout, FormError } from "./AuthLayout";

interface ConnectRequest {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  expiresAt: string | null;
  /** The app asked for `documents:sign`. Signing is still off unless the box is ticked. */
  signRequested?: boolean;
}

/** What each OAuth scope lets the app do, in the words the page uses. */
const SCOPE_LABELS: Record<string, string> = {
  "documents:read": "auth.connect.scopeRead",
  "documents:write": "auth.connect.scopeWrite"
};

/**
 * The consent page for "Sign in with DocuStamp" (server: cloud/lib/oauth.js).
 *
 * An MCP app such as ChatGPT sends the browser to /api/oauth/authorize, which
 * stores the request and redirects here with `?request=<id>`. RequireAuth (in
 * the router) makes the user sign in first and brings them back. Allowing or
 * denying asks the server for the url to return to, and the page goes there:
 * with a one-time code when allowed, with `error=access_denied` when not.
 *
 * Signing for the person is never part of the default grant. An app that can
 * send gets an unticked "Let <app> sign documents for me" box, which needs a
 * verified email first (the inline verify box stands in for it until then);
 * the choice goes to `oauthdecide` as `allowSigning`. A server without email
 * verification fails that query, and then the box is left out.
 */
export default function ConnectPage() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const brand = useSignInBrand();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");
  const [allowSigning, setAllowSigning] = useState(false);
  const verification = useEmailVerification(Boolean(requestId));

  const request = useQuery({
    queryKey: ["oauth", "request", requestId],
    queryFn: () => cloud<ConnectRequest>("oauthrequest", { requestId }),
    enabled: Boolean(requestId),
    retry: false,
    staleTime: Infinity
  });

  async function decide(approve: boolean) {
    setBusy(approve ? "allow" : "deny");
    setError("");
    try {
      const sign = approve && allowSigning && verification.data?.verified === true;
      const res = await cloud<{ redirectUrl: string }>("oauthdecide", {
        requestId,
        approve,
        ...(sign ? { allowSigning: true } : {})
      });
      // Leave `busy` set: the page is navigating away and must not be clicked twice.
      window.location.assign(res.redirectUrl);
    } catch (err) {
      setBusy(null);
      setError((err as Error).message || t("auth.connect.failed"));
    }
  }

  async function switchAccount() {
    await logout();
    navigate("/login", { replace: true, state: { from: location.pathname + location.search } });
  }

  if (!requestId || request.isError) {
    return (
      <AuthLayout>
        <AuthHeading title={t("auth.connect.expiredTitle")}>{t("auth.connect.expiredBody")}</AuthHeading>
        <Link to="/inbox">
          <Button variant="default" block>
            {t("auth.connect.backToApp", { product: brand.name })}
          </Button>
        </Link>
      </AuthLayout>
    );
  }

  if (request.isLoading || !request.data) {
    return (
      <AuthLayout>
        <div className="flex justify-center py-16 text-muted-2">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </AuthLayout>
    );
  }

  const app = request.data.clientName || t("auth.connect.unnamedApp");
  const scopes = request.data.scopes.filter((scope) => SCOPE_LABELS[scope]);
  const signRequested = request.data.signRequested === true;
  const offerSigning =
    verification.data !== undefined && (request.data.scopes.includes("documents:write") || signRequested);

  return (
    <AuthLayout>
      <AuthHeading title={t("auth.connect.title", { app })}>
        {t("auth.connect.subtitle", { app, product: brand.name })}
      </AuthHeading>

      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-[12px]">
          <span className="min-w-0 truncate text-ink-2">{t("auth.connect.signedInAs", { email: user?.email ?? "" })}</span>
          <button
            type="button"
            className="shrink-0 text-accent hover:underline underline-offset-2"
            onClick={() => void switchAccount()}
          >
            {t("auth.connect.switchAccount")}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-semibold text-ink-2">{t("auth.connect.wants", { app })}</span>
          <ul className="flex flex-col gap-2">
            {scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2 text-[13px] text-ink">
                <Check className="mt-0.5 size-3.5 shrink-0 text-accent" strokeWidth={2} />
                <span>{t(SCOPE_LABELS[scope])}</span>
              </li>
            ))}
          </ul>
        </div>

        {offerSigning ? (
          <div className="flex flex-col gap-2">
            {verification.data?.verified ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 hover:border-line-strong">
                <Checkbox
                  className="mt-[3px]"
                  checked={allowSigning}
                  onChange={setAllowSigning}
                  disabled={busy !== null}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-ink">{t("auth.connect.allowSigning", { app })}</span>
                  <span className="text-[12px] leading-relaxed text-muted">{t("auth.connect.allowSigningHint")}</span>
                </span>
              </label>
            ) : (
              <VerifyEmailCard variant="inline" reason={t("auth.connect.verifyReason", { app })} />
            )}
            {signRequested ? (
              <p className="text-[11.5px] leading-relaxed text-muted">{t("auth.connect.signRequested", { app })}</p>
            ) : null}
          </div>
        ) : null}

        <p className="text-[12px] leading-relaxed text-muted">
          <Trans
            i18nKey="auth.connect.redirectNote"
            values={{ host: request.data.redirectHost }}
            components={[<span key="host" className="font-mono text-ink-2" />]}
          />{" "}
          {t("auth.connect.warning", { app })}
        </p>

        <FormError>{error}</FormError>

        <div className="flex gap-2">
          <Button
            variant="primary"
            block
            loading={busy === "allow"}
            disabled={busy !== null}
            onClick={() => void decide(true)}
          >
            {t("auth.connect.allow")}
          </Button>
          <Button variant="default" block loading={busy === "deny"} disabled={busy !== null} onClick={() => void decide(false)}>
            {t("auth.connect.deny")}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
