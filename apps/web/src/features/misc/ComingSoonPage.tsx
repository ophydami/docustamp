import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";

/**
 * Placeholder for routes that are not built yet. `titleKey` names the heading in
 * the locale file (the router passes the nav label's key); `title` takes a ready
 * string when a caller already has one.
 */
export default function ComingSoonPage({ title, titleKey }: { title?: string; titleKey?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center">
      <EmptyState title={title ?? t(titleKey ?? "misc.comingSoon.title")} body={t("misc.comingSoon.body")} />
    </div>
  );
}
