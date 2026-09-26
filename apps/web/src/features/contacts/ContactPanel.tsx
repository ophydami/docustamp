import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MoreHorizontal, X } from "lucide-react";
import { Avatar, Button, Cap, Menu, Pill, toast } from "@/components/ui";
import type { PillTone } from "@/components/ui";
import { whenShort } from "@/lib/format";
import { remindError, remindErrorTitle, remindSummary } from "@/lib/reminder";
import { sendReminders } from "./api";
import type { Contact, ContactStats, DocStatus } from "./types";

const TONES: Record<DocStatus, PillTone> = {
  draft: "neutral",
  waiting: "warn",
  completed: "ink",
  declined: "danger",
  expired: "danger"
};

const STATUS_KEYS: Record<DocStatus, string> = {
  draft: "common.status.draft",
  waiting: "contacts.status.waiting",
  completed: "common.status.completed",
  declined: "common.status.declined",
  expired: "common.status.expired"
};

/** "38m", "6h", "1.4 days" */
function duration(t: TFunction, ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return t("contacts.duration.minutes", { count: Math.max(1, minutes) });
  const hours = minutes / 60;
  if (hours < 36) return t("contacts.duration.hours", { count: Math.round(hours) });
  const days = hours / 24;
  return t("contacts.duration.days", { count: days, value: days.toFixed(1) });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-baseline">
      <Cap className="w-[70px] shrink-0 pt-px">{label}</Cap>
      <div className="text-[13px] min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function ContactPanel({
  contact,
  stats,
  onClose,
  onEdit,
  onDelete
}: {
  contact: Contact;
  stats?: ContactStats;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [reminding, setReminding] = useState(false);

  const firstName = contact.name.split(/\s+/)[0] || contact.email;
  const docs = stats?.docs ?? [];
  const shown = showAll ? docs : docs.slice(0, 5);
  const pendingDocs = docs.filter((d) => d.pending);

  async function remind() {
    setReminding(true);
    try {
      const totals = await sendReminders(pendingDocs);
      const { title, detail } = remindSummary(totals);
      const only = totals.failed.length === 1 ? totals.failed[0] : undefined;
      if (totals.sent.length) toast.success(title, detail);
      else if (only) toast.error(remindErrorTitle(only.code), only.message);
      else toast.show(title, detail);
    } catch (err) {
      const { title, detail } = remindError(err);
      toast.error(title, detail);
    } finally {
      setReminding(false);
    }
  }

  return (
    <aside
      className={
        // Below 768px the panel is a full-screen sheet over the list; from there
        // up it is the usual right-hand column.
        "bg-surface flex flex-col min-h-0 fixed inset-0 z-40 " +
        "md:static md:inset-auto md:z-auto md:w-[360px] md:shrink-0 md:border-l md:border-line"
      }
    >
      <div className="flex items-start gap-3 px-5 pt-5 pb-4">
        <Avatar name={contact.name} email={contact.email} size={44} />
        <div className="flex-1 min-w-0">
          <h2 className="font-serif text-[20px] leading-tight truncate">{contact.name || contact.email}</h2>
          <p className="text-[12px] text-muted truncate">
            {[contact.jobTitle, contact.company].filter(Boolean).join(" · ") ||
              t("contacts.panel.noCompanyOnFile")}
          </p>
        </div>
        <Menu
          trigger={(p) => (
            <button
              type="button"
              aria-label={t("contacts.a11y.contactActions")}
              className="text-muted-2 hover:text-ink p-1 -mr-1"
              {...p}
            >
              <MoreHorizontal className="size-4" strokeWidth={1.6} />
            </button>
          )}
          items={[
            {
              label: t("contacts.actions.sendDocument"),
              onSelect: () => navigate(`/send?to=${encodeURIComponent(contact.email)}`)
            },
            { label: t("common.actions.edit"), onSelect: onEdit },
            "separator",
            { label: t("common.actions.delete"), danger: true, onSelect: onDelete }
          ]}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("contacts.a11y.closePanel")}
          className="text-muted-2 hover:text-ink p-1"
        >
          <X className="size-4" strokeWidth={1.6} />
        </button>
      </div>

      <div className="px-5 flex gap-2">
        <Button
          variant="primary"
          className="flex-1"
          onClick={() => navigate(`/send?to=${encodeURIComponent(contact.email)}`)}
        >
          {t("contacts.actions.sendDocument")}
        </Button>
        {pendingDocs.length ? (
          <Button onClick={remind} loading={reminding}>
            {t("contacts.actions.remind", { count: pendingDocs.length })}
          </Button>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-5 py-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <Row label={t("contacts.fields.email")}>
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </Row>
          {contact.phone ? <Row label={t("contacts.fields.phone")}>{contact.phone}</Row> : null}
          {contact.createdAt ? (
            <Row label={t("contacts.fields.added")}>
              <span className="text-ink-2">{whenShort(contact.createdAt)}</span>
            </Row>
          ) : null}
          <Row label={t("contacts.fields.signsIn")}>
            {stats?.medianSignMs != null ? (
              <span className="text-ink-2">
                {t("contacts.panel.median", { value: duration(t, stats.medianSignMs) })} ·{" "}
                {t("common.count.document", { count: stats.signedCount })}
              </span>
            ) : (
              <span className="text-muted-2">{t("contacts.panel.notEnoughSigned")}</span>
            )}
          </Row>
        </div>

        <div className="flex flex-col gap-2">
          <Cap>{t("contacts.panel.documentsWith", { name: firstName })}</Cap>
          {docs.length ? (
            <>
              <ul className="flex flex-col">
                {shown.map((d) => (
                  <li key={d.objectId}>
                    <button
                      type="button"
                      onClick={() => navigate(`/documents/${d.objectId}`)}
                      className="w-full flex items-center gap-2 py-2 text-left border-b border-line-soft hover:bg-surface-2"
                    >
                      <span className="flex-1 min-w-0 truncate text-[13px]">{d.name}</span>
                      <Pill tone={TONES[d.status]}>{t(STATUS_KEYS[d.status])}</Pill>
                    </button>
                  </li>
                ))}
              </ul>
              {docs.length > shown.length ? (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="self-start text-[12px] text-accent hover:text-accent-deep"
                >
                  {t("contacts.panel.seeAll", { count: docs.length })}
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-[13px] text-muted-2">{t("contacts.panel.noDocuments")}</p>
          )}
        </div>
      </div>
    </aside>
  );
}
