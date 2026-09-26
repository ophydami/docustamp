import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react";
import { Card, Field, Input, Select, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useTemplates } from "../api";
import { isEmail, isUrl, type BccEntry, type ChainConfig, type SendSettings } from "../types";

export interface MoreOptionsProps {
  settings: SendSettings;
  onSettings: (patch: Partial<SendSettings>) => void;
}

/**
 * The request options the old form kept behind "Advanced options": blind copies,
 * a redirect after signing, letting signers place their own fields, and the
 * follow-up chain (send a document from a template once this one completes).
 */
export function MoreOptions({ settings, onSettings }: MoreOptionsProps) {
  const { t } = useTranslation();
  const filled =
    settings.bcc.length +
    (settings.redirectUrl.trim() ? 1 : 0) +
    (settings.allowModifications ? 1 : 0) +
    (settings.chain ? 1 : 0);
  const [open, setOpen] = useState(filled > 0);
  const redirectInvalid = settings.redirectUrl.trim().length > 0 && !isUrl(settings.redirectUrl);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="self-start inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          strokeWidth={1.6}
        />
        {t("send.more.toggle")}
        {!open && filled ? (
          <span className="text-[11px] font-normal text-muted-2">
            {t("send.more.setCount", { count: filled })}
          </span>
        ) : null}
      </button>

      {open ? (
        <Card className="flex flex-col gap-4 px-4 py-4">
          <BccField value={settings.bcc} onChange={(bcc) => onSettings({ bcc })} />

          <Field
            label={t("send.more.redirectLabel")}
            hint={t("send.more.redirectHint")}
            error={redirectInvalid ? t("send.more.redirectError") : undefined}
          >
            <Input
              type="url"
              inputMode="url"
              value={settings.redirectUrl}
              invalid={redirectInvalid}
              onChange={(e) => onSettings({ redirectUrl: e.target.value })}
              placeholder="https://example.com/thank-you"
            />
          </Field>

          <div className="flex items-start gap-3">
            <Toggle
              checked={settings.allowModifications}
              onChange={(v) => onSettings({ allowModifications: v })}
              label={t("send.more.allowModifications")}
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold">{t("send.more.allowModifications")}</span>
              <span className="text-[12px] text-muted">{t("send.more.allowModificationsHint")}</span>
            </div>
          </div>

          <ChainField value={settings.chain} onChange={(chain) => onSettings({ chain })} />
        </Card>
      ) : null}
    </div>
  );
}

/**
 * "After everyone has signed, send ...": pick a template for the follow-up and
 * optionally give it a title. The server carries this document's signers over.
 */
function ChainField({
  value,
  onChange
}: {
  value: ChainConfig | null;
  onChange: (v: ChainConfig | null) => void;
}) {
  const { t } = useTranslation();
  const templates = useTemplates(true);
  const list = templates.data ?? [];
  // A stored chain whose template is not in the list any more (deleted, or the
  // list is still loading) stays selectable so it is not silently dropped.
  const missing = value && !list.some((tpl) => tpl.objectId === value.templateId);

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("send.more.chainLabel")} hint={t("send.more.chainHint")}>
        <Select
          value={value?.templateId ?? ""}
          onChange={(e) => {
            const templateId = e.target.value;
            if (!templateId) return onChange(null);
            const tpl = list.find((x) => x.objectId === templateId);
            onChange({
              templateId,
              templateName: tpl?.name ?? value?.templateName,
              name: value?.name
            });
          }}
          aria-label={t("send.more.chainLabel")}
        >
          <option value="">{t("send.more.chainNone")}</option>
          {missing ? (
            <option value={value.templateId}>{value.templateName || value.templateId}</option>
          ) : null}
          {list.map((tpl) => (
            <option key={tpl.objectId} value={tpl.objectId}>
              {tpl.name}
            </option>
          ))}
        </Select>
      </Field>
      {value ? (
        <Field label={t("send.more.chainTitleLabel")}>
          <Input
            value={value.name ?? ""}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder={value.templateName || t("send.more.chainTitlePlaceholder")}
          />
        </Field>
      ) : null}
    </div>
  );
}

function BccField({ value, onChange }: { value: BccEntry[]; onChange: (v: BccEntry[]) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit(raw: string): boolean {
    const parts = raw
      .split(/[,;\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return true;
    const taken = new Set(value.map((b) => b.email.toLowerCase()));
    const added: BccEntry[] = [];
    for (const part of parts) {
      const email = part.toLowerCase();
      if (!isEmail(email)) {
        setError(t("send.more.bccInvalid", { email: part }));
        return false;
      }
      if (taken.has(email)) continue;
      taken.add(email);
      added.push({ email });
    }
    setError(null);
    if (added.length) onChange([...value, ...added]);
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (!draft.trim()) return;
      e.preventDefault();
      if (commit(draft)) setDraft("");
      return;
    }
    if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  // Not a `Field`: the chips carry their own buttons, which do not belong inside a label.
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-ink-2">{t("send.more.bccLabel")}</span>
      <div className="flex flex-col gap-2">
        {value.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {value.map((b) => (
              <li
                key={b.email}
                className="inline-flex items-center gap-1.5 h-6 pl-2.5 pr-1 rounded-full bg-accent-soft text-accent text-[12px]"
              >
                <span className="max-w-[220px] truncate">{b.email}</span>
                <button
                  type="button"
                  aria-label={t("send.a11y.removeEmail", { email: b.email })}
                  onClick={() => onChange(value.filter((x) => x.email !== b.email))}
                  className="inline-flex items-center justify-center size-4 rounded-full hover:bg-ink/10"
                >
                  <X className="size-3" strokeWidth={1.6} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Input
          type="email"
          value={draft}
          invalid={!!error}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim() && commit(draft)) setDraft("");
          }}
          placeholder={t("send.more.bccPlaceholder")}
          aria-label={t("send.a11y.bccEmail")}
        />
      </div>
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : (
        <span className="text-[11px] text-muted-2">{t("send.more.bccHint")}</span>
      )}
    </div>
  );
}
