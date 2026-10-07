import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useExtUser } from "@/lib/extUser";

const FinishWorkspacePage = lazy(() => import("@/features/auth/FinishWorkspacePage"));

function Waiting() {
  return (
    <div className="h-full flex items-center justify-center bg-ground text-muted-2">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

/**
 * Route guard that sits inside RequireAuth: a session alone is not enough, the
 * account also needs its `contracts_Users` row, or every page in the app fails
 * with "User profile not found".
 *
 * The sign-in page already checks this, but a session can arrive without it: a
 * signer who verified an emailed code on a signing link holds a session for an
 * account the server created as a side effect of being a contact, and opening
 * the app afterwards used to walk straight past the check. Such an account gets
 * the "finish your workspace" step in place, which also points out that joining
 * an existing team is the admin's job. A suspended account goes back to the
 * sign-in page, which drops the session and says why. If the profile cannot be
 * read at all (a network blip), the pages render and show their own errors
 * rather than locking the person out.
 */
export function RequireProfile({ children }: { children: ReactNode }) {
  const profile = useExtUser();
  const loc = useLocation();
  if (profile.isPending) return <Waiting />;
  if (profile.isError) return <>{children}</>;
  if (profile.data === null) {
    return (
      <Suspense fallback={<Waiting />}>
        <FinishWorkspacePage />
      </Suspense>
    );
  }
  if (profile.data.IsDisabled === true) {
    return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  }
  return <>{children}</>;
}
