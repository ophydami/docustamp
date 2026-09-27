import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, MoreVertical, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Button, Cap, Card, Field, Input, Menu, Select, Textarea, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useContactSearch } from "../api";
import { MoreOptions } from "./MoreOptions";
import {
  EXPIRY_OPTIONS,
  REMINDER_OPTIONS,
  isEmail,
  type ContactRecord,
  type Recipient,
  type RecipientRole,
  type SendMessage,
  type SendSettings
} from "../types";

export interface StepRecipientsProps {
  recipients: Recipient[];
  onPatch: (key: string, patch: Partial<Recipient>) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onAdd: (role: RecipientRole) => void;
  onAddMe: () => void;
  onOpenContacts: () => void;
  meAlreadyAdded: boolean;
  settings: SendSettings;
  onSettings: (patch: Partial<SendSettings>) => void;
  message: SendMessage;
  onMessage: (patch: Partial<SendMessage>) => void;
}

export function StepRecipients(props: StepRecipientsProps) {
  const { t } = useTranslation();
  const signers = props.recipients.filter((r) => r.role === "signer");

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[22px] leading-tight tracking-[-.015em]">{t("send.recipients.title")}</h1>
        <p className="text-[13px] text-muted">{t("send.recipients.subtitle")}</p>
      </div>

      <Card className="px-4 py-3.5 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Toggle
            checked={props.settings.sendInOrder}
            onChange={(v) => props.onSettings({ sendInOrder: v })}
            label={t("send.recipients.sendInOrder")}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-semibold">{t("send.recipients.sendInOrder")}</span>
            <span className="text-[12px] text-muted">
              {props.settings.sendInOrder
                ? t("send.recipients.sendInOrderOn")
                : t("send.recipients.sendInOrderOff")}
            </span>
          </div>
        </div>
        {props.settings.sendInOrder ? (
          <div className="flex items-start gap-3 pl-[46px]">
            <Toggle
              checked={props.settings.strictOrder}
              onChange={(v) => props.onSettings({ strictOrder: v })}
              label={t("send.recipients.strictOrder")}
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold">{t("send.recipients.strictOrder")}</span>
              <span className="text-[12px] text-muted">{t("send.recipients.strictOrderHint")}</span>
            </div>
          </div>
        ) : null}
      </Card>

      <div className="flex flex-col gap-2.5">
        {props.recipients.map((r, index) => (
          <RecipientCard
            key={r.key}
            recipient={r}
            /** Signing position, counted over signers only. */
            position={r.role === "signer" ? signers.findIndex((s) => s.key === r.key) + 1 : 0}
            showOrder={props.settings.sendInOrder}
            canMoveUp={index > 0}
            canMoveDown={index < props.recipients.length - 1}
            onPatch={(patch) => props.onPatch(r.key, patch)}
            onRemove={() => props.onRemove(r.key)}
            onMove={(d) => props.onMove(r.key, d)}
          />
        ))}
        {props.recipients.length === 0 ? (
          <p className="text-[12px] text-muted-2 border border-dashed border-line-strong rounded-lg px-4 py-6 text-center">
            {t("send.recipients.empty")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" strokeWidth={1.6} />} onClick={() => props.onAdd("signer")}>
          {t("send.actions.addRecipient")}
        </Button>
        <Button size="sm" icon={<Users className="size-3.5" strokeWidth={1.6} />} onClick={props.onOpenContacts}>
          {t("send.actions.fromContacts")}
        </Button>
        <Button size="sm" icon={<Plus className="size-3.5" strokeWidth={1.6} />} onClick={() => props.onAdd("cc")}>
          {t("send.actions.addCc")}
        </Button>
        <Button
          size="sm"
          icon={<UserPlus className="size-3.5" strokeWidth={1.6} />}
          onClick={props.onAddMe}
          disabled={props.meAlreadyAdded}
        >
          {t("send.actions.addMe")}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <Cap>{t("send.message.heading")}</Cap>
        <Field label={t("send.message.subject")}>
          <Input
            value={props.message.subject}
            onChange={(e) => props.onMessage({ subject: e.target.value })}
            placeholder={t("send.message.subjectPlaceholder")}
          />
        </Field>
        {/* The `{{var}}` markers in the hint are the mail merge's, not i18next's:
            unknown interpolation variables are left untouched. */}
        <Field label={t("send.message.body")} hint={t("send.message.bodyHint")}>
          <Textarea
            rows={6}
            value={props.message.body}
            onChange={(e) => props.onMessage({ body: e.target.value })}
            placeholder={t("send.message.bodyPlaceholder")}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <Cap>{t("send.settings.heading")}</Cap>
        <Card className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 px-4 py-4">
          <Field label={t("send.settings.expires")}>
            <Select
              value={props.settings.expiryDays}
              onChange={(e) => props.onSettings({ expiryDays: Number(e.target.value) })}
            >
              {EXPIRY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {t("common.count.day", { count: d })}
                </option>
              ))}
              {EXPIRY_OPTIONS.includes(props.settings.expiryDays as (typeof EXPIRY_OPTIONS)[number]) ? null : (
                <option value={props.settings.expiryDays}>
                  {t("common.count.day", { count: props.settings.expiryDays })}
                </option>
              )}
            </Select>
          </Field>
          <Field label={t("send.settings.reminders")}>
            <Select
              value={props.settings.remindEveryDays}
              onChange={(e) => props.onSettings({ remindEveryDays: Number(e.target.value) })}
            >
              {REMINDER_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? t("common.state.none") : t("send.settings.everyDays", { count: d })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("send.settings.signerCheck")}>
            <Select
              value={props.settings.auth}
              onChange={(e) => props.onSettings({ auth: e.target.value === "otp" ? "otp" : "link" })}
            >
              <option value="link">{t("send.settings.emailLink")}</option>
              <option value="otp">{t("send.settings.emailCode")}</option>
            </Select>
          </Field>
          <Field label={t("send.settings.notifyMe")}>
            <div className="h-9 flex items-center">
              <Toggle
                checked={props.settings.notifyOnSignatures}
                onChange={(v) => props.onSettings({ notifyOnSignatures: v })}
                label={t("send.recipients.notifyToggle")}
              />
            </div>
          </Field>
        </Card>
        <MoreOptions settings={props.settings} onSettings={props.onSettings} />
        <p className="text-[11px] text-muted-2">{t("send.recipients.reminderNote")}</p>
      </div>
    </div>
  );
}

function RecipientCard({
  recipient,
  position,
  showOrder,
  canMoveUp,
  canMoveDown,
  onPatch,
  onRemove,
  onMove
}: {
  recipient: Recipient;
  position: number;
  showOrder: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPatch: (patch: Partial<Recipient>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const { data: matches } = useContactSearch(focused ? recipient.email : "");
  const suggestions = (matches ?? [])
    .filter((c) => c.email.toLowerCase() !== recipient.email.trim().toLowerCase())
    .slice(0, 5);
  const invalidEmail = recipient.email.length > 0 && !isEmail(recipient.email);

  function pick(contact: ContactRecord) {
    onPatch({ name: contact.name || recipient.name, email: contact.email, contactId: contact.objectId });
    setFocused(false);
  }

  return (
    <div
      className={cn(
        "swatch relative bg-surface border border-line rounded-xl pl-4 pr-3 py-3 items-start gap-x-3 gap-y-2 grid",
        // Under 768 the inputs stack: number and menu keep the top row, the fields
        // run down the middle column.
        "grid-cols-[28px_minmax(0,1fr)_28px]",
        "md:gap-3 md:grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_128px_28px]"
      )}
      style={{ ["--swatch" as string]: recipient.color, boxShadow: "inset 3px 0 0 0 var(--swatch-on)" }}
    >
      <span className="num mt-2 text-[12px] font-semibold text-muted-2 col-start-1 row-start-1">
        {recipient.role === "signer" ? (showOrder ? position : "•") : "cc"}
      </span>

      <Input
        className="col-start-2 row-start-1"
        value={recipient.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        placeholder={t("send.placeholders.fullName")}
        aria-label={t("send.a11y.recipientName")}
      />

      <div className="relative col-start-2 row-start-2 md:col-start-3 md:row-start-1">
        <Input
          type="email"
          value={recipient.email}
          invalid={invalidEmail}
          onChange={(e) => onPatch({ email: e.target.value, contactId: undefined })}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          placeholder={t("send.placeholders.email")}
          aria-label={t("send.a11y.recipientEmail")}
        />
        {focused && suggestions.length ? (
          <ul className="absolute z-30 mt-1 w-full bg-surface border border-line rounded-xl shadow-[var(--shadow-pop)] py-1 max-h-56 overflow-y-auto scroll-thin">
            {suggestions.map((c) => (
              <li key={c.objectId}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                  className="w-full text-left px-3 py-1.5 hover:bg-line-soft"
                >
                  <span className="block text-[13px] truncate">{c.name || c.email}</span>
                  <span className="block text-[11px] text-muted-2 truncate">{c.email}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {invalidEmail ? (
          <span className="block mt-1 text-[11px] text-danger">{t("send.recipients.invalidEmail")}</span>
        ) : null}
      </div>

      <Select
        className="col-start-2 row-start-3 md:col-start-4 md:row-start-1"
        value={recipient.role}
        onChange={(e) => onPatch({ role: e.target.value === "cc" ? "cc" : "signer" })}
        aria-label={t("send.a11y.role")}
      >
        <option value="signer">{t("send.recipients.roleSigner")}</option>
        <option value="cc">{t("send.recipients.roleCc")}</option>
      </Select>

      <Menu
        align="right"
        className={cn("mt-0.5 col-start-3 row-start-1 md:col-start-5")}
        trigger={(triggerProps) => (
          <button
            type="button"
            aria-label={t("send.a11y.recipientOptions")}
            className="size-8 inline-flex items-center justify-center rounded-md text-muted-2 hover:bg-line-soft"
            {...triggerProps}
          >
            <MoreVertical className="size-4" strokeWidth={1.6} />
          </button>
        )}
        items={[
          {
            label: t("send.recipients.moveUp"),
            icon: <ArrowUp className="size-3.5" strokeWidth={1.6} />,
            disabled: !canMoveUp,
            onSelect: () => onMove(-1)
          },
          {
            label: t("send.recipients.moveDown"),
            icon: <ArrowDown className="size-3.5" strokeWidth={1.6} />,
            disabled: !canMoveDown,
            onSelect: () => onMove(1)
          },
          "separator",
          {
            label: t("common.actions.remove"),
            danger: true,
            icon: <Trash2 className="size-3.5" strokeWidth={1.6} />,
            onSelect: onRemove
          }
        ]}
      />
    </div>
  );
}
