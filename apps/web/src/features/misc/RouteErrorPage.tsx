import { useEffect, useState } from "react";
import { useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { isChunkLoadError, isReloadPending, reloadOnce } from "@/lib/chunkRecovery";

/**
 * The one error boundary over every route (app/router.tsx). It replaces the
 * router's default "Unexpected Application Error" developer page, which is
 * what a signer saw when their VPN dropped the signing page's download.
 *
 * Not lazy on purpose: it has to render when lazy pages cannot.
 *
 * A page that failed to download reloads once (lib/chunkRecovery.ts); while
 * that reload is on its way this shows a spinner, not an error. A second
 * failure, or any other crash, gets a plain message and a "Try again" button.
 */
export default function RouteErrorPage() {
  const error = useRouteError();
  const { t } = useTranslation();
  const download = isChunkLoadError(error);
  const [pending, setPending] = useState(isReloadPending);

  useEffect(() => {
    console.error("[docustamp] page error", error);
    if (!pending && download && reloadOnce()) setPending(true);
  }, [error, download, pending]);

  if (pending) {
    return (
      <div className="min-h-screen grid place-items-center bg-ground">
        <Loader2 className="size-5 animate-spin text-muted" strokeWidth={1.6} />
      </div>
    );
  }

  // The message itself only in development; a signer never needs a stack trace.
  const detail = import.meta.env.DEV && error instanceof Error ? error.message : null;

  return (
    <div className="min-h-screen grid place-items-center bg-ground">
      <EmptyState
        title={t(download ? "misc.errorPage.loadTitle" : "misc.errorPage.crashTitle")}
        body={
          <>
            {t(download ? "misc.errorPage.loadBody" : "misc.errorPage.crashBody")}
            {detail ? (
              <span className="block mt-2 font-mono text-[12px] text-muted-2 break-all">{detail}</span>
            ) : null}
          </>
        }
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("misc.errorPage.retry")}
          </Button>
        }
      />
    </div>
  );
}
