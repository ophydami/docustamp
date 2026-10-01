import type { ViewData } from "./types";

/**
 * One shape for every document the views show. A document someone else sent
 * the user (the participant view, `role: 'signer'`) is named `id` and `title`
 * and lists no other signers' details; an owned one is `objectId` and `name`.
 */
export function normalizeView<T extends ViewData>(data: T): T {
  if (data.view !== "document") return data;
  const doc = data.document;
  const pages = (doc.myFields || []).map((f) => Number(f.page)).filter((n) => n > 0);
  return {
    ...data,
    previewPage: data.previewPage ?? (pages.length ? Math.min(...pages) : undefined),
    document: {
      ...doc,
      objectId: doc.objectId ?? doc.id ?? "",
      name: doc.name ?? doc.title ?? "",
      signers: Array.isArray(doc.signers) ? doc.signers : []
    }
  };
}
