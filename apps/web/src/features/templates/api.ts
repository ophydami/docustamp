import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { startOfQuarter } from "date-fns";
import i18next from "i18next";
import { num } from "@/lib/format";
import { Parse, cloud, rest } from "@/lib/parse";
import { decryptPdfBytes, docxToPdfBytes } from "@/lib/customRoutes";
import { useAuth } from "@/app/auth";
import { toTemplate, type RawTemplate, type Template, type TemplateUsage } from "./types";

/** getReport id for the templates list (BACKEND_API.md §9). */
const TEMPLATES_REPORT_ID = "6TeaPr321t";
/** getReport pages server-side, but the gallery filters and sorts client-side. */
const LIST_LIMIT = 300;
/** Server maxUploadSize is 100mb; the old client capped uploads at 80mb. */
export const MAX_UPLOAD_MB = 80;

export const templateKeys = {
  list: ["templates", "list"] as const,
  usage: (userId: string) => ["templates", "usage", userId] as const,
  thumb: (id: string) => ["templates", "thumb", id] as const,
  teams: ["templates", "teams"] as const
};

/* ------------------------------------------------------------------ reads */

export function useTemplates() {
  return useQuery({
    queryKey: templateKeys.list,
    queryFn: async (): Promise<Template[]> => {
      const rows = await cloud<RawTemplate[]>("getReport", {
        reportId: TEMPLATES_REPORT_ID,
        limit: LIST_LIMIT,
        skip: 0
      });
      return (Array.isArray(rows) ? rows : []).map(toTemplate);
    },
    staleTime: 30_000
  });
}

interface UsageRow {
  createdAt?: string;
  TemplateId?: { objectId?: string };
}

/**
 * How often each template has been used, counted from the documents that point
 * back at one. There is no server-side aggregate, so this is a single capped
 * query (server maxLimit is 500) that we tally client-side. Failing this query
 * only removes the usage numbers from the UI.
 */
export function useTemplateUsage() {
  const { user } = useAuth();
  return useQuery({
    queryKey: templateKeys.usage(user?.id ?? ""),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<TemplateUsage> => {
      const where = {
        TemplateId: { $exists: true },
        IsArchive: { $ne: true },
        CreatedBy: { __type: "Pointer", className: "_User", objectId: user?.id }
      };
      const res = await rest<{ results?: UsageRow[] }>("classes/contracts_Document", {
        query: { where: JSON.stringify(where), keys: "TemplateId", limit: "500", order: "-createdAt" }
      });
      const quarterStart = startOfQuarter(new Date()).getTime();
      const byTemplate: Record<string, number> = {};
      let thisQuarter = 0;
      for (const row of res.results ?? []) {
        const id = row.TemplateId?.objectId;
        if (!id) continue;
        byTemplate[id] = (byTemplate[id] ?? 0) + 1;
        const t = row.createdAt ? new Date(row.createdAt).getTime() : 0;
        if (t >= quarterStart) thisQuarter += 1;
      }
      return { byTemplate, thisQuarter };
    }
  });
}

/**
 * A fresh, readable URL for a template's PDF.
 *
 * TemplateAfterFind now presigns every row of a result, not just single-object
 * reads, so the url already on the card is normally fetchable and the gallery
 * asks for nothing extra. Two cases still need this: a result past the
 * trigger's 200-object cap, whose rows come back unsigned, and a local-storage
 * token that has aged out (they live ~200 s). Both surface as a viewer error,
 * which is what enables this query.
 */
export function useTemplateThumbUrl(templateId: string, url: string, enabled: boolean) {
  return useQuery({
    queryKey: templateKeys.thumb(templateId),
    enabled: enabled && !!url,
    // Local-storage tokens live 200s; refetch rather than serve a dead URL.
    staleTime: 120_000,
    retry: 1,
    queryFn: () => cloud<string>("getsignedurl", { url, templateId })
  });
}

export interface Team {
  objectId: string;
  Name?: string;
}

export function useTeams(enabled: boolean) {
  return useQuery({
    queryKey: templateKeys.teams,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await cloud<Team[]>("getteams", { active: true });
      return Array.isArray(res) ? res : [];
    }
  });
}

/* -------------------------------------------------------------- mutations */

function templatePath(id: string) {
  return `classes/contracts_Template/${id}`;
}

export function useTemplateMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: templateKeys.list });

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      rest(templatePath(v.id), { method: "PUT", body: { Name: v.name.slice(0, 250) } }),
    onSuccess: invalidate
  });

  // Nothing can be hard-deleted through the REST API (CLP, §3.1): archive instead.
  const archive = useMutation({
    mutationFn: (id: string) => rest(templatePath(id), { method: "PUT", body: { IsArchive: true } }),
    onSuccess: invalidate
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => cloud<{ objectId: string }>("createduplicate", { templateId: id }),
    onSuccess: invalidate
  });

  const shareWithTeams = useMutation({
    mutationFn: (v: { id: string; teamIds: string[] }) =>
      rest(templatePath(v.id), {
        method: "PUT",
        body: {
          SharedWith: v.teamIds.map((objectId) => ({
            __type: "Pointer",
            className: "contracts_Teams",
            objectId
          }))
        }
      }),
    onSuccess: invalidate
  });

  return { rename, archive, duplicate, shareWithTeams };
}

/* ------------------------------------------------------- create from file */

/** Thrown when the uploaded PDF needs a password we do not have yet. */
export class PdfPasswordError extends Error {
  constructor() {
    super(i18next.t("templates.errors.pdfLocked"));
    this.name = "PdfPasswordError";
  }
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isDocx(file: File) {
  return file.type === DOCX_MIME || file.name.toLowerCase().endsWith(".docx");
}
export function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** LibreOffice conversion on the server (@/lib/customRoutes). Concurrency 1, so this can be slow. */
async function docxToPdf(file: File): Promise<Blob> {
  const bytes = await docxToPdfBytes(file, {
    convertFailed: i18next.t("templates.errors.convertDocx"),
    downloadFailed: i18next.t("templates.errors.downloadConverted")
  });
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

/** coherentpdf on the server (@/lib/customRoutes). */
async function decryptPdf(file: File | Blob, name: string, password: string): Promise<Blob> {
  const bytes = await decryptPdfBytes(file, name, password, {
    wrongPassword: () => new PdfPasswordError(),
    failed: (message) => new Error(message || i18next.t("templates.errors.pdfUnreadable"))
  });
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

/** Reject encrypted PDFs early so we can ask for a password before uploading. */
async function assertReadablePdf(blob: Blob): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({ data: bytes });
  try {
    const doc = await task.promise;
    doc.cleanup();
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") throw new PdfPasswordError();
    throw new Error(i18next.t("templates.errors.notReadablePdf"));
  }
}

function pdfName(original: string) {
  const stem = original.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 40) || "template";
  return `${stem}_${Date.now().toString(36)}.pdf`;
}

/** "Master services agreement.docx" -> "Master services agreement" */
export function titleFromFilename(name: string) {
  return (
    name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 250) ||
    i18next.t("templates.card.untitled")
  );
}

async function uploadPdf(blob: Blob, fileName: string): Promise<string> {
  const parseFile = new Parse.File(fileName, blob, "application/pdf");
  await parseFile.save();
  const raw = parseFile.url();
  if (!raw) throw new Error(i18next.t("templates.errors.uploadNoUrl"));
  // Local file storage rejects unsigned GETs, so mirror the old client and store
  // the JWT-signed URL. The server strips the query before re-signing on read.
  if (raw.includes("/files/")) {
    const signed = await cloud<{ url?: string }>("fileupload", { url: raw }).catch(() => null);
    if (signed?.url) return signed.url;
  }
  return raw;
}

export interface CreateTemplateInput {
  file: File;
  /** contracts_Users objectId, required by every downstream flow. */
  extUserId: string;
  password?: string;
  name?: string;
}

/**
 * Upload a PDF or DOCX and create the `contracts_Template` row for it.
 * There is no cloud function for this: the old client saved the class directly
 * (BACKEND_API.md §3.11), and create/update on contracts_Template is open to
 * authenticated clients.
 */
export async function createTemplateFromFile(input: CreateTemplateInput): Promise<string> {
  const { file, extUserId, password } = input;
  const userId = Parse.User.current()?.id;
  if (!userId) throw new Error(i18next.t("templates.errors.signedOut"));
  if (!extUserId) throw new Error(i18next.t("templates.errors.profileLoading"));
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(i18next.t("templates.errors.tooLarge", { size: num(MAX_UPLOAD_MB) }));
  }

  let blob: Blob;
  if (isDocx(file)) {
    blob = await docxToPdf(file);
  } else if (isPdf(file)) {
    blob = password ? await decryptPdf(file, file.name, password) : file;
    await assertReadablePdf(blob);
  } else {
    throw new Error(i18next.t("templates.errors.unsupportedFile"));
  }

  const url = await uploadPdf(blob, pdfName(file.name));

  const body = {
    Name: input.name?.slice(0, 250) || titleFromFilename(file.name),
    URL: url,
    Note: i18next.t("templates.defaults.note"),
    Description: "",
    PenColors: ["blue", "red", "black"],
    SendinOrder: false,
    SendInOrderStrict: false,
    AutomaticReminders: false,
    RemindOnceInEvery: 5,
    IsTourEnabled: false,
    AllowModifications: false,
    IsEnableOTP: false,
    NotifyOnSignatures: true,
    TimeToCompleteDays: 15,
    CreatedBy: { __type: "Pointer", className: "_User", objectId: userId },
    ExtUserPtr: { __type: "Pointer", className: "contracts_Users", objectId: extUserId }
  };
  const created = await rest<{ objectId?: string }>("classes/contracts_Template", {
    method: "POST",
    body
  });
  if (!created.objectId) throw new Error(i18next.t("templates.errors.createFailed"));
  return created.objectId;
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createTemplateFromFile,
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.list })
  });
}
