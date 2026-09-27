import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { useBrand } from "@/lib/brand";

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
          <span className="inline-flex items-center justify-center size-5 rounded-[6px] bg-ink text-ground font-bold text-[12px] leading-none">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="font-semibold text-[14px] text-ink leading-none">{name}</span>
        </>
      )}
    </span>
  );
  return asLink ? <Link to="/">{inner}</Link> : inner;
}
