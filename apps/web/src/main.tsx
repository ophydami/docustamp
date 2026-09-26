import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import "./index.css";
import { initParse } from "@/lib/parse";
import { initI18n } from "@/lib/i18n";
import { queryClient } from "@/lib/queryClient";
import { useThemeSync } from "@/lib/theme";
import { AuthProvider } from "@/app/auth";
import { router } from "@/app/router";
import { Toaster } from "@/components/ui";

initParse();

/** Shown while a newly picked language downloads its bundle. */
function LanguageFallback() {
  return (
    <div className="min-h-screen grid place-items-center bg-ground">
      <Loader2 className="size-5 animate-spin text-muted" strokeWidth={1.6} />
    </div>
  );
}

/** Owns the one call that keeps <html data-theme> in step with the setting. */
function App() {
  useThemeSync();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Suspense fallback={<LanguageFallback />}>
          <RouterProvider router={router} />
          <Toaster />
        </Suspense>
      </AuthProvider>
    </QueryClientProvider>
  );
}

// The first language bundle is awaited so the app never paints raw keys.
void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
