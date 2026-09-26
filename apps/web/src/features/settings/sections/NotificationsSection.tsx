import { Trans, useTranslation } from "react-i18next";
import { Toggle } from "@/components/ui";
import { useExtUser } from "@/lib/extUser";
import { updatePreferences, useInvalidateExtUser } from "../api";
import { FormColumn, SectionCard, SectionError, SectionLoading, ToggleRow } from "../parts";
import { useSectionForm } from "../sectionForm";

interface NotificationValues {
  NotifyOnSignatures: boolean;
}

export default function NotificationsSection() {
  const { t } = useTranslation();
  const { data: extUser, isPending, error, refetch } = useExtUser();
  const invalidateExtUser = useInvalidateExtUser();

  const initial: NotificationValues | null = extUser
    ? { NotifyOnSignatures: extUser.NotifyOnSignatures !== false }
    : null;

  const form = useSectionForm<NotificationValues>({
    initial,
    successTitle: t("settings.notifications.toast.saved"),
    errorTitle: t("settings.notifications.toast.saveFailed"),
    save: async (v) => {
      // Only the key this screen owns: `updatepreferences` accepts a patch of
      // one, and sending a browser-guessed Timezone alongside used to rewrite
      // the stored zone every time somebody toggled a notification.
      await updatePreferences({ NotifyOnSignatures: v.NotifyOnSignatures });
      await invalidateExtUser();
    }
  });

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending || !form.values) return <SectionLoading />;
  const v = form.values;

  return (
    <FormColumn>
      <SectionCard
        title={t("settings.notifications.emailMeAbout.title")}
        note={t("settings.notifications.emailMeAbout.note")}
      >
        <ToggleRow
          label={t("settings.notifications.emailMeAbout.eachSignature")}
          description={t("settings.notifications.emailMeAbout.eachSignatureHint")}
          control={
            <Toggle
              checked={v.NotifyOnSignatures}
              onChange={(c) => form.set({ NotifyOnSignatures: c })}
              label={t("settings.notifications.emailMeAbout.toggleLabel")}
            />
          }
        />
      </SectionCard>

      <SectionCard title={t("settings.notifications.always.title")}>
        <ul className="flex flex-col gap-2.5 text-[12px] text-muted leading-relaxed">
          <li>
            <Trans
              i18nKey="settings.notifications.always.completed"
              components={{ 1: <span className="text-ink-2 font-medium" /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="settings.notifications.always.declined"
              components={{ 1: <span className="text-ink-2 font-medium" /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="settings.notifications.always.requests"
              components={{ 1: <span className="text-ink-2 font-medium" /> }}
            />
          </li>
        </ul>
        <p className="text-[11px] text-muted-2 leading-relaxed">{t("settings.notifications.always.note")}</p>
      </SectionCard>
    </FormColumn>
  );
}
