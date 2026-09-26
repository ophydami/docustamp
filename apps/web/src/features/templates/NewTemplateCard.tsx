import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

export const ACCEPT = ".pdf,.docx,application/pdf";

/** Dashed drop zone that sits last in the grid and opens the file picker on click. */
export function NewTemplateCard({
  busy,
  onPick,
  onFile
}: {
  busy: boolean;
  onPick: () => void;
  onFile: (f: File) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "min-h-[268px] rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 px-5 text-center transition-colors",
        over ? "border-accent bg-accent-tint" : "border-line-strong bg-surface-2 hover:border-muted-2",
        busy && "opacity-60 cursor-wait"
      )}
    >
      <span className="size-8 rounded-full bg-paper flex items-center justify-center text-ink-2">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" strokeWidth={1.6} />}
      </span>
      <span className="text-[13px] font-semibold">{busy ? t("templates.new.preparing") : t("templates.actions.new")}</span>
      <span className="text-[11px] text-muted-2 leading-relaxed max-w-[190px]">
        {t("templates.new.hint")}
      </span>
    </button>
  );
}
