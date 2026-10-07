import { useAuth } from "@/app/auth";
import { AuthLayout } from "./AuthLayout";
import { CompleteProfile } from "./CompleteProfile";

/**
 * What RequireProfile shows a signed-in account that has no `contracts_Users`
 * row, in place of the page that was asked for. Once the row exists the profile
 * query is refreshed (CompleteProfile does that) and the guard renders the page.
 */
export default function FinishWorkspacePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <AuthLayout>
      <CompleteProfile
        name={user.name || user.email || user.username}
        email={user.email || user.username}
        onDone={() => undefined}
      />
    </AuthLayout>
  );
}
