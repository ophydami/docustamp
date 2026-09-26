import { useMutation, useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { cloud, rest } from "@/lib/parse";
import type { EditorDoc, EditorMode, PlaceholderGroup } from "./types";

/** getDocument / getTemplate return raw Parse JSON; only the fields we use are typed. */
interface RawContact {
  objectId?: string;
  Name?: string;
  Email?: string;
}
interface RawDoc {
  objectId?: string;
  Name?: string;
  URL?: string;
  SignedUrl?: string;
  Placeholders?: PlaceholderGroup[];
  Signers?: RawContact[];
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  SentToOthers?: boolean;
}

export const editorKey = (mode: EditorMode, id: string) => ["editor", mode, id] as const;

export function className(mode: EditorMode) {
  return mode === "template" ? "contracts_Template" : "contracts_Document";
}

function toEditorDoc(raw: RawDoc, mode: EditorMode): EditorDoc {
  const url = raw.SignedUrl || raw.URL || "";
  return {
    objectId: raw.objectId ?? "",
    name: raw.Name ?? i18next.t("editor.load.untitled"),
    url,
    placeholders: Array.isArray(raw.Placeholders) ? raw.Placeholders : [],
    signers: (raw.Signers ?? [])
      .filter((s): s is RawContact & { objectId: string } => typeof s?.objectId === "string")
      .map((s) => ({ objectId: s.objectId, Name: s.Name, Email: s.Email })),
    isCompleted: raw.IsCompleted === true,
    isDeclined: raw.IsDeclined === true,
    // Documents only: SignedUrl present means it has been sent (§11 quirk 6).
    sent: mode === "document" && Boolean(raw.SignedUrl)
  };
}

export async function fetchEditorDoc(mode: EditorMode, id: string): Promise<EditorDoc> {
  const raw =
    mode === "template"
      ? await cloud<RawDoc>("getTemplate", { templateId: id })
      : await cloud<RawDoc>("getDocument", { docId: id });
  if (!raw || typeof raw !== "object") throw new Error(i18next.t("editor.errors.couldNotLoadDocument"));
  return toEditorDoc(raw, mode);
}

export function useEditorDoc(mode: EditorMode, id: string | undefined) {
  return useQuery({
    queryKey: editorKey(mode, id ?? ""),
    queryFn: () => fetchEditorDoc(mode, id as string),
    enabled: Boolean(id),
    staleTime: Infinity,
    // The send flow edits recipients (and so Placeholders) between visits, so a
    // cached copy is only trustworthy for the lifetime of one mount: refetch when
    // the editor opens, never while it is being used (a stale re-fetch would blow
    // away in-progress edits).
    refetchOnMount: "always",
    refetchOnWindowFocus: false
  });
}

/**
 * Download the PDF bytes. The URL from `afterFind` is presigned for 160-200 s, so a
 * failure is usually an expired token: ask for a fresh one and retry once (§8.3).
 */
export async function fetchPdfBytes(
  url: string,
  ids: { docId?: string; templateId?: string }
): Promise<Uint8Array> {
  const once = async (u: string) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  try {
    return await once(url);
  } catch {
    const fresh = await cloud<string>("getsignedurl", { url, ...ids });
    if (typeof fresh !== "string" || !fresh) throw new Error(i18next.t("editor.errors.pdfLinkExpired"));
    return once(fresh);
  }
}

export function usePdfBytes(mode: EditorMode, id: string | undefined, url: string | undefined) {
  return useQuery({
    queryKey: ["editor", "pdf", mode, id, url],
    queryFn: () => fetchPdfBytes(url as string, mode === "template" ? { templateId: id } : { docId: id }),
    enabled: Boolean(url && id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0
  });
}

/**
 * Persist the whole `Placeholders` array. The old frontend does the same thing
 * (PUT on the class, no patch, no locking) and autosaves every 2 s (§3.11).
 */
export async function savePlaceholders(
  mode: EditorMode,
  id: string,
  placeholders: PlaceholderGroup[]
): Promise<void> {
  await rest(`classes/${className(mode)}/${id}`, { method: "PUT", body: { Placeholders: placeholders } });
}

export function useSavePlaceholders(mode: EditorMode, id: string | undefined) {
  return useMutation({
    mutationFn: (placeholders: PlaceholderGroup[]) => savePlaceholders(mode, id as string, placeholders)
  });
}
