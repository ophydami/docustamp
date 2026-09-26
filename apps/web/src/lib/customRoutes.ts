/**
 * The server's non-Parse Express routes.
 *
 * `/docxtopdf` (LibreOffice) and `/decryptpdf` (coherentpdf) are plain multipart
 * endpoints mounted at the root of the same Express app as parse-server, so they
 * hang off `customRouteBase()`, never off SERVER_URL. Both need a session.
 *
 * The upload flow (features/send) and the template flow (features/templates)
 * used to carry a copy of each call with different headers and different route
 * bases; they both go through here now and only keep their own error mapping,
 * because their UIs react to a wrong password differently.
 */
import { APP_ID, customRouteBase, sessionToken } from "@/lib/parse";

/**
 * Headers for a multipart POST. No Content-Type: the browser has to set the
 * multipart boundary itself. The routes read the lowercase `sessiontoken`
 * header; the standard spelling and the app id go along for the middleware.
 */
export function customRouteHeaders(): Record<string, string> {
  const token = sessionToken();
  return {
    "X-Parse-Application-Id": APP_ID,
    ...(token ? { sessiontoken: token, "X-Parse-Session-Token": token } : {})
  };
}

function postForm(path: string, form: FormData): Promise<Response> {
  return fetch(`${customRouteBase()}${path}`, {
    method: "POST",
    headers: customRouteHeaders(),
    body: form
  });
}

/**
 * POST /docxtopdf, then fetch the PDF it produced. Concurrency on the server is
 * 1, so this can take a while. `messages.convertFailed` is used when the route
 * fails without saying why, `messages.downloadFailed` when the converted file
 * itself cannot be fetched.
 */
export async function docxToPdfBytes(
  file: File,
  messages: { convertFailed: string; downloadFailed: string }
): Promise<Uint8Array> {
  const form = new FormData();
  form.append("file", file);
  const res = await postForm("/docxtopdf", form);
  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !json.url) throw new Error(json.error || messages.convertFailed);
  const pdf = await fetch(json.url);
  if (!pdf.ok) throw new Error(messages.downloadFailed);
  return new Uint8Array(await pdf.arrayBuffer());
}

/**
 * POST /decryptpdf, which answers with raw PDF bytes.
 *
 * The route needs a session, so a 401 means either "not signed in" or "wrong
 * password" and only the second should send the user back to the password
 * prompt: the body's message is what tells them apart. The caller supplies both
 * errors so each feature keeps its own class and wording.
 */
export async function decryptPdfBytes(
  file: Blob,
  fileName: string,
  password: string,
  errors: { wrongPassword: () => Error; failed: (serverMessage: string) => Error }
): Promise<Uint8Array> {
  const form = new FormData();
  form.append("file", file, fileName);
  form.append("password", password);
  const res = await postForm("/decryptpdf", form);
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    const message = json.error ?? "";
    if (res.status === 401 && (!message || /password/i.test(message))) throw errors.wrongPassword();
    throw errors.failed(message);
  }
  return new Uint8Array(await res.arrayBuffer());
}
