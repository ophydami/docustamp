/**
 * Data access for the AI page.
 *
 * Three cloud functions (server `cloud/parsefunction/aiFunctions.js`):
 *   aistatus            → { enabled, provider, model }
 *   aianalyzedocument   { url, instructions?, recipients? } → AiProposal
 *   aipreparedocument   { url, proposal, recipients, send, ... } → { document, needsRecipients }
 * The PDF itself is uploaded with the send flow's pipeline (`prepareFile`), so
 * Word files and encrypted PDFs work here exactly as they do on the send page.
 */
import { useQuery } from "@tanstack/react-query";
import { cloud } from "@/lib/parse";
import type { PlaceholderGroup, WidgetType } from "@/features/editor/types";

export interface AiStatus {
  enabled: boolean;
  provider: "bedrock" | "anthropic";
  model: string;
  region?: string;
}

export interface AiRole {
  index: number;
  role: string;
  name: string;
  email: string;
  isSender: boolean;
  color: string;
  fieldCount: number;
}

export interface AiField {
  role: string;
  /** -1 for prefill fields. */
  roleIndex: number;
  type: WidgetType;
  label: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  values?: string[];
  anchor: string | null;
}

export interface AiProposal {
  title: string;
  summary: string;
  documentType: string;
  language: string;
  signingOrderMatters: boolean;
  pageCount: number;
  pages: Array<{ number: number; width: number; height: number }>;
  roles: AiRole[];
  fields: AiField[];
  placeholders: PlaceholderGroup[];
  warnings: string[];
  ai: { model: string; usedVision: boolean; inputTokens?: number; outputTokens?: number };
}

export interface AiRecipientInput {
  name: string;
  email: string;
  role?: string;
}

export interface PreparedDocument {
  objectId: string;
  name: string;
  status: "draft" | "in_progress" | "completed" | "declined" | "expired";
  fieldCount: number;
  signers: Array<{ role: string; name: string; email: string; status: string; signingUrl?: string }>;
  mail?: { sent: string[]; failed: Array<{ email: string; reason: string }> } | null;
}

export interface PrepareResult {
  document: PreparedDocument | null;
  proposal: AiProposal;
  needsRecipients: Array<{ index: number; role: string; name: string }>;
}

export const aiStatusKey = ["ai", "status"] as const;

export function useAiStatus() {
  return useQuery({
    queryKey: aiStatusKey,
    queryFn: () => cloud<AiStatus>("aistatus"),
    staleTime: 10 * 60_000,
    retry: false
  });
}

export async function analyzeDocument(input: {
  url: string;
  instructions?: string;
  recipients?: AiRecipientInput[];
}): Promise<AiProposal> {
  return await cloud<AiProposal>("aianalyzedocument", {
    url: input.url,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.recipients?.length ? { recipients: input.recipients } : {})
  });
}

export async function prepareDocument(input: {
  url: string;
  proposal: AiProposal;
  recipients: AiRecipientInput[];
  name?: string;
  send: boolean;
  settings?: { sendInOrder?: boolean; expiryDays?: number };
}): Promise<PrepareResult> {
  return await cloud<PrepareResult>("aipreparedocument", {
    url: input.url,
    proposal: input.proposal,
    recipients: input.recipients,
    ...(input.name ? { name: input.name } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    send: input.send
  });
}
