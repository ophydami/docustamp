import { useCallback, useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";
import { useTranslation } from "react-i18next";
import { Eraser, Upload } from "lucide-react";
import { Button, Dialog, Field, Input, Tabs, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { ensureScriptFont, fileToDataUrl, trimDataUrl, typedSignatureDataUrl } from "../imageUtils";

type Mode = "draw" | "type" | "upload";

const INKS = [
  { value: "#1c1b18", labelKey: "settings.signatureDialog.ink.ink" },
  { value: "#1d4ed8", labelKey: "settings.signatureDialog.ink.blue" }
];

export interface SignatureDialogProps {
  open: boolean;
  onClose: () => void;
  /** "signature" uses a wide pad, "initials" a square one. */
  target: "signature" | "initials";
  /** Prefills the Type tab. */
  suggestedText: string;
  /** Receives a trimmed PNG data URL. Should throw to keep the dialog open. */
  onCommit: (dataUrl: string) => Promise<void>;
}

export function SignatureDialog({ open, onClose, target, suggestedText, onCommit }: SignatureDialogProps) {
  const { t } = useTranslation();
  const wide = target === "signature";
  const [mode, setMode] = useState<Mode>("draw");
  const [color, setColor] = useState(INKS[0].value);
  const [empty, setEmpty] = useState(true);
  const [typed, setTyped] = useState(suggestedText);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const padRef = useRef<SignaturePad | null>(null);
  const colorRef = useRef(color);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    colorRef.current = color;
    if (padRef.current) padRef.current.penColor = color;
  }, [color]);

  useEffect(() => {
    if (open) void ensureScriptFont();
  }, [open]);

  const setCanvas = useCallback((node: HTMLCanvasElement | null) => {
    padRef.current?.off();
    padRef.current = null;
    if (!node) return;
    const ratio = Math.max(2, window.devicePixelRatio || 1);
    node.width = node.offsetWidth * ratio;
    node.height = node.offsetHeight * ratio;
    node.getContext("2d")?.scale(ratio, ratio);
    const pad = new SignaturePad(node, {
      penColor: colorRef.current,
      backgroundColor: "rgba(0,0,0,0)",
      minWidth: 0.8,
      maxWidth: 2.4
    });
    pad.addEventListener("endStroke", () => setEmpty(pad.isEmpty()));
    padRef.current = pad;
    setEmpty(true);
  }, []);

  const clear = () => {
    padRef.current?.clear();
    setEmpty(true);
  };

  const canSave =
    (mode === "draw" && !empty) || (mode === "type" && typed.trim().length > 0) || (mode === "upload" && !!uploaded);

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg)$/.test(file.type)) {
      toast.error(
        t("settings.signatureDialog.errors.unsupportedImage"),
        t("settings.signatureDialog.errors.unsupportedImageBody")
      );
      return;
    }
    try {
      const raw = await fileToDataUrl(file);
      setUploaded(await trimDataUrl(raw));
    } catch (err) {
      toast.error(t("settings.signatureDialog.errors.couldNotRead"), err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      let dataUrl: string;
      if (mode === "draw") {
        const pad = padRef.current;
        if (!pad || pad.isEmpty()) throw new Error(t("settings.signatureDialog.errors.drawFirst"));
        dataUrl = await trimDataUrl(pad.toDataURL("image/png"));
      } else if (mode === "type") {
        dataUrl = await trimDataUrl(await typedSignatureDataUrl(typed.trim(), color, wide ? 520 : 220));
      } else {
        if (!uploaded) throw new Error(t("settings.signatureDialog.errors.chooseFirst"));
        dataUrl = uploaded;
      }
      await onCommit(dataUrl);
      onClose();
    } catch (err) {
      toast.error(t("settings.signatureDialog.errors.saveFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={wide ? 600 : 520}
      title={wide ? t("settings.signatureDialog.titleSignature") : t("settings.signatureDialog.titleInitials")}
      description={t("settings.signatureDialog.description")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void submit()}>
            {wide ? t("settings.signatureDialog.saveSignature") : t("settings.signatureDialog.saveInitials")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Tabs<Mode>
          value={mode}
          onChange={setMode}
          items={[
            { value: "draw", label: t("settings.signatureDialog.tabs.draw") },
            { value: "type", label: t("settings.signatureDialog.tabs.type") },
            { value: "upload", label: t("settings.signatureDialog.tabs.upload") }
          ]}
        />

        {mode === "draw" ? (
          <div className="flex flex-col gap-2.5">
            <div className="theme-light bg-paper rounded-lg p-3 flex justify-center">
              <canvas
                ref={setCanvas}
                className="bg-surface border border-line rounded-md touch-none cursor-crosshair"
                style={{ width: wide ? 468 : 200, height: 170 }}
              />
            </div>
            <div className="flex items-center gap-2">
              <InkPicker color={color} onChange={setColor} />
              <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser className="size-3.5" strokeWidth={1.6} />} onClick={clear}>
                {t("common.actions.clear")}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === "type" ? (
          <div className="flex flex-col gap-3">
            <Field label={wide ? t("settings.signatureDialog.fields.name") : t("settings.signatureDialog.fields.initials")}>
              <Input
                value={typed}
                maxLength={wide ? 30 : 4}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={wide ? "Ana Silva" : "AS"}
                autoFocus
              />
            </Field>
            <div className="theme-light bg-paper rounded-lg p-3 flex items-center justify-center min-h-[110px]">
              <span
                className="leading-none text-center break-all"
                style={{ fontFamily: '"Caveat", "Segoe Script", cursive', fontSize: 56, fontWeight: 600, color }}
              >
                {typed.trim() || (wide ? "Ana Silva" : "AS")}
              </span>
            </div>
            <InkPicker color={color} onChange={setColor} />
          </div>
        ) : null}

        {mode === "upload" ? (
          <div className="flex flex-col gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
            />
            <div className="theme-light bg-paper rounded-lg p-3 flex items-center justify-center min-h-[140px]">
              {uploaded ? (
                <img src={uploaded} alt="" className="max-h-[120px] max-w-full object-contain" />
              ) : (
                <span className="text-[12px] text-muted-2">{t("settings.signatureDialog.uploadHint")}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<Upload className="size-3.5" strokeWidth={1.6} />} onClick={() => fileRef.current?.click()}>
                {t("settings.signatureDialog.chooseImage")}
              </Button>
              {uploaded ? (
                <Button size="sm" variant="ghost" onClick={() => setUploaded(null)}>
                  {t("common.actions.remove")}
                </Button>
              ) : null}
              <span className="text-[11px] text-muted-2 ml-auto">{t("settings.signatureDialog.trimNote")}</span>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function InkPicker({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-2 mr-1">{t("settings.signatureDialog.ink.label")}</span>
      {INKS.map((ink) => (
        <button
          key={ink.value}
          type="button"
          aria-label={t(ink.labelKey)}
          aria-pressed={color === ink.value}
          onClick={() => onChange(ink.value)}
          className={cn(
            "size-5 rounded-full border-2 transition-colors",
            color === ink.value ? "border-accent" : "border-line-strong hover:border-muted-2"
          )}
          style={{ background: ink.value }}
        />
      ))}
    </div>
  );
}
