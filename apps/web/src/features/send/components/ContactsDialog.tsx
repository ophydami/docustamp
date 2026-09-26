import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import { Avatar, Button, Checkbox, Dialog, EmptyState, Input } from "@/components/ui";
import { useContacts } from "../api";
import type { ContactRecord } from "../types";

export interface ContactsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Emails already on the request, so they can be shown as taken. */
  taken: string[];
  onAdd: (contacts: ContactRecord[]) => void;
}

export function ContactsDialog({ open, onClose, taken, onAdd }: ContactsDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Record<string, ContactRecord>>({});
  const { data, isLoading, error } = useContacts(open);

  const takenSet = useMemo(() => new Set(taken.map((t) => t.toLowerCase())), [taken]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data ?? [];
    if (!q) return all;
    return all.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  }, [data, query]);

  const pickedList = Object.values(picked);

  function close() {
    setPicked({});
    setQuery("");
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("send.contacts.title")}
      description={t("send.contacts.description")}
      width={520}
      footer={
        <>
          <Button onClick={close}>{t("common.actions.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!pickedList.length}
            onClick={() => {
              onAdd(pickedList);
              close();
            }}
          >
            {pickedList.length
              ? t("send.contacts.addCount", { count: pickedList.length })
              : t("common.actions.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("send.contacts.searchPlaceholder")}
          left={<Search className="size-3.5" strokeWidth={1.6} />}
        />
        <div className="max-h-[320px] overflow-y-auto scroll-thin -mx-1 px-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-2">
              <Loader2 className="size-4 animate-spin" strokeWidth={1.6} />
            </div>
          ) : error ? (
            <p className="text-[12px] text-danger py-6 text-center">
              {t("send.contacts.loadError")} {(error as Error).message}
            </p>
          ) : rows.length === 0 ? (
            <EmptyState
              title={t("send.contacts.emptyTitle")}
              body={query ? t("send.contacts.emptySearch") : t("send.contacts.emptyBody")}
              className="py-10"
            />
          ) : (
            <ul className="flex flex-col">
              {rows.map((c) => {
                const isTaken = takenSet.has(c.email.toLowerCase());
                const checked = !!picked[c.objectId];
                return (
                  <li key={c.objectId}>
                    <button
                      type="button"
                      disabled={isTaken}
                      onClick={() =>
                        setPicked((prev) => {
                          const next = { ...prev };
                          if (next[c.objectId]) delete next[c.objectId];
                          else next[c.objectId] = c;
                          return next;
                        })
                      }
                      className="w-full flex items-center gap-3 h-[46px] px-2 rounded-md text-left hover:bg-line-soft disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <Checkbox checked={isTaken ? true : checked} disabled={isTaken} />
                      <Avatar name={c.name} email={c.email} size={26} tone={isTaken ? "neutral" : "accent"} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium truncate">{c.name || c.email}</span>
                        <span className="block text-[11px] text-muted-2 truncate">{c.email}</span>
                      </span>
                      {isTaken ? (
                        <span className="text-[11px] text-muted-2">{t("send.contacts.added")}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
