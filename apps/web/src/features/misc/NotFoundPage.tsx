import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, EmptyState } from "@/components/ui";

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex items-center justify-center">
      <EmptyState
        title={t("misc.notFound.title")}
        body={t("misc.notFound.body")}
        action={
          <Link to="/inbox">
            <Button variant="primary">{t("misc.notFound.action")}</Button>
          </Link>
        }
      />
    </div>
  );
}
