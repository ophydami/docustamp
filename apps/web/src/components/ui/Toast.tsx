import { create } from "zustand";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export type ToastTone = "default" | "success" | "error";
export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => {
    const id = seq++;
    set((s) => ({ items: [...s.items, { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), 5000);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
}));

/** Imperative helper: toast.success("Sent"), toast.error("Failed", err.message). */
export const toast = {
  show: (title: string, body?: string) => useToasts.getState().push({ title, body, tone: "default" }),
  success: (title: string, body?: string) => useToasts.getState().push({ title, body, tone: "success" }),
  error: (title: string, body?: string) => useToasts.getState().push({ title, body, tone: "error" })
};

export function Toaster() {
  const { t } = useTranslation();
  const { items, dismiss } = useToasts();
  if (!items.length) return null;
  return (
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 w-80">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "bg-ink text-ground rounded-lg px-3.5 py-3 shadow-[var(--shadow-pop)] flex gap-3 items-start",
            item.tone === "error" && "bg-danger",
            item.tone === "success" && "bg-accent"
          )}
        >
          <div className="flex-1 flex flex-col gap-0.5">
            <span className="text-[13px] font-semibold">{item.title}</span>
            {item.body ? <span className="text-[12px] opacity-80">{item.body}</span> : null}
          </div>
          <button type="button" onClick={() => dismiss(item.id)} aria-label={t("common.actions.dismiss")} className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
