import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LanguageMini } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useBrand } from "@/lib/brand";
import { SOURCE_URL } from "@/lib/source";

/**
 * Tenant branding for this host (`useBrand`), falling back to the plain "DocuStamp"
 * wordmark when the host has no tenant logo, the call fails, or the image will
 * not load.
 */
function Wordmark() {
  const { name, logoUrl } = useBrand();
  const [logoBroken, setLogoBroken] = useState(false);

  if (logoUrl && !logoBroken) {
    return (
      <img
        src={logoUrl}
        alt={name}
        className="h-[28px] w-auto max-w-[220px] object-contain object-left"
        onError={() => setLogoBroken(true)}
      />
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="grid place-items-center size-[22px] rounded-[6px] bg-white/95 font-serif text-[14px] leading-none text-brand-panel"
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="text-[15px] font-semibold tracking-[-.01em] text-white">{name}</span>
    </div>
  );
}

/**
 * The split auth frame: an accent panel on the left (640px on wide screens,
 * a short band above the form below 900px) and a centred 400px column.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex flex-col min-[900px]:flex-row bg-ground">
      <aside
        className={cn(
          "bg-brand-panel text-white shrink-0",
          "px-6 py-5",
          "min-[900px]:w-[640px] min-[900px]:px-16 min-[900px]:py-14",
          "min-[900px]:flex min-[900px]:flex-col min-[900px]:justify-between"
        )}
      >
        <Wordmark />

        <div className="hidden min-[900px]:block max-w-[460px] py-10">
          <h2 className="font-serif text-[46px] leading-[1.08] tracking-[-.015em]">
            {t("auth.marketing.headline")}
          </h2>
          <p className="mt-5 text-[15px] leading-[1.6] text-white/70">{t("auth.marketing.body")}</p>
        </div>

        <p className="hidden min-[900px]:flex items-center text-[12px] text-white/50">
          {t("auth.footer.openSource")}
          <span className="px-1.5 text-white/30">&middot;</span>
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-white/60 hover:text-white underline-offset-2 hover:underline"
          >
            {t("auth.footer.source")}
          </a>
          <span className="px-1.5 text-white/30">&middot;</span>
          <a href="/status" className="text-white/60 hover:text-white underline-offset-2 hover:underline">
            {t("auth.footer.status")}
          </a>
          <span className="px-1.5 text-white/30">&middot;</span>
          <LanguageMini tone="onDark" className="-ml-1.5" />
        </p>
      </aside>

      <main className="flex-1 flex items-start min-[900px]:items-center justify-center px-6 py-12 min-[900px]:py-10">
        <div className="w-full max-w-[400px]">
          {children}
          <div className="mt-8 flex justify-center min-[900px]:hidden">
            <LanguageMini />
          </div>
        </div>
      </main>
    </div>
  );
}

/** Serif page heading plus a secondary line, used by every auth screen. */
export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-7">
      <h1 className="font-serif text-[30px] leading-tight tracking-[-.015em]">{title}</h1>
      {children ? <p className="mt-1.5 text-[13px] text-muted">{children}</p> : null}
    </header>
  );
}

/** Inline form-level error banner. */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
    >
      {children}
    </div>
  );
}

export function OrDivider({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 my-5" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] uppercase tracking-[.08em] text-muted-2">
        {label ?? t("auth.divider.or")}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
