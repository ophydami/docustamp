import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, Loader2, Plus, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { Button, Card, Cap, Field, Input, Pill, Textarea, toast } from "@/components/ui";
import { PdfViewer, type PdfPageInfo } from "@/components/pdf/PdfViewer";
import { cn } from "@/lib/cn";
import { useExtUser } from "@/lib/extUser";
import { ACCEPTED_EXTENSIONS, MAX_FILE_MB, formatBytes, prepareFile, type UploadStage } from "@/features/send/upload";
import { PasswordDialog, type PasswordRequest } from "@/features/send/components/PasswordDialog";
import type { UploadedFile } from "@/features/send/types";
import { isEmail } from "@/features/send/types";
import { analyzeDocument, prepareDocument, useAiStatus, type AiProposal, type AiRecipientInput } from "./api";

/**
 * "Ask Sign": drop a document, say what you want, let the model work out who signs
 * and where, review, then send or open the editor. One screen, three phases:
 * pick → review → done.
 */

type Phase = "pick" | "analyzing" | "review" | "submitting";

interface RoleDraft {
  role: string;
  name: string;
  email: string;
  isSender: boolean;
  color: string;
  fieldCount: number;
}

const PREVIEW_WIDTH = 420;

export default function AiPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useAiStatus();
  const { data: extUser } = useExtUser();

  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [stage, setStage] = useState<UploadStage>({ kind: "idle" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [knownRecipients, setKnownRecipients] = useState<AiRecipientInput[]>([]);
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [title, setTitle] = useState("");
  const [pages, setPages] = useState<PdfPageInfo[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Password prompt for encrypted PDFs, same dialog the send flow uses.
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const passwordAttempt = useRef(0);
  const askPassword = useCallback(
    (fileName: string, retry: boolean) =>
      new Promise<string | null>((resolve) => {
        passwordAttempt.current += 1;
        setPasswordRequest({
          id: passwordAttempt.current,
          fileName,
          retry,
          resolve: (value) => {
            setPasswordRequest(null);
            resolve(value);
          }
        });
      }),
    []
  );

  const busy = stage.kind !== "idle" && stage.kind !== "done";
  const aiOff = status.data?.enabled === false;

  async function onPickFile(picked: File) {
    setUploadError(null);
    try {
      const prepared = await prepareFile(picked, { onStage: setStage, askPassword });
      if (!prepared) {
        setStage({ kind: "idle" });
        return;
      }
      setFile(prepared);
      setProposal(null);
      setRoles([]);
      setPhase("pick");
    } catch (err) {
      setStage({ kind: "idle" });
      setUploadError((err as Error).message);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const picked = e.dataTransfer.files?.[0];
    if (picked) void onPickFile(picked);
  }

  async function runAnalysis() {
    if (!file) return;
    setPhase("analyzing");
    try {
      const recipients = knownRecipients.filter((r) => isEmail(r.email));
      const result = await analyzeDocument({ url: file.url, instructions, recipients });
      setProposal(result);
      setTitle(result.title || file.title);
      setRoles(
        result.roles.map((r, i) => {
          const given = recipients[i];
          const selfEmail = (extUser?.Email as string | undefined) ?? "";
          return {
            role: r.role,
            name: given?.name || r.name || (r.isSender ? (extUser?.Name as string | undefined) ?? "" : ""),
            email: given?.email || r.email || (r.isSender ? selfEmail : ""),
            isSender: r.isSender,
            color: r.color,
            fieldCount: r.fieldCount
          };
        })
      );
      setPhase("review");
    } catch (err) {
      setPhase("pick");
      toast.error(t("ai.toast.analysisFailed"), (err as Error).message);
    }
  }

  const missing = roles.filter((r) => !isEmail(r.email));

  async function submit(send: boolean) {
    if (!file || !proposal) return;
    if (missing.length) {
      toast.error(t("ai.toast.missingEmails", { count: missing.length }));
      return;
    }
    setPhase("submitting");
    try {
      const result = await prepareDocument({
        url: file.url,
        proposal,
        recipients: roles.map((r) => ({ name: r.name.trim(), email: r.email.trim().toLowerCase(), role: r.role })),
        name: title.trim() || proposal.title,
        send
      });
      if (!result.document) {
        setPhase("review");
        toast.error(t("ai.toast.missingEmails", { count: result.needsRecipients.length }));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
      if (send) {
        const failed = result.document.mail?.failed?.length ?? 0;
        if (failed) toast.error(t("ai.toast.sentWithFailures", { count: failed }));
        else toast.success(t("ai.toast.sent", { count: result.document.mail?.sent?.length ?? 0 }));
        navigate(`/documents/${result.document.objectId}`);
      } else {
        toast.success(t("ai.toast.draftCreated"));
        navigate(`/editor/${result.document.objectId}`);
      }
    } catch (err) {
      setPhase("review");
      toast.error(t(send ? "ai.toast.sendFailed" : "ai.toast.draftFailed"), (err as Error).message);
    }
  }

  function reset() {
    setFile(null);
    setProposal(null);
    setRoles([]);
    setStage({ kind: "idle" });
    setPhase("pick");
    setPages([]);
  }

  const fieldsByPage = useMemo(() => {
    const map = new Map<number, AiProposal["fields"]>();
    for (const f of proposal?.fields ?? []) {
      const list = map.get(f.page) ?? [];
      list.push(f);
      map.set(f.page, list);
    }
    return map;
  }, [proposal]);

  const roleColor = (idx: number) => (idx >= 0 ? roles[idx]?.color ?? "#93a3db" : "#8a857b");

  // pdf.js transfers the buffer it is handed, so the viewer gets its own stable copy per file.
  const previewBytes = useMemo(() => file?.data.slice() ?? null, [file]);

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col overflow-auto scroll-thin px-4 py-4 lg:px-6 lg:py-5 gap-4 [&>*]:shrink-0">
        <header className="flex flex-col gap-1">
          <p className="text-[13px] text-muted max-w-2xl">{t("ai.subtitle")}</p>
          {status.data ? (
            <p className="text-[11px] text-muted-2 font-mono">
              {t("ai.poweredBy", { model: status.data.model, provider: status.data.provider === "bedrock" ? "Amazon Bedrock" : "Anthropic" })}
            </p>
          ) : null}
        </header>

        {aiOff ? (
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-4 text-warn-ink mt-0.5" strokeWidth={1.6} />
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold">{t("ai.disabled.title")}</span>
                <span className="text-[12px] text-muted">{t("ai.disabled.body")}</span>
              </div>
            </div>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] items-start">
          {/* Left: input and review */}
          <div className="flex flex-col gap-4 min-w-0">
            {/* Step 1: the file */}
            <Card className="p-4 flex flex-col gap-3">
              <Cap>{t("ai.steps.document")}</Cap>
              {!file ? (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={t("ai.drop.aria")}
                  onClick={() => !busy && inputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (!busy) inputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center cursor-pointer transition-colors",
                    dragging ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong bg-surface-2",
                    busy && "opacity-60 cursor-default"
                  )}
                >
                  {busy ? (
                    <Loader2 className="size-5 animate-spin text-muted" />
                  ) : (
                    <UploadCloud className="size-5 text-muted" strokeWidth={1.6} />
                  )}
                  <span className="text-[13px] font-semibold">
                    {busy ? stageText(stage, t) : t("ai.drop.title")}
                  </span>
                  <span className="text-[12px] text-muted">{t("ai.drop.hint", { size: MAX_FILE_MB })}</span>
                  <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPTED_EXTENSIONS.join(",")}
                    className="hidden"
                    onChange={(e) => {
                      const picked = e.target.files?.[0];
                      e.target.value = "";
                      if (picked) void onPickFile(picked);
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
                  <FileText className="size-4 text-muted" strokeWidth={1.6} />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] font-semibold truncate">{file.fileName}</span>
                    <span className="text-[11px] text-muted-2">
                      {t("common.count.page", { count: file.pageCount })}, {formatBytes(file.bytes)}
                      {file.converted ? `, ${t("ai.file.converted")}` : ""}
                    </span>
                  </div>
                  <Button size="xs" variant="ghost" onClick={reset} disabled={phase === "analyzing" || phase === "submitting"}>
                    {t("ai.file.replace")}
                  </Button>
                </div>
              )}
              {uploadError ? <p className="text-[12px] text-danger">{uploadError}</p> : null}
            </Card>

            {/* Step 2: what you want */}
            {phase === "pick" || phase === "analyzing" ? (
              <Card className="p-4 flex flex-col gap-3">
                <Cap>{t("ai.steps.instructions")}</Cap>
                <Field label={t("ai.instructions.label")} hint={t("ai.instructions.hint")}>
                  <Textarea
                    rows={3}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder={t("ai.instructions.placeholder")}
                    disabled={phase === "analyzing"}
                  />
                </Field>
                <div className="flex flex-col gap-2">
                  <span className="flex items-center justify-between text-[12px] font-semibold text-ink-2">
                    <span>{t("ai.known.label")}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<Plus className="size-3.5" strokeWidth={1.6} />}
                      onClick={() => setKnownRecipients((l) => [...l, { name: "", email: "" }])}
                      disabled={phase === "analyzing"}
                    >
                      {t("ai.known.add")}
                    </Button>
                  </span>
                  {knownRecipients.length === 0 ? (
                    <p className="text-[11px] text-muted-2">{t("ai.known.empty")}</p>
                  ) : (
                    knownRecipients.map((r, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1.4fr_28px] gap-2 items-center">
                        <Input
                          placeholder={t("ai.known.name")}
                          value={r.name}
                          onChange={(e) => setKnownRecipients((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        />
                        <Input
                          type="email"
                          placeholder={t("ai.known.email")}
                          value={r.email}
                          onChange={(e) => setKnownRecipients((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={t("common.actions.remove")}
                          onClick={() => setKnownRecipients((l) => l.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="size-3.5" strokeWidth={1.6} />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    variant="primary"
                    icon={<Sparkles className="size-4" strokeWidth={1.6} />}
                    loading={phase === "analyzing"}
                    disabled={!file || busy || aiOff}
                    onClick={() => void runAnalysis()}
                  >
                    {phase === "analyzing" ? t("ai.actions.analyzing") : t("ai.actions.analyze")}
                  </Button>
                  {phase === "analyzing" ? <span className="text-[12px] text-muted">{t("ai.actions.analyzingHint")}</span> : null}
                </div>
              </Card>
            ) : null}

            {/* Step 3: review */}
            {proposal && (phase === "review" || phase === "submitting") ? (
              <>
                <Card className="p-4 flex flex-col gap-3">
                  <Cap>{t("ai.steps.review")}</Cap>
                  <Field label={t("ai.review.title")}>
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={250} />
                  </Field>
                  <p className="text-[13px] text-ink-2 leading-relaxed">{proposal.summary}</p>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {proposal.documentType ? <Pill tone="neutral">{proposal.documentType}</Pill> : null}
                    <Pill tone="neutral">{t("common.count.page", { count: proposal.pageCount })}</Pill>
                    <Pill tone="neutral">{t("common.count.field", { count: proposal.fields.length })}</Pill>
                    {proposal.signingOrderMatters ? <Pill tone="warn">{t("ai.review.inOrder")}</Pill> : null}
                  </div>
                  {proposal.warnings.length ? (
                    <ul className="flex flex-col gap-1 rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn-ink">
                      {proposal.warnings.map((w, i) => (
                        <li key={i} className="flex gap-2">
                          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" strokeWidth={1.6} />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>

                <Card className="p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <Cap>{t("ai.review.signers")}</Cap>
                    <span className="text-[11px] text-muted-2">{t("ai.review.signersHint")}</span>
                  </div>
                  {roles.map((r, i) => (
                    <div key={i} className="grid grid-cols-[14px_1fr] gap-3 items-start">
                      <span className="mt-2.5 size-3 rounded-full border border-line" style={{ background: r.color }} aria-hidden />
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-[12px]">
                          <span className="font-semibold">{r.role}</span>
                          {r.isSender ? <Pill tone="accent">{t("ai.review.you")}</Pill> : null}
                          <span className="text-muted-2">{t("common.count.field", { count: r.fieldCount })}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Input
                            placeholder={t("ai.known.name")}
                            value={r.name}
                            onChange={(e) => setRoles((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                          />
                          <Input
                            type="email"
                            placeholder={t("ai.known.email")}
                            value={r.email}
                            aria-invalid={!isEmail(r.email)}
                            className={cn(!isEmail(r.email) && "border-danger-line")}
                            onChange={(e) => setRoles((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  {missing.length ? (
                    <p className="text-[12px] text-danger">{t("ai.review.missing", { count: missing.length })}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      variant="primary"
                      loading={phase === "submitting"}
                      disabled={missing.length > 0 || phase === "submitting"}
                      onClick={() => void submit(true)}
                    >
                      {t("ai.actions.sendNow")}
                    </Button>
                    <Button disabled={missing.length > 0 || phase === "submitting"} onClick={() => void submit(false)}>
                      {t("ai.actions.openEditor")}
                    </Button>
                    <Button variant="ghost" disabled={phase === "submitting"} onClick={() => setPhase("pick")}>
                      {t("ai.actions.adjust")}
                    </Button>
                  </div>
                </Card>
              </>
            ) : null}
          </div>

          {/* Right: preview */}
          <Card className="p-3 flex flex-col gap-2 min-w-0 lg:sticky lg:top-4">
            <div className="flex items-center justify-between">
              <Cap>{t("ai.preview.title")}</Cap>
              {proposal ? <span className="text-[11px] text-muted-2">{t("ai.preview.legend")}</span> : null}
            </div>
            {file && previewBytes ? (
              <div className="max-h-[72vh] overflow-auto scroll-thin rounded-md bg-surface-2 p-2">
                <PdfViewer
                  src={previewBytes}
                  pageWidth={PREVIEW_WIDTH}
                  gap={12}
                  onLoad={setPages}
                  renderOverlay={(page, scale) => {
                    const fields = fieldsByPage.get(page.number) ?? [];
                    if (!fields.length) return null;
                    return (
                      <>
                        {fields.map((f, i) => (
                          <div
                            key={i}
                            title={`${f.role}: ${f.label || f.type}`}
                            className="absolute rounded-[3px] border text-[9px] leading-none overflow-hidden"
                            style={{
                              left: f.x * scale,
                              top: f.y * scale,
                              width: f.width * scale,
                              height: f.height * scale,
                              background: `${roleColor(f.roleIndex)}66`,
                              borderColor: roleColor(f.roleIndex)
                            }}
                          >
                            <span className="absolute left-0.5 top-0.5 px-1 rounded-sm bg-surface/80 text-ink-2 font-medium">
                              {f.type}
                            </span>
                          </div>
                        ))}
                      </>
                    );
                  }}
                />
                {pages.length === 0 ? (
                  <div className="flex items-center justify-center py-10 text-muted-2">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-md bg-surface-2 py-16 text-[12px] text-muted-2">
                {t("ai.preview.empty")}
              </div>
            )}
          </Card>
        </div>
      </div>

      <PasswordDialog request={passwordRequest} />
    </div>
  );
}

function stageText(stage: UploadStage, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (stage.kind) {
    case "reading":
      return t("send.documents.stage.reading");
    case "converting":
      return t("send.documents.stage.converting");
    case "decrypting":
      return t("send.documents.stage.decrypting");
    case "uploading":
      return t("send.documents.stage.uploading", { percent: stage.percent });
    default:
      return "";
  }
}
