import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, KeyRound, Plug, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, Pill, toast } from "@/components/ui";
import { customRouteBase } from "@/lib/parse";
import { whenShort } from "@/lib/format";
import { FormColumn, ReadOnlyRow, SectionCard, SectionError, SectionLoading } from "../parts";
import {
  useApiToken,
  useGenerateApiToken,
  useOAuthGrants,
  useRevokeApiToken,
  useRevokeOAuthGrant,
  type OAuthGrantInfo
} from "../api";
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

/**
 * Apps connected through "Sign in with DocuStamp" (OAuth), such as ChatGPT.
 * Each row is one connection; disconnecting ends its tokens at once.
 */
function ConnectedAppsCard() {
  const { t } = useTranslation();
  const grants = useOAuthGrants();
  const revoke = useRevokeOAuthGrant();
  const [confirm, setConfirm] = useState<OAuthGrantInfo | null>(null);

  async function onDisconnect() {
    if (!confirm) return;
    try {
      await revoke.mutateAsync(confirm.id);
      setConfirm(null);
      toast.success(t("settings.apiWebhooks.apps.disconnected"));
    } catch (err) {
      toast.error(t("settings.apiWebhooks.apps.failed"), (err as Error).message);
    }
  }

  const list = grants.data?.grants ?? [];
  const nameOf = (grant: OAuthGrantInfo) => grant.clientName || t("settings.apiWebhooks.apps.unnamed");

  return (
    <SectionCard
      title={t("settings.apiWebhooks.apps.title")}
      note={t("settings.apiWebhooks.apps.note")}
      aside={<Plug className="size-4 text-muted" strokeWidth={1.6} />}
    >
      {grants.isLoading ? (
        <SectionLoading />
      ) : grants.error ? (
        <SectionError error={grants.error} onRetry={() => void grants.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-[12px] text-muted">{t("settings.apiWebhooks.apps.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.map((grant) => (
            <li key={grant.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink truncate">{nameOf(grant)}</span>
                  {grant.redirectHost ? <span className="font-mono text-[11px] text-muted">{grant.redirectHost}</span> : null}
                  <Pill tone={grant.scopes.includes("documents:write") ? "accent" : "neutral"}>
                    {grant.scopes.includes("documents:write")
                      ? t("settings.apiWebhooks.apps.readWrite")
                      : t("settings.apiWebhooks.apps.readOnly")}
                  </Pill>
                </div>
                <span className="text-[11.5px] text-muted">
                  {t("settings.apiWebhooks.apps.connected")}{" "}
                  {grant.createdAt ? whenShort(grant.createdAt) : t("common.state.unknown")}
                  <span className="px-1.5 text-muted-2">&middot;</span>
                  {t("settings.apiWebhooks.token.lastUsed")}{" "}
                  {grant.lastUsedAt ? whenShort(grant.lastUsedAt) : t("settings.apiWebhooks.token.never")}
                </span>
              </div>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 className="size-3.5" strokeWidth={1.6} />}
                onClick={() => setConfirm(grant)}
              >
                {t("settings.apiWebhooks.apps.disconnect")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t("settings.apiWebhooks.apps.disconnect")}
        description={confirm ? t("settings.apiWebhooks.apps.disconnectConfirm", { app: nameOf(confirm) }) : ""}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="danger" loading={revoke.isPending} onClick={() => void onDisconnect()}>
              {t("settings.apiWebhooks.apps.disconnect")}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </SectionCard>
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
      <ConnectedAppsCard />

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
