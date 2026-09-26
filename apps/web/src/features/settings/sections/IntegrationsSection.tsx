import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, EmptyState } from "@/components/ui";
import { FormColumn, SectionCard } from "../parts";

export default function IntegrationsSection() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <FormColumn className="max-w-[560px]">
      <SectionCard>
        <EmptyState
          title={t("settings.integrations.title")}
          body={t("settings.integrations.body")}
          action={
            <Button size="sm" onClick={() => navigate("/settings/api")}>
              {t("settings.integrations.seeApi")}
            </Button>
          }
        />
      </SectionCard>
    </FormColumn>
  );
}
