/**
 * The signature-request email.
 *
 * The server has no "send this document" function: the client composes the HTML
 * and posts it to `sendmailv3` (§4.6, §10.2). The `{{signing_url}}` it merges in
 * comes from the server's `getsigninglinks` (see @/lib/signingLinks): links now
 * carry a per-signer token this app cannot mint.
 */
import i18next from "i18next";

export function defaultSubject(documentName: string): string {
  return documentName
    ? i18next.t("send.mail.subjectDefault", { name: documentName })
    : i18next.t("send.mail.subjectDefaultUnnamed");
}

export function defaultBody(senderName: string): string {
  // The `{{receiver_name}}` and `{{document_title}}` markers are the server's own
  // mail merge, not i18next: unknown variables are left untouched by design.
  return i18next.t("send.mail.bodyDefault", {
    senderName: senderName || i18next.t("send.mail.aColleague")
  });
}

/**
 * The message as it is stored on the document (`RequestSubject` / `RequestBody`).
 *
 * The default body is this app's own wording, written for the shell below, and
 * it carries no `{{signing_url}}`: the button is part of the shell, not the
 * text. Stored as `RequestBody` it became the server's template for every later
 * mail for the document (reminders, an MCP or API resend), and those rendered it
 * as the whole mail. So the untouched default is not stored; the server then
 * falls back to its own full template, link included. Anything the user typed
 * is kept as they typed it.
 */
export function messageToPersist(
  message: { subject: string; body: string },
  senderName: string
): { subject: string; body: string } {
  const body = message.body === defaultBody(senderName) ? "" : message.body;
  return { subject: message.subject, body };
}

export interface MailVariables {
  document_title: string;
  note: string;
  sender_name: string;
  sender_mail: string;
  receiver_name: string;
  receiver_email: string;
  expiry_date: string;
  company_name: string;
  signing_url: string;
}

/** Same `{{var}}` vocabulary the server's mail merge uses (§10.2). */
export function applyVariables(text: string, vars: MailVariables): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const value = (vars as unknown as Record<string, string>)[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain-text body (as typed in step 2) wrapped into a simple, portable email. */
export function buildRequestHtml(body: string, vars: MailVariables): string {
  return [
    "<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head>",
    '<body style="margin:0;padding:0">',
    requestContent(body, vars),
    "</body></html>"
  ].join("");
}

/** The values that are the same for every row of a bulk send. */
export type SharedMailVariables = Pick<
  MailVariables,
  "document_title" | "note" | "sender_name" | "sender_mail" | "company_name"
>;

/**
 * The same email, left as a template for the server to merge.
 *
 * `batchdocuments` creates the documents and sends their first email itself, running
 * subject and body through the server's own `{{var}}` merge (§4.3, §10.2). So the values
 * that differ per row stay as placeholders and only the shared ones are filled in here.
 * The server wraps what it is given in `<html><body>`, so this returns the fragment only.
 */
export function buildRequestTemplate(body: string, shared: SharedMailVariables): string {
  return requestContent(body, {
    ...shared,
    receiver_name: "{{receiver_name}}",
    receiver_email: "{{receiver_email}}",
    expiry_date: "{{expiry_date}}",
    signing_url: "{{signing_url}}"
  });
}

function requestContent(body: string, vars: MailVariables): string {
  const paragraphs = applyVariables(body, vars)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  const note = vars.note
    ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f4f5;border-radius:8px;line-height:1.6">${escapeHtml(
        vars.note
      )}</p>`
    : "";
  return [
    '<div style="padding:24px;background:#fafafa;font-family:Helvetica,Arial,sans-serif;color:#09090b;font-size:15px">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:28px 30px">',
    paragraphs,
    note,
    `<p style="margin:22px 0"><a href="${vars.signing_url}" style="display:inline-block;background:#09090b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Review and sign</a></p>`,
    `<p style="margin:0 0 6px;font-size:13px;color:#71717b">This request expires on ${escapeHtml(vars.expiry_date)}.</p>`,
    // The sender's address sits behind their name as a mailto link rather than
    // being printed: a mail that leads with a bare gmail address reads like spam.
    `<p style="margin:0;font-size:13px;color:#71717b">Sent by ${senderLink(vars)}${
      vars.company_name ? `, ${escapeHtml(vars.company_name)}` : ""
    }.</p>`,
    "</div></div>"
  ].join("");
}

function senderLink(vars: MailVariables): string {
  const name = vars.sender_name.trim() || vars.company_name.trim() || vars.sender_mail;
  if (!vars.sender_mail) return escapeHtml(name);
  return `<a href="mailto:${escapeHtml(vars.sender_mail)}" style="color:#71717b">${escapeHtml(name)}</a>`;
}

export function formatExpiry(date: Date): string {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}
