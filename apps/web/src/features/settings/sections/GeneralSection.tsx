import { useTranslation } from "react-i18next";
import { Field, Input, Pill } from "@/components/ui";
import { SERVER_URL } from "@/lib/parse";
import { isAdminRole, useExtUser } from "@/lib/extUser";
import { useTenant } from "../api";
import { FormColumn, Grid2, NotAvailableNote, ReadOnlyRow, SectionCard, SectionError, SectionLoading } from "../parts";

export default function GeneralSection() {
  const { t } = useTranslation();
  const { data: extUser } = useExtUser();
  const { data: tenant, isPending, error, refetch } = useTenant();
  const admin = isAdminRole(extUser?.UserRole);

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending) return <SectionLoading />;

  if (!tenant) {
    return (
      <FormColumn>
        <SectionCard title={t("settings.general.workspace.title")}>
          <p className="text-[13px] text-muted">{t("settings.general.workspace.missing")}</p>
        </SectionCard>
      </FormColumn>
    );
  }

  const address = [tenant.Address, tenant.City, tenant.State, tenant.PinCode, tenant.Country].filter(Boolean).join(", ");

  return (
    <FormColumn>
      <SectionCard
        title={t("settings.general.workspace.title")}
        note={t("settings.general.workspace.note")}
        aside={
          tenant.IsActive === false ? (
            <Pill tone="danger">{t("settings.general.workspace.inactive")}</Pill>
          ) : (
            <Pill tone="accent">{t("settings.general.workspace.active")}</Pill>
          )
        }
      >
        <Grid2>
          <Field label={t("settings.general.workspace.name")}>
            <Input value={tenant.TenantName ?? ""} readOnly disabled />
          </Field>
          <Field label={t("settings.general.workspace.contactEmail")}>
            <Input value={tenant.EmailAddress ?? ""} readOnly disabled />
          </Field>
          <Field label={t("settings.general.workspace.contactNumber")}>
            <Input value={tenant.ContactNumber ?? ""} readOnly disabled />
          </Field>
          <Field label={t("settings.general.workspace.domain")}>
            <Input
              value={tenant.Domain ?? ""}
              readOnly
              disabled
              placeholder={t("settings.general.workspace.domainPlaceholder")}
            />
          </Field>
        </Grid2>
        {address ? (
          <Field label={t("settings.general.workspace.address")}>
            <Input value={address} readOnly disabled />
          </Field>
        ) : null}
        <NotAvailableNote>
          {admin ? t("settings.general.workspace.adminNote") : t("settings.general.workspace.memberNote")}
        </NotAvailableNote>
      </SectionCard>

      <SectionCard title={t("settings.general.install.title")} note={t("settings.general.install.note")}>
        <ReadOnlyRow label={t("settings.general.install.appUrl")} value={window.location.origin} mono />
        <ReadOnlyRow label={t("settings.general.install.apiUrl")} value={SERVER_URL} mono />
        <ReadOnlyRow label={t("settings.general.install.workspaceId")} value={tenant.objectId} mono />
        {tenant.createdAt ? (
          <ReadOnlyRow
            label={t("settings.general.install.created")}
            value={new Date(tenant.createdAt).toLocaleDateString()}
          />
        ) : null}
      </SectionCard>
    </FormColumn>
  );
}
