import { useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Trash2, Upload } from "lucide-react";
import { Avatar, Button, Dialog, Field, Input, LanguageSelect, Select, ThemeSegment, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { currentLang } from "@/lib/i18n";
import { Parse } from "@/lib/parse";
import { isAdminRole, useExtUser } from "@/lib/extUser";
import {
  compressImage,
  requestAccountDeletion,
  saveUserAccount,
  updateExtUser,
  updatePreferences,
  uploadImage,
  useInvalidateExtUser
} from "../api";
import { DATE_FORMATS, browserTimezone, timezoneList, zoneOffsetLabel } from "../constants";
import { FormColumn, Grid2, SectionCard, SectionError, SectionLoading, ToggleRow } from "../parts";
import { useSectionForm } from "../sectionForm";

interface ProfileValues {
  Name: string;
  Phone: string;
  Company: string;
  JobTitle: string;
  Timezone: string;
  Language: string;
  DateFormat: string;
  ProfilePic: string;
}

export default function ProfileSection() {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const { data: extUser, isPending, error, refetch } = useExtUser();
  const invalidateExtUser = useInvalidateExtUser();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const zones = useMemo(() => timezoneList(), []);

  const initial: ProfileValues | null = extUser
    ? {
        Name: extUser.Name ?? "",
        Phone: extUser.Phone ?? "",
        Company: extUser.Company ?? "",
        JobTitle: extUser.JobTitle ?? "",
        Timezone: extUser.Timezone ?? browserTimezone(),
        // What the UI is showing now, so Save records the language the user sees.
        Language: currentLang(),
        DateFormat: extUser.DateFormat ?? "MM/DD/YYYY",
        ProfilePic: (Parse.User.current()?.get("ProfilePic") as string | undefined) ?? ""
      }
    : null;

  const form = useSectionForm<ProfileValues>({
    initial,
    successTitle: t("settings.profile.toast.saved"),
    errorTitle: t("settings.profile.toast.saveFailed"),
    save: async (v) => {
      if (!extUser?.objectId) throw new Error(t("settings.profile.toast.missingRow"));
      await updateExtUser({
        Name: v.Name,
        Phone: v.Phone,
        Company: v.Company,
        JobTitle: v.JobTitle,
        Language: v.Language
      });
      await updatePreferences({ Timezone: v.Timezone, DateFormat: v.DateFormat });
      await saveUserAccount({ name: v.Name, phone: v.Phone, ProfilePic: v.ProfilePic });
      await invalidateExtUser();
      await refresh();
    }
  });

  if (error) return <SectionError error={error} onRetry={() => void refetch()} />;
  if (isPending || !form.values) return <SectionLoading />;
  const v = form.values;

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      toast.error(t("settings.profile.toast.unsupportedImage"), t("settings.profile.toast.unsupportedImageBody"));
      return;
    }
    setUploading(true);
    try {
      const small = await compressImage(file, 240);
      const url = await uploadImage(small);
      form.set({ ProfilePic: url });
      toast.show(t("settings.profile.toast.pictureReady"), t("settings.profile.toast.pictureReadyBody"));
    } catch (err) {
      toast.error(t("settings.profile.toast.uploadFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <FormColumn>
      <SectionCard title={t("settings.profile.details.title")} note={t("settings.profile.details.note")}>
        <div className="flex items-center gap-4">
          {v.ProfilePic ? (
            <img
              src={v.ProfilePic}
              alt=""
              className="size-14 rounded-full object-cover border border-line"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <Avatar name={v.Name} email={extUser?.Email} size={56} />
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => void onPickFile(e.target.files?.[0])}
              />
              <Button
                size="sm"
                icon={uploading ? undefined : <Upload className="size-3.5" strokeWidth={1.6} />}
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {t("settings.profile.details.uploadPicture")}
              </Button>
              {v.ProfilePic ? (
                <Button size="sm" variant="ghost" onClick={() => form.set({ ProfilePic: "" })}>
                  {t("common.actions.remove")}
                </Button>
              ) : null}
            </div>
            <span className="text-[11px] text-muted-2">{t("settings.profile.details.pictureHint")}</span>
          </div>
        </div>

        <Grid2>
          <Field label={t("settings.profile.details.fullName")}>
            <Input value={v.Name} onChange={(e) => form.set({ Name: e.target.value })} placeholder="Ana Silva" />
          </Field>
          <Field label={t("settings.profile.details.phone")}>
            <Input value={v.Phone} onChange={(e) => form.set({ Phone: e.target.value })} placeholder="+44 20 7946 0000" />
          </Field>
          <Field label={t("settings.profile.details.company")}>
            <Input value={v.Company} onChange={(e) => form.set({ Company: e.target.value })} />
          </Field>
          <Field label={t("settings.profile.details.jobTitle")}>
            <Input value={v.JobTitle} onChange={(e) => form.set({ JobTitle: e.target.value })} />
          </Field>
        </Grid2>

        <Field label={t("settings.profile.details.signInEmail")} hint={t("settings.profile.details.signInEmailHint")}>
          <Input value={extUser?.Email ?? user?.email ?? ""} readOnly disabled />
        </Field>
      </SectionCard>

      <SectionCard title={t("settings.profile.regional.title")} note={t("settings.profile.regional.note")}>
        <Grid2>
          <Field label={t("settings.profile.regional.timezone")}>
            <Select value={v.Timezone} onChange={(e) => form.set({ Timezone: e.target.value })}>
              {zones.includes(v.Timezone) ? null : <option value={v.Timezone}>{v.Timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("settings.profile.regional.dateFormat")}>
            <Select value={v.DateFormat} onChange={(e) => form.set({ DateFormat: e.target.value })}>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col justify-end pb-1.5">
            <span className="text-[11px] text-muted-2">
              {t("settings.profile.regional.offset", {
                zone: v.Timezone,
                offset: zoneOffsetLabel(v.Timezone) || t("settings.profile.regional.offsetUnknown")
              })}
            </span>
          </div>
        </Grid2>
      </SectionCard>

      <SectionCard title={t("common.theme.label")} note={t("settings.profile.appearance.note")}>
        <ToggleRow
          label={t("settings.profile.appearance.theme")}
          description={t("settings.profile.appearance.themeHint")}
          control={<ThemeSegment />}
        />
        <ToggleRow
          label={t("common.language.label")}
          description={t("settings.profile.language.hint")}
          control={
            <LanguageSelect className="w-[180px]" onChange={(lang) => form.set({ Language: lang })} />
          }
        />
      </SectionCard>

      <SectionCard
        title={t("settings.profile.delete.title")}
        note={t("settings.profile.delete.note")}
        className="border-danger-line"
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12px] text-muted leading-relaxed max-w-[320px]">
            {isAdminRole(extUser?.UserRole)
              ? t("settings.profile.delete.admin")
              : t("settings.profile.delete.nonAdmin")}
          </p>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="size-3.5" strokeWidth={1.6} />}
            disabled={!isAdminRole(extUser?.UserRole)}
            onClick={() => setDeleteOpen(true)}
          >
            {t("settings.profile.delete.button")}
          </Button>
        </div>
      </SectionCard>

      <DeleteAccountDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} email={extUser?.Email ?? user?.email ?? ""} />
    </FormColumn>
  );
}

function DeleteAccountDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      await requestAccountDeletion(user.id);
      setSent(true);
      toast.success(
        t("settings.profile.delete.toastSent"),
        t("settings.profile.delete.toastSentBody", { email })
      );
    } catch (err) {
      toast.error(t("settings.profile.delete.toastFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setConfirm("");
        setSent(false);
        onClose();
      }}
      width={480}
      title={t("settings.profile.delete.title")}
      description={t("settings.profile.delete.dialogDescription")}
      footer={
        sent ? (
          <Button onClick={onClose}>{t("common.actions.close")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="danger" loading={busy} disabled={confirm !== "DELETE"} onClick={() => void submit()}>
              {t("settings.profile.delete.emailLink")}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <p className="text-[13px] text-ink-2 leading-relaxed">
          <Trans
            i18nKey="settings.profile.delete.sent"
            values={{ email }}
            components={{ 1: <span className="font-medium" /> }}
          />
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            <Trans
              i18nKey="settings.profile.delete.intro"
              values={{ email }}
              components={{ 1: <span className="font-medium" /> }}
            />
          </p>
          <Field label={t("settings.profile.delete.confirmLabel", { word: "DELETE" })}>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" autoFocus />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
