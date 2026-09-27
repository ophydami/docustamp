import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SignaturePad from "signature_pad";
import { Loader2, PenLine, Type, Upload, UserCheck } from "lucide-react";
import { Button, Cap, Checkbox, Field, Input, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  CURSIVE_FONT,
  ensureCursiveFont,
  fileToDataUrl,
  initialsFrom,
  trimTransparent,
  typedSignatureToPng,
  urlToDataUrl,
  whiteToTransparent
} from "../signatureImage";
import type { AdoptedSignature, SavedSignature } from "../types";

type Method = "draw" | "type" | "upload" | "default";

/** Translation leaf per input method: `default` reads as "Saved" to the signer. */
const METHOD_KEYS: Record<Method, string> = { draw: "draw", type: "type", upload: "upload", default: "saved" };

const PEN_COLORS: Record<string, string> = { black: "#1c1b18", blue: "#22449c", red: "#b5412e" };

interface Props {
  open: boolean;
  onClose: () => void;
  /** Which field opened the dialog, so the heading can say "initials". */
  target: "signature" | "initials" | "stamp";
  defaultName: string;
  /** Signature methods the sender allows: draw, typed, upload, default. */
  allowed: string[];
  penColors: string[];
  saved?: SavedSignature | null;
  onOpenDisclosure: () => void;
  onAdopt: (s: AdoptedSignature) => void;
}

/**
 * The adopt-signature sheet. First time a signature field is tapped this is the
 * consent gate too: the e-sign checkbox lives here and "Adopt and sign" is the
 * moment the signer agrees.
 */
export function AdoptSignatureDialog({
  open,
  onClose,
  target,
  defaultName,
  allowed,
  penColors,
  saved,
  onOpenDisclosure,
  onAdopt
}: Props) {
  const { t } = useTranslation();
  const methods = useMemo(() => {
    const enabled = new Set(allowed.length ? allowed : ["draw", "typed", "upload", "default"]);
    const out: Method[] = [];
    if (enabled.has("draw")) out.push("draw");
    if (enabled.has("typed")) out.push("type");
    if (enabled.has("upload")) out.push("upload");
    if (enabled.has("default") && (saved?.imageUrl || saved?.initials)) out.push("default");
    return out.length ? out : (["draw", "type"] as Method[]);
  }, [allowed, saved]);

  const colors = useMemo(() => {
    const allowedColors = ["black", "blue", "red"];
    const picked = penColors.map((c) => c.toLowerCase()).filter((c) => allowedColors.includes(c));
    return picked.length ? Array.from(new Set(picked)) : allowedColors;
  }, [penColors]);

  // The parent remounts this dialog per field, so the initial state is the
  // reset: no effect needs to clear it.
  const [method, setMethod] = useState<Method>(() => methods[0]);
  const [fullName, setFullName] = useState(defaultName);
  const [initialsText, setInitialsText] = useState(() => initialsFrom(defaultName));
  const [pen, setPen] = useState(() => colors[0]);
  const [agreed, setAgreed] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [savedImage, setSavedImage] = useState<string | null>(null);
  const [typedPreview, setTypedPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawn, setDrawn] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) ensureCursiveFont();
  }, [open]);

  /* --- the drawing pad ------------------------------------------------ */

  const mountPad = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = Math.max(240, Math.round(rect?.width ?? 440));
      const h = Math.round(Math.min(180, Math.max(120, w * 0.38)));
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * 2;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = w * ratio;
      canvas.height = h * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      padRef.current?.off();
      const pad = new SignaturePad(canvas, {
        penColor: PEN_COLORS[pen] ?? PEN_COLORS.black,
        minWidth: 0.7,
        maxWidth: 2.4,
        backgroundColor: "rgba(0,0,0,0)"
      });
      pad.addEventListener("endStroke", () => setDrawn(!pad.isEmpty()));
      padRef.current = pad;
      setDrawn(false);
    },
    [pen]
  );

  useEffect(() => {
    if (!open || method !== "draw") return;
    const id = window.requestAnimationFrame(() => mountPad(canvasRef.current));
    return () => {
      window.cancelAnimationFrame(id);
      padRef.current?.off();
      padRef.current = null;
    };
  }, [open, method, mountPad]);

  useEffect(() => {
    if (padRef.current) padRef.current.penColor = PEN_COLORS[pen] ?? PEN_COLORS.black;
  }, [pen]);

  /* --- typed preview -------------------------------------------------- */

  useEffect(() => {
    if (!open || method !== "type") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      typedSignatureToPng(fullName || " ", PEN_COLORS[pen] ?? PEN_COLORS.black)
        .then((png) => {
          if (!cancelled) setTypedPreview(png);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, method, fullName, pen]);

  /* --- saved signature ------------------------------------------------ */

  useEffect(() => {
    if (!open || method !== "default") return;
    const url = target === "initials" ? (saved?.initials ?? saved?.imageUrl) : (saved?.imageUrl ?? saved?.initials);
    if (!url) return;
    let cancelled = false;
    urlToDataUrl(url)
      .then((d) => {
        if (!cancelled) setSavedImage(d);
      })
      .catch(() => {
        if (!cancelled) setSavedImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, method, saved, target]);

  /* --- upload --------------------------------------------------------- */

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("signer.toast.imageTooLarge.title"), t("signer.toast.imageTooLarge.body"));
      return;
    }
    setBusy(true);
    try {
      const raw = await fileToDataUrl(file);
      const clear = await whiteToTransparent(raw);
      setUploaded(await trimTransparent(clear, 6));
    } catch (e) {
      toast.error(t("signer.toast.imageUnreadable"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  /* --- adopt ---------------------------------------------------------- */

  const currentImage = (): string | null => {
    if (method === "draw") return padRef.current && !padRef.current.isEmpty() ? padRef.current.toDataURL("image/png") : null;
    if (method === "type") return typedPreview;
    if (method === "upload") return uploaded;
    return savedImage;
  };

  const hasMark =
    method === "draw" ? drawn : method === "type" ? !!typedPreview : method === "upload" ? !!uploaded : !!savedImage;
  const ready = agreed && hasMark;

  const adopt = async () => {
    const image = currentImage();
    if (!image || !agreed) return;
    setBusy(true);
    try {
      const signature = method === "draw" ? await trimTransparent(image, 6) : image;
      let initials: string | undefined;
      if (method === "default" && saved?.initials) {
        initials = await urlToDataUrl(saved.initials).catch(() => undefined);
      }
      if (!initials) {
        initials = await typedSignatureToPng(initialsText || initialsFrom(fullName), PEN_COLORS[pen] ?? PEN_COLORS.black);
      }
      onAdopt({
        signature,
        initials,
        fullName: fullName.trim() || defaultName,
        initialsText: initialsText.trim() || initialsFrom(fullName),
        method,
        typedFont: method === "type" ? CURSIVE_FONT : undefined
      });
    } catch (e) {
      toast.error(t("signer.toast.adoptFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const heading = target === "initials" ? t("signer.adopt.titleInitials") : t("signer.adopt.titleSignature");

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
    >
      <div className="w-full sm:w-[560px] max-h-[92vh] overflow-y-auto scroll-thin bg-surface rounded-t-xl sm:rounded-xl border border-line shadow-[var(--shadow-pop)]">
        <div className="px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
          <h2 className="font-semibold text-[20px] leading-tight text-ink tracking-[-.015em]">{heading}</h2>
          <p className="mt-1 text-[13px] text-muted">{t("signer.adopt.description")}</p>

          <div className="mt-4 grid grid-cols-[1fr_120px] gap-3">
            <Field label={t("signer.adopt.fields.fullName")}>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={60} />
            </Field>
            <Field label={t("signer.adopt.fields.initials")}>
              <Input
                value={initialsText}
                onChange={(e) => setInitialsText(e.target.value.toUpperCase())}
                maxLength={4}
                className="text-center"
              />
            </Field>
          </div>

          {/* method segment */}
          <div className="mt-4 inline-flex items-center gap-0.5 p-0.5 bg-sand border border-line rounded-md">
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={cn(
                  "h-8 px-3 rounded-[6px] text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors",
                  method === m ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"
                )}
              >
                {m === "draw" ? <PenLine className="size-3.5" strokeWidth={1.6} /> : null}
                {m === "type" ? <Type className="size-3.5" strokeWidth={1.6} /> : null}
                {m === "upload" ? <Upload className="size-3.5" strokeWidth={1.6} /> : null}
                {m === "default" ? <UserCheck className="size-3.5" strokeWidth={1.6} /> : null}
                {t(`signer.adopt.methods.${METHOD_KEYS[m]}`)}
              </button>
            ))}
            {colors.length > 1 && (method === "draw" || method === "type") ? (
              <span className="ml-2 mr-1 inline-flex items-center gap-1.5">
                {colors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={t("signer.adopt.penColor", { color: t(`signer.adopt.colors.${c}`) })}
                    onClick={() => setPen(c)}
                    className={cn(
                      "size-5 rounded-full border-2 transition-colors",
                      pen === c ? "border-ink" : "border-line-strong"
                    )}
                    style={{ backgroundColor: PEN_COLORS[c] }}
                  />
                ))}
              </span>
            ) : null}
          </div>

          {/* the pad */}
          <div className="theme-light mt-3 relative rounded-xl border border-line-strong bg-surface-2 overflow-hidden">
            {method === "draw" ? (
              <div className="p-2">
                <canvas ref={canvasRef} className="block touch-none rounded-md paper-white w-full" />
              </div>
            ) : null}

            {method === "type" ? (
              <div className="h-[150px] flex items-center justify-center px-4">
                {typedPreview ? (
                  <img src={typedPreview} alt={t("signer.adopt.preview.typed")} className="max-h-[110px] object-contain" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-muted-2" />
                )}
              </div>
            ) : null}

            {method === "upload" ? (
              <div className="h-[150px] flex flex-col items-center justify-center gap-2 px-4">
                {uploaded ? (
                  <img src={uploaded} alt={t("signer.adopt.preview.uploaded")} className="max-h-[104px] object-contain" />
                ) : (
                  <p className="text-[12px] text-muted-2">{t("signer.adopt.uploadHint")}</p>
                )}
                <Button
                  size="sm"
                  icon={<Upload className="size-3.5" strokeWidth={1.6} />}
                  onClick={() => fileRef.current?.click()}
                  loading={busy}
                >
                  {uploaded ? t("signer.adopt.chooseAnother") : t("signer.adopt.chooseImage")}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </div>
            ) : null}

            {method === "default" ? (
              <div className="h-[150px] flex items-center justify-center px-4">
                {savedImage ? (
                  <img src={savedImage} alt={t("signer.adopt.preview.saved")} className="max-h-[110px] object-contain" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-muted-2" />
                )}
              </div>
            ) : null}
          </div>

          <div className="mt-2 flex items-center justify-between min-h-7">
            <Cap className="text-muted-2">
              {method === "draw" ? t("signer.adopt.hint.draw") : null}
              {method === "type" ? t("signer.adopt.hint.type", { font: CURSIVE_FONT }) : null}
              {method === "upload" ? t("signer.adopt.hint.upload") : null}
              {method === "default" ? t("signer.adopt.hint.saved") : null}
            </Cap>
            {method === "draw" ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  padRef.current?.clear();
                  setDrawn(false);
                }}
              >
                {t("common.actions.clear")}
              </Button>
            ) : null}
          </div>

          <label className="mt-4 flex items-start gap-2.5 cursor-pointer">
            <span className="mt-0.5">
              <Checkbox checked={agreed} onChange={setAgreed} />
            </span>
            <span className="text-[12px] leading-relaxed text-ink-2">{t("signer.adopt.consent")}</span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-3.5 border-t border-line bg-surface-2 rounded-b-xl">
          <button
            type="button"
            onClick={onOpenDisclosure}
            className="text-[12px] text-muted hover:text-accent underline underline-offset-2 text-left"
          >
            {t("signer.disclosure.title")}
          </button>
          <div className="flex items-center gap-2 shrink-0">
            <Button onClick={onClose} className="min-h-11 sm:min-h-0">
              {t("common.actions.cancel")}
            </Button>
            <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void adopt()} className="min-h-11 sm:min-h-0">
              {t("signer.adopt.adoptAndSign")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
