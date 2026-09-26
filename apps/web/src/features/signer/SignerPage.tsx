import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  X
} from "lucide-react";
import { PdfViewer, useVisiblePage, type PdfPageInfo } from "@/components/pdf/PdfViewer";
import { Button, Cap, Kbd, LanguageMini, Menu, Pill, toast } from "@/components/ui";
import { useAuth } from "@/app/auth";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import {
  declineDocument,
  fetchContact,
  fetchDocument,
  fetchSavedSignature,
  freshUrl,
  isFlatPlaceholders,
  isOtpGate,
  markViewed,
  notifyNextSigner,
  saveMyPlaceholders,
  signPdf,
  toSignerDocument
} from "./api";
import { newField, placeholdersWithAdded } from "./addField";
import { certificateSignature, embedWidgetsToDoc, fetchPdfBytes, isPdfLibMissing } from "./pdfEmbed";
import {
  dateFnsPattern,
  defaultSize,
  doneCount,
  fieldDatePattern,
  fieldLabel,
  formatToday,
  inReadingOrder,
  isFilled,
  IDENTITY_TYPES,
  AUTOFILL_TYPES,
  requiredCount,
  validateField
} from "./widgets";
import { stripDataUrl } from "./signatureImage";
import type {
  AdoptedSignature,
  BlockReason,
  RawContact,
  RawDocument,
  RawPlaceholder,
  SavedSignature,
  SignerDocument,
  SignerField,
  SignerIdentity,
  WidgetType
} from "./types";
import { AddFieldButton, AddFieldPalette, AddFieldSheet } from "./components/AddFieldPalette";
import { AdoptSignatureDialog } from "./components/AdoptSignatureDialog";
import { DeclineDialog } from "./components/DeclineDialog";
import { DisclosureDialog } from "./components/DisclosureDialog";
import { FieldBox } from "./components/FieldBox";
import { OtpGate } from "./components/OtpGate";
import { StatusScreen } from "./components/StatusScreen";
import { useIsDesktop } from "./components/useIsDesktop";
import { Wordmark } from "./components/Wordmark";
import { dateMedium } from "@/lib/format";

type Phase = "loading" | "otp" | "ready" | "error";

export default function SignerPage({ mode }: { mode?: "recipient" | "self" }) {
  const { t } = useTranslation();
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user, loginWithSessionToken } = useAuth();
  const isDesktop = useIsDesktop();

  const docId = params.docId ?? "";
  const contactIdParam = params.contactId;
  const selfMode = mode === "self";
  /** Quick-send hands links out directly, so the client must not email the next signer. */
  const suppressMail = search.get("sendmail") === "false";
  /**
   * Per-signer signing token, put here by the `/login/<base64>` page. It proves
   * "I am this signer on this document" to every guest cloud call; an owner
   * signing their own document has a session instead and arrives without one.
   */
  const signingToken = search.get("t") ?? undefined;

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [raw, setRaw] = useState<RawDocument | null>(null);
  const [contact, setContact] = useState<RawContact | null>(null);
  const [otpEmail, setOtpEmail] = useState("");
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pageInfos, setPageInfos] = useState<PdfPageInfo[]>([]);
  const [saved, setSaved] = useState<SavedSignature | null>(null);

  const [fields, setFields] = useState<SignerField[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [adopted, setAdopted] = useState<AdoptedSignature | null>(null);
  const [adoptFor, setAdoptFor] = useState<SignerField | null>(null);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showLanguage, setShowLanguage] = useState(false);

  const zIndexRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageTargetRef = useRef<number | null>(null);
  const currentPage = useVisiblePage(scrollRef, pageInfos.length);

  /* ---------------------------------------------------------------- *
   * Load: contact (for the OTP email), then the document, then the PDF
   * ---------------------------------------------------------------- */

  const load = useCallback(async (opts: { afterOtp?: boolean } = {}) => {
    if (!docId) {
      setPhase("error");
      setLoadError(t("signer.errors.missingDocId"));
      return;
    }
    setPhase("loading");
    setLoadError(null);
    let contactRow: RawContact | null = null;
    if (contactIdParam && !selfMode) {
      // `getcontact` has no auth check, so it works before the OTP gate too.
      contactRow = await fetchContact(contactIdParam, false, { docId, signingToken }).catch(() => null);
      setContact(contactRow);
      if (contactRow?.Email) setOtpEmail(contactRow.Email);
    }
    try {
      const doc = await fetchDocument(docId, signingToken);
      setRaw(doc);
      setPhase("ready");
    } catch (e) {
      if (isOtpGate(e)) {
        if (opts.afterOtp) {
          // The code was accepted and we are signed in as the recipient, yet
          // the server still refuses the document: the signer's user has no
          // read ACL on it. Showing the gate again would only loop forever.
          setPhase("error");
          setLoadError(t("signer.errors.noAccessAfterOtp"));
          return;
        }
        setOtpEmail((prev) => prev || contactRow?.Email || user?.email || "");
        setPhase("otp");
        return;
      }
      setPhase("error");
      setLoadError(e instanceof Error ? e.message : t("signer.errors.couldNotOpen"));
    }
  }, [docId, contactIdParam, selfMode, signingToken, user?.email, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------------------------------------------------------- *
   * Identity: who are we signing as
   * ---------------------------------------------------------------- */

  const identity: SignerIdentity | null = useMemo(() => {
    if (!raw) return null;
    if (selfMode) {
      return {
        userId: user?.id,
        name: raw.ExtUserPtr?.Name ?? user?.name ?? user?.email ?? t("signer.party.you"),
        email: raw.ExtUserPtr?.Email ?? user?.email,
        placeholderIndex: 0,
        isOwner: true
      };
    }
    const placeholders = Array.isArray(raw.Placeholders) ? raw.Placeholders : [];
    const contacts = Array.isArray(raw.Signers) ? raw.Signers : [];
    const myEmail = (contact?.Email ?? user?.email ?? "").toLowerCase();

    let index = -1;
    let row: RawContact | null = contact;
    if (contactIdParam) {
      index = placeholders.findIndex((p) => p.signerObjId === contactIdParam);
      if (!row) row = contacts.find((c) => c.objectId === contactIdParam) ?? null;
    }
    if (index < 0 && myEmail) {
      index = placeholders.findIndex((p) => {
        if (p.email && p.email.toLowerCase() === myEmail) return true;
        const c = contacts.find((s) => s.objectId === p.signerObjId);
        return !!c?.Email && c.Email.toLowerCase() === myEmail;
      });
      if (index >= 0 && !row) row = contacts.find((c) => c.objectId === placeholders[index].signerObjId) ?? null;
    }
    const userPtr = row?.UserId as { objectId?: string } | undefined;
    return {
      contactId: row?.objectId ?? contactIdParam,
      userId: userPtr?.objectId ?? user?.id,
      name: row?.Name ?? user?.name ?? row?.Email ?? t("signer.party.you"),
      email: row?.Email ?? user?.email,
      company: row?.Company,
      jobTitle: row?.JobTitle,
      placeholderIndex: index,
      isOwner: false
    };
  }, [raw, contact, contactIdParam, selfMode, user, t]);

  const doc: SignerDocument | null = useMemo(
    () => (raw ? toSignerDocument(raw, identity) : null),
    [raw, identity]
  );

  /* ---------------------------------------------------------------- *
   * Seed the editable fields, prefilling identity and date widgets
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!doc || !identity) return;
    setFields(
      doc.fields.map((f) => {
        if (!f.mine || f.response !== undefined) return f;
        if (f.type === "date") return { ...f, response: formatToday(fieldDatePattern(f, doc.dateFormat)) };
        if (IDENTITY_TYPES.has(f.type)) {
          const v =
            f.type === "name"
              ? identity.name
              : f.type === "email"
                ? identity.email
                : f.type === "company"
                  ? identity.company
                  : identity.jobTitle;
          const fallback = typeof f.defaultValue === "string" ? f.defaultValue : undefined;
          const value = v || fallback;
          if (value) return { ...f, response: value };
        }
        if (typeof f.defaultValue === "string" && f.defaultValue) return { ...f, response: f.defaultValue };
        return f;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.objectId, doc?.fields.length, identity?.placeholderIndex]);

  /* ---------------------------------------------------------------- *
   * Side loads: audit "Viewed", the saved signature, and the PDF bytes
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!doc || !identity?.contactId || doc.isCompleted || doc.isDeclined) return;
    void markViewed(doc.objectId, identity.contactId, signingToken);
  }, [doc, identity?.contactId, signingToken]);

  useEffect(() => {
    const uid = identity?.userId;
    // `getdefaultsignature` refuses unless the userId is the caller's own, so
    // this is only worth asking for once a session exists for that same user
    // (the owner, or a guest who came through the OTP gate). A guest on a
    // non-OTP document has no session at all, and the call would always throw.
    if (!uid || user?.id !== uid) {
      setSaved(null);
      return;
    }
    let cancelled = false;
    void fetchSavedSignature(uid).then((s) => {
      if (!cancelled) setSaved(s);
    });
    return () => {
      cancelled = true;
    };
  }, [identity?.userId, user?.id]);

  const fileUrl = doc?.fileUrl;
  useEffect(() => {
    if (!fileUrl) return;
    let cancelled = false;
    setPdfBytes(null);
    fetchPdfBytes(fileUrl)
      .then((b) => {
        if (!cancelled) setPdfBytes(b);
      })
      .catch((e: Error) => {
        if (!cancelled) toast.error(t("signer.toast.couldNotOpenDocument"), e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [fileUrl, t]);

  // pdf.js may take ownership of the buffer it is handed, so every consumer
  // gets its own copy and the pristine ArrayBuffer stays available for signing.
  const viewerSrc = useMemo(() => (pdfBytes ? new Uint8Array(pdfBytes.slice(0)) : null), [pdfBytes]);
  const thumbSrc = useMemo(() => (pdfBytes ? new Uint8Array(pdfBytes.slice(0)) : null), [pdfBytes]);

  /* ---------------------------------------------------------------- *
   * Derived signing state
   * ---------------------------------------------------------------- */

  const myFields = useMemo(() => inReadingOrder(fields.filter((f) => f.mine && !f.readOnly)), [fields]);
  const total = requiredCount(fields);
  const done = doneCount(fields);
  const outstanding = useMemo(() => myFields.filter((f) => validateField(f) !== null), [myFields]);
  const allDone = outstanding.length === 0;

  /**
   * `AllowModifications` lets the recipient place extra widgets in their own
   * group (§3.5); self-sign always can, because the owner may be starting from
   * a plain PDF with no placeholders at all. A recipient we could not match to
   * a placeholder is excluded: there is no group to file the widgets under.
   */
  const canModify =
    !!doc && (selfMode || (doc.allowModifications && (identity?.placeholderIndex ?? -1) >= 0));

  const blockReason: BlockReason | null = useMemo(() => {
    if (!doc || !identity) return null;
    if (doc.isDeclined) return "declined";
    if (doc.isCompleted) return "completed";
    const mine = doc.signers.find((s) => s.order === identity.placeholderIndex);
    if (!selfMode && mine?.state === "signed") return "already_signed";
    if (doc.expiryDate && new Date(doc.expiryDate).getTime() < Date.now()) return "expired";
    // Both flags on purpose: strict order is meaningless without send-in-order,
    // and `toSignerDocument` normalises the same pair.
    if (!selfMode && doc.sendInOrder && doc.sendInOrderStrict) {
      const prior = doc.signers.find(
        (s) => !s.isPrefill && s.order < identity.placeholderIndex && s.state !== "signed"
      );
      if (prior) return "waiting_turn";
    }
    // An empty document is not a dead end when the signer may add their own.
    if (!doc.fields.some((f) => f.mine) && !canModify) return "no_fields";
    return null;
  }, [doc, identity, selfMode, canModify]);

  const canAddFields = canModify && !blockReason && !submitting;

  /* ---------------------------------------------------------------- *
   * Field editing
   * ---------------------------------------------------------------- */

  const setResponse = useCallback((key: number, response: string | number[] | undefined) => {
    setFields((prev) => {
      const target = prev.find((f) => f.key === key);
      if (!target) return prev;
      const propagate = AUTOFILL_TYPES.has(target.type) && !!target.name && typeof response === "string";
      return prev.map((f) => {
        if (f.key === key) return { ...f, response };
        // §7.3 duplicate auto-fill: same options.name, same answer.
        if (propagate && f.mine && !f.readOnly && f.name === target.name && f.type === target.type) {
          return { ...f, response };
        }
        return f;
      });
    });
    setTouched((t) => new Set(t).add(key));
  }, []);

  /* ---------------------------------------------------------------- *
   * Fields the signer adds themselves
   * ---------------------------------------------------------------- */

  const addField = useCallback(
    (type: WidgetType) => {
      if (!doc || !identity) return;
      const info = pageInfos.find((p) => p.number === currentPage) ?? pageInfos[0];
      if (!info) {
        toast.error(t("signer.toast.stillLoading"));
        return;
      }
      const size = defaultSize(type);
      const pattern = dateFnsPattern(doc.dateFormat);
      zIndexRef.current += 1;
      const field = newField({
        type,
        page: info.number,
        // Centre of the page, in PDF points from its top-left (§7.4).
        x: Math.max(0, (info.width - size.w) / 2),
        y: Math.max(0, (info.height - size.h) / 2),
        placedScale: 1,
        zIndex: zIndexRef.current,
        sameTypeCount: fields.filter((f) => f.mine && f.type === type).length,
        selfSign: selfMode,
        dateFormat: pattern,
        party: {
          name: identity.name,
          email: identity.email,
          color: doc.signers.find((s) => s.order === identity.placeholderIndex)?.color ?? "#0f6e56"
        },
        placeholderIndex: identity.placeholderIndex < 0 ? 0 : identity.placeholderIndex
      });
      // Date fields answer themselves, exactly like the ones the sender placed.
      const seeded = type === "date" ? { ...field, response: formatToday(pattern) } : field;
      setFields((prev) => [...prev, seeded]);
      setActiveKey(seeded.key);
    },
    [doc, identity, pageInfos, currentPage, fields, selfMode, t]
  );

  const moveField = useCallback((key: number, x: number, y: number) => {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, x, y } : f)));
  }, []);

  const resizeField = useCallback((key: number, w: number, h: number) => {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, w, h, resized: true } : f)));
  }, []);

  const deleteField = useCallback((key: number) => {
    setFields((prev) => prev.filter((f) => f.key !== key || !f.added));
    setActiveKey((k) => (k === key ? null : k));
  }, []);

  const applySignature = useCallback((s: AdoptedSignature, targetKey: number | null) => {
    setFields((prev) =>
      prev.map((f) => {
        if (!f.mine || f.readOnly) return f;
        const image = f.type === "initials" ? (s.initials ?? s.signature) : s.signature;
        if (f.key === targetKey) return { ...f, response: image };
        // Apply to every other empty signature/initials field too, so the
        // signer adopts once and the rest of the document fills in.
        if ((f.type === "signature" || f.type === "initials") && !isFilled(f)) return { ...f, response: image };
        if (f.type === "name" && !isFilled(f)) return { ...f, response: s.fullName };
        return f;
      })
    );
  }, []);

  const goToField = useCallback((key: number | undefined) => {
    if (key === undefined) return;
    setActiveKey(key);
  }, []);

  const nextField = useCallback(() => {
    if (!myFields.length) return;
    const idx = activeKey === null ? -1 : myFields.findIndex((f) => f.key === activeKey);
    const rest = [...myFields.slice(idx + 1), ...myFields.slice(0, Math.max(0, idx + 1))];
    const target = rest.find((f) => validateField(f) !== null) ?? rest[0];
    goToField(target?.key);
  }, [myFields, activeKey, goToField]);

  const prevField = useCallback(() => {
    if (!myFields.length) return;
    const idx = activeKey === null ? 0 : myFields.findIndex((f) => f.key === activeKey);
    goToField(myFields[(idx - 1 + myFields.length) % myFields.length]?.key);
  }, [myFields, activeKey, goToField]);

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  const download = useCallback(
    async (which: "original" | "current") => {
      const url = which === "original" ? doc?.originalUrl : doc?.fileUrl;
      if (!url || !doc) return;
      setDownloading(true);
      try {
        window.open(await freshUrl(url, doc.objectId, signingToken), "_blank", "noopener");
      } catch (e) {
        toast.error(t("signer.toast.downloadFailed"), e instanceof Error ? e.message : undefined);
      } finally {
        setDownloading(false);
      }
    },
    [doc, signingToken, t]
  );

  const onDecline = useCallback(
    async (reason: string) => {
      if (!doc || !identity) return;
      const userId = identity.userId;
      if (!userId) {
        toast.error(t("signer.toast.noIdentity.title"), t("signer.toast.noIdentity.body"));
        return;
      }
      setDeclining(true);
      try {
        await declineDocument(doc.objectId, reason, userId, signingToken);
        setShowDecline(false);
        toast.success(t("signer.toast.declined.title"), t("signer.toast.declined.body", { name: doc.ownerName }));
        await load();
      } catch (e) {
        toast.error(t("signer.toast.declineFailed"), e instanceof Error ? e.message : undefined);
      } finally {
        setDeclining(false);
      }
    },
    [doc, identity, load, signingToken, t]
  );

  const finish = useCallback(async () => {
    if (!doc || !identity || !pdfBytes) return;
    // Self-sign needs at least one signature, like the old `embedWidgetsData`.
    if (selfMode && !fields.some((f) => f.mine && f.type === "signature")) {
      toast.error(t("signer.toast.needSignature.title"), t("signer.toast.needSignature.body"));
      return;
    }
    if (outstanding.length) {
      setTouched(new Set(myFields.map((f) => f.key)));
      goToField(outstanding[0].key);
      toast.error(
        t("signer.toast.fieldsOutstanding", { count: outstanding.length }),
        validateField(outstanding[0]) ?? undefined
      );
      return;
    }
    setSubmitting(true);
    try {
      // Widgets the signer placed go onto the document before `signPdf`, so the
      // stored layout matches the bytes we are about to stamp (§6.2, §7.2).
      const added = fields.filter((f) => f.added);
      if (selfMode || added.length) {
        const stored: RawPlaceholder[] = Array.isArray(doc.raw.Placeholders) ? doc.raw.Placeholders : [];
        // Self-sign keeps pages flat, but a self-signed document that came from
        // a template still has signer wrappers: writing the flat shape over it
        // would drop the other groups, so follow whatever is already stored.
        const flat = selfMode && (stored.length === 0 || isFlatPlaceholders(stored));
        await saveMyPlaceholders(
          doc.objectId,
          placeholdersWithAdded(stored, added, {
            selfSign: flat,
            placeholderIndex: Math.max(0, identity.placeholderIndex)
          }),
          { selfSign: selfMode, signingToken }
        );
      }

      const answered = fields.filter((f) => f.mine && (isFilled(f) || f.type === "checkbox" || f.type === "radio button"));
      const pdfFile = await embedWidgetsToDoc({
        pdfBytes: pdfBytes.slice(0),
        fields: answered,
        dateFormat: doc.dateFormat
      });

      const sig = answered.find((f) => f.type === "signature" && typeof f.response === "string");
      const signature = sig?.response
        ? stripDataUrl(await certificateSignature(String(sig.response)).catch(() => String(sig.response)))
        : undefined;

      await signPdf({
        pdfFile,
        docId: doc.objectId,
        // The owner signing their own document sends no userId (§6.4 step 3).
        userId: selfMode ? undefined : identity.contactId,
        signature,
        signingToken
      });

      // Sequential sending is client-driven unless the links were handed out
      // directly (§6.8 step 9).
      const next = doc.signers.find(
        (s) => !s.isPrefill && s.order > identity.placeholderIndex && s.state !== "signed"
      );
      // Undefined when no mail was owed, so the done page can tell "not
      // notified" apart from "nothing to notify".
      let nextSignerNotified: boolean | undefined;
      if (doc.sendInOrder && next?.email && !suppressMail) {
        // The server renders the next signer's request mail and mints their
        // signing link; the page only says who is next.
        nextSignerNotified = await notifyNextSigner({
          docId: doc.objectId,
          recipient: next.email,
          signingToken
        });
        if (!nextSignerNotified) {
          // Non-blocking: the signature itself is already recorded, and
          // nothing server-side re-drives the chain, so the person in front of
          // the screen is the only one who can pass the failure on.
          toast.error(
            t("signer.toast.nextSignerNotNotified.title", { name: next.name || next.email }),
            t("signer.toast.nextSignerNotNotified.body")
          );
        }
      }

      // The done page reads the document again, so it needs the token too.
      const doneQuery = signingToken ? `?t=${encodeURIComponent(signingToken)}` : "";
      navigate(`/sign/${doc.objectId}/done${doneQuery}`, {
        replace: true,
        state: {
          docName: doc.name,
          signerName: identity.name,
          signedAt: new Date().toISOString(),
          nextSignerName: next?.name,
          nextSignerNotified,
          senderName: doc.ownerName,
          senderEmail: doc.ownerEmail,
          completed: !next,
          signers: doc.signers
            .filter((s) => !s.isPrefill)
            .map((s) => ({
              name: s.name,
              email: s.email,
              signed: s.state === "signed" || s.order === identity.placeholderIndex
            })),
          redirectUrl: doc.redirectUrl
        }
      });
    } catch (e) {
      if (isPdfLibMissing(e)) {
        toast.error(t("signer.toast.noPdfLib.title"), t("signer.toast.noPdfLib.body"));
      } else {
        toast.error(t("signer.toast.signFailed"), e instanceof Error ? e.message : undefined);
      }
      setSubmitting(false);
    }
  }, [doc, identity, pdfBytes, outstanding, myFields, fields, selfMode, suppressMail, signingToken, navigate, goToField, t]);

  useHotkeys(
    {
      enter: (e) => {
        if (submitting || !doc || blockReason) return;
        e.preventDefault();
        if (allDone) void finish();
        else nextField();
      },
      escape: () => setActiveKey(null)
    },
    [allDone, submitting, doc, blockReason, finish, nextField]
  );

  /* ---------------------------------------------------------------- *
   * Renders
   * ---------------------------------------------------------------- */

  if (phase === "otp") {
    return (
      <OtpGate
        email={otpEmail}
        docId={docId}
        signingToken={signingToken}
        onVerified={async (token) => {
          await loginWithSessionToken(token);
          await load({ afterOtp: true });
        }}
      />
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 bg-ground">
        <Loader2 className="size-5 animate-spin text-muted-2" />
        <span className="text-[12px] text-muted-2">{t("signer.loading")}</span>
      </div>
    );
  }

  if (phase === "error" || !doc || !identity) {
    return <StatusScreen reason="not_found" extra={<p className="mt-4 text-[12px] text-muted-2">{loadError}</p>} />;
  }

  if (blockReason) {
    const waitingOn = doc.signers.find(
      (s) => !s.isPrefill && s.order < identity.placeholderIndex && s.state !== "signed"
    )?.name;
    return (
      <StatusScreen
        reason={blockReason}
        docName={doc.name}
        senderName={doc.ownerName}
        senderEmail={doc.ownerEmail}
        waitingOn={waitingOn}
        declineReason={doc.declineReason}
        declinedBy={doc.declinedByName}
        expiresAt={doc.expiryDate ? dateMedium(new Date(doc.expiryDate)) : undefined}
        onDownload={doc.isCompleted || blockReason === "already_signed" ? () => void download("current") : undefined}
        downloading={downloading}
      />
    );
  }

  const myIndex = doc.signers.filter((s) => !s.isPrefill).findIndex((s) => s.order === identity.placeholderIndex);
  const signerCount = doc.signers.filter((s) => !s.isPrefill).length;
  const activeField = fields.find((f) => f.key === activeKey) ?? null;

  const overlay = (page: PdfPageInfo, scale: number) =>
    fields
      .filter((f) => f.page === page.number)
      .map((f) => (
        <FieldBox
          key={f.key}
          field={f}
          scale={scale}
          active={f.key === activeKey}
          invalid={touched.has(f.key) && validateField(f) !== null}
          dateFormat={doc.dateFormat}
          onFocus={setActiveKey}
          onChange={setResponse}
          onRequestSignature={(field) => setAdoptFor(field)}
          onRequestImage={(field) => {
            imageTargetRef.current = field.key;
            imageInputRef.current?.click();
          }}
          bounds={{ w: page.width, h: page.height }}
          onMove={canAddFields ? moveField : undefined}
          onResize={canAddFields ? resizeField : undefined}
          onDelete={canAddFields ? deleteField : undefined}
        />
      ));

  const headerMeta = [
    doc.ownerEmail
      ? t("signer.header.sentByWithEmail", { name: doc.ownerName, email: doc.ownerEmail })
      : t("signer.header.sentBy", { name: doc.ownerName }),
    pageInfos.length ? t("common.count.page", { count: pageInfos.length }) : null,
    !selfMode && myIndex >= 0 && signerCount > 1
      ? t("signer.header.signerPosition", { position: myIndex + 1, count: signerCount })
      : null
  ]
    .filter(Boolean)
    .join(" · ");

  const menuItems = [
    { label: t("signer.actions.downloadOriginal"), onSelect: () => void download("original") },
    { label: t("signer.disclosure.title"), onSelect: () => setShowDisclosure(true) },
    { label: t("signer.menu.language"), onSelect: () => setShowLanguage(true) },
    "separator" as const,
    { label: t("signer.decline.title"), onSelect: () => setShowDecline(true), danger: true }
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ground">
      {submitting ? <SealingOverlay /> : null}

      {isDesktop ? (
        <header className="h-[60px] shrink-0 flex items-center gap-4 px-5 bg-surface border-b border-line">
          <Wordmark />
          <span className="w-px h-6 bg-line" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink truncate">{doc.name}</p>
            <p className="text-[11px] text-muted truncate">{headerMeta}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted num">
                {t("signer.header.progressDesktop", { done, total })}
              </span>
              <Progress done={done} total={total} className="w-20" />
            </div>
            <LanguageMini />
            <Button size="sm" variant="ghost" onClick={() => navigate(-1)}>
              {t("signer.actions.finishLater")}
            </Button>
            {!selfMode ? (
              <Button size="sm" variant="danger" onClick={() => setShowDecline(true)}>
                {t("common.actions.decline")}
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => (allDone ? void finish() : nextField())} kbd="↵">
              {allDone ? t("signer.actions.finish") : t("signer.actions.nextField")}
            </Button>
          </div>
        </header>
      ) : (
        <header className="h-[52px] shrink-0 flex items-center gap-2 px-3 bg-surface border-b border-line">
          <button
            type="button"
            aria-label={t("common.actions.close")}
            className="size-11 -ml-2 flex items-center justify-center text-muted"
            onClick={() => navigate(-1)}
          >
            <X className="size-4.5" strokeWidth={1.6} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink truncate">{doc.name}</p>
            <p className="text-[11px] text-muted truncate">{t("signer.header.from", { name: doc.ownerName })}</p>
          </div>
          <LanguageMini className="shrink-0 [&>select]:h-11" />
          <Menu
            align="right"
            items={menuItems}
            trigger={(p) => (
              <button {...p} aria-label={t("signer.a11y.moreActions")} className="size-11 -mr-2 flex items-center justify-center text-muted">
                <MoreHorizontal className="size-4.5" strokeWidth={1.6} />
              </button>
            )}
          />
        </header>
      )}

      {!isDesktop ? (
        <div className="shrink-0 flex items-center gap-2.5 px-4 h-9 bg-surface border-b border-line">
          <span className="text-[11px] text-muted num whitespace-nowrap">
            {t("signer.header.progressMobile", { done, total })}
          </span>
          <Progress done={done} total={total} className="flex-1" />
          <span className="text-[11px] font-mono text-muted-2 whitespace-nowrap">
            {t("signer.header.pageOfShort", { current: currentPage, total: pageInfos.length || "-" })}
          </span>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 flex">
        {isDesktop ? (
          <ThumbRail
            src={thumbSrc}
            pages={pageInfos}
            current={currentPage}
            fields={fields}
            onSelect={(n) => {
              scrollRef.current?.querySelector<HTMLElement>(`[data-page="${n}"]`)?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        ) : null}

        <div
          ref={scrollRef}
          className="flex-1 min-w-0 overflow-y-auto scroll-thin bg-paper"
          onKeyDown={(e) => {
            // Enter inside a field means "done here, take me to the next one".
            // Anywhere else the global hotkey already handles it.
            if (e.key !== "Enter" || e.shiftKey) return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag !== "INPUT" && tag !== "SELECT") return;
            e.preventDefault();
            if (allDone) void finish();
            else nextField();
          }}
        >
          <div className={cn("flex justify-center", isDesktop ? "py-6" : "py-4")}>
            {viewerSrc ? (
              <PdfViewer
                src={viewerSrc}
                pageWidth={isDesktop ? 680 : Math.max(280, Math.min(680, window.innerWidth - 32))}
                renderOverlay={overlay}
                onLoad={setPageInfos}
                onError={(e) => toast.error(t("signer.toast.renderFailed"), e.message)}
                gap={isDesktop ? 20 : 12}
              />
            ) : (
              <div className="flex items-center justify-center p-16">
                <Loader2 className="size-5 animate-spin text-muted-2" />
              </div>
            )}
          </div>
        </div>

        {isDesktop ? (
          <aside className="w-[320px] shrink-0 border-l border-line bg-surface overflow-y-auto scroll-thin">
            <div className="p-5 border-b border-line">
              <Cap className="text-muted-2">{t("signer.rail.yourFields")}</Cap>
              <ul className="mt-2.5 flex flex-col gap-0.5">
                {myFields.map((f) => {
                  // A tick means "answered and valid". `validateField` alone says
                  // "acceptable to submit", which is also true of an optional field
                  // left blank, and that used to paint it ticked and struck through.
                  const valid = validateField(f) === null;
                  const ok = valid && isFilled(f);
                  const skippable = valid && !f.required && !isFilled(f);
                  return (
                    <li key={f.key}>
                      <button
                        type="button"
                        onClick={() => goToField(f.key)}
                        className={cn(
                          "w-full flex items-center gap-2 h-8 px-2 rounded-md text-left transition-colors",
                          f.key === activeKey ? "bg-accent-soft text-accent" : "hover:bg-line-soft text-ink-2"
                        )}
                      >
                        <span className="size-4 shrink-0 flex items-center justify-center">
                          {ok ? (
                            <Check className="size-3.5 text-accent" strokeWidth={2} />
                          ) : (
                            <span
                              className={cn(
                                "size-2 rounded-full border",
                                skippable ? "border-line" : "border-line-strong"
                              )}
                            />
                          )}
                        </span>
                        <span
                          className={cn(
                            "flex-1 min-w-0 truncate text-[13px]",
                            ok && "line-through text-muted-2",
                            skippable && "text-muted-2"
                          )}
                        >
                          {f.required ? fieldLabel(f) : t("signer.rail.optionalField", { label: fieldLabel(f) })}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-2">
                          {t("signer.rail.pageShort", { page: f.page })}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {!myFields.length ? (
                  <li className="text-[12px] text-muted-2 px-2">
                    {canAddFields ? t("signer.rail.emptyCanAdd") : t("signer.rail.empty")}
                  </li>
                ) : null}
              </ul>
            </div>

            {canAddFields ? <AddFieldPalette page={currentPage} onAdd={addField} /> : null}

            <div className="p-5 border-b border-line">
              <Cap className="text-muted-2">{t("signer.about.title")}</Cap>
              <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">
                {aboutText(doc, identity.placeholderIndex, t)}
              </p>
              {doc.expiryDate ? (
                <p className="mt-2 text-[12px] text-muted">
                  {t("signer.about.expires", { date: dateMedium(new Date(doc.expiryDate)) })}
                </p>
              ) : null}
              {doc.note ? (
                <p className="mt-3 rounded-lg bg-sand px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">{doc.note}</p>
              ) : null}
            </div>

            <div className="p-5 flex flex-col gap-2">
              <Button
                block
                icon={<Download className="size-3.5" strokeWidth={1.6} />}
                onClick={() => void download("original")}
                loading={downloading}
              >
                {t("signer.actions.downloadOriginal")}
              </Button>
              {doc.ownerEmail ? (
                <a
                  href={`mailto:${doc.ownerEmail}?subject=${encodeURIComponent(
                    t("signer.email.questionSubject", { document: doc.name })
                  )}`}
                  className="no-underline"
                >
                  <Button block icon={<MessageCircleQuestion className="size-3.5" strokeWidth={1.6} />}>
                    {t("signer.actions.askQuestion")}
                  </Button>
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => setShowDisclosure(true)}
                className="mt-2 text-left text-[11px] leading-relaxed text-muted-2 hover:text-accent"
              >
                {t("signer.disclosure.agreeLink")}
              </button>
            </div>
          </aside>
        ) : null}
      </div>

      {!isDesktop ? (
        <div className="shrink-0 bg-surface border-t border-line">
          <div className="flex gap-1.5 px-3 py-2 overflow-x-auto scroll-thin">
            {myFields.map((f) => {
              // Same rule as the rail: the "done" chip colour means answered, not
              // merely acceptable (an optional field left blank is not done).
              const ok = validateField(f) === null && isFilled(f);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => goToField(f.key)}
                  className={cn(
                    "h-8 shrink-0 px-2.5 rounded-full border text-[12px] font-medium whitespace-nowrap transition-colors",
                    f.key === activeKey
                      ? "bg-accent border-accent text-on-accent"
                      : ok
                        ? "bg-accent-soft border-accent-line text-accent"
                        : "bg-surface border-line text-ink-2"
                  )}
                >
                  {`${fieldLabel(f)} · ${t("signer.rail.pageShort", { page: f.page })}`}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 px-3 pb-3">
            {canAddFields ? <AddFieldButton onClick={() => setShowAddSheet(true)} /> : null}
            <button
              type="button"
              aria-label={t("signer.a11y.previousField")}
              onClick={prevField}
              className="size-[46px] shrink-0 rounded-md border border-line bg-surface flex items-center justify-center text-ink-2"
            >
              <ArrowUp className="size-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              aria-label={t("signer.a11y.nextField")}
              onClick={nextField}
              className="size-[46px] shrink-0 rounded-md border border-line bg-surface flex items-center justify-center text-ink-2"
            >
              <ArrowDown className="size-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              onClick={() => (allDone ? void finish() : activeField ? openActive(activeField, setAdoptFor, nextField) : nextField())}
              className="flex-1 h-[46px] rounded-md bg-accent text-on-accent text-[14px] font-semibold"
            >
              {allDone
                ? t("signer.actions.finish")
                : activeField &&
                    (activeField.type === "signature" || activeField.type === "initials") &&
                    !isFilled(activeField)
                  ? t("signer.actions.signHere")
                  : t("common.actions.next")}
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          const key = imageTargetRef.current;
          e.target.value = "";
          if (!file || key === null) return;
          const fr = new FileReader();
          fr.onload = () => setResponse(key, String(fr.result));
          fr.onerror = () => toast.error(t("signer.toast.imageUnreadable"));
          fr.readAsDataURL(file);
        }}
      />

      <LanguageSheet open={showLanguage} onClose={() => setShowLanguage(false)} />

      <AddFieldSheet
        open={showAddSheet && canAddFields}
        onClose={() => setShowAddSheet(false)}
        onAdd={addField}
        page={currentPage}
      />

      <AdoptSignatureDialog
        key={adoptFor?.key ?? "adopt"}
        open={!!adoptFor}
        onClose={() => setAdoptFor(null)}
        target={adoptFor?.type === "initials" ? "initials" : adoptFor?.type === "stamp" ? "stamp" : "signature"}
        defaultName={identity.name}
        allowed={doc.signatureTypes}
        penColors={doc.penColors}
        saved={saved}
        onOpenDisclosure={() => setShowDisclosure(true)}
        onAdopt={(s) => {
          setAdopted(s);
          applySignature(s, adoptFor?.key ?? null);
          setAdoptFor(null);
          window.setTimeout(nextField, 120);
        }}
      />

      <DisclosureDialog open={showDisclosure} onClose={() => setShowDisclosure(false)} senderEmail={doc.ownerEmail} />

      <DeclineDialog
        open={showDecline}
        onClose={() => setShowDecline(false)}
        onConfirm={(reason) => void onDecline(reason)}
        busy={declining}
        docName={doc.name}
        senderName={doc.ownerName}
      />

      {adopted && isDesktop ? (
        <span className="sr-only" aria-live="polite">
          {t("signer.a11y.signatureAdopted", { name: adopted.fullName })}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

function openActive(
  field: SignerField,
  setAdoptFor: (f: SignerField) => void,
  next: () => void
) {
  if (field.type === "signature" || field.type === "initials" || field.type === "stamp" || field.type === "draw") {
    if (!isFilled(field)) {
      setAdoptFor(field);
      return;
    }
  }
  next();
}

function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span
      className={cn("h-1.5 rounded-full bg-line overflow-hidden inline-block", className)}
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <span className="block h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
    </span>
  );
}

function aboutText(doc: SignerDocument, myIndex: number, t: TFunction): string {
  const parties = doc.signers.filter((s) => !s.isPrefill);
  const prev = [...parties].reverse().find((s) => s.order < myIndex && s.state === "signed");
  const next = parties.find((s) => s.order > myIndex && s.state !== "signed");
  const bits: string[] = [];
  if (prev?.signedAt) {
    bits.push(
      t("signer.about.prevSignedOn", { name: prev.name, date: dateMedium(new Date(prev.signedAt)) })
    );
  } else if (prev) {
    bits.push(t("signer.about.prevSigned", { name: prev.name }));
  }
  bits.push(next ? t("signer.about.nextSigner", { name: next.name }) : t("signer.about.lastSigner"));
  return bits.join(" ");
}

function SealingOverlay() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-ground/96">
      <Loader2 className="size-6 animate-spin text-accent" />
      <p className="font-serif text-[22px] text-ink">{t("signer.sealing.title")}</p>
      <p className="text-[12px] text-muted">{t("signer.sealing.body")}</p>
    </div>
  );
}

/** The picker behind the phone "more" menu, where the top bar has no room to spare. */
function LanguageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label={t("common.actions.close")} className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div className="relative rounded-t-xl bg-surface border-t border-line px-4 pt-4 pb-6">
        <div className="flex items-center gap-2">
          <p className="flex-1 min-w-0 text-[15px] font-semibold text-ink">{t("common.language.label")}</p>
          <button
            type="button"
            aria-label={t("common.actions.close")}
            onClick={onClose}
            className="size-11 -mr-2 flex items-center justify-center text-muted"
          >
            <X className="size-4.5" strokeWidth={1.6} />
          </button>
        </div>
        <LanguageMini className="mt-3 w-full [&>select]:h-11 [&>select]:w-full [&>select]:text-[14px]" />
      </div>
    </div>
  );
}

function ThumbRail({
  src,
  pages,
  current,
  fields,
  onSelect
}: {
  src: Uint8Array | null;
  pages: PdfPageInfo[];
  current: number;
  fields: SignerField[];
  onSelect: (n: number) => void;
}) {
  const { t } = useTranslation();
  const marksByPage = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const f of fields) {
      if (!f.mine) continue;
      const list = m.get(f.page) ?? [];
      if (list.length < 4) list.push(f.color);
      m.set(f.page, list);
    }
    return m;
  }, [fields]);

  return (
    <div className="w-[110px] shrink-0 border-r border-line bg-surface overflow-y-auto scroll-thin py-3">
      {src ? (
        <PdfViewer
          src={src}
          pageWidth={78}
          gap={10}
          className="px-2"
          pageClassName="cursor-pointer"
          renderOverlay={(page) => (
            <button
              type="button"
              onClick={() => onSelect(page.number)}
              aria-label={t("signer.a11y.goToPage", { page: page.number })}
              className={cn(
                "absolute inset-0 flex items-end justify-between p-1 rounded-[2px] transition-colors",
                page.number === current ? "outline outline-2 outline-accent" : "hover:outline hover:outline-1 hover:outline-line-strong"
              )}
            >
              <span className="font-mono text-[9px] text-muted-2 bg-surface/85 px-1 rounded-[2px]">{page.number}</span>
              <span className="flex gap-0.5">
                {(marksByPage.get(page.number) ?? []).map((c, i) => (
                  <span key={i} className="size-1.5 rounded-full" style={{ backgroundColor: c }} />
                ))}
              </span>
            </button>
          )}
        />
      ) : (
        <div className="flex justify-center pt-6">
          <Loader2 className="size-4 animate-spin text-muted-2" />
        </div>
      )}
      {pages.length ? (
        <p className="mt-3 text-center">
          <Pill tone="neutral" className="font-mono">
            {current}/{pages.length}
          </Pill>
        </p>
      ) : null}
      <span className="sr-only">
        <Kbd>↵</Kbd> {t("signer.hints.enterMovesNext")}
      </span>
    </div>
  );
}
