import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input, Pill, Textarea, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { isAdminRole, useExtUser } from "@/lib/extUser";
import { useAuth } from "@/app/auth";
import { updateTenantTemplates, useTenant } from "../api";
import { MAIL_VARIABLES } from "../constants";
import type { EmailEditorType } from "../types";
import { FormColumn, SectionCard, SectionError, SectionLoading } from "../parts";
import { useSectionForm } from "../sectionForm";

/** The old editor stored a full HTML document; show only the body while editing. */
function unwrapBody(html?: string): string {
  if (!html) return "";
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match ? match[1] : html).trim();
}

function wrapBody(body: string): string {
  const inner = body.trim().replace(/"/g, "'");
  if (!inner) return "";
  return `<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head><body>${inner}</body></html>`;
}

/** Strip anything executable before putting the body in the preview. */
function safePreviewHtml(html: string, values: Record<string, string>): string {
  let out = html
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

interface TemplateValues {
  RequestSubject: string;
  RequestBody: string;
  CompletionSubject: string;
  CompletionBody: string;
}

type Tab = "request" | "completion";

export default function EmailTemplatesSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: extUser } = useExtUser();
  const { data: tenant, isPending, error, refetch } = useTenant();
  const admin = isAdminRole(extUser?.UserRole);
  const [tab, setTab] = useState<Tab>("request");

  /**
   * Only the tenant row is shown, for admins and members alike, because only
   * the tenant row is writable: every mail builder resolves the template as
   * document, then tenant, then the sender's own contracts_Users row, then
   * built-in (cloud/lib/requestMail.js). Nothing writes that per-sender row any
   * more, so a member gets a read-only view of the workspace template instead of
   * an editor whose "Saved" changed nothing.
   */
  const initial: TemplateValues | null = tenant
    ? {
        RequestSubject: (tenant.RequestSubject ?? "").trim(),
        RequestBody: unwrapBody(tenant.RequestBody),
        CompletionSubject: (tenant.CompletionSubject ?? "").trim(),
        CompletionBody: unwrapBody(tenant.CompletionBody)
      }
    : null;

  const editorType: EmailEditorType = (tenant?.EmailEditorType as EmailEditorType | undefined) ?? {
    request: "basic",
    completion: "basic"
  };

  const form = useSectionForm<TemplateValues>({
    initial,
    successTitle: t("settings.emailTemplates.toast.saved"),
    errorTitle: t("settings.emailTemplates.toast.saveFailed"),
    save: async (v) => {
      // Unreachable for a member: every control below is disabled, so the form
      // never goes dirty and the save bar never appears.
      if (!admin) return;
      if (!tenant?.objectId) throw new Error(t("settings.emailTemplates.toast.noTenant"));
      const details = {
        RequestSubject: v.RequestSubject.trim(),
        RequestBody: wrapBody(v.RequestBody),
        CompletionSubject: v.CompletionSubject.trim(),
        CompletionBody: wrapBody(v.CompletionBody),
        EmailEditorType: editorType
      };
      await updateTenantTemplates(tenant.objectId, details);
      await refetch();
    }
  });

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending || !form.values) return <SectionLoading />;
  if (!tenant) {
    return (
      <SectionCard title={t("settings.sections.email.title")}>
        <p className="text-[13px] text-muted">{t("settings.emailTemplates.noTenant")}</p>
      </SectionCard>
    );
  }
  const v = form.values;

  const isRequest = tab === "request";
  const defaultSubject = t(
    isRequest ? "settings.emailTemplates.defaults.requestSubject" : "settings.emailTemplates.defaults.completionSubject"
  );
  const defaultBody = t(
    isRequest ? "settings.emailTemplates.defaults.requestBody" : "settings.emailTemplates.defaults.completionBody"
  );
  const subject = isRequest ? v.RequestSubject : v.CompletionSubject;
  const body = isRequest ? v.RequestBody : v.CompletionBody;
  const setSubject = (s: string) => form.set(isRequest ? { RequestSubject: s } : { CompletionSubject: s });
  const setBody = (s: string) => form.set(isRequest ? { RequestBody: s } : { CompletionBody: s });

  const sample: Record<string, string> = {
    document_title: t("settings.emailTemplates.sample.documentTitle"),
    note: t("settings.emailTemplates.sample.note"),
    sender_name: extUser?.Name ?? user?.name ?? t("settings.emailTemplates.sample.senderName"),
    sender_mail: extUser?.Email ?? user?.email ?? "",
    sender_phone: extUser?.Phone ?? "",
    receiver_name: "Ana Silva",
    receiver_email: "ana@acme.com",
    receiver_phone: "",
    expiry_date: t("settings.emailTemplates.sample.expiryDate"),
    company_name: tenant.TenantName ?? "",
    signing_url: "#"
  };

  const usingDefault = body.trim().length === 0;

  return (
    <div className="flex gap-6 items-start flex-wrap">
      <FormColumn>
        <SectionCard
          title={isRequest ? t("settings.emailTemplates.requestTitle") : t("settings.emailTemplates.completionTitle")}
          note={
            admin ? t("settings.emailTemplates.adminNote") : t("settings.emailTemplates.userNote")
          }
          aside={
            <div className="inline-flex bg-paper rounded-md p-0.5">
              {(
                [
                  ["request", t("settings.emailTemplates.tabs.request")],
                  ["completion", t("settings.emailTemplates.tabs.completion")]
                ] as Array<[Tab, string]>
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
          }
        >
          <Field label={t("settings.emailTemplates.subject")}>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={defaultSubject}
              disabled={!admin}
            />
          </Field>
          <Field
            label={t("settings.emailTemplates.body")}
            hint={t("settings.emailTemplates.bodyHint")}
            right={
              !admin ? null : usingDefault ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setBody(defaultBody);
                    if (!subject) setSubject(defaultSubject);
                  }}
                >
                  {t("settings.emailTemplates.startFromDefault")}
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setBody("");
                    setSubject("");
                    toast.show(t("settings.emailTemplates.toast.cleared"), t("settings.emailTemplates.toast.clearedBody"));
                  }}
                >
                  {t("common.actions.reset")}
                </Button>
              )
            }
          >
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[220px] font-mono text-[12px]"
              placeholder={defaultBody}
              disabled={!admin}
            />
          </Field>
        </SectionCard>

        <SectionCard title={t("settings.emailTemplates.variables.title")} note={t("settings.emailTemplates.variables.note")}>
          <div className="flex flex-wrap gap-1.5">
            {MAIL_VARIABLES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`{{${name}}}`)
                    .then(() => toast.success(t("common.actions.copied"), `{{${name}}}`))
                    .catch(() => toast.error(t("settings.emailTemplates.toast.copyFailed")));
                }}
                className="font-mono text-[11px] px-2 h-6 rounded-md bg-paper text-ink-2 hover:bg-sand"
              >
                {`{{${name}}}`}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-2">{t("settings.emailTemplates.variables.expiryNote")}</p>
        </SectionCard>
      </FormColumn>

      <div className="flex-1 min-w-[360px] max-w-[520px] flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-2">{t("settings.emailTemplates.preview.title")}</span>
          {usingDefault ? (
            <Pill tone="neutral">{t("settings.emailTemplates.preview.serverDefault")}</Pill>
          ) : (
            <Pill tone="accent">{t("settings.emailTemplates.preview.custom")}</Pill>
          )}
        </div>
        <div className="bg-sand border border-line rounded-lg p-4">
          <div className="bg-surface border border-line rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft">
              <span className="text-[12px] text-ink-2">
                {safePreviewHtml(subject || defaultSubject, sample)}
              </span>
            </div>
            <div
              className="px-4 py-4 text-[13px] leading-relaxed [&_a]:text-accent [&_p]:mb-2"
              dangerouslySetInnerHTML={{
                __html: safePreviewHtml(body || defaultBody, sample)
              }}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-2">{t("settings.emailTemplates.preview.note")}</p>
      </div>
    </div>
  );
}
