import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { Button, Field, Input, LogoMark, Textarea, Toggle, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { isAdminRole, useExtUser } from "@/lib/extUser";
import { updateTenantBranding, uploadImage, useInvalidateTenant, useTenant, type TenantBranding } from "../api";
import { FormColumn, NotAvailableNote, SectionCard, SectionError, SectionLoading, ToggleRow } from "../parts";
import { useSectionForm } from "../sectionForm";

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const int = parseInt(m[1], 16);
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastOnWhite(hex: string): number {
  return Math.round(((1 + 0.05) / (luminance(hex) + 0.05)) * 100) / 100;
}

const ACCENT = "#0F6E56";
const LOGO_TYPES = ["image/png", "image/svg+xml", "image/jpeg"];
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_SENDER_NAME = 80;
const MAX_FOOTER = 500;

/** The branding half of partners_Tenant, as `updatetenant` accepts it. */
interface BrandingValues {
  TenantName: string;
  Logo: string;
  EmailSenderName: string;
  EmailFooter: string;
  HidePoweredBy: boolean;
  ReplyTo: string;
}

type PreviewTab = "email" | "signing" | "pdf";

export default function BrandingSection() {
  const { t } = useTranslation();
  const { data: extUser } = useExtUser();
  const { data: tenant, isPending, error, refetch } = useTenant();
  const invalidateTenant = useInvalidateTenant();
  const admin = isAdminRole(extUser?.UserRole);
  const [tab, setTab] = useState<PreviewTab>("email");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const initial: BrandingValues | null = tenant
    ? {
        TenantName: tenant.TenantName ?? "",
        Logo: tenant.Logo ?? "",
        EmailSenderName: tenant.EmailSenderName ?? "",
        EmailFooter: tenant.EmailFooter ?? "",
        HidePoweredBy: tenant.HidePoweredBy === true,
        ReplyTo: tenant.ReplyTo ?? ""
      }
    : null;

  const form = useSectionForm<BrandingValues>({
    initial,
    successTitle: t("settings.branding.toast.saved"),
    errorTitle: t("settings.branding.toast.saveFailed"),
    // Only the keys that actually changed are sent: `updatetenant` refuses an
    // empty TenantName, and a workspace that never had one would otherwise be
    // unable to save so much as a toggle.
    save: async (v) => {
      if (!tenant || !initial) return;
      const patch: TenantBranding = {};
      if (v.TenantName.trim() !== initial.TenantName) patch.TenantName = v.TenantName.trim();
      if (v.Logo !== initial.Logo) patch.Logo = v.Logo;
      if (v.EmailSenderName.trim() !== initial.EmailSenderName) patch.EmailSenderName = v.EmailSenderName.trim();
      if (v.EmailFooter.trim() !== initial.EmailFooter) patch.EmailFooter = v.EmailFooter.trim();
      if (v.HidePoweredBy !== initial.HidePoweredBy) patch.HidePoweredBy = v.HidePoweredBy;
      if (v.ReplyTo.trim() !== initial.ReplyTo) patch.ReplyTo = v.ReplyTo.trim();
      if (Object.keys(patch).length === 0) return;
      await updateTenantBranding(tenant.objectId, patch);
      await invalidateTenant();
    }
  });

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending || !form.values) return <SectionLoading />;
  const v = form.values;

  const workspace = v.TenantName.trim() || t("settings.workspaceFallback");
  const senderName = v.EmailSenderName.trim() || workspace;
  const contrast = contrastOnWhite(ACCENT);

  async function pickLogo(file: File | undefined) {
    if (!file || !tenant) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast.error(t("settings.branding.identity.wrongType"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t("settings.branding.identity.tooLarge"));
      return;
    }
    setUploading(true);
    try {
      const url = await uploadImage(file);
      form.set({ Logo: url });
    } catch (err) {
      toast.error(
        t("settings.branding.identity.uploadFailed"),
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex gap-6 items-start flex-wrap">
      <FormColumn>
        <SectionCard title={t("settings.branding.identity.title")} note={t("settings.branding.identity.note")}>
          <div className="flex items-center gap-4">
            <div className="size-14 rounded-lg bg-paper border border-line flex items-center justify-center overflow-hidden shrink-0">
              {v.Logo ? (
                <img src={v.Logo} alt="" className="max-h-10 max-w-12 object-contain" />
              ) : (
                <LogoMark size={22} className="text-ink" />
              )}
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <span className="text-[13px] font-medium">
                {v.Logo ? t("settings.branding.identity.logo") : t("settings.branding.identity.noLogo")}
              </span>
              {admin ? (
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInput}
                    type="file"
                    accept={LOGO_TYPES.join(",")}
                    className="hidden"
                    onChange={(e) => {
                      void pickLogo(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={uploading}
                    icon={<Upload className="size-3.5" strokeWidth={1.6} />}
                    onClick={() => fileInput.current?.click()}
                  >
                    {uploading
                      ? t("settings.branding.identity.uploading")
                      : v.Logo
                        ? t("settings.branding.identity.replace")
                        : t("settings.branding.identity.upload")}
                  </Button>
                  {v.Logo ? (
                    <Button size="sm" variant="ghost" onClick={() => form.set({ Logo: "" })}>
                      {t("settings.branding.identity.remove")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <span className="text-[11px] text-muted-2 leading-relaxed">
                {t("settings.branding.identity.logoHint")}
              </span>
            </div>
          </div>

          <Field label={t("settings.branding.identity.workspaceName")} hint={t("settings.branding.identity.workspaceNameHint")}>
            <Input
              value={v.TenantName}
              readOnly={!admin}
              disabled={!admin}
              maxLength={100}
              onChange={(e) => form.set({ TenantName: e.target.value })}
            />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-semibold text-ink-2">{t("settings.branding.identity.accent")}</span>
            <div className="flex items-center gap-2.5">
              <span className="size-8 rounded-md border border-line" style={{ background: ACCENT }} />
              <code className="font-mono text-[12px] text-muted">{ACCENT}</code>
              <span className="text-[11px] text-muted-2 ml-auto">
                {contrast >= 4.5
                  ? t("settings.branding.identity.contrastAA", { ratio: contrast.toFixed(2) })
                  : t("settings.branding.identity.contrastBelowAA", { ratio: contrast.toFixed(2) })}
              </span>
            </div>
            <NotAvailableNote>{t("settings.branding.identity.accentNote")}</NotAvailableNote>
          </div>

          {admin ? null : <NotAvailableNote>{t("settings.branding.identity.memberNote")}</NotAvailableNote>}
        </SectionCard>

        <SectionCard title={t("settings.branding.sender.title")} note={t("settings.branding.sender.note")}>
          <Field label={t("settings.branding.sender.senderName")} hint={t("settings.branding.sender.senderNameHint")}>
            <Input
              value={v.EmailSenderName}
              readOnly={!admin}
              disabled={!admin}
              maxLength={MAX_SENDER_NAME}
              placeholder={workspace}
              onChange={(e) => form.set({ EmailSenderName: e.target.value })}
            />
          </Field>
          <Field label={t("settings.branding.sender.replyTo")}>
            <Input
              type="email"
              value={v.ReplyTo}
              readOnly={!admin}
              disabled={!admin}
              placeholder={t("settings.branding.sender.replyToPlaceholder")}
              onChange={(e) => form.set({ ReplyTo: e.target.value })}
            />
          </Field>
          <Field label={t("settings.branding.sender.domain")}>
            <Input value={tenant?.Domain || window.location.host} readOnly disabled />
          </Field>
          <div className="flex flex-col gap-3 pt-1 border-t border-line-soft">
            <ToggleRow
              disabled={!admin}
              label={t("settings.branding.sender.hidePoweredBy")}
              description={t("settings.branding.sender.hidePoweredByHint")}
              control={
                <Toggle
                  checked={v.HidePoweredBy}
                  onChange={(c) => form.set({ HidePoweredBy: c })}
                  disabled={!admin}
                  label={t("settings.branding.sender.hidePoweredByToggle")}
                />
              }
            />
            <Field
              label={t("settings.branding.sender.footerText")}
              hint={t("settings.branding.sender.footerHint")}
              right={
                admin ? (
                  <span className="num text-[11px] text-muted-2">
                    {v.EmailFooter.length}/{MAX_FOOTER}
                  </span>
                ) : null
              }
            >
              <Textarea
                value={v.EmailFooter}
                readOnly={!admin}
                disabled={!admin}
                maxLength={MAX_FOOTER}
                rows={3}
                placeholder={t("settings.branding.sender.footerPlaceholder")}
                onChange={(e) => form.set({ EmailFooter: e.target.value })}
              />
            </Field>
          </div>
          {admin ? null : <NotAvailableNote>{t("settings.branding.sender.memberNote")}</NotAvailableNote>}
        </SectionCard>
      </FormColumn>

      <div className="flex-1 min-w-[380px] max-w-[520px] flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-semibold text-ink-2">{t("settings.branding.preview.title")}</span>
          <div className="ml-auto inline-flex bg-paper rounded-md p-0.5">
            {(
              [
                ["email", t("settings.branding.preview.email")],
                ["signing", t("settings.branding.preview.signing")],
                ["pdf", t("settings.branding.preview.pdf")]
              ] as Array<[PreviewTab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "h-6 px-2.5 rounded-[6px] text-[12px] font-medium",
                  tab === id ? "bg-surface text-ink shadow-[var(--shadow-raise)]" : "text-muted"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "email" ? (
          <EmailPreview
            logo={v.Logo}
            workspace={workspace}
            senderName={senderName}
            replyTo={v.ReplyTo}
            footer={v.EmailFooter}
            hidePoweredBy={v.HidePoweredBy}
            recipient="ana@acme.com"
          />
        ) : null}
        {tab === "signing" ? <SigningPreview logo={v.Logo} workspace={workspace} senderName={senderName} /> : null}
        {tab === "pdf" ? <PdfPreview workspace={workspace} senderName={senderName} /> : null}

        <p className="text-[11px] text-muted-2">{t("settings.branding.preview.note")}</p>
      </div>
    </div>
  );
}

/**
 * `light` pins the frame to the light palette. Emails and the completed PDF
 * render light for the recipient whatever this app is set to, so previewing
 * them in dark would be a lie.
 */
function PreviewFrame({ children, light }: { children: ReactNode; light?: boolean }) {
  return <div className={cn("bg-sand border border-line rounded-xl p-4", light && "theme-light")}>{children}</div>;
}

function EmailPreview({
  logo,
  workspace,
  senderName,
  replyTo,
  footer,
  hidePoweredBy,
  recipient
}: {
  logo?: string;
  workspace: string;
  senderName: string;
  replyTo: string;
  footer: string;
  hidePoweredBy: boolean;
  recipient: string;
}) {
  const { t } = useTranslation();
  const doc = t("settings.branding.preview.sampleDoc");
  return (
    <PreviewFrame light>
      <div className="bg-surface rounded-md border border-line overflow-hidden">
        <div className="px-4 py-3 border-b border-line-soft flex flex-col gap-0.5">
          <span className="text-[12px] text-ink">
            <span className="font-semibold">{senderName}</span>
            <span className="text-muted-2"> {replyTo ? `<${replyTo}>` : ""}</span>
          </span>
          <span className="text-[11px] text-muted-2">{t("settings.branding.preview.to", { recipient })}</span>
          <span className="text-[12px] text-ink-2 mt-1">
            {t("settings.branding.preview.emailSubject", { sender: senderName, document: doc })}
          </span>
        </div>
        <div className="px-5 py-5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            {logo ? (
              <img src={logo} alt="" className="h-6 max-w-24 object-contain" />
            ) : (
              <LogoMark size={22} className="text-ink" />
            )}
            <span className="text-[13px] font-semibold">{workspace}</span>
          </div>
          <h3 className="font-semibold text-[15px] leading-snug tracking-[-.015em]">
            {t("settings.branding.preview.emailHeading", { sender: senderName, document: doc })}
          </h3>
          <p className="text-[12px] text-muted leading-relaxed">{t("settings.branding.preview.emailBody")}</p>
          <span className="inline-flex items-center justify-center h-8 px-3.5 rounded-md bg-ink text-ground text-[12px] font-semibold w-max">
            {t("settings.branding.preview.emailCta")}
          </span>
          <div className="pt-3 mt-1 border-t border-line-soft text-[11px] text-muted-2 leading-relaxed flex flex-col gap-1.5">
            <span>{t("settings.branding.preview.emailFooter", { workspace })}</span>
            {footer.trim() ? <span className="whitespace-pre-line text-ink-2">{footer.trim()}</span> : null}
            {hidePoweredBy ? null : <span>{t("settings.branding.preview.poweredBy")}</span>}
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

function SigningPreview({ logo, workspace, senderName }: { logo?: string; workspace: string; senderName: string }) {
  const { t } = useTranslation();
  const doc = t("settings.branding.preview.sampleDoc");
  return (
    <PreviewFrame>
      <div className="bg-surface rounded-md border border-line overflow-hidden">
        <div className="h-11 border-b border-line flex items-center gap-2 px-3.5">
          {logo ? (
            <img src={logo} alt="" className="h-5 max-w-20 object-contain" />
          ) : (
            <LogoMark size={18} className="text-ink" />
          )}
          <span className="text-[12px] font-semibold">{workspace}</span>
          <span className="text-[11px] text-muted-2 truncate">· {doc}</span>
          <span className="ml-auto inline-flex items-center h-6 px-2.5 rounded-md bg-ink text-ground text-[11px] font-semibold">
            {t("settings.branding.preview.finish")}
          </span>
        </div>
        <div className="p-4 bg-ground">
          <div className="bg-surface border border-line rounded-sm aspect-[8.5/6] p-4 flex flex-col gap-2">
            <span className="h-2 w-2/3 bg-line rounded-full" />
            <span className="h-2 w-full bg-line-soft rounded-full" />
            <span className="h-2 w-5/6 bg-line-soft rounded-full" />
            <span className="mt-auto h-9 w-40 border border-dashed border-accent-line bg-accent-tint rounded-md flex items-center px-2 text-[11px] text-accent font-semibold">
              {t("settings.branding.preview.signHere")}
            </span>
            <span className="text-[10px] text-muted-2">
              {t("settings.branding.preview.requestedBy", { sender: senderName })}
            </span>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

function PdfPreview({ workspace, senderName }: { workspace: string; senderName: string }) {
  const { t } = useTranslation();
  return (
    <PreviewFrame light>
      <div className="bg-surface rounded-md border border-line p-5 flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <span className="font-semibold text-[14px]">{t("settings.branding.preview.sampleDoc")}</span>
          <span className="text-[11px] text-accent font-semibold">{t("common.status.completed")}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="h-2 w-full bg-line-soft rounded-full" />
          <span className="h-2 w-11/12 bg-line-soft rounded-full" />
          <span className="h-2 w-3/4 bg-line-soft rounded-full" />
        </div>
        <div className="mt-2 border border-line rounded-md p-3 flex flex-col gap-1">
          <span className="text-[11px] tracking-[.08em] uppercase text-muted-2 font-medium">
            {t("settings.branding.preview.certificate")}
          </span>
          <span className="text-[12px] text-ink-2">{t("settings.branding.preview.issuedBy", { workspace })}</span>
          <span className="text-[11px] text-muted-2">
            {t("settings.branding.preview.pdfSender", { sender: senderName })} ·{" "}
            {t("common.count.signer", { count: 2 })} · {t("settings.branding.preview.pdfTimestamps")}
          </span>
        </div>
      </div>
    </PreviewFrame>
  );
}
