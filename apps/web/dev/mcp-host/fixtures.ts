/**
 * Canned tool results for the test host (`?fixture=<name>`), so each screen
 * of src/mcp-app/ can be looked at without a server, a token or a real
 * document. The page is the built one (dist/mcp-app.html); app-only tool
 * calls are answered here.
 *
 *   approval-chat      sign_document waiting for approval, approvable in the chat
 *                      (`fail=1`: approving fails; the code is NONCE below)
 *   approval-web       the same where the host may not approve: "Approve in DocuStamp"
 *                      (`webAfter=<seconds>`: then it is approved in DocuStamp)
 *   approval-nocode    approvable in the chat, but the result came without its code
 *   approval-expired   the document changed, the request expired
 *   approval-signed    approved and signed
 *   signed-banner      sign_document signed the user's own document
 *   received           a document someone else sent, waiting on the user
 *   received-waiting   the same, before the user's turn
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** The approval code the approval-chat fixture hands the page. The host flags it anywhere else. */
export const NONCE = "fixture-nonce-6f1c2a";

const APP = "https://sign.docustamp.dev";
const now = Date.now();
const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();

const NDA = {
  id: "Rq81mZt0Pe",
  title: "Mutual NDA, Acme Corp",
  senderName: "Dana Whitfield",
  senderCompany: "Acme Corp",
  senderEmail: "dana@acme.example",
  pageCount: 2
};

function approval(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "ap_7Hq2xW91",
    status,
    createdAt: iso(-0.02),
    decidedAt: null as string | null,
    decidedVia: null as string | null,
    error: null as string | null,
    document: NDA,
    agent: { name: "ChatGPT", host: "chatgpt.com", kind: "oauth" },
    values: [
      { key: "sig_1", type: "signature", label: "Signature", value: "Alex Rivera", page: 2 },
      { key: "name_1", type: "name", label: "Full name", value: "Alex Rivera", page: 2 },
      { key: "title_1", type: "text", label: "Title", value: "Founder", page: 2 },
      { key: "date_1", type: "date", label: "Date", value: "10/01/2026", page: 2 },
      { key: "agree_1", type: "checkbox", label: "I have read the agreement", value: true, page: 2 }
    ],
    review: {
      summary:
        "A two-way NDA: both sides keep the other's confidential information private for 3 years. Mostly standard, with a non-solicit clause that goes beyond confidentiality.",
      overall: "review",
      parties: [
        { name: "Acme Corp", role: "Disclosing and receiving party" },
        { name: "Alex Rivera", role: "Disclosing and receiving party" }
      ],
      keyTerms: [{ label: "Term", value: "3 years", quote: "for a period of three (3) years", page: 1 }],
      flags: [
        {
          severity: "warning",
          title: "Non-solicit for 12 months",
          why: "You could not hire or approach Acme staff for a year after this ends, which is unusual in an NDA.",
          quote:
            "Recipient shall not, directly or indirectly, solicit or hire any employee of Discloser for twelve (12) months following termination.",
          page: 2
        },
        {
          severity: "caution",
          title: "Disputes go to New York courts",
          why: "Any dispute is heard in New York, wherever you are.",
          quote: "exclusive jurisdiction of the state and federal courts located in New York County",
          page: 2
        },
        {
          severity: "info",
          title: "Information must be marked confidential",
          why: "Only information labeled confidential is covered.",
          quote: "clearly marked as \"Confidential\" at the time of disclosure",
          page: 1
        },
        {
          severity: "info",
          title: "Return or destroy on request",
          why: "Standard.",
          quote: "return or destroy all Confidential Information",
          page: 2
        }
      ],
      instructionsAimedAtAI: false,
      model: "fixture",
      reviewedAt: iso(-0.02),
      disclaimer: "This is not legal advice."
    },
    ...extra
  };
}

const RENTAL_DOC = {
  objectId: "Xk29dLm4Qa",
  name: "Rental Agreement, 14 Elm St",
  status: "in_progress",
  updatedAt: iso(0),
  sentAt: iso(0),
  expiresAt: iso(14),
  fieldCount: 6,
  signers: [
    { name: "Alex Rivera", email: "alex@rivera.example", role: "Landlord", status: "signed", signedAt: iso(0) },
    { name: "Jordan Lee", email: "jordan.lee@example.com", role: "Tenant", status: "pending" }
  ],
  urls: { app: `${APP}/documents/Xk29dLm4Qa` }
};

function received(myStatus: string) {
  return {
    view: "document",
    canWrite: true,
    appUrl: APP,
    // The participant view: `id` and `title`, no other signers' details.
    document: {
      id: NDA.id,
      title: NDA.title,
      role: "signer",
      status: "in_progress",
      sender: { name: NDA.senderName, company: NDA.senderCompany, email: NDA.senderEmail },
      sentAt: iso(-1),
      expiresAt: iso(6),
      myStatus,
      mySeat: { contactId: "c_91", role: "Recipient" },
      myFields: [
        { key: "sig_1", type: "signature", label: "Signature", required: true, page: 2 },
        { key: "title_1", type: "text", label: "Title", required: false, page: 2 },
        { key: "date_1", type: "date", label: "Date", required: true, page: 2 }
      ],
      pageCount: 2,
      urls: { file: `${APP}/files/fixture.pdf`, app: `${APP}/inbox` }
    }
  };
}

/** A page of a plain document, drawn here: lines of text and, on page 2, the signing block. */
function pageImage(page: number, pageCount: number) {
  const width = 765;
  const height = 990;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#18181b";
  g.font = "600 22px Georgia, serif";
  if (page === 1) g.fillText("MUTUAL NON-DISCLOSURE AGREEMENT", 90, 110);
  g.fillStyle = "#a1a1aa";
  let y = page === 1 ? 160 : 100;
  for (let i = 0; i < (page === 2 ? 16 : 30); i++) {
    const w = i % 7 === 6 ? 300 : 560 - ((i * 37) % 60);
    g.fillRect(90, y, w, 7);
    y += i % 7 === 6 ? 34 : 22;
  }
  if (page === 2) {
    const box = (x: number, top: number, w: number, label: string) => {
      g.fillStyle = "rgba(20, 71, 230, 0.08)";
      g.fillRect(x, top, w, 40);
      g.strokeStyle = "#1447e6";
      g.setLineDash([5, 4]);
      g.strokeRect(x, top, w, 40);
      g.setLineDash([]);
      g.fillStyle = "#1447e6";
      g.font = "500 13px sans-serif";
      g.fillText(label, x + 8, top + 25);
    };
    g.fillStyle = "#18181b";
    g.font = "600 14px sans-serif";
    g.fillText("ACME CORP", 90, 640);
    g.fillText("RECIPIENT", 420, 640);
    box(420, 670, 240, "Signature");
    box(420, 730, 240, "Title");
    box(420, 790, 160, "Date");
  }
  return { page, pageCount, width, height, source: "original", image: canvas.toDataURL("image/png") };
}

const ok = (summary: string, structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: summary }],
  structuredContent
});
const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

export interface Fixture {
  tool: Tool;
  result: CallToolResult;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

const TOOL = (name: string): Tool => ({ name, inputSchema: { type: "object" } });

export function fixture(name: string, params: URLSearchParams): Fixture {
  const started = Date.now();
  const webAfter = Number(params.get("webAfter") || 0);
  let current: ReturnType<typeof approval> | null = null;
  let documentData: Record<string, unknown> | null = null;
  let result: CallToolResult;
  let tool = TOOL("sign_document");

  if (name.startsWith("approval-")) {
    const chatApproval = name !== "approval-web";
    current =
      name === "approval-expired"
        ? approval("expired")
        : name === "approval-signed"
          ? approval("signed", { decidedAt: iso(-0.01), decidedVia: "chat" })
          : approval("pending");
    result = {
      ...ok(`Waiting for the user to approve signing "${NDA.title}".`, {
        view: "approval",
        approval: current,
        chatApproval,
        appUrl: APP
      }),
      ...(name === "approval-chat" ? { _meta: { "docustamp/approvalNonce": NONCE } } : {})
    };
  } else if (name === "signed-banner") {
    documentData = { view: "document", canWrite: true, appUrl: APP, previewPage: 2, document: RENTAL_DOC };
    result = ok(`Signed "${RENTAL_DOC.name}" for the user.`, {
      ...documentData,
      banner: { kind: "signed_for_you", agent: { name: "ChatGPT", host: "chatgpt.com" } }
    });
  } else if (name === "received" || name === "received-waiting") {
    tool = TOOL("show_document");
    documentData = received(name === "received" ? "needs_you" : "waiting");
    result = ok(`"${NDA.title}" was sent to the user.`, documentData);
  } else {
    throw new Error(`Unknown fixture "${name}".`);
  }

  async function callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await new Promise((r) => setTimeout(r, 250));
    if (tool === "app_page") {
      const page = Math.min(2, Math.max(1, Number(args.page) || 1));
      return ok(`Page ${page} of 2.`, pageImage(page, 2));
    }
    if (tool === "app_approval" && current) {
      if (webAfter && current.status === "pending" && Date.now() - started > webAfter * 1000)
        current = { ...current, status: "signed", decidedAt: new Date().toISOString(), decidedVia: "web" };
      return ok("Approval.", { approval: current });
    }
    if (tool === "app_decide_approval" && current) {
      if (args.nonce !== NONCE) return fail("Error (141): This approval link is no longer valid.");
      if (current.status !== "pending") return fail("Error (141): This request was already decided.");
      const at = new Date().toISOString();
      if (args.decision === "decline") current = { ...current, status: "declined", decidedAt: at, decidedVia: "chat" };
      else if (params.get("fail"))
        current = {
          ...current,
          status: "failed",
          decidedAt: at,
          decidedVia: "chat",
          error: "The document changed after you were asked. Ask your agent to try again."
        };
      else current = { ...current, status: "signed", decidedAt: at, decidedVia: "chat" };
      return ok("Decided.", { approval: current });
    }
    if (tool === "app_document" && documentData) return ok("Document data.", documentData);
    return ok("Done.", { ok: true });
  }

  return { tool, result, callTool };
}
