import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { AppShell, BareShell } from "./AppShell";
import { RequireAuth } from "./auth";
import { Loader2 } from "lucide-react";

// Feature pages are lazy so each feature folder is its own chunk.
// Each feature owns src/features/<name>/ and exports pages from index.tsx.
const LoginPage = lazy(() => import("@/features/auth/LoginPage"));
const SignupPage = lazy(() => import("@/features/auth/SignupPage"));
const ForgotPasswordPage = lazy(() => import("@/features/auth/ForgotPasswordPage"));
const GuestLoginPage = lazy(() => import("@/features/auth/GuestLoginPage"));

const InboxPage = lazy(() => import("@/features/inbox/InboxPage"));
const DocumentsPage = lazy(() => import("@/features/documents/DocumentsPage"));
const DocumentDetailPage = lazy(() => import("@/features/documents/DocumentDetailPage"));
const SendPage = lazy(() => import("@/features/send/SendPage"));
const EditorPage = lazy(() => import("@/features/editor/EditorPage"));
const TemplatesPage = lazy(() => import("@/features/templates/TemplatesPage"));
const ContactsPage = lazy(() => import("@/features/contacts/ContactsPage"));
const ReportsPage = lazy(() => import("@/features/reports/ReportsPage"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));
const AiPage = lazy(() => import("@/features/ai/AiPage"));
const SignerPage = lazy(() => import("@/features/signer/SignerPage"));
const SignerDonePage = lazy(() => import("@/features/signer/SignerDonePage"));
const VerifyPage = lazy(() => import("@/features/signer/VerifyPage"));
const NotFoundPage = lazy(() => import("@/features/misc/NotFoundPage"));
const ComingSoonPage = lazy(() => import("@/features/misc/ComingSoonPage"));
const LegalPage = lazy(() => import("@/features/misc/LegalPage"));

function Fallback() {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-2">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Fallback />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  // Public
  { path: "/login", element: <S><LoginPage /></S> },
  { path: "/login/:base64url", element: <S><GuestLoginPage /></S> },
  { path: "/signup", element: <S><SignupPage /></S> },
  { path: "/forgot-password", element: <S><ForgotPasswordPage /></S> },
  { path: "/terms", element: <S><LegalPage kind="terms" /></S> },
  { path: "/privacy", element: <S><LegalPage kind="privacy" /></S> },
  { path: "/status", element: <S><LegalPage kind="status" /></S> },

  // Signer (public, token in URL; no account needed)
  {
    element: <BareShell />,
    children: [
      { path: "/sign/:docId", element: <S><SignerPage /></S> },
      { path: "/sign/:docId/:contactId", element: <S><SignerPage /></S> },
      { path: "/sign/:docId/done", element: <S><SignerDonePage /></S> },
      { path: "/verify", element: <S><VerifyPage /></S> },
      // Legacy OpenSign links keep working
      { path: "/recipientSignPdf/:docId", element: <S><SignerPage /></S> },
      { path: "/recipientSignPdf/:docId/:contactId", element: <S><SignerPage /></S> },
      { path: "/load/recipientSignPdf/:docId/:contactId", element: <S><SignerPage /></S> },
      { path: "/verify-document", element: <S><VerifyPage /></S> }
    ]
  },

  // Signed-in, full-bleed (no sidebar)
  {
    element: (
      <RequireAuth>
        <BareShell />
      </RequireAuth>
    ),
    children: [
      { path: "/send", element: <S><SendPage /></S> },
      { path: "/send/:docId", element: <S><SendPage /></S> },
      { path: "/editor/:docId", element: <S><EditorPage /></S> },
      { path: "/templates/:templateId/edit", element: <S><EditorPage mode="template" /></S> },
      // Self-sign uses the same signer UI in "self" mode
      { path: "/sign-yourself/:docId", element: <S><SignerPage mode="self" /></S> }
    ]
  },

  // Signed-in app shell
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/inbox" replace /> },
      { path: "/inbox", element: <S><InboxPage /></S> },
      { path: "/documents", element: <S><DocumentsPage /></S> },
      { path: "/documents/:docId", element: <S><DocumentDetailPage /></S> },
      { path: "/templates", element: <S><TemplatesPage /></S> },
      { path: "/contacts", element: <S><ContactsPage /></S> },
      { path: "/contacts/:contactId", element: <S><ContactsPage /></S> },
      { path: "/reports", element: <S><ReportsPage /></S> },
      { path: "/reports/:reportId", element: <S><ReportsPage /></S> },
      { path: "/ai", element: <S><AiPage /></S> },
      { path: "/automations", element: <S><ComingSoonPage titleKey="app.nav.automations" /></S> },
      { path: "/settings", element: <S><SettingsPage /></S> },
      { path: "/settings/:section", element: <S><SettingsPage /></S> },
      // Legacy OpenSign routes
      { path: "/dashboard/:id", element: <Navigate to="/inbox" replace /> },
      { path: "/report/:id", element: <Navigate to="/documents" replace /> },
      { path: "/managesign", element: <Navigate to="/settings/signature" replace /> },
      { path: "/preferences", element: <Navigate to="/settings" replace /> },
      { path: "/profile", element: <Navigate to="/settings/profile" replace /> },
      { path: "/users", element: <Navigate to="/settings/team" replace /> },
      { path: "/drive", element: <Navigate to="/documents" replace /> },
      { path: "/placeHolderSign/:docId", element: <Navigate to="/send/:docId" replace /> }
    ]
  },

  { path: "*", element: <S><NotFoundPage /></S> }
]);

export function RootOutlet() {
  return <Outlet />;
}
