import { Copy, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Cap, Input, Select, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  DATE_FORMATS,
  FONT_COLORS,
  FONT_SIZES,
  PREFILL_COLOR,
  VALIDATION_TYPES,
  WIDGET_BY_TYPE
} from "../constants";
import { signerLabel } from "../model";
import { heightForOptions, optionValues, typeLabelKey } from "../widgets";
import type { EditorField, SignerRow, Widget, WidgetOptions, WidgetType } from "../types";

/** Types whose `options.defaultValue` is a plain string the sender can pre-fill. */
const HAS_DEFAULT: WidgetType[] = ["text", "text input", "cells", "name", "company", "job title", "email", "dropdown", "radio button"];
/** Types the signer app honours `options.isReadOnly` for (§7.3). */
const HAS_READONLY: WidgetType[] = ["text input", "cells", "checkbox", "radio button", "dropdown", "date"];

export interface PropertiesProps {
  field: EditorField;
  index: number;
  total: number;
  signers: SignerRow[];
  onChange: (next: EditorField, mergeKey?: string) => void;
  onDelete: () => void;
  onCopyToPages: () => void;
  disabled: boolean;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 border-b border-line-soft">
      <Cap>{label}</Cap>
      {children}
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  disabled
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-2 uppercase tracking-[.08em]">{label}</span>
      <input
        type="number"
        step={1}
        value={Math.round(value * 100) / 100}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={cn(
          "h-8 px-2 w-full bg-surface border border-line rounded-md font-mono text-[12px] text-ink",
          "focus:outline-none focus:border-accent disabled:bg-ground disabled:text-muted"
        )}
      />
    </label>
  );
}

export function Properties({
  field,
  index,
  total,
  signers,
  onChange,
  onDelete,
  onCopyToPages,
  disabled
}: PropertiesProps) {
  const { t } = useTranslation();
  const w = field.widget;
  const type = w.type;
  const spec = WIDGET_BY_TYPE[type];
  const values = optionValues(w);
  const signer = signers.find((s) => s.id === field.signerId);

  const patch = (widget: Partial<Widget>, mergeKey?: string) =>
    onChange({ ...field, widget: { ...w, ...widget } }, mergeKey);
  const patchOptions = (options: Partial<WidgetOptions>, mergeKey?: string) =>
    patch({ options: { ...w.options, ...options } }, mergeKey);

  const setValues = (next: string[]) => {
    const grow = type === "checkbox" || type === "radio button";
    patch({
      options: { ...w.options, values: next },
      ...(grow ? { Height: heightForOptions(type, next.length) } : {})
    });
  };

  const isTextish = ["text", "text input", "cells", "name", "company", "job title", "email", "date", "dropdown", "radio button", "checkbox"].includes(
    type
  );
  const alwaysRequired = type === "signature";

  return (
    <aside className="w-[300px] shrink-0 bg-surface border-l border-line flex flex-col min-h-0">
      <header className="px-4 h-[52px] shrink-0 flex items-center gap-2 border-b border-line">
        <span
          className="swatch size-2.5 rounded-full shrink-0 border border-ink/15"
          style={{ ["--swatch" as string]: signer && signer.color !== PREFILL_COLOR ? signer.color : "var(--color-faint)", background: "var(--swatch-on)" }}
        />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold truncate">{t(typeLabelKey(type))}</p>
          <p className="text-[11px] text-muted-2 num">
            {t("editor.properties.fieldPosition", { index: index + 1, total })}
          </p>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin">
        <Section label={t("editor.properties.assignedTo")}>
          <Select
            value={field.signerId ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...field, signerId: Number(e.target.value) })}
            className="h-8"
            aria-label={t("editor.properties.assignedTo")}
          >
            {field.signerId === null ? <option value="">{t("editor.properties.unassigned")}</option> : null}
            {signers.map((s) => (
              <option key={s.id} value={s.id}>
                {signerLabel(s, t)}
              </option>
            ))}
          </Select>
        </Section>

        <div className="flex items-center justify-between px-4 py-3.5 border-b border-line-soft">
          <div>
            <p className="text-[13px]">{t("editor.properties.required")}</p>
            {alwaysRequired ? (
              <p className="text-[11px] text-muted-2">{t("editor.properties.signatureAlwaysRequired")}</p>
            ) : null}
          </div>
          <Toggle
            checked={alwaysRequired || w.options.status === "required"}
            disabled={disabled || alwaysRequired}
            label={t("editor.properties.required")}
            onChange={(v) => patchOptions({ status: v ? "required" : "optional" })}
          />
        </div>

        <Section label={t("editor.properties.signerLabel")}>
          <Input
            className="h-8"
            maxLength={40}
            value={typeof w.options.hint === "string" ? w.options.hint : ""}
            disabled={disabled}
            placeholder={t(typeLabelKey(type))}
            onChange={(e) => patchOptions({ hint: e.target.value }, `hint:${field.id}`)}
          />
        </Section>

        <Section label={t("editor.properties.sizeAndPosition")}>
          <div className="grid grid-cols-2 gap-2">
            <Num label={t("editor.properties.size.width")} value={w.Width} disabled={disabled} onChange={(n) => patch({ Width: Math.max(spec.minWidth, n), IsResize: true }, `w:${field.id}`)} />
            <Num label={t("editor.properties.size.height")} value={w.Height} disabled={disabled} onChange={(n) => patch({ Height: Math.max(spec.minHeight, n), IsResize: true }, `h:${field.id}`)} />
            <Num label={t("editor.properties.size.x")} value={w.xPosition} disabled={disabled} onChange={(n) => patch({ xPosition: n }, `x:${field.id}`)} />
            <Num label={t("editor.properties.size.y")} value={w.yPosition} disabled={disabled} onChange={(n) => patch({ yPosition: n }, `y:${field.id}`)} />
          </div>
          <p className="text-[11px] text-muted-2">{t("editor.properties.measuredFrom", { page: field.page })}</p>
        </Section>

        {type === "date" ? (
          <Section label={t("editor.properties.dateFormat")}>
            <Select
              className="h-8"
              value={typeof w.options.validation?.format === "string" ? w.options.validation.format : ""}
              disabled={disabled}
              aria-label={t("editor.properties.dateFormat")}
              onChange={(e) => patchOptions({ validation: { ...w.options.validation, type: "date-format", format: e.target.value } })}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Section>
        ) : null}

        {values.length || type === "dropdown" || type === "radio button" || type === "checkbox" ? (
          <Section label={t("editor.properties.options")}>
            <div className="flex flex-col gap-1.5">
              {values.map((v, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    className="h-8"
                    value={v}
                    disabled={disabled}
                    onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <button
                    type="button"
                    aria-label={t("editor.properties.removeOption", { index: i + 1 })}
                    disabled={disabled || values.length <= 1}
                    onClick={() => setValues(values.filter((_, j) => j !== i))}
                    className="text-muted-2 hover:text-danger disabled:opacity-40 p-1"
                  >
                    <X className="size-3.5" strokeWidth={1.6} />
                  </button>
                </div>
              ))}
            </div>
            <Button
              size="xs"
              icon={<Plus className="size-3.5" strokeWidth={1.6} />}
              disabled={disabled}
              onClick={() => setValues([...values, `Option-${values.length + 1}`])}
            >
              {t("editor.properties.addOption")}
            </Button>
            {type !== "dropdown" ? (
              <Select
                className="h-8 mt-1"
                aria-label={t("editor.properties.optionLayout")}
                value={w.options.layout ?? "vertical"}
                disabled={disabled}
                onChange={(e) => patchOptions({ layout: e.target.value === "horizontal" ? "horizontal" : "vertical" })}
              >
                <option value="vertical">{t("editor.properties.layout.stacked")}</option>
                <option value="horizontal">{t("editor.properties.layout.sideBySide")}</option>
              </Select>
            ) : null}
          </Section>
        ) : null}

        {type === "checkbox" ? (
          <Section label={t("editor.properties.howManyPicked")}>
            <div className="grid grid-cols-2 gap-2">
              <Num
                label={t("editor.properties.min")}
                value={Number(w.options.validation?.minRequiredCount ?? 0)}
                disabled={disabled}
                onChange={(n) =>
                  patchOptions({ validation: { ...w.options.validation, minRequiredCount: Math.max(0, Math.round(n)) } })
                }
              />
              <Num
                label={t("editor.properties.max")}
                value={Number(w.options.validation?.maxRequiredCount ?? values.length)}
                disabled={disabled}
                onChange={(n) =>
                  patchOptions({ validation: { ...w.options.validation, maxRequiredCount: Math.max(0, Math.round(n)) } })
                }
              />
            </div>
          </Section>
        ) : null}

        {type === "cells" ? (
          <Section label={t("editor.properties.cells")}>
            <Num
              label={t("editor.properties.cellCount")}
              value={Number(w.options.cellCount ?? 5)}
              disabled={disabled}
              onChange={(n) => patchOptions({ cellCount: Math.max(1, Math.round(n)) })}
            />
          </Section>
        ) : null}

        {type === "text input" || type === "cells" || type === "email" ? (
          <Section label={t("editor.properties.validation")}>
            <Select
              className="h-8"
              aria-label={t("editor.properties.validation")}
              value={typeof w.options.validation?.type === "string" ? w.options.validation.type : ""}
              disabled={disabled}
              onChange={(e) => patchOptions({ validation: { ...w.options.validation, type: e.target.value } })}
            >
              {VALIDATION_TYPES.map((v) => (
                <option key={v.value} value={v.value}>
                  {t(v.labelKey)}
                </option>
              ))}
            </Select>
            {w.options.validation?.type === "regex" ? (
              <Input
                className="h-8 font-mono text-[12px]"
                placeholder="^[A-Z]{2}\\d{4}$"
                value={typeof w.options.validation?.pattern === "string" ? w.options.validation.pattern : ""}
                disabled={disabled}
                onChange={(e) => patchOptions({ validation: { ...w.options.validation, pattern: e.target.value } }, `re:${field.id}`)}
              />
            ) : null}
          </Section>
        ) : null}

        {HAS_DEFAULT.includes(type) ? (
          <Section label={t("editor.properties.defaultValue")}>
            <Input
              className="h-8"
              value={typeof w.options.defaultValue === "string" ? w.options.defaultValue : ""}
              disabled={disabled}
              onChange={(e) => patchOptions({ defaultValue: e.target.value }, `dv:${field.id}`)}
              placeholder={t("editor.properties.defaultValuePlaceholder")}
            />
          </Section>
        ) : null}

        {HAS_READONLY.includes(type) ? (
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-line-soft">
            <div>
              <p className="text-[13px]">{t("editor.properties.readOnly")}</p>
              <p className="text-[11px] text-muted-2">{t("editor.properties.readOnlyHelp")}</p>
            </div>
            <Toggle
              checked={w.options.isReadOnly === true}
              disabled={disabled}
              label={t("editor.properties.readOnly")}
              onChange={(v) => patchOptions({ isReadOnly: v })}
            />
          </div>
        ) : null}

        {isTextish ? (
          <Section label={t("editor.properties.textStyle")}>
            <div className="grid grid-cols-2 gap-2">
              <Select
                className="h-8"
                aria-label={t("editor.properties.fontSize")}
                value={String(w.options.fontSize ?? 12)}
                disabled={disabled}
                onChange={(e) => patchOptions({ fontSize: Number(e.target.value) })}
              >
                {FONT_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {t("editor.properties.fontSizeOption", { size: s })}
                  </option>
                ))}
              </Select>
              <Select
                className="h-8"
                aria-label={t("editor.properties.fontColour")}
                value={String(w.options.fontColor ?? "black")}
                disabled={disabled}
                onChange={(e) => patchOptions({ fontColor: e.target.value })}
              >
                {FONT_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {t(`editor.properties.fontColours.${c}`)}
                  </option>
                ))}
              </Select>
            </div>
          </Section>
        ) : null}

        {type === "signature" || type === "initials" ? (
          <Section label={t("editor.properties.rotation")}>
            <Select
              className="h-8"
              aria-label={t("editor.properties.rotation")}
              value={String(w.options.rotation ?? 0)}
              disabled={disabled}
              onChange={(e) => patchOptions({ rotation: Number(e.target.value) })}
            >
              {[0, 90, 180, 270].map((r) => (
                <option key={r} value={r}>
                  {r}°
                </option>
              ))}
            </Select>
          </Section>
        ) : null}

        <Section label={t("editor.properties.dataMapping")}>
          <Input
            className="h-8 font-mono text-[12px]"
            value={w.options.name}
            disabled={disabled}
            onChange={(e) => patchOptions({ name: e.target.value }, `name:${field.id}`)}
          />
          <p className="text-[11px] text-muted-2">{t("editor.properties.dataMappingHelp")}</p>
        </Section>
      </div>

      <div className="shrink-0 border-t border-line p-3 flex flex-col gap-2">
        <Button
          block
          size="sm"
          icon={<Copy className="size-3.5" strokeWidth={1.6} />}
          disabled={disabled}
          onClick={onCopyToPages}
        >
          {t("editor.properties.copyToEveryPage")}
        </Button>
        <Button
          block
          size="sm"
          variant="danger"
          icon={<Trash2 className="size-3.5" strokeWidth={1.6} />}
          kbd="⌫"
          disabled={disabled}
          onClick={onDelete}
        >
          {t("editor.properties.deleteField")}
        </Button>
      </div>
    </aside>
  );
}
