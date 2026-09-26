import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { Button, Dialog, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MAX_FORWARD_RECIPIENTS, useContactSuggestions, useForwardDocument } from "./api";
import type { Document } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Forward a completed document to people who are not on it.
 *
 * `forwarddoc` emails the signed PDF as an attachment, one message per address,
 * with a server-built subject and body. There is no covering note to add and no
 * per-recipient reply, so this dialog only collects addresses.
 */
export function ForwardDialog({ doc, onClose }: { doc: Document | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const forward = useForwardDocument();
  const suggestions = useContactSuggestions(draft);

  useEffect(() => {
    if (doc) {
      setEmails([]);
      setDraft("");
      setError(null);
    }
  }, [doc]);

  const already = useMemo(() => new Set(emails), [emails]);
  const matches = (suggestions.data ?? []).filter((s) => !already.has(s.email)).slice(0, 6);

  const add = (value: string) => {
    const email = value.trim().toLowerCase().replace(/[,;]+$/, "");
    if (!email) return;
    if (!EMAIL.test(email)) {
      setError(t("documents.forward.invalidEmail", { email }));
      return;
    }
    if (already.has(email)) {
      setDraft("");
      return;
    }
    if (emails.length >= MAX_FORWARD_RECIPIENTS) {
      setError(t("documents.forward.limit", { count: MAX_FORWARD_RECIPIENTS }));
      return;
    }
    setEmails((list) => [...list, email]);
    setDraft("");
    setError(null);
  };

  const send = () => {
    // A half-typed address in the box should count, so commit it first.
    const pending = draft.trim().toLowerCase();
    const list = pending && EMAIL.test(pending) && !already.has(pending) ? [...emails, pending] : emails;
    if (!list.length) {
      setError(t("documents.forward.needOne"));
      return;
    }
    if (!doc) return;
    forward.mutate(
      { docId: doc.objectId, recipients: list },
      {
        onSuccess: (res) => {
          // `forwarddoc` mails one message per address and only throws when it
          // reached nobody, so a "success" can still have addresses it missed.
          if (res.failed.length) {
            toast.error(
              t("documents.toast.forwardedPartial", { sent: res.sent.length, total: list.length }),
              t("documents.toast.forwardedPartialBody", {
                emails: res.failed.map((f) => f.email).join(", ")
              })
            );
          } else {
            toast.success(
              t("documents.toast.forwarded", { count: res.sent.length || list.length }),
              t("documents.toast.forwardedBody", { name: doc.name })
            );
          }
          onClose();
        },
        onError: (e: Error) => toast.error(t("documents.toast.forwardFailed"), e.message)
      }
    );
  };

  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      title={t("documents.actions.forwardCopy")}
      description={doc ? t("documents.forward.description", { name: doc.name }) : undefined}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button variant="primary" loading={forward.isPending} onClick={send}>
            {t("documents.forward.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-ink-2">{t("documents.forward.recipientsLabel")}</span>
        <div
          onClick={() => inputRef.current?.focus()}
          className={cn(
            "min-h-9 w-full bg-surface border border-line rounded-md px-2 py-1.5 flex flex-wrap items-center gap-1.5",
            "focus-within:border-accent focus-within:shadow-[var(--shadow-focus)]",
            error && "border-danger"
          )}
        >
          {emails.map((e) => (
            <span key={e} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-accent-soft text-accent text-[12px]">
              {e}
              <button
                type="button"
                aria-label={t("documents.a11y.removeEmail", { email: e })}
                className="p-0.5 hover:text-ink"
                onClick={() => setEmails((list) => list.filter((x) => x !== e))}
              >
                <X className="size-3" strokeWidth={1.6} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setError(null);
              const v = e.target.value;
              if (/[,;\s]$/.test(v)) add(v);
              else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              } else if (e.key === "Backspace" && !draft) {
                setEmails((list) => list.slice(0, -1));
              }
            }}
            placeholder={emails.length ? "" : t("documents.forward.emailPlaceholder")}
            className="flex-1 min-w-40 h-6 bg-transparent text-[13px] text-ink placeholder:text-muted-2 focus:outline-none"
          />
        </div>
        {error ? (
          <span className="text-[12px] text-danger">{error}</span>
        ) : (
          <span className="text-[11px] text-muted-2">
            {t("documents.forward.hint", { count: MAX_FORWARD_RECIPIENTS })}
          </span>
        )}
      </div>

      {draft.trim().length >= 2 ? (
        <div className="mt-2 border border-line rounded-md bg-surface overflow-hidden">
          {suggestions.isLoading ? (
            <p className="px-3 py-2 text-[12px] text-muted-2 flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" /> {t("documents.forward.searching")}
            </p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-muted-2">{t("documents.forward.noMatches")}</p>
          ) : (
            matches.map((s) => (
              <button
                key={s.objectId}
                type="button"
                onClick={() => add(s.email)}
                className="w-full text-left px-3 h-9 flex items-center gap-2 text-[13px] hover:bg-line-soft"
              >
                <span className="truncate">{s.name || s.email}</span>
                {s.name ? <span className="text-[11px] text-muted-2 truncate">{s.email}</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
