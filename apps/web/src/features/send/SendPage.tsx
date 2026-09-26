import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Loader2, PanelRight, X } from "lucide-react";
import { Button, Dialog, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { activeLocale, ago, num } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useAuth } from "@/app/auth";
import { useExtUser } from "@/lib/extUser";
import {
  createDraft,
  draftPatch,
  ensureContact,
  expiryFrom,
  fetchTemplate,
  markMailSent,
  markSent,
  sendBatchDocuments,
  sendMail,
  updateDocument,
  useDraft,
  useFolderName,
  useHistory,
  useTemplates
} from "./api";
import {
  buildRequestHtml,
  buildRequestTemplate,
  defaultBody,
  defaultSubject,
  formatExpiry,
  messageToPersist
} from "./mail";
import { loadSigningLinks, signingLinkFor } from "@/lib/signingLinks";
import { computeSuggestion } from "./suggest";
import { recordFileUsage } from "@/lib/fileUsage";
import { prepareFile, toPdfBlob, type UploadStage } from "./upload";
import {
  DEFAULT_SETTINGS,
  isEmail,
  isUrl,
  pointer,
  randomPlaceholderId,
  signerColor,
  type BulkRow,
  type ContactRecord,
  type DraftDocument,
  type PlaceholderEntry,
  type Recipient,
  type RecipientRole,
  type SendMessage,
  type SendMode,
  type SendSettings,
  type Step,
  type UploadedFile
} from "./types";
import { ContactsDialog } from "./components/ContactsDialog";
import { PasswordDialog, type PasswordRequest } from "./components/PasswordDialog";
import { PreviewAside } from "./components/PreviewAside";
import { StepBulk } from "./components/StepBulk";
import { emptyBulkRow } from "./bulk";
import { StepDocuments } from "./components/StepDocuments";
import { StepRecipients } from "./components/StepRecipients";
import { StepReview, type Problem } from "./components/StepReview";

let recipientSeq = 0;
let passwordSeq = 0;
function newRecipient(role: RecipientRole, index: number, seed?: Partial<Recipient>): Recipient {
  recipientSeq += 1;
  return {
    key: `r-${recipientSeq}`,
    name: "",
    email: "",
    role,
    color: signerColor(index),
    placeholderId: randomPlaceholderId(),
    ...seed
  };
}

/** Rebuild Placeholders from the recipient list, keeping any fields the editor placed. */
function buildPlaceholders(recipients: Recipient[], existing: PlaceholderEntry[]): PlaceholderEntry[] {
  const prefill = existing.find((p) => p.Role === "prefill");
  const signers = recipients.filter((r) => r.role === "signer");
  const entries = signers.map((r, i) => {
    const prev =
      existing.find((p) => p.Role !== "prefill" && r.placeholderId && p.Id === r.placeholderId) ??
      existing.find((p) => p.Role !== "prefill" && r.contactId && p.signerObjId === r.contactId);
    return {
      Id: prev?.Id ?? r.placeholderId ?? randomPlaceholderId(),
      Role: prev?.Role ?? `Role ${i + 1}`,
      blockColor: r.color,
      signerObjId: r.contactId ?? "",
      signerPtr: r.contactId ? pointer("contracts_Contactbook", r.contactId) : {},
      email: r.email.trim().toLowerCase(),
      placeHolder: prev?.placeHolder ?? []
    } satisfies PlaceholderEntry;
  });
  return prefill ? [prefill, ...entries] : entries;
}

function recipientsFromDraft(draft: DraftDocument): Recipient[] {
  const signers = draft.placeholders
    .filter((p) => p.Role !== "prefill")
    .map((p, i) => {
      const contact = draft.signers.find((s) => s.objectId === p.signerObjId);
      recipientSeq += 1;
      return {
        key: `r-${recipientSeq}`,
        contactId: p.signerObjId || undefined,
        placeholderId: p.Id,
        name: contact?.name ?? "",
        email: contact?.email ?? p.email ?? "",
        phone: contact?.phone,
        role: "signer" as const,
        color: p.blockColor && p.blockColor !== "transparent" ? p.blockColor : signerColor(i)
      };
    });
  // A document created outside this flow can have Signers but no Placeholders yet.
  if (!signers.length && draft.signers.length) {
    return draft.signers.map((c, i) => ({
      key: `r-s${i}`,
      contactId: c.objectId,
      placeholderId: randomPlaceholderId(),
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: "signer" as const,
      color: signerColor(i)
    }));
  }
  const cc = draft.cc.map((c, i) => ({
    key: `cc-${i}`,
    name: c.Name ?? "",
    email: c.Email,
    role: "cc" as const,
    color: signerColor(signers.length + i)
  }));
  return [...signers, ...cc];
}

const STEP_KEYS: Record<Step, string> = {
  1: "send.steps.documents",
  2: "send.steps.recipients",
  3: "send.steps.fields",
  4: "send.steps.review"
};

/** One key per step: the label is never lowercased, which does not travel. */
const CONTINUE_KEYS: Record<Step, string> = {
  1: "send.nav.continueToDocuments",
  2: "send.nav.continueToRecipients",
  3: "send.nav.continueToFields",
  4: "send.nav.continueToReview"
};

export default function SendPage() {
  const { t } = useTranslation();
  const params = useParams<{ docId?: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: extUser } = useExtUser();

  const mode: SendMode =
    search.get("mode") === "self" ? "self" : search.get("mode") === "bulk" ? "bulk" : "request";
  const templateParam = search.get("template") ?? undefined;
  const prefillEmail = search.get("to") ?? undefined;
  // Set when "Upload" was opened from inside a Drive folder. The new document is
  // filed there (§3.5 `Folder`).
  const folderParam = search.get("folder") ?? undefined;
  const stepParam = Number(search.get("step"));

  const [docId, setDocId] = useState<string | undefined>(params.docId);
  const [step, setStep] = useState<Step>(stepParam === 4 ? 4 : 1);
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [settings, setSettings] = useState<SendSettings>(DEFAULT_SETTINGS);
  const [message, setMessage] = useState<SendMessage>({ subject: "", body: "" });
  const [placeholders, setPlaceholders] = useState<PlaceholderEntry[]>([]);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkResult, setBulkResult] = useState<{ created: number; failed: number } | null>(null);

  const [stage, setStage] = useState<UploadStage>({ kind: "idle" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendProgress, setSendProgress] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [, forceTick] = useState(0);

  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const hydrated = useRef(false);
  const templateApplied = useRef(false);

  const draftQuery = useDraft(docId);
  const draft = draftQuery.data;
  const templatesQuery = useTemplates(mode !== "bulk" && !docId);
  const historyQuery = useHistory(step === 2 && mode === "request");
  const folderQuery = useFolderName(folderParam ?? draft?.folderId);
  const folderName = folderQuery.data || draft?.folderName;

  /* ---------------------------------------------------------- hydrate a draft */
  useEffect(() => {
    // Wait for the mount-time refetch: cached data here can predate the editor's
    // latest save, and hydrating from it would write stale recipients / fields back.
    if (!draft || hydrated.current || draftQuery.isFetching) return;
    hydrated.current = true;
    setName(draft.name);
    setNote(draft.note);
    setPlaceholders(draft.placeholders);
    setRecipients(recipientsFromDraft(draft));
    setSettings(draft.settings);
    setMessage({
      subject: draft.message.subject || defaultSubject(draft.name),
      body: draft.message.body || defaultBody(extUser?.Name ?? user?.name ?? "")
    });
    if (draft.sent) {
      toast.show(t("send.toast.alreadySentTitle"), t("send.toast.alreadySentBody"));
    }
  }, [draft, draftQuery.isFetching, extUser?.Name, t, user?.name]);

  /* ------------------------------------------------ start from a template link */
  const applyTemplate = useCallback(
    async (templateId: string) => {
      if (!extUser?.objectId || !user?.id) {
        toast.error(t("send.toast.profileLoadingTitle"), t("send.toast.profileLoadingBody"));
        return;
      }
      setPendingTemplateId(templateId);
      try {
        const tpl = await fetchTemplate(templateId);
        if (!tpl.url) throw new Error(t("send.errors.templateNoDocument"));
        const id = await createDraft({
          name: tpl.name,
          url: tpl.url,
          extUserId: extUser.objectId,
          userId: user.id,
          note: tpl.note,
          description: tpl.description,
          templateId,
          settings: tpl.settings,
          placeholders: tpl.placeholders,
          folderId: folderParam
        });
        hydrated.current = true;
        setDocId(id);
        setName(tpl.name);
        setNote(tpl.note);
        setPlaceholders(tpl.placeholders);
        setSettings(tpl.settings);
        setMessage({
          subject: tpl.message.subject || defaultSubject(tpl.name),
          body: tpl.message.body || defaultBody(extUser.Name ?? user.name ?? "")
        });
        setFile({
          url: tpl.url,
          fileName: `${tpl.name}.pdf`,
          title: tpl.name,
          bytes: 0,
          pageCount: 0,
          data: new Uint8Array(),
          decrypted: false,
          converted: false
        });
        const roles = tpl.placeholders.filter((p) => p.Role !== "prefill");
        setRecipients(
          roles.map((p, i) => {
            recipientSeq += 1;
            return {
              key: `r-${recipientSeq}`,
              placeholderId: p.Id,
              contactId: p.signerObjId || undefined,
              name: tpl.signers.find((s) => s.objectId === p.signerObjId)?.name ?? "",
              email: tpl.signers.find((s) => s.objectId === p.signerObjId)?.email ?? p.email ?? "",
              role: "signer" as const,
              color: p.blockColor && p.blockColor !== "transparent" ? p.blockColor : signerColor(i)
            };
          })
        );
        navigate(`/send/${id}${mode === "bulk" ? `?mode=bulk&template=${templateId}` : ""}`, { replace: true });
        setStep(2);
      } catch (err) {
        toast.error(t("send.toast.templateFailed"), (err as Error).message);
      } finally {
        setPendingTemplateId(null);
      }
    },
    [extUser?.objectId, extUser?.Name, folderParam, mode, navigate, t, user?.id, user?.name]
  );

  useEffect(() => {
    if (!templateParam || docId || templateApplied.current || !extUser?.objectId || !user?.id) return;
    templateApplied.current = true;
    void applyTemplate(templateParam);
  }, [applyTemplate, docId, extUser?.objectId, templateParam, user?.id]);

  /* --------------------------------------------------------------- autosave */
  // The name the default body is written for; `messageToPersist` compares
  // against the same default to tell an untouched body from an edited one.
  const senderName = extUser?.Name ?? user?.name ?? "";
  const snapshot = useMemo(
    () =>
      JSON.stringify({
        name,
        note,
        settings,
        message,
        recipients: recipients.map((r) => [r.role, r.name, r.email, r.contactId ?? ""])
      }),
    [name, note, settings, message, recipients]
  );

  const persist = useCallback(
    async (opts: { withContacts: boolean }) => {
      if (!docId) return;
      setSaving(true);
      try {
        let list = recipients;
        if (opts.withContacts) list = await ensureContacts(recipients, extUser?.TenantId?.objectId);
        const next = buildPlaceholders(list, placeholders);
        await updateDocument(
          docId,
          draftPatch({
            name,
            note,
            recipients: list,
            settings,
            message: messageToPersist(message, senderName),
            placeholders: next,
            createdAt: draft?.createdAt
          })
        );
        if (opts.withContacts) setRecipients(list);
        setPlaceholders(next);
        setSavedSnapshot(snapshot);
        setSavedAt(new Date());
      } finally {
        setSaving(false);
      }
    },
    [
      docId,
      draft?.createdAt,
      extUser?.TenantId?.objectId,
      message,
      name,
      note,
      placeholders,
      recipients,
      senderName,
      settings,
      snapshot
    ]
  );

  useEffect(() => {
    if (!docId || !hydrated.current) return;
    if (savedSnapshot === null) {
      setSavedSnapshot(snapshot);
      return;
    }
    if (savedSnapshot === snapshot) return;
    const timer = window.setTimeout(() => {
      persist({ withContacts: false }).catch((err: Error) =>
        toast.error(t("send.toast.draftNotSaved"), err.message)
      );
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [docId, persist, savedSnapshot, snapshot, t]);

  // Keep the "saved 10s ago" line moving.
  useEffect(() => {
    if (!savedAt) return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, [savedAt]);

  const unsaved = !!docId && savedSnapshot !== null && savedSnapshot !== snapshot;

  /* ------------------------------------------------------------ file upload */
  const askPassword = useCallback(
    (fileName: string, retry: boolean) =>
      new Promise<string | null>((resolve) => {
        passwordSeq += 1;
        setPasswordRequest({
          id: passwordSeq,
          fileName,
          retry,
          resolve: (value) => {
            setPasswordRequest(null);
            resolve(value);
          }
        });
      }),
    []
  );

  const onPickFile = useCallback(
    async (picked: File) => {
      if (!extUser?.objectId || !user?.id) {
        toast.error(t("send.toast.profileLoadingTitle"), t("send.toast.profileLoadingBody"));
        return;
      }
      setUploadError(null);
      try {
        const prepared = await prepareFile(picked, { onStage: setStage, askPassword });
        if (!prepared) {
          setStage({ kind: "idle" });
          return;
        }
        setFile(prepared);
        setName(prepared.title);
        const id = await createDraft({
          name: prepared.title,
          url: prepared.url,
          extUserId: extUser.objectId,
          userId: user.id,
          settings,
          folderId: folderParam
        });
        hydrated.current = true;
        setSavedSnapshot(null);
        setDocId(id);
        setSavedAt(new Date());
        setMessage({
          subject: defaultSubject(prepared.title),
          body: defaultBody(extUser.Name ?? user.name ?? "")
        });
        if (prefillEmail) setRecipients([newRecipient("signer", 0, { email: prefillEmail })]);
        // Storage accounting is the server's job now (see @/lib/fileUsage).
        void recordFileUsage(prepared.url, prepared.bytes);
        if (mode === "self") {
          await updateDocument(id, { IsSignyourself: true });
          navigate(`/sign-yourself/${id}`);
          return;
        }
        navigate(`/send/${id}${window.location.search}`, { replace: true });
        setStep(2);
      } catch (err) {
        setUploadError((err as Error).message);
        toast.error(t("send.toast.uploadFailed"), (err as Error).message);
      } finally {
        setStage({ kind: "idle" });
      }
    },
    [
      askPassword,
      extUser?.Name,
      extUser?.objectId,
      folderParam,
      mode,
      navigate,
      prefillEmail,
      settings,
      t,
      user?.id,
      user?.name
    ]
  );

  /* ------------------------------------------------------------- recipients */
  const signers = recipients.filter((r) => r.role === "signer");
  const meEmail = (extUser?.Email ?? user?.email ?? "").toLowerCase();

  function patchRecipient(key: string, patch: Partial<Recipient>) {
    setRecipients((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        // A recipient loaded from a draft is bound to a contact-book row. Once the
        // email is changed that row no longer describes this person, so drop the
        // binding: `ensureContacts` then finds or creates the right contact and the
        // saved Signers / Placeholders follow the edit instead of the old contact.
        if (
          patch.email !== undefined &&
          r.contactId &&
          patch.email.trim().toLowerCase() !== r.email.trim().toLowerCase()
        ) {
          next.contactId = undefined;
        }
        return next;
      })
    );
  }
  function removeRecipient(key: string) {
    setRecipients((prev) => recolor(prev.filter((r) => r.key !== key)));
  }
  function moveRecipient(key: string, direction: -1 | 1) {
    setRecipients((prev) => {
      const i = prev.findIndex((r) => r.key === key);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return recolor(next);
    });
  }
  function addRecipient(role: RecipientRole) {
    setRecipients((prev) => [...prev, newRecipient(role, prev.length)]);
  }
  function addContacts(contacts: ContactRecord[]) {
    setRecipients((prev) => {
      const taken = new Set(prev.map((r) => r.email.toLowerCase()));
      const added = contacts
        .filter((c) => !taken.has(c.email.toLowerCase()))
        .map((c, i) =>
          newRecipient("signer", prev.length + i, {
            name: c.name,
            email: c.email,
            phone: c.phone,
            contactId: c.objectId
          })
        );
      return [...prev, ...added];
    });
  }
  function addMe() {
    if (!meEmail) return;
    setRecipients((prev) => [
      ...prev,
      newRecipient("signer", prev.length, { name: extUser?.Name ?? user?.name ?? "", email: meEmail })
    ]);
  }

  /* ------------------------------------------------------------ suggestions */
  const suggestion = useMemo(
    () => computeSuggestion(historyQuery.data, recipients.map((r) => r.email)),
    [historyQuery.data, recipients]
  );

  /* -------------------------------------------------------------- validation */
  const problems = useMemo<Problem[]>(() => {
    const out: Problem[] = [];
    if (!docId) out.push({ id: "no-doc", label: t("send.errors.noDocument"), step: 1 });
    if (!signers.length) out.push({ id: "no-signer", label: t("send.errors.noSigner"), step: 2 });
    for (const r of recipients) {
      if (!isEmail(r.email)) {
        out.push({
          id: `email-${r.key}`,
          label: t("send.errors.invalidEmail", { name: r.name || t("send.errors.aRecipient") }),
          step: 2
        });
      }
    }
    if (!message.subject.trim()) out.push({ id: "subject", label: t("send.errors.noSubject"), step: 2 });
    if (settings.redirectUrl.trim() && !isUrl(settings.redirectUrl)) {
      out.push({
        id: "redirect",
        label: t("send.errors.redirectUrl"),
        step: 2
      });
    }
    for (const r of signers) {
      const entry = placeholders.find(
        (p) => (r.placeholderId && p.Id === r.placeholderId) || (r.contactId && p.signerObjId === r.contactId)
      );
      const fieldCount = entry?.placeHolder?.reduce((n, page) => n + (page.pos?.length ?? 0), 0) ?? 0;
      if (!fieldCount) {
        out.push({
          id: `fields-${r.key}`,
          label: t("send.errors.noFields", { name: r.name || r.email || t("send.errors.aSigner") }),
          step: 3
        });
      }
    }
    return out;
  }, [docId, message.subject, placeholders, recipients, settings.redirectUrl, signers, t]);

  const redirectValid = !settings.redirectUrl.trim() || isUrl(settings.redirectUrl);
  const step2Valid =
    signers.length > 0 &&
    recipients.every((r) => isEmail(r.email)) &&
    message.subject.trim().length > 0 &&
    redirectValid;
  const bulkValid = bulkRows.length > 0 && bulkRows.every((r) => isEmail(r.email));

  const canContinue =
    mode === "bulk"
      ? step === 1
        ? !!docId
        : bulkValid
      : step === 1
        ? !!docId
        : step === 2
          ? step2Valid
          : problems.length === 0;

  /* ------------------------------------------------------------------ steps */
  const steps: Step[] = mode === "bulk" ? [1, 2, 4] : [1, 2, 3, 4];
  const stepIndex = steps.indexOf(step);
  const nextStep: Step | null = stepIndex >= 0 && stepIndex < steps.length - 1 ? steps[stepIndex + 1] : null;

  const continueLabel =
    step === 4
      ? mode === "bulk"
        ? t("send.nav.sendRequests", { count: bulkRows.length })
        : t("send.nav.sendNow")
      : t(CONTINUE_KEYS[nextStep ?? 4]);

  /* -------------------------------------------------------------- send flows */
  async function goToFields() {
    if (!docId) return;
    setBusy(true);
    try {
      await persist({ withContacts: true });
      navigate(`/editor/${docId}`);
    } catch (err) {
      toast.error(t("send.toast.couldNotSaveDraft"), (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    const url = file?.url || draft?.url || "";
    if (!docId || !url) return;
    setBusy(true);
    try {
      const list = await ensureContacts(recipients, extUser?.TenantId?.objectId);
      setRecipients(list);
      const next = buildPlaceholders(list, placeholders);
      setPlaceholders(next);
      const stored = messageToPersist(message, senderName);
      await updateDocument(
        docId,
        draftPatch({ name, note, recipients: list, settings, message: stored, placeholders: next, createdAt: draft?.createdAt })
      );
      await markSent(docId, url);

      // Signing links carry a per-signer token minted by the server, so they are
      // fetched once the document exists and just before the mail is composed.
      const links = await loadSigningLinks(docId);

      const targets = list.filter((r) => r.role === "signer");
      const mailTo = settings.sendInOrder ? targets.slice(0, 1) : targets;
      const expiry = expiryFrom(draft?.createdAt, settings.expiryDays);
      const mailParams = (r: Recipient) => {
        const vars = {
          document_title: name,
          note,
          sender_name: extUser?.Name ?? user?.name ?? "",
          sender_mail: extUser?.Email ?? user?.email ?? "",
          receiver_name: r.name,
          receiver_email: r.email,
          expiry_date: formatExpiry(expiry),
          company_name: (extUser?.Company as string) ?? "",
          signing_url: signingLinkFor(links, docId, { contactId: r.contactId, email: r.email })
        };
        const from =
          extUser?.UseNameAsSender === true ? (extUser?.Name as string) || vars.sender_mail : vars.sender_mail;
        return {
          recipient: r.email,
          subject: applySubject(message.subject, vars),
          html: buildRequestHtml(message.body, vars),
          from,
          replyto: vars.sender_mail,
          extUserId: extUser?.objectId
        };
      };
      // The document stays marked as sent even when the mail is refused, so the
      // only honest thing left to do is name the people who did not get one.
      const notMailed: string[] = [];
      for (const r of mailTo) {
        try {
          await sendMail(mailParams(r));
        } catch {
          notMailed.push(r.email);
        }
      }
      await markMailSent(docId, stored.subject, stored.body);
      setSavedSnapshot(snapshot);

      if (notMailed.length) {
        toast.error(
          t("send.toast.emailsFailed", { count: notMailed.length }),
          `${t("send.toast.emailsFailedBody")} ${notMailed.join(", ")}`
        );
      } else {
        toast.success(t("send.toast.sentToPeople", { count: mailTo.length }));
      }
      navigate(`/documents/${docId}`);
    } catch (err) {
      toast.error(t("send.toast.couldNotSend"), (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkSend() {
    if (!extUser?.objectId || !user?.id || !draft) return;
    const url = draft.url;
    const roleEntry = placeholders.find((p) => p.Role !== "prefill");
    if (!url || !roleEntry) {
      toast.error(t("send.toast.bulkBlockedTitle"), t("send.toast.bulkBlockedBody"));
      return;
    }
    setBusy(true);
    const rows = bulkRows;
    // The server creates the documents but not the people, so the contact rows the
    // Signers array points at still have to exist first.
    const prepared: Array<{ key: string; contact: ContactRecord }> = [];
    const failed = new Map<string, string>();
    // Rows whose document was created but whose recipient was not emailed.
    const notMailed: string[] = [];
    try {
      for (let i = 0; i < rows.length; i++) {
        setSendProgress(t("send.progress.preparing", { index: num(i + 1), total: num(rows.length) }));
        try {
          const contact = await ensureContact({
            name: rows[i].name,
            email: rows[i].email,
            phone: rows[i].phone,
            tenantId: extUser.TenantId?.objectId
          });
          prepared.push({ key: rows[i].key, contact });
        } catch (err) {
          failed.set(rows[i].key, (err as Error).message);
        }
      }

      let created = 0;
      if (prepared.length) {
        setSendProgress(t("send.progress.sending", { count: prepared.length }));
        const shared = {
          document_title: name,
          note,
          sender_name: extUser.Name ?? user.name ?? "",
          sender_mail: extUser.Email ?? user.email ?? "",
          company_name: (extUser.Company as string) ?? ""
        };
        // One call: `batchdocuments` creates every document already sent and emails
        // its signer, then answers with a result per row in the order sent.
        const summary = await sendBatchDocuments({
          sender: {
            userId: user.id,
            extUserId: extUser.objectId,
            name: shared.sender_name,
            email: shared.sender_mail,
            company: shared.company_name || undefined,
            phone: (extUser.Phone as string) || undefined,
            useNameAsSender: extUser.UseNameAsSender === true
          },
          name,
          url,
          note,
          templateId: draft.templateId ?? templateParam,
          settings,
          subject: message.subject,
          bodyTemplate: buildRequestTemplate(message.body, shared),
          placeholders,
          roleId: roleEntry.Id,
          contacts: prepared.map((p) => p.contact)
        });
        notMailed.push(...summary.mailFailed.map((m) => m.email).filter(Boolean));
        const unreported = new Set(prepared.map((p) => p.key));
        for (const row of summary.results) {
          const sent = prepared[row.index];
          if (!sent) continue;
          unreported.delete(sent.key);
          if (row.objectId) created += 1;
          else failed.set(sent.key, row.error || t("send.errors.rowNotCreated"));
        }
        for (const key of unreported) failed.set(key, t("send.errors.rowNotReported"));
      }

      // Rows that went out are done: leave only the failures behind, so pressing
      // send again retries those and nobody is sent to twice.
      setBulkRows(rows.filter((r) => failed.has(r.key)).map((r) => ({ ...r, error: failed.get(r.key) })));
      setBulkResult({ created, failed: failed.size });

      if (created) toast.success(t("send.toast.sentRequests", { count: created }));
      if (notMailed.length) {
        // The documents exist; their recipients were never emailed.
        toast.error(
          t("send.toast.emailsFailed", { count: notMailed.length }),
          `${t("send.toast.emailsFailedBody")} ${notMailed.join(", ")}`
        );
      }
      if (failed.size) {
        toast.error(t("send.toast.rowsFailed", { count: failed.size }), t("send.toast.rowsFailedBody"));
      } else {
        navigate("/documents");
      }
    } catch (err) {
      // The whole call failed, so no row can be assumed sent.
      setBulkRows(rows.map((r) => ({ ...r, error: failed.get(r.key) })));
      setBulkResult(null);
      toast.error(t("send.toast.couldNotSend"), (err as Error).message);
    } finally {
      setSendProgress(null);
      setBusy(false);
    }
  }

  async function onContinue() {
    if (!canContinue || busy) return;
    if (mode === "bulk") {
      if (step === 1) setStep(2);
      else if (step === 2) setStep(4);
      else await handleBulkSend();
      return;
    }
    if (step === 1) setStep(2);
    else if (step === 2) await goToFields();
    else if (step === 4) await handleSend();
  }

  async function saveAndClose() {
    if (!docId) {
      navigate("/inbox");
      return;
    }
    setBusy(true);
    try {
      await persist({ withContacts: true });
      navigate(`/documents/${docId}`);
    } catch (err) {
      toast.error(t("send.toast.couldNotSaveDraft"), (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (unsaved) {
      setConfirmClose(true);
      return;
    }
    navigate(docId ? `/documents/${docId}` : "/inbox");
  }

  useHotkeys(
    {
      "mod+enter": (e) => {
        e.preventDefault();
        void onContinue();
      },
      escape: () => {
        if (passwordRequest || contactsOpen || confirmClose) return;
        close();
      }
    },
    [canContinue, busy, step, mode, unsaved, passwordRequest, contactsOpen, confirmClose, recipients, message, settings]
  );

  /* ------------------------------------------------------------------ render */
  // The uploaded bytes are previewed through a blob url: pdf.js may transfer the
  // array it is handed, and a signed url would expire while the page is open.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadedPages, setLoadedPages] = useState(0);
  const previewBytes = file?.data ?? null;
  useEffect(() => {
    if (!previewBytes?.length) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(toPdfBlob(previewBytes));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewBytes]);

  const pageCount = file?.pageCount || loadedPages || undefined;
  const loadingDraft = !!docId && draftQuery.isLoading && !draft;
  const previewSrc = previewUrl ?? file?.url ?? draft?.url ?? null;
  const fileName = file?.fileName ?? (draft ? `${draft.name}.pdf` : "");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="relative h-14 shrink-0 bg-surface border-b border-line flex items-center gap-2 sm:gap-3 px-3 sm:px-4">
        <button
          type="button"
          onClick={close}
          aria-label={t("common.actions.close")}
          className="size-8 inline-flex items-center justify-center rounded-md text-muted-2 hover:bg-line-soft hover:text-ink"
        >
          <X className="size-4" strokeWidth={1.6} />
        </button>
        <span className="text-[13px] font-semibold whitespace-nowrap">
          {mode === "self" ? t("send.title.self") : mode === "bulk" ? t("send.title.bulk") : t("send.title.request")}
        </span>
        <span className="hidden sm:flex text-[12px] text-muted-2 items-center gap-1.5">
          {saving ? (
            <>
              <Loader2 className="size-3 animate-spin" strokeWidth={1.6} /> {t("common.state.saving")}
            </>
          ) : savedAt ? (
            t("send.header.draftSaved", { when: ago(savedAt) })
          ) : null}
        </span>

        {/* Under 1024 the full stepper does not fit next to the actions. */}
        <span className="lg:hidden ml-auto pl-1 text-[12px] text-muted-2 whitespace-nowrap">
          {t("send.header.stepOf", { index: num(stepIndex + 1), total: num(steps.length) })} ·{" "}
          {t(STEP_KEYS[step])}
        </span>

        <nav
          className="hidden lg:flex absolute left-1/2 -translate-x-1/2 items-center gap-1.5"
          aria-label={t("send.a11y.progress")}
        >
          {steps.map((s, i) => {
            const done = steps.indexOf(step) > i;
            const current = s === step;
            return (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 ? <span className="w-5 h-px bg-line" /> : null}
                <button
                  type="button"
                  disabled={!docId && s !== 1}
                  onClick={() => (s === 3 ? void goToFields() : setStep(s))}
                  className={cn(
                    "flex items-center gap-2 h-7 pl-1 pr-2.5 rounded-full text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                    current ? "bg-ink text-ground" : "text-muted hover:bg-line-soft"
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex items-center justify-center size-5 rounded-full text-[10px] font-semibold",
                      done
                        ? "bg-accent text-on-accent"
                        : current
                          ? "bg-ground/15 text-ground"
                          : "border border-line-strong text-muted-2"
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={2.2} /> : steps.indexOf(s) + 1}
                  </span>
                  {t(STEP_KEYS[s])}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="ml-2 lg:ml-auto flex items-center gap-2">
          <Button
            size="sm"
            className="lg:hidden"
            icon={<PanelRight className="size-3.5" strokeWidth={1.6} />}
            onClick={() => setPreviewOpen((v) => !v)}
            aria-expanded={previewOpen}
          >
            {t("common.actions.preview")}
          </Button>
          <Button size="sm" className="max-sm:hidden" onClick={saveAndClose} disabled={busy || !docId}>
            {t("send.actions.saveAndClose")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            kbd="⌘↵"
            loading={busy}
            disabled={!canContinue || busy}
            onClick={() => void onContinue()}
          >
            {sendProgress ?? continueLabel}
          </Button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 overflow-y-auto scroll-thin">
          <div className="max-w-[760px] pt-6 px-5 pb-14 sm:pt-7 sm:pr-8 sm:pl-9">
            {loadingDraft ? (
              <div className="flex items-center gap-2 text-muted-2 py-20">
                <Loader2 className="size-4 animate-spin" strokeWidth={1.6} /> {t("send.state.loadingDraft")}
              </div>
            ) : draftQuery.error ? (
              <div className="py-20 flex flex-col gap-3">
                <h1 className="font-serif text-[22px]">{t("send.state.draftError")}</h1>
                <p className="text-[13px] text-muted">{(draftQuery.error as Error).message}</p>
                <div>
                  <Button onClick={() => navigate("/documents")}>{t("send.actions.backToDocuments")}</Button>
                </div>
              </div>
            ) : step === 1 ? (
              <StepDocuments
                hasDocument={!!docId}
                fileName={fileName}
                bytes={file?.bytes}
                pageCount={pageCount}
                name={name}
                onName={setName}
                note={note}
                onNote={setNote}
                stage={stage}
                error={uploadError}
                onPickFile={(f) => void onPickFile(f)}
                onReplace={() => {
                  toast.show(t("send.toast.replaceFileTitle"), t("send.toast.replaceFileBody"));
                }}
                templates={templatesQuery.data ?? []}
                templatesLoading={templatesQuery.isLoading}
                templatesError={!!templatesQuery.error}
                onUseTemplate={(id) => void applyTemplate(id)}
                pendingTemplateId={pendingTemplateId}
                selfSign={mode === "self"}
                folderName={folderName}
              />
            ) : step === 2 && mode === "bulk" ? (
              <StepBulk
                templateName={name}
                roleCount={placeholders.filter((p) => p.Role !== "prefill").length}
                rows={bulkRows}
                onRows={setBulkRows}
                onOpenContacts={() => setContactsOpen(true)}
              />
            ) : step === 2 ? (
              <StepRecipients
                recipients={recipients}
                onPatch={patchRecipient}
                onRemove={removeRecipient}
                onMove={moveRecipient}
                onAdd={addRecipient}
                onAddMe={addMe}
                onOpenContacts={() => setContactsOpen(true)}
                meAlreadyAdded={!meEmail || recipients.some((r) => r.email.toLowerCase() === meEmail)}
                settings={settings}
                onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                message={message}
                onMessage={(patch) => setMessage((m) => ({ ...m, ...patch }))}
              />
            ) : step === 4 && mode === "bulk" ? (
              <BulkReview
                rows={bulkRows}
                result={bulkResult}
                documentName={name}
                subject={message.subject}
                expiry={expiryFrom(draft?.createdAt, settings.expiryDays)}
                onBack={() => setStep(2)}
              />
            ) : (
              <StepReview
                fileName={fileName}
                pageCount={pageCount}
                bytes={file?.bytes}
                documentName={name}
                note={note}
                recipients={recipients}
                settings={settings}
                message={message}
                expiryDate={expiryFrom(draft?.createdAt, settings.expiryDays)}
                problems={problems}
                onGoto={(s) => (s === 3 ? void goToFields() : setStep(s))}
                onSend={() => void handleSend()}
                sending={busy}
              />
            )}
          </div>
        </main>

        <PreviewAside
          open={previewOpen}
          src={previewSrc}
          fileName={fileName}
          bytes={file?.bytes}
          pageCount={pageCount}
          onPages={setLoadedPages}
          decrypted={file?.decrypted}
          converted={file?.converted}
          suggestion={step === 2 && mode === "request" ? suggestion : null}
          onAddSuggested={(r) =>
            setRecipients((prev) => [...prev, newRecipient("signer", prev.length, { name: r.name, email: r.email })])
          }
          onUseExpiry={(days) => setSettings((s) => ({ ...s, expiryDays: days }))}
        />
      </div>

      <ContactsDialog
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        taken={mode === "bulk" ? bulkRows.map((r) => r.email) : recipients.map((r) => r.email)}
        onAdd={(contacts) => {
          if (mode === "bulk") {
            const taken = new Set(bulkRows.map((r) => r.email.toLowerCase()));
            setBulkRows((prev) => [
              ...prev,
              ...contacts
                .filter((c) => !taken.has(c.email.toLowerCase()))
                .map((c) => emptyBulkRow(c.name, c.email, c.phone))
            ]);
          } else addContacts(contacts);
        }}
      />

      <PasswordDialog request={passwordRequest} />

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title={t("send.dialog.leaveTitle")}
        description={t("send.dialog.leaveDescription")}
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>{t("send.actions.keepEditing")}</Button>
            <Button
              onClick={() => {
                setConfirmClose(false);
                navigate(docId ? `/documents/${docId}` : "/inbox");
              }}
            >
              {t("send.actions.discardAndClose")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmClose(false);
                void saveAndClose();
              }}
            >
              {t("send.actions.saveAndClose")}
            </Button>
          </>
        }
      />
    </div>
  );
}

function BulkReview({
  rows,
  result,
  documentName,
  subject,
  expiry,
  onBack
}: {
  rows: BulkRow[];
  result: { created: number; failed: number } | null;
  documentName: string;
  subject: string;
  expiry: Date;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const retry = !!result?.failed;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-serif text-[28px] font-medium leading-tight">
          {retry
            ? t("send.bulkReview.toRetry", { count: rows.length })
            : t("send.bulkReview.each", { count: rows.length })}
        </h1>
        <p className="text-[13px] text-muted">
          {retry
            ? t("send.bulkReview.retryBody", { count: result.created })
            : t("send.bulkReview.body", { template: documentName || t("send.bulk.theTemplate") })}
        </p>
      </div>
      <div className="border border-line rounded-lg bg-surface overflow-hidden">
        <div className="grid grid-cols-[32px_1fr_1fr] items-center h-[34px] px-3 bg-surface-2 border-b border-line text-[11px] uppercase tracking-[.08em] text-muted-2">
          <span>#</span>
          <span>{t("send.fields.name")}</span>
          <span>{retry ? t("send.bulkReview.emailAndReason") : t("send.fields.email")}</span>
        </div>
        <ul className="divide-y divide-line-soft max-h-[420px] overflow-y-auto scroll-thin">
          {rows.map((r, i) => (
            <li
              key={r.key}
              className="grid grid-cols-[32px_1fr_1fr] items-center px-3 min-h-[46px] py-2 text-[13px]"
            >
              <span className="num text-muted-2 text-[12px]">{i + 1}</span>
              <span className="truncate">{r.name || t("send.review.noName")}</span>
              <span className="min-w-0">
                <span className="block truncate text-muted">{r.email}</span>
                {r.error ? <span className="block truncate text-[12px] text-danger">{r.error}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[12px] text-muted-2">
        {t("send.bulkReview.subject", { subject: subject || t("send.review.noSubject") })} ·{" "}
        {t("send.bulkReview.expires", { date: expiry.toLocaleDateString(activeLocale()) })}
      </p>
      <div>
        <Button onClick={onBack}>{t("send.actions.backToList")}</Button>
      </div>
    </div>
  );
}

/** Recipient colors follow position, so re-sorting keeps the palette in order. */
function recolor(list: Recipient[]): Recipient[] {
  return list.map((r, i) => ({ ...r, color: signerColor(i) }));
}

/** Create the contracts_Contactbook rows the document's Signers array points at. */
async function ensureContacts(recipients: Recipient[], tenantId?: string): Promise<Recipient[]> {
  const out: Recipient[] = [];
  for (const r of recipients) {
    if (r.role !== "signer" || r.contactId || !isEmail(r.email)) {
      out.push(r);
      continue;
    }
    const contact = await ensureContact({ name: r.name, email: r.email, phone: r.phone, tenantId });
    out.push({ ...r, contactId: contact.objectId, name: r.name || contact.name, email: contact.email });
  }
  return out;
}

function applySubject(subject: string, vars: Record<string, string>): string {
  return subject.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key: string) => vars[key.toLowerCase()] ?? m);
}
