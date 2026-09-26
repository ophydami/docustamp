import { ArrowLeft, ChevronDown, Eye, Loader2, Redo2, Sparkles, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Menu } from "@/components/ui";
import { cn } from "@/lib/cn";
import { ZOOM_PRESETS, zoomLabel } from "../constants";

export type SaveStatus = "saved" | "saving" | "dirty" | "error";

export interface TopBarProps {
  name: string;
  isTemplate: boolean;
  status: SaveStatus;
  onBack: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number | null;
  onZoom: (z: number | null) => void;
  snap: boolean;
  onSnap: (v: boolean) => void;
  onAutoDetect: () => void;
  detecting: boolean;
  unassigned: number;
  preview: boolean;
  onPreview: (v: boolean) => void;
  onPrimary: () => void;
  primaryLabel: string;
  primaryBusy: boolean;
  disabled: boolean;
}

const STATUS_KEYS: Record<SaveStatus, string> = {
  saved: "editor.topBar.status.saved",
  saving: "editor.topBar.status.saving",
  dirty: "editor.topBar.status.dirty",
  error: "editor.topBar.status.error"
};

function IconButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="size-8 inline-flex items-center justify-center rounded-md text-ink-2 hover:bg-line-soft disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export function TopBar(props: TopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="h-14 shrink-0 bg-surface border-b border-line flex items-center gap-2 px-3">
      <IconButton label={t("common.actions.back")} onClick={props.onBack}>
        <ArrowLeft className="size-4" strokeWidth={1.6} />
      </IconButton>

      <div className="min-w-0 flex items-baseline gap-1.5 mr-1">
        <span className="font-serif text-[17px] truncate max-w-[280px]">{props.name}</span>
        {props.isTemplate ? <span className="text-[12px] text-muted-2">· {t("editor.topBar.template")}</span> : null}
      </div>

      <span
        className={cn(
          "text-[12px] shrink-0 flex items-center gap-1.5",
          props.status === "error" ? "text-danger" : props.status === "dirty" ? "text-warn-ink" : "text-muted-2"
        )}
      >
        {props.status === "saving" ? <Loader2 className="size-3 animate-spin" /> : null}
        {t(STATUS_KEYS[props.status])}
      </span>

      <div className="flex items-center gap-0.5 ml-2">
        <IconButton label={t("editor.topBar.undo")} onClick={props.onUndo} disabled={!props.canUndo || props.disabled}>
          <Undo2 className="size-4" strokeWidth={1.6} />
        </IconButton>
        <IconButton label={t("editor.topBar.redo")} onClick={props.onRedo} disabled={!props.canRedo || props.disabled}>
          <Redo2 className="size-4" strokeWidth={1.6} />
        </IconButton>
      </div>

      <span className="w-px h-6 bg-line mx-1" />

      <Menu
        align="left"
        trigger={(triggerProps) => (
          <Button size="sm" iconRight={<ChevronDown className="size-3.5" strokeWidth={1.6} />} {...triggerProps}>
            {zoomLabel(t, props.zoom)}
          </Button>
        )}
        items={ZOOM_PRESETS.map((z) => ({ label: zoomLabel(t, z), onSelect: () => props.onZoom(z) }))}
      />

      <Button size="sm" onClick={() => props.onSnap(!props.snap)} aria-pressed={props.snap}>
        {props.snap ? t("editor.topBar.snapOn") : t("editor.topBar.snapOff")}
      </Button>

      <Button
        size="sm"
        loading={props.detecting}
        disabled={props.disabled || props.preview}
        icon={props.detecting ? undefined : <Sparkles className="size-3.5" strokeWidth={1.6} />}
        onClick={props.onAutoDetect}
        title={t("editor.topBar.autoDetectTitle")}
      >
        {t("editor.topBar.autoDetect")}
      </Button>

      <div className="flex-1" />

      {props.unassigned > 0 ? (
        <span className="text-[12px] text-danger font-medium">
          {t("editor.topBar.unassigned", { count: props.unassigned })}
        </span>
      ) : null}

      <Button
        size="sm"
        onClick={() => props.onPreview(!props.preview)}
        aria-pressed={props.preview}
        icon={<Eye className="size-3.5" strokeWidth={1.6} />}
        className={cn(props.preview && "border-accent text-accent bg-accent-soft")}
      >
        {t("editor.topBar.previewAsSigner")}
      </Button>

      <Button variant="dark" size="sm" onClick={props.onPrimary} loading={props.primaryBusy} disabled={props.disabled}>
        {props.primaryLabel}
      </Button>
    </header>
  );
}
