import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, Pill, toast } from "@/components/ui";
import { customRouteBase } from "@/lib/parse";
import { whenShort } from "@/lib/format";
import { FormColumn, ReadOnlyRow, SectionCard, SectionError, SectionLoading } from "../parts";
import { useApiToken, useGenerateApiToken, useRevokeApiToken } from "../api";
import { MCP_TOOL_NAMES } from "../mcpTools";

/** `/api/app` -> `/api`: the MCP endpoint and the REST API live beside the Parse mount (@/lib/parse). */
const API_ROOT = customRouteBase();
const MCP_URL = `${API_ROOT}/mcp`;
const REST_URL = `${API_ROOT}/v1`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={label}
      icon={done ? <Check className="size-3.5" strokeWidth={1.6} /> : <Copy className="size-3.5" strokeWidth={1.6} />}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t("common.actions.copied") : t("common.actions.copy")}
    </Button>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative rounded-md border border-line bg-surface-2">
      <div className="absolute right-1 top-1">
        <CopyButton value={code} label={label} />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 pr-20 text-[11.5px] leading-relaxed font-mono text-ink-2 whitespace-pre">{code}</pre>
    </div>
  );
}

export default function ApiWebhooksSection() {
  const { t } = useTranslation();
  const tokenQuery = useApiToken();
  const generate = useGenerateApiToken();
  const revoke = useRevokeApiToken();
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const info = tokenQuery.data?.token ?? null;
  const exampleToken = freshToken ?? "os_YOUR_TOKEN";

  async function onGenerate() {
    try {
      const res = await generate.mutateAsync();
      setFreshToken(res.token);
      toast.success(t("settings.apiWebhooks.token.generated"));
    } catch (err) {
      toast.error(t("settings.apiWebhooks.token.failed"), (err as Error).message);
    }
  }

  async function onRevoke() {
    try {
      await revoke.mutateAsync();
      setFreshToken(null);
      setConfirmRevoke(false);
      toast.success(t("settings.apiWebhooks.token.revoked"));
    } catch (err) {
      toast.error(t("settings.apiWebhooks.token.failed"), (err as Error).message);
    }
  }

  const claudeCode = `claude mcp add --transport http docustamp ${MCP_URL} \\\n  --header "Authorization: Bearer ${exampleToken}"`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        docustamp: {
          command: "npx",
          args: ["-y", "mcp-remote", MCP_URL, "--header", `Authorization: Bearer ${exampleToken}`]
        }
      }
    },
    null,
    2
  );
  const curl = `curl -X POST ${REST_URL}/documents/quick-send \\\n  -H "Authorization: Bearer ${exampleToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"fileBase64":"<base64 pdf>","fileName":"lease.pdf",\n       "instructions":"I am the landlord, the tenant signs first",\n       "recipients":[{"name":"Jane Okafor","email":"jane@example.com"}]}'`;

  return (
    <FormColumn className="max-w-[640px]">
      <SectionCard
        title={t("settings.apiWebhooks.token.title")}
        note={t("settings.apiWebhooks.token.note")}
        aside={<KeyRound className="size-4 text-muted" strokeWidth={1.6} />}
      >
        {tokenQuery.isLoading ? (
          <SectionLoading />
        ) : tokenQuery.error ? (
          <SectionError error={tokenQuery.error} onRetry={() => void tokenQuery.refetch()} />
        ) : (
          <>
            {freshToken ? (
              <div className="flex flex-col gap-2 rounded-md border border-accent-line bg-accent-tint px-3 py-2.5">
                <span className="text-[12px] font-semibold text-accent">{t("settings.apiWebhooks.token.shownOnce")}</span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate font-mono text-[12px]">{freshToken}</code>
                  <CopyButton value={freshToken} label={t("settings.apiWebhooks.token.copy")} />
                </div>
              </div>
            ) : null}
            {info ? (
              <>
                <ReadOnlyRow label={t("settings.apiWebhooks.token.prefix")} value={`${info.prefix}…`} mono />
                <ReadOnlyRow
                  label={t("settings.apiWebhooks.token.created")}
                  value={info.createdAt ? whenShort(info.createdAt) : t("common.state.unknown")}
                />
                <ReadOnlyRow
                  label={t("settings.apiWebhooks.token.lastUsed")}
                  value={info.lastUsedAt ? whenShort(info.lastUsedAt) : t("settings.apiWebhooks.token.never")}
                />
              </>
            ) : (
              <p className="text-[12px] text-muted">{t("settings.apiWebhooks.token.none")}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={generate.isPending}
                icon={info ? <RefreshCw className="size-3.5" strokeWidth={1.6} /> : <KeyRound className="size-3.5" strokeWidth={1.6} />}
                onClick={() => void onGenerate()}
              >
                {info ? t("settings.apiWebhooks.token.rotate") : t("settings.apiWebhooks.token.generate")}
              </Button>
              {info ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="size-3.5" strokeWidth={1.6} />}
                  onClick={() => setConfirmRevoke(true)}
                >
                  {t("settings.apiWebhooks.token.revoke")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard title={t("settings.apiWebhooks.mcp.title")} note={t("settings.apiWebhooks.mcp.note")}>
        <ReadOnlyRow label={t("settings.apiWebhooks.mcp.endpoint")} value={MCP_URL} mono />
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-ink-2">{t("settings.apiWebhooks.mcp.claudeCode")}</span>
          <CodeBlock code={claudeCode} label={t("common.actions.copy")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-ink-2">{t("settings.apiWebhooks.mcp.claudeDesktop")}</span>
          <CodeBlock code={claudeDesktop} label={t("common.actions.copy")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-ink-2">{t("settings.apiWebhooks.mcp.tools")}</span>
          <div className="flex flex-wrap gap-1.5">
            {MCP_TOOL_NAMES.map((n) => (
              <Pill key={n} tone="neutral">
                <span className="font-mono">{n}</span>
              </Pill>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("settings.apiWebhooks.rest.title")} note={t("settings.apiWebhooks.rest.note")}>
        <ReadOnlyRow label="Base URL" value={REST_URL} mono />
        <CodeBlock code={curl} label={t("common.actions.copy")} />
        <p className="text-[12px] text-muted leading-relaxed">{t("settings.apiWebhooks.rest.example")}</p>
      </SectionCard>

      <SectionCard title={t("settings.apiWebhooks.webhooks.title")}>
        <p className="text-[12px] text-muted leading-relaxed">{t("settings.apiWebhooks.webhooks.body")}</p>
      </SectionCard>

      <Dialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title={t("settings.apiWebhooks.token.revoke")}
        description={t("settings.apiWebhooks.token.revokeConfirm")}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="danger" loading={revoke.isPending} onClick={() => void onRevoke()}>
              {t("settings.apiWebhooks.token.revoke")}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </FormColumn>
  );
}
