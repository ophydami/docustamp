import { useTranslation } from "react-i18next";
import { Checkbox, Field, Select, Toggle, toast } from "@/components/ui";
import { useExtUser } from "@/lib/extUser";
import {
  setDateWidgetPreference,
  updatePreferences,
  updateSignatureTypes,
  useInvalidateExtUser,
  useTenant
} from "../api";
import { DATE_FORMATS, FILENAME_FORMATS, browserTimezone, filenameFormatLabel, timezoneList } from "../constants";
import type { DateWidgetPreference, SignatureTypeEntry } from "../types";
import { FormColumn, Grid2, SectionCard, SectionError, SectionLoading, ToggleRow } from "../parts";
import { useSectionForm } from "../sectionForm";

const DEFAULT_TYPES: SignatureTypeEntry[] = [
  { name: "draw", enabled: true },
  { name: "typed", enabled: true },
  { name: "upload", enabled: true },
  { name: "default", enabled: true }
];

interface SigningValues {
  SignatureType: SignatureTypeEntry[];
  SendinOrder: boolean;
  NotifyOnSignatures: boolean;
  IsTourEnabled: boolean;
  IsLTVEnabled: boolean;
  Is12HourTime: boolean;
  DateFormat: string;
  Timezone: string;
  DownloadFilenameFormat: string;
  dateIsSigningDate: boolean;
  dateIsReadOnly: boolean;
}

function readDateWidget(pref: unknown): DateWidgetPreference | undefined {
  if (!Array.isArray(pref)) return undefined;
  return (pref as DateWidgetPreference[]).find((p) => p?.type === "date");
}

export default function SigningDefaultsSection() {
  const { t } = useTranslation();
  const { data: extUser, isPending, error, refetch } = useExtUser();
  const { data: tenant } = useTenant();
  const invalidateExtUser = useInvalidateExtUser();
  const zones = timezoneList();

  const tenantTypes = (tenant?.SignatureType ?? []).filter((entry) => entry?.name);
  const base = tenantTypes.length ? tenantTypes : DEFAULT_TYPES;
  const userTypes = Array.isArray(extUser?.SignatureType) ? (extUser.SignatureType as SignatureTypeEntry[]) : [];
  const dateWidget = readDateWidget(extUser?.WidgetPreferences);

  const initial: SigningValues | null = extUser
    ? {
        SignatureType: base.map((entry) => ({
          name: entry.name,
          enabled: userTypes.find((u) => u.name === entry.name)?.enabled ?? entry.enabled !== false
        })),
        SendinOrder: extUser.SendinOrder !== false,
        NotifyOnSignatures: extUser.NotifyOnSignatures !== false,
        IsTourEnabled: extUser.IsTourEnabled !== false,
        IsLTVEnabled: extUser.IsLTVEnabled === true,
        Is12HourTime: extUser.Is12HourTime === true,
        DateFormat: (extUser.DateFormat as string | undefined) ?? "MM/DD/YYYY",
        Timezone: (extUser.Timezone as string | undefined) ?? browserTimezone(),
        DownloadFilenameFormat: (extUser.DownloadFilenameFormat as string | undefined) ?? "DOCNAME",
        dateIsSigningDate: dateWidget?.isSigningDate === true,
        dateIsReadOnly: dateWidget?.isReadOnly === true
      }
    : null;

  const form = useSectionForm<SigningValues>({
    initial,
    successTitle: t("settings.signing.toast.saved"),
    errorTitle: t("settings.signing.toast.saveFailed"),
    save: async (v) => {
      const enabled = v.SignatureType.filter((entry) => entry.enabled);
      if (!enabled.length) throw new Error(t("settings.signing.errors.noTypes"));
      if (enabled.length === 1 && enabled[0].name === "default") {
        throw new Error(t("settings.signing.errors.onlyDefault"));
      }
      await updateSignatureTypes(v.SignatureType);
      await updatePreferences({
        Timezone: v.Timezone,
        NotifyOnSignatures: v.NotifyOnSignatures,
        SendinOrder: v.SendinOrder,
        IsTourEnabled: v.IsTourEnabled,
        IsLTVEnabled: v.IsLTVEnabled,
        Is12HourTime: v.Is12HourTime,
        DateFormat: v.DateFormat,
        DownloadFilenameFormat: v.DownloadFilenameFormat
      });
      await setDateWidgetPreference({
        isSigningDate: v.dateIsSigningDate,
        isReadOnly: v.dateIsReadOnly,
        date: dateWidget?.date ?? "",
        format: dateWidget?.format ?? "MM/dd/yyyy"
      });
      await invalidateExtUser();
    }
  });

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending || !form.values) return <SectionLoading />;
  const v = form.values;

  const toggleType = (name: string, on: boolean) => {
    form.set({
      SignatureType: v.SignatureType.map((entry) => (entry.name === name ? { ...entry, enabled: on } : entry))
    });
  };

  const filenameExample = FILENAME_FORMATS.find((f) => f.value === v.DownloadFilenameFormat)?.example;
  const typeLabel = (name: string) => t(`settings.signing.types.labels.${name}`, { defaultValue: name });

  return (
    <FormColumn>
      <SectionCard title={t("settings.signing.types.title")} note={t("settings.signing.types.note")}>
        <div className="flex flex-col gap-2.5">
          {v.SignatureType.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className="flex items-center gap-2.5 text-left"
              onClick={() => toggleType(entry.name, !entry.enabled)}
            >
              <Checkbox checked={entry.enabled} onChange={(on) => toggleType(entry.name, on)} label={typeLabel(entry.name)} />
              <span className="text-[13px]">{typeLabel(entry.name)}</span>
            </button>
          ))}
        </div>
        {tenantTypes.length ? (
          <p className="text-[11px] text-muted-2">{t("settings.signing.types.workspaceNote")}</p>
        ) : null}
      </SectionCard>

      <SectionCard title={t("settings.signing.sending.title")} note={t("settings.signing.sending.note")}>
        <ToggleRow
          label={t("settings.signing.sending.inOrder")}
          description={t("settings.signing.sending.inOrderHint")}
          control={
            <Toggle
              checked={v.SendinOrder}
              onChange={(c) => form.set({ SendinOrder: c })}
              label={t("settings.signing.sending.inOrder")}
            />
          }
        />
        <ToggleRow
          label={t("settings.signing.sending.notify")}
          description={t("settings.signing.sending.notifyHint")}
          control={
            <Toggle
              checked={v.NotifyOnSignatures}
              onChange={(c) => form.set({ NotifyOnSignatures: c })}
              label={t("settings.signing.sending.notifyToggle")}
            />
          }
        />
        <ToggleRow
          label={t("settings.signing.sending.tour")}
          description={t("settings.signing.sending.tourHint")}
          control={
            <Toggle
              checked={v.IsTourEnabled}
              onChange={(c) => form.set({ IsTourEnabled: c })}
              label={t("settings.signing.sending.tourToggle")}
            />
          }
        />
        <ToggleRow
          label={t("settings.signing.sending.ltv")}
          description={t("settings.signing.sending.ltvHint")}
          control={<Toggle checked={v.IsLTVEnabled} onChange={(c) => form.set({ IsLTVEnabled: c })} label="LTV" />}
        />
      </SectionCard>

      <SectionCard title={t("settings.signing.dates.title")} note={t("settings.signing.dates.note")}>
        <Grid2>
          <Field label={t("settings.signing.dates.dateFormat")}>
            <Select value={v.DateFormat} onChange={(e) => form.set({ DateFormat: e.target.value })}>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("settings.signing.dates.clock")}>
            <Select
              value={v.Is12HourTime ? "12" : "24"}
              onChange={(e) => form.set({ Is12HourTime: e.target.value === "12" })}
            >
              <option value="24">{t("settings.signing.dates.clock24")}</option>
              <option value="12">{t("settings.signing.dates.clock12")}</option>
            </Select>
          </Field>
        </Grid2>
        <Field label={t("settings.signing.dates.timezone")} hint={t("settings.signing.dates.timezoneHint")}>
          <Select value={v.Timezone} onChange={(e) => form.set({ Timezone: e.target.value })}>
            {zones.includes(v.Timezone) ? null : <option value={v.Timezone}>{v.Timezone}</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("settings.signing.dates.filename")} hint={filenameExample}>
          <Select
            value={v.DownloadFilenameFormat}
            onChange={(e) => form.set({ DownloadFilenameFormat: e.target.value })}
          >
            {FILENAME_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {filenameFormatLabel(t, f.value)}
              </option>
            ))}
          </Select>
        </Field>
      </SectionCard>

      <SectionCard title={t("settings.signing.dateFields.title")} note={t("settings.signing.dateFields.note")}>
        <ToggleRow
          label={t("settings.signing.dateFields.useSigningDate")}
          description={t("settings.signing.dateFields.useSigningDateHint")}
          control={
            <Toggle
              checked={v.dateIsSigningDate}
              onChange={(c) => form.set({ dateIsSigningDate: c })}
              label={t("settings.signing.dateFields.useSigningDateToggle")}
            />
          }
        />
        <ToggleRow
          label={t("settings.signing.dateFields.readOnly")}
          description={t("settings.signing.dateFields.readOnlyHint")}
          control={
            <Toggle
              checked={v.dateIsReadOnly}
              onChange={(c) => {
                if (c && !v.dateIsSigningDate) {
                  toast.show(
                    t("settings.signing.dateFields.sourceToast"),
                    t("settings.signing.dateFields.sourceToastBody")
                  );
                }
                form.set({ dateIsReadOnly: c });
              }}
              label={t("settings.signing.dateFields.readOnlyToggle")}
            />
          }
        />
      </SectionCard>

      <SectionCard title={t("settings.signing.perRequest.title")}>
        <p className="text-[12px] text-muted leading-relaxed">{t("settings.signing.perRequest.body")}</p>
      </SectionCard>
    </FormColumn>
  );
}
