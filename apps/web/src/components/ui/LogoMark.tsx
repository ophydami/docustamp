import { cn } from "@/lib/cn";

// The DocuStamp mark, the same drawing as brand/docustamp-mark.svg: a page with a
// folded corner, a rubber stamp cut out of it and a line of ink under the stamp.
const PAGE = "M16 4H38V18H52V56A4 4 0 0 1 48 60H16A4 4 0 0 1 12 56V8A4 4 0 0 1 16 4Z";
const FLAP = "M40.5 4L52 15.5H42.5A2 2 0 0 1 40.5 13.5Z";
const STAMP =
  "M29.4 29.84L28.4 36.5H21A2 2 0 0 0 19 38.5V41A2 2 0 0 0 21 43H43A2 2 0 0 0 45 41V38.5" +
  "A2 2 0 0 0 43 36.5H35.6L34.6 29.84A4.8 4.8 0 1 0 29.4 29.84Z" +
  "M22.3 44.3A0.8 0.8 0 0 0 21.5 45.1V46A0.8 0.8 0 0 0 22.3 46.8H41.7A0.8 0.8 0 0 0 42.5 46V45.1A0.8 0.8 0 0 0 41.7 44.3Z";

/**
 * The page takes the current text colour (text-ink on the app, white on the
 * ink auth panel); the stamp shows whatever is behind it; the ink line is the
 * accent blue. `size` is the height in px; the mark is 40 x 56.
 */
export function LogoMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox="12 4 40 56"
      height={size}
      width={(size * 40) / 56}
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path fill="currentColor" fillRule="evenodd" d={PAGE + STAMP} />
      <path fill="currentColor" d={FLAP} />
      <rect x="19" y="50.5" width="26" height="3.5" rx="1.75" fill="var(--color-accent)" />
    </svg>
  );
}
