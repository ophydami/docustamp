import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";
import { FormColumn, SectionCard } from "../parts";

export default function BillingSection() {
  const { t } = useTranslation();
  return (
    <FormColumn className="max-w-[560px]">
      <SectionCard>
        <EmptyState title={t("settings.billing.title")} body={t("settings.billing.body")} />
      </SectionCard>
    </FormColumn>
  );
}
