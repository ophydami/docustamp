import { useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Plus, ShieldCheck, X } from "lucide-react";
import { Button, Checkbox, Field, Input, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { dateMedium } from "@/lib/format";
import { agentRulesKey, saveAgentRules, useAgentRules } from "../api";
import { ALWAYS_ASK_KEYS, RULE_DOC_TYPES } from "../constants";
import { FormColumn, SectionCard, SectionError, SectionLoading, ToggleRow } from "../parts";
import { useSectionForm } from "../sectionForm";
import type { AgentRules, AlwaysAskKey, RuleDocType } from "../types";

/**
 * The editable part of the rules. The limit is kept as typed text so an empty
 * box while someone types is not a 0, and is checked on save.
 */
interface RulesValues {
  enabled: boolean;
  documentTypes: RuleDocType[];
  maxValue: string;
  trustedSenderDomains: string[];
  alwaysAsk: Record<AlwaysAskKey, boolean>;
  sendOnlyTo: string[];
}

function valuesOf(rules: AgentRules): RulesValues {
  return {
    enabled: rules.autoSign.enabled,
    documentTypes: rules.autoSign.documentTypes,
    maxValue: String(rules.autoSign.maxValueUsd),
    trustedSenderDomains: rules.autoSign.trustedSenderDomains,
    alwaysAsk: rules.alwaysAsk,
    sendOnlyTo: rules.sendOnlyTo
  };
}

/** A whole dollar amount, 0 or more, from what was typed ("25,000" and "$25000" both work). Null when it is not one. */
function parseLimit(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d+$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isSafeInteger(n) ? n : null;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/**
 * One domain the way the server stores it (cloud/lib/agentRules.js
 * normaliseDomain): lowercase, no scheme, path or port, and an email address
 * gives its domain. Empty when it is not a domain.
 */
function normaliseDomain(value: string): string {
  let s = value.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.split(/[/?#]/)[0].split(":")[0];
  s = s.replace(/^\*\./, "").replace(/\.$/, "");
  return DOMAIN_RE.test(s) ? s : "";
}

/**
 * Rules for your AI: one set for every app the person connected and their API
 * key (server: cloud/lib/agentRules.js). What an agent may sign without asking
 * on a document someone else sent, what always comes to the person first, and
 * who it may send to. Only the person changes them here; an agent can read
 * them (the get_rules tool) and never write them.
 */
export default function RulesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useAgentRules();

  const form = useSectionForm<RulesValues>({
    initial: query.data ? valuesOf(query.data) : null,
    successTitle: t("settings.rules.toast.saved"),
    errorTitle: t("settings.rules.toast.saveFailed"),
    save: async (v) => {
      const max = parseLimit(v.maxValue);
      if (max === null) throw new Error(t("settings.rules.autoSign.limitInvalid"));
      if (v.enabled && v.documentTypes.length === 0) throw new Error(t("settings.rules.autoSign.needType"));
      const saved = await saveAgentRules({
        autoSign: {
          enabled: v.enabled,
          documentTypes: v.documentTypes,
          maxValueUsd: max,
          trustedSenderDomains: v.trustedSenderDomains
        },
        alwaysAsk: v.alwaysAsk,
        sendOnlyTo: v.sendOnlyTo
      });
      qc.setQueryData(agentRulesKey, saved);
    }
  });

  if (query.error) return <SectionError error={query.error} onRetry={() => void query.refetch()} />;
  if (query.isPending || !form.values) return <SectionLoading />;
  const v = form.values;
  const rules = query.data;
  const limitInvalid = parseLimit(v.maxValue) === null;

  function toggleType(type: RuleDocType) {
    const on = v.documentTypes.includes(type);
    // Kept in the page's order, so the saved list does not depend on click order.
    const next = on ? v.documentTypes.filter((x) => x !== type) : RULE_DOC_TYPES.filter((x) => x === type || v.documentTypes.includes(x));
    form.set({ documentTypes: next });
  }

  return (
    <FormColumn className="max-w-[640px]">
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.6} />
        <div className="min-w-0 flex flex-col gap-0.5">
          <p className="text-[13px] leading-relaxed text-ink-2">{t("settings.rules.readOnlyNote")}</p>
          {rules?.updatedAt ? (
            <p className="text-[11.5px] text-muted">
              <Trans
                i18nKey={rules.updatedBy?.name ? "settings.rules.updatedBy" : "settings.rules.updated"}
                values={{ name: rules.updatedBy?.name ?? "", date: dateMedium(rules.updatedAt) }}
                components={[<span key="date" className="num text-ink-2" />]}
              />
            </p>
          ) : null}
        </div>
      </div>

      <SectionCard title={t("settings.rules.autoSign.title")} note={t("settings.rules.autoSign.note")}>
        <ToggleRow
          label={t("settings.rules.autoSign.toggle")}
          description={t("settings.rules.autoSign.toggleHint")}
          control={
            <Toggle
              checked={v.enabled}
              onChange={(c) => form.set({ enabled: c })}
              label={t("settings.rules.autoSign.toggleLabel")}
            />
          }
        />

        {!v.enabled ? (
          <p className="rounded-md bg-surface-3 px-3 py-2 text-[12px] leading-relaxed text-ink-2">{t("settings.rules.autoSign.offNote")}</p>
        ) : null}

        <div className={cn("flex flex-col gap-4 transition-opacity", !v.enabled && "opacity-60")}>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">{t("settings.rules.autoSign.typesLabel")}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("settings.rules.autoSign.typesLabel")}>
              {RULE_DOC_TYPES.map((type) => {
                const on = v.documentTypes.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleType(type)}
                    className={cn(
                      "inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-[12px] font-medium transition-colors",
                      on
                        ? "bg-accent-soft border-accent-line text-accent"
                        : "bg-surface border-line text-ink-2 hover:border-line-strong hover:text-ink"
                    )}
                  >
                    {t(`settings.rules.types.${type}`)}
                  </button>
                );
              })}
            </div>
            <span className={cn("text-[11px]", v.enabled && v.documentTypes.length === 0 ? "text-danger" : "text-muted-2")}>
              {v.enabled && v.documentTypes.length === 0 ? t("settings.rules.autoSign.needType") : t("settings.rules.autoSign.typesHint")}
            </span>
          </div>

          <Field
            label={t("settings.rules.autoSign.limitLabel")}
            hint={t("settings.rules.autoSign.limitHint")}
            error={limitInvalid ? t("settings.rules.autoSign.limitInvalid") : undefined}
          >
            <Input
              className="max-w-[220px] num"
              left={<span className="text-[13px]">$</span>}
              inputMode="numeric"
              value={v.maxValue}
              invalid={limitInvalid}
              onChange={(e) => form.set({ maxValue: e.target.value })}
            />
          </Field>

          <DomainList
            label={t("settings.rules.autoSign.sendersLabel")}
            hint={t("settings.rules.autoSign.sendersHint")}
            value={v.trustedSenderDomains}
            onChange={(next) => form.set({ trustedSenderDomains: next })}
          />
        </div>
      </SectionCard>

      <SectionCard title={t("settings.rules.alwaysAsk.title")} note={t("settings.rules.alwaysAsk.note")}>
        <ul className="flex flex-col gap-3">
          {ALWAYS_ASK_KEYS.map((key) => (
            <li key={key} className="flex items-start gap-2.5">
              <Checkbox
                className="mt-[3px]"
                checked={v.alwaysAsk[key]}
                label={t(`settings.rules.alwaysAsk.${key}`)}
                onChange={(c) => form.set({ alwaysAsk: { ...v.alwaysAsk, [key]: c } })}
              />
              <button
                type="button"
                className="min-w-0 flex flex-col gap-0.5 text-left"
                onClick={() => form.set({ alwaysAsk: { ...v.alwaysAsk, [key]: !v.alwaysAsk[key] } })}
              >
                <span className="text-[13px] font-medium text-ink">{t(`settings.rules.alwaysAsk.${key}`)}</span>
                <span className="text-[12px] leading-relaxed text-muted">{t(`settings.rules.alwaysAsk.${key}Hint`)}</span>
              </button>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t("settings.rules.sending.title")} note={t("settings.rules.sending.note")}>
        <DomainList
          label={t("settings.rules.sending.label")}
          hint={t("settings.rules.sending.hint")}
          value={v.sendOnlyTo}
          onChange={(next) => form.set({ sendOnlyTo: next })}
        />
      </SectionCard>
    </FormColumn>
  );
}

/** A list of domains: type one and press Enter or Add, remove one with its x. */
function DomainList({
  label,
  hint,
  value,
  onChange
}: {
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  function add() {
    if (!text.trim()) return;
    const domain = normaliseDomain(text);
    if (!domain) {
      setError(t("settings.rules.domains.invalid"));
      return;
    }
    if (value.includes(domain)) {
      setError(t("settings.rules.domains.duplicate", { domain }));
      return;
    }
    onChange([...value, domain]);
    setText("");
    setError("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-2">{label}</span>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((domain) => (
            <li
              key={domain}
              className="inline-flex items-center gap-1 h-6 pl-2 pr-0.5 rounded-full border border-line bg-surface-2 font-mono text-[11.5px] text-ink-2"
            >
              {domain}
              <button
                type="button"
                className="inline-flex items-center justify-center size-5 rounded-full text-muted hover:text-ink hover:bg-surface-3"
                aria-label={t("settings.rules.domains.remove", { domain })}
                onClick={() => onChange(value.filter((d) => d !== domain))}
              >
                <X className="size-3" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-[12px] text-muted">{t("settings.rules.domains.none")}</span>
      )}
      <div className="flex items-center gap-2">
        <Input
          className="max-w-[260px] font-mono text-[12px]"
          placeholder={t("settings.rules.domains.placeholder")}
          aria-label={label}
          value={text}
          invalid={Boolean(error)}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={onKeyDown}
        />
        <Button size="sm" icon={<Plus className="size-3.5" strokeWidth={1.6} />} disabled={!text.trim()} onClick={add}>
          {t("settings.rules.domains.add")}
        </Button>
      </div>
      {error ? <span className="text-[12px] text-danger">{error}</span> : <span className="text-[11px] text-muted-2">{hint}</span>}
    </div>
  );
}
