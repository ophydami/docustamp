import { useEffect, useState, type ReactNode } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Avatar, AvatarStack } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { callTool } from "./bridge";
import { shortDate, stamp, statusOf } from "./format";
import type { DocRow, DocStatus, PageImage, SignerRow } from "./types";

/*
  Shared pieces of the MCP app, built from the web app's own components so the
  app inside ChatGPT reads as DocuStamp: status as tinted pills with a dot,
  people as initials avatars, numbers and dates in Geist Mono, hairline rows,
  skeletons (never a centred spinner) while loading.
*/

/** A number or date inside running text: Geist Mono, tabular. */
export function N({ children }: { children: ReactNode }) {
  return <span className="num">{children}</span>;
}

/** The line under a document's name: who it waits on, who it is for, or when it finished. */
export function DocSubline({ doc, locale }: { doc: DocRow; locale?: string }) {
  const names = (list: SignerRow[]) => list.map((s) => s.name || s.email).filter(Boolean) as string[];
  const few = (list: string[]) =>
    list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ");
  if (doc.status === "completed")
    return (
      <>
        Completed <N>{shortDate(doc.completedAt || doc.updatedAt, locale)}</N>
      </>
    );
  if (doc.status === "draft") {
    const who = names(doc.signers);
    return (
      <>
        {who.length ? `For ${few(who)}` : "No recipients yet"}
        {doc.fieldCount ? (
          <>
            {" · "}
            <N>{doc.fieldCount}</N> {doc.fieldCount === 1 ? "field" : "fields"}
          </>
        ) : null}
      </>
    );
  }
  if (doc.status === "in_progress") {
    const pending = names(doc.signers.filter((s) => s.status === "pending"));
    return (
      <>
        {pending.length ? `Waiting on ${few(pending)}` : "Waiting"}
        {doc.expiresAt ? (
          <>
            {" · due "}
            <N>{shortDate(doc.expiresAt, locale)}</N>
          </>
        ) : null}
      </>
    );
  }
  return (
    <>
      Updated <N>{shortDate(doc.updatedAt, locale)}</N>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

export function StatusPill({ status, className }: { status: DocStatus; className?: string }) {
  const s = statusOf(status);
  return (
    <Pill tone={s.tone} dot className={className}>
      {s.label}
    </Pill>
  );
}

/** Tinted message, the web app's inline banner: green, amber or red only as a tint, grey for plain news. */
export function Banner({ tone, children }: { tone: "success" | "warn" | "danger" | "neutral"; children: ReactNode }) {
  const tones = {
    success: "bg-success-soft text-success-ink",
    warn: "bg-warn-soft text-warn-ink",
    danger: "bg-danger-soft text-danger",
    neutral: "bg-surface-3 text-ink-2"
  };
  return <div className={cn("rounded-md px-3 py-2 text-[12.5px] leading-relaxed", tones[tone])}>{children}</div>;
}

/** A grey block standing in for content that is loading. */
export function Skel({ className }: { className?: string }) {
  return <span className={cn("block rounded-md bg-surface-3 animate-pulse", className)} aria-hidden />;
}

/** Placeholder rows that mirror DocRowItem while a list loads. */
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5 border-b border-line-soft last:border-0">
          <Skel className="size-[22px] rounded-full" />
          <div className="flex-1 flex flex-col gap-1.5">
            <Skel className="h-3 w-2/5" />
            <Skel className="h-2.5 w-3/5" />
          </div>
          <Skel className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** A document row: who is on it, its name, the line under it, its status. Hairline-separated. */
export function DocRowItem({ doc, onOpen, locale }: { doc: DocRow; onOpen: (doc: DocRow) => void; locale?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(doc)}
      className="w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-line-soft last:border-0 hover:bg-surface-2 focus-visible:outline-offset-[-2px]"
    >
      {/* A fixed slot, so titles line up whether a row has one signer or several. */}
      <span className="flex w-[38px] shrink-0">
        <AvatarStack people={doc.signers.map((s) => ({ name: s.name, email: s.email }))} size={22} max={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{doc.name}</div>
        <div className="text-[11.5px] text-muted truncate">
          <DocSubline doc={doc} locale={locale} />
        </div>
      </div>
      <StatusPill status={doc.status} className="shrink-0" />
    </button>
  );
}

/** One recipient, as on the web app's document page. A draft's recipients have no signing state yet. */
export function RecipientRow({
  signer,
  draft = false,
  locale
}: {
  signer: SignerRow;
  draft?: boolean;
  locale?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0">
      <Avatar name={signer.name} email={signer.email} size={26} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{signer.name || signer.email}</div>
        <div className="text-[11px] text-muted-2 truncate">
          {[signer.role, signer.name ? signer.email : ""].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="text-right shrink-0">
        {draft ? null : signer.status === "signed" ? (
          <span className="num text-[12px] text-muted" title={stamp(signer.signedAt, locale)}>
            Signed {shortDate(signer.signedAt, locale)}
          </span>
        ) : signer.status === "declined" ? (
          <Pill tone="danger">Declined</Pill>
        ) : (
          <Pill tone="neutral">Not signed</Pill>
        )}
      </div>
    </div>
  );
}

/**
 * One page of the document with its fields drawn on it (the app-only
 * `app_page` tool), on white paper in both themes. A completed document shows
 * its signed copy.
 */
export function PagePreview({
  app,
  documentId,
  title,
  source = "original",
  startPage = 1,
  compact = false
}: {
  app: App;
  documentId: string;
  title: string;
  source?: "original" | "signed";
  startPage?: number;
  compact?: boolean;
}) {
  const [page, setPage] = useState(startPage);
  // What came back for which page: a page turn shows the skeleton until its own answer arrives.
  const [loaded, setLoaded] = useState<{ page: number; image?: PageImage; error?: string } | null>(null);

  useEffect(() => {
    let live = true;
    callTool<PageImage>(app, "app_page", { documentId, page, source })
      .then((image) => live && setLoaded({ page, image }))
      .catch((err: Error) => live && setLoaded({ page, error: err.message }));
    return () => {
      live = false;
    };
  }, [app, documentId, page, source]);

  const current = loaded?.page === page ? loaded : null;
  const shown = current?.image ?? null;
  const error = current?.error ?? "";
  const image = loaded?.image ?? null;
  const ratio = image ? `${image.width} / ${image.height}` : "8.5 / 11";
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div
        className={cn(
          "paper-white relative w-full overflow-hidden border border-line",
          compact ? "rounded-md" : "rounded-lg"
        )}
        style={{ aspectRatio: ratio }}
      >
        {shown ? (
          <img
            src={shown.image}
            alt={`Page ${shown.page} of ${shown.pageCount} of ${title}, with the signing fields marked`}
            className="block size-full object-contain"
          />
        ) : error ? (
          <div className="grid size-full place-items-center p-3 text-center text-[12px] text-muted">{error}</div>
        ) : (
          <Skel className="size-full rounded-none" />
        )}
      </div>
      {!compact && image && image.pageCount > 1 ? (
        <figcaption className="flex items-center justify-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            icon={<ChevronLeft className="size-3.5" strokeWidth={1.6} />}
          />
          <span className="num text-[11.5px] text-muted">
            {page} / {image.pageCount}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Next page"
            disabled={page >= image.pageCount}
            onClick={() => setPage((p) => Math.min(image.pageCount, p + 1))}
            icon={<ChevronRight className="size-3.5" strokeWidth={1.6} />}
          />
        </figcaption>
      ) : null}
    </figure>
  );
}
