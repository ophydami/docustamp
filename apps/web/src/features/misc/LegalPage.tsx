import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Cap } from "@/components/ui";
import { useBrand } from "@/lib/brand";

export type LegalKind = "terms" | "privacy" | "status";

/** Placeholder legal/status pages so footer links resolve. Content is bracketed on purpose. */
export default function LegalPage({ kind }: { kind: LegalKind }) {
  const { t } = useTranslation();
  const { name } = useBrand();
  return (
    <div className="min-h-full bg-ground flex justify-center py-16 px-6">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <Link to="/login" className="text-[13px]">
          ← {t("common.actions.back")}
        </Link>
        <Cap>{name}</Cap>
        <h1 className="font-semibold text-[24px] tracking-[-.015em]">{t(`misc.legal.${kind}.title`)}</h1>
        <p className="text-[14px] text-ink-2 leading-relaxed">{t(`misc.legal.${kind}.body`)}</p>
      </div>
    </div>
  );
}
