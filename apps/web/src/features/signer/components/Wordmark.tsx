import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { useBrand } from "@/lib/brand";
import { LogoMark } from "@/components/ui";

/**
 * The workspace wordmark used across the public signer surfaces: the tenant's
 * logo when one is set, otherwise the mark and the workspace name (falling back
 * to "DocuStamp").
 */
export function Wordmark({ className, asLink }: { className?: string; asLink?: boolean }) {
  const { name, logoUrl } = useBrand();
  const inner = (
    <span className={cn("inline-flex items-center gap-1.5 select-none", className)}>
      {logoUrl ? (
        <img src={logoUrl} alt={name} className="max-h-7 max-w-[160px] object-contain" />
      ) : (
        <>
          <LogoMark size={20} className="text-ink" />
          <span className="font-semibold text-[14px] text-ink leading-none">{name}</span>
        </>
      )}
    </span>
  );
  return asLink ? <Link to="/">{inner}</Link> : inner;
}
