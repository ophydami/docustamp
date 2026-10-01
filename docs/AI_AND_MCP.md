# AI document preparation, API tokens, MCP and REST API

Everything lives in `apps/server/cloud/`:

```
cloud/ai/client.js        Claude client selection (Bedrock or Anthropic), model from env
cloud/ai/pdfLayout.js     pdf.js text extraction -> coordinate-annotated transcript
cloud/ai/analyze.js       the prompt, the forced tool schema, anchor -> coordinate resolution
cloud/lib/apiTokens.js    personal tokens (hashed on contracts_Users)
cloud/lib/oauth.js        "Sign in with DocuStamp": OAuth 2.1 server for MCP clients (ChatGPT, Claude...)
cloud/routes/oauth.js     the OAuth endpoints and /.well-known discovery documents
cloud/mcp/app.js          the MCP Apps page and the tools that show it (ChatGPT sidebar, panel, cards)
cloud/lib/context.js      the Caller object every library function takes
cloud/lib/documents.js    createDocument / sendDocument / list / get / templates
cloud/lib/contacts.js     ensureContact / listContacts (master key, scoped to the caller)
cloud/lib/files.js        upload PDF bytes, fetch stored PDFs
cloud/lib/requestMail.js  the signature-request email, rendered and sent server-side
cloud/lib/widgets.js      server-side widget factory (same shapes as both frontends)
cloud/mcp/server.js       the MCP tools
cloud/mcp/route.js        stateless Streamable-HTTP endpoint + token auth
cloud/api/v1.js           REST API v1 (thin wrappers over cloud/lib)
cloud/api/shared.js       the flows REST and MCP share: analyse, quick-send, remind, sizes, errors
cloud/parsefunction/aiFunctions.js, apiTokenFunctions.js, oauthFunctions.js   cloud functions for the web app
spec/ApiMcpAi.spec.js     coverage (fake Claude client)
spec/OAuth.spec.js        coverage for the OAuth flow, scopes and tool safety labels
spec/McpApp.spec.js       coverage for the MCP Apps page, entrypoints and app-only tools
```

Web: `apps/web/src/features/ai/` (the "Ask AI" page at `/ai`), the "Prepare with AI" card on
the send page, Settings > API and MCP (`features/settings/sections/ApiWebhooksSection.tsx`, which
also lists connected apps), and the OAuth consent page at `/connect`
(`features/auth/ConnectPage.tsx`).

## 1. How the AI preparation works

1. The PDF is uploaded as usual (web: `prepareFile`, API: `POST /v1/files` or `fileBase64`).
2. `extractLayout` (pdf.js, Node) produces one line per text baseline with `id`, box `[x y w h]`
   in PDF points from the page's top-left, and every underline run on the line as
   `blank0[x w] blank1[x w] ...`. Page height includes the CropBox offset like both frontends.
3. One Claude call: system prompt (cached), the PDF as a `document` block (vision) and the
   transcript. Vision is skipped when the request would not fit: the gate is on the *encoded*
   payload (base64 is ~1.34x the file) plus the transcript against an 18 MB budget, and above
   100 pages. `tool_choice` forces `propose_signing_setup`, whose input is validated with a
   deliberately lenient zod schema: caps (250-char title, 1200-char summary, 120 fields, 10
   roles, known field types) are enforced by truncating in `shapeProposal` and reported in
   `warnings`, never by throwing away a response that has already been paid for. The model
   returns title/summary, roles (with names/emails only when printed in the document), and
   fields anchored to line ids with a placement (`on_blank` + optional `blank_index`,
   `right_of_label`, `below_label`, or `absolute`).
4. `resolveFieldBox` turns anchors into exact boxes (field bottom rests on the underline),
   clamps to the page, drops duplicates, unknown roles, unknown types and any field on a page
   that was not transcribed (all counted in `warnings`), and guarantees every role has a
   signature: the fallback boxes are laid out as a grid on the document's real last page and go
   into `fields[]` like every other field, so the preview, `fieldCount` and the created document
   agree. `buildPlaceholders` emits the real `Placeholders` schema (§6.2/§7 of
   `apps/web/docs/BACKEND_API.md`) with `signerObjId: ""`; `createDocument` binds contacts.

Limits worth knowing: the transcript covers the **first 60 pages** only (`pagesTruncated: true`
and a warning say so; a field the model puts on page 61+ is dropped rather than moved to page 1)
and is capped at ~320k characters, past which plain text lines are dropped and lines carrying a
blank run are kept. Page geometry follows the CropBox offset like both frontends, and that
offset is only applied to upright pages (a 90/270 rotation would otherwise shift it onto the
wrong axis); text coordinates themselves come from the rotated viewport, so rotated pages are
placed in the same top-left system as everything else.

The tests run against a fake client; a real run on the sample lease (1 page, 12 fields) takes
15-25 s on Sonnet 4.6 via Bedrock and costs ~3k input / ~1.5k output tokens.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `AI_ENABLED` | on once a provider is configured (`ANTHROPIC_API_KEY`, `AI_PROVIDER` or `AWS_BEARER_TOKEN_BEDROCK`), otherwise off | `true` forces it on (e.g. Bedrock through an instance role), `false` hides the AI page and rejects the AI functions |
| `AI_PROVIDER` | `bedrock`, unless `ANTHROPIC_API_KEY` is set **and** `AI_MODEL` does not contain `anthropic.` (a Bedrock-style id keeps Bedrock even with the key set) | Only `bedrock` and `anthropic` are accepted; any other value is logged and falls back to `bedrock` |
| `AI_MODEL` | `us.anthropic.claude-sonnet-4-6` | Bedrock InvokeModel ids (`us.`/`global.`) use the legacy client; bare `anthropic.claude-sonnet-5` style ids use the Messages-API ("Mantle") endpoint once the AWS account has the marketplace agreement |
| `AI_REGION` | `AWS_REGION` or `us-east-1` | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | | or any other AWS credential source; needs `bedrock:InvokeModel` (+ `bedrock-mantle:CreateInference` for the new endpoint) |

Bedrock needs an IAM identity allowed `bedrock:InvokeModel` on the model (plus
`bedrock-mantle:CreateInference` for the Messages-API endpoint). Keep its keys in the
server's env file, never in the repository.

## 2. Cloud functions (session auth, used by the web app)

| Function | Params | Returns |
|---|---|---|
| `aistatus` | | `{ enabled, provider, model }`; needs a session, and only an admin also gets `region` |
| `aianalyzedocument` | `{ url \| fileBase64, instructions?, recipients? }` | proposal (see below) |
| `aipreparedocument` | `{ url \| fileBase64, proposal?, recipients?, name?, settings?, message?, note?, send?, folderId? }` | `{ document, proposal, needsRecipients }`; `document` is null while roles lack emails. Pass the reviewed `proposal` back to skip a second model call |
| `generateapitoken` | | `{ token, prefix, createdAt }` (token shown once) |
| `revokeapitoken` | | `{ revoked }` |
| `getapitoken` | | `{ token: { prefix, createdAt, lastUsedAt } \| null }` |

### File urls

Everywhere a `url` is accepted (`aianalyzedocument`, `aipreparedocument`, the MCP file tools,
`POST /files`, `/documents`, `/documents/analyze`, `/documents/quick-send`, `PATCH /documents/:id`)
the server applies the same two rules, both in `cloud/lib/files.js`:

- **Fetching** (`assertFetchableUrl`): http(s) only, no redirects, 80 MB and 60 s caps, and the
  host has to resolve to public addresses. Loopback, link-local (169.254/16, fe80::/10), private
  (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), multicast and the cloud metadata hosts are
  refused, all with the same message ("The file could not be fetched.") so the endpoint cannot be
  used to probe the network. Our own storage origins (`SERVER_URL`, `PUBLIC_URL`, `DO_BASEURL`,
  `DO_ENDPOINT`) are always allowed. `ALLOW_PRIVATE_FETCH=true` lifts the address check for tests
  only; never set it on a deployment.
- **Storing** (`assertStoredFileUrl`): only a url this deployment produced is written onto a
  document. An external url is downloaded once and re-uploaded to our own storage, and the copy's
  url is stored, so a third-party host can never serve (or later swap) the bytes a signer sees.
  A stored url that another account's document already uses is refused (403).

`resolveFileUrl` signs (local JWT) or presigns (S3) only urls on our own origins; a foreign url is
never signed and is handed back untouched.

Proposal shape: `{ title, summary, documentType, language, signingOrderMatters, pageCount,
pages[], pagesTruncated, roles[{ index, role, name, email, isSender, color, fieldCount }],
fields[{ role, roleIndex, type, label, page, x, y, width, height, required, values?, anchor }],
placeholders[], warnings[], ai{ model, usedVision, inputTokens, outputTokens } }`.

Rate limit: **10 AI calls / minute / user**, shared by the cloud functions, the MCP tools
(`analyze_document`, `quick_send`, `ai_layout_draft`) and the REST routes (`/documents/analyze`,
`/documents/quick-send`, `/documents/:id/ai-layout`), so a personal token cannot spend the AI
budget under the generic API limit. In-memory per process.

### Emails the model read out of the PDF

The PDF's text goes into the prompt verbatim, so an address printed (or hidden) in the document
is untrusted: a document saying "countersigned by x@evil.com" must not turn into mail on its own.
Such an address is never bound by itself. It comes back in `needsRecipients` as
`{ index, role, name, suggestedEmail, source: "document" }`, and is used only when the caller
either passes it in `recipients` or sets `acceptExtractedRecipients: true` (the web page's
review step is exactly that confirmation). `ai_layout_draft` follows the same rule: a role it
cannot bind to an existing recipient leaves the draft untouched and is reported instead.

## 3. API tokens

`Settings > API and MCP`. One token per account, format `os_` + 40 base62 chars, stored as a
sha256 hash (`contracts_Users.ApiTokenHash`, plus `ApiTokenPrefix`, `ApiTokenCreatedAt`,
`ApiTokenLastUsedAt`). Send it as `Authorization: Bearer os_...` (also accepted: `x-api-token`).
A token acts as the user: documents it creates are owned by that user; it can only read and act
on that user's own documents, contacts and templates.

Rate limits: 120 req/min per token, 240 req/min per IP (the IP bucket is the pre-auth speed bump,
so it sits above the per-token budget and several colleagues behind one office IP do not share a
smaller one). Both counters live in memory **per Node process**: on a multi-instance deployment
the effective ceiling is that many times the number, so treat them as abuse control rather than
as a quota. AI calls have their own 10/min budget on top (§1).

Bodies are capped at 72 MB on `/api/v1` and `/api/mcp` (a 50 MB PDF is ~67 MB of base64); a
larger one is refused with 413 before the token is even looked up. Authentication failures always
answer 401 with `WWW-Authenticate`, including the case where the account behind a token has been
deleted.

## 4. MCP server (stateless)

Endpoint: `https://sign.example.com/api/mcp` (the server answers `/api/*` itself and mounts
`/mcp` next to the Parse mount). Streamable HTTP, POST only, `sessionIdGenerator: undefined`,
JSON responses. A new `McpServer` is built per request around the caller resolved from the token,
and torn down when the response closes, so nothing is kept between calls.

```bash
claude mcp add --transport http docustamp https://sign.example.com/api/mcp \
  --header "Authorization: Bearer os_..."
```

Claude Desktop and other stdio-only clients: `npx -y mcp-remote https://sign.example.com/api/mcp --header "Authorization: Bearer os_..."`.

### Connecting by signing in (OAuth): ChatGPT, Claude and other MCP apps

Apps that cannot take a pasted header (ChatGPT plugins, Claude connectors) connect with
"Sign in with DocuStamp" instead: the user adds `https://sign.example.com/api/mcp` in the app,
signs in to DocuStamp, and allows access. The server is its own OAuth 2.1 authorization server
(`cloud/lib/oauth.js`), using the MCP SDK's handlers for the protocol details:

1. A request without a token gets `401` with
   `WWW-Authenticate: Bearer realm="docustamp", resource_metadata="https://sign.example.com/.well-known/oauth-protected-resource/api/mcp"`.
2. Discovery: that document (RFC 9728) names the issuer (the public origin); the issuer's
   `/.well-known/oauth-authorization-server` (also served as `openid-configuration`, RFC 8414)
   lists `/api/oauth/register`, `/authorize`, `/token` and `/revoke`, PKCE `S256` only, and
   `token_endpoint_auth_methods_supported: ["none"]`.
3. Registration (RFC 7591) is open and every client is a public one: no client secret, whatever
   the client asked for. Redirect uris must be https, http on loopback, or a private-use scheme
   (`vscode:`); `javascript:`, `data:`, `file:` and friends are refused.
4. `/api/oauth/authorize` stores the request (10 minutes) and redirects to the web app's consent
   page, `/connect?request=<id>`. The page goes through sign-in first, shows the app's name, the
   host it returns to (the part a client cannot fake) and what it asks for, and calls
   `oauthrequest` / `oauthdecide`. Allowing mints a one-time code (5 minutes).
5. `/api/oauth/token` checks the PKCE verifier and the redirect uri and returns a Bearer access
   token (`dsat_`, 1 hour) and a refresh token (`dsrt_`, 30 days). Refresh tokens rotate on
   every use and the old pair stops working. A code presented twice is treated as stolen: the
   connection it produced is deleted.

Scopes: `documents:read`, `documents:write` and `documents:sign` (write implies read; no scope
asked for means read and write). A connection without `documents:write` does not even see the tools
that change anything. `documents:sign` lets the app sign for the user (see "Agents that sign"
below) and is **never granted because a client asked for it**: asking only makes the consent page
offer a "Can sign for me" box (`oauthrequest` returns `signRequested`). The user grants it with
that box (`oauthdecide { allowSigning: true }`) or later with the switch under Settings > API and
MCP > Connected apps (`setoauthgrantsigning { id, enabled }`), and either way only once their email
address is verified. The grant records `SigningEnabledAt`; `listoauthgrants` returns `canSign` and
`signingEnabledAt`. The grant is read on every request, so the switch applies to the app's next
call without a reconnect, and a refresh that names only read and write keeps it.
Access tokens are bound to the MCP endpoint (`resource`, RFC 8707) and are refused by the REST API,
which keeps using personal tokens. Personal `os_` tokens work on the MCP endpoint exactly as before.

A connected app is never given signing links, because a link is a bearer credential: whoever opens
it signs as that signer. `get_signing_links` is not registered for an OAuth caller, and every
result it receives has `signingUrl`, `signingLinks`, `signingToken`, `nextSignerUrl` and
`nextSignerEmail` removed (`stripSigningLinks` in `cloud/mcp/server.js`), whatever the tool. An
app signs only through `sign_document` / `signForMe`, for the user who connected it. Personal `os_`
tokens, which the user holds directly, still get links.

Version 0.4.2 also forced the emailed code (`IsEnableOTP`) on every document a connected app sent.
That is gone: the app never holds a link, so the link in the signer's own inbox is enough, and the
code is again a per-document setting (`settings.otp`).

Storage is three master-key-only classes, tokens and codes as sha256 hashes:
`contracts_OAuthClient`, `contracts_OAuthRequest`, `contracts_OAuthGrant` (one row per connection;
Settings > API and MCP > Connected apps lists and deletes these through `listoauthgrants` /
`revokeoauthgrant`). Suspending a member or an admin resetting their password deletes their
connections too.

OAuth needs `PUBLIC_URL` on https (http is accepted on localhost for development). Without it, or
with `OAUTH_ENABLED=false`, the endpoints answer 404 and the 401 carries no `resource_metadata`.
Rate limits per IP: `OAUTH_REGISTER_RATE_LIMIT` (20/min), `OAUTH_AUTHORIZE_RATE_LIMIT` (60/min),
`OAUTH_TOKEN_RATE_LIMIT` (120/min, also used for revoke), `OAUTH_DISCOVERY_RATE_LIMIT` (120/min).

### Agents that sign

An agent signs only for the person who connected it, through its own path (`cloud/lib/agentSign.js`
stamps the PDF on the server and records the signature), never through a signing link.

- **Who may.** An OAuth app needs `documents:sign` ("Can sign for me", above); a personal API
  token is the user's own key and may. Either way the user's email must be verified, and the
  sign-in address, account email and profile email must match (`cloud/lib/agentIdentity.js`).
  Without the scope, `sign_document` (registered for every write connection) answers "Signing is
  off for this app. Turn on 'Can sign for me' for <app> in DocuStamp Settings > API and MCP."
- **Which seat.** Only the recipient whose contact is the user's own account and address. A
  recipient `{ "me": true, "role": "Landlord" }` is that seat: name and email come from the
  account (`resolveMeRecipients` in `cloud/lib/documents.js`; every tool that takes recipients
  accepts it). The server instructions tell the model to add the user only when they sign too,
  and never to type or draw the user's signature into a PDF it generates itself.
- **`signForMe: true`** on `quick_send`, `send_document`, `create_document { send: true }` and
  `create_document_from_template { send: true }`: the document is marked sent, the agent signs the
  user's seat, then only the people still owing a signature are mailed, so the user gets a "signed
  for you" notice (with a Void button) instead of a request. The result carries `signedForYou`.
  Refused before anything goes out when the app may not sign, the user is not a recipient, the
  document signs in order and the user is not first ("Send it, then call sign_document when it's
  your turn"), or a required value of the user's is one the agent cannot fill (checked on the
  draft with `prepareAgentSignature(..., { allowDraft: true })`). If the signature still fails,
  everybody is mailed as usual, the user included, and `warnings` gives the reason.
- **`sign_document { documentId, fields? }`** (destructive): signs the user's seat on a sent
  document. On the user's own document it signs right away, emails the user the same notice, and
  (in hosts that show apps) shows the document card with a "signed for you" banner. `fields`
  gives values the account cannot fill, keyed by the field key from `get_draft`, or from
  `get_document`'s `myFields` on a document sent to the user (text, number, dropdown, radio,
  cells: a string; checkbox: true/false or option labels). On a document someone else sent, it
  signs nothing and asks the user to approve (below).
- **Recorded.** The audit entry gets `Method: "agent"`, the agent (name and redirect host),
  on whose behalf, and what allowed it (`own_document` with when signing was turned on, or
  `web` / `chat` with the approval id). The client IP of the MCP request (`caller.ip`, set in
  `authenticateApiRequest`) is the signing IP; for a web approval it is the browser's.
  `get_audit_trail` returns these as `method`, `agent`, `onBehalfOf` and `allowedBy`.
- `analyze_document` / `quick_send` tell the model who the sender is, so `is_sender` is only set
  for the sender's own party when the document has a signing line for it.

### Documents other people send the user

The flow the server instructions describe: `list_inbox` -> `get_document` -> `review_document`
-> `sign_document` -> (the user approves) -> `get_approval`.

- **`list_inbox { status?, limit?, skip? }`** (`cloud/lib/inbox.js`): documents sent to the user,
  `needs_you` (default: live and their turn, the in-order rule applied on the server), `waiting`,
  `completed` or `all`. A participant is a contact on the document bound to the user's account.
- **Participant reads.** `get_document`, `preview_page`, `show_document`, `app_document` and
  `app_page` answer the owner exactly as before; for someone the document was sent to they fall
  back to what that person sees: title, sender, status, `myStatus`, their seat and fields with
  keys, the other signers' names (never their addresses), a short-lived link to the current PDF,
  and page images in signer mode with only their own fields drawn. Never signing links, notes or
  webhooks. Anyone else gets "Document not found."
- **`review_document { documentId }`** (`cloud/ai/review.js`): the AI's read of the terms (summary,
  parties, key terms with quotes, flags, `instructionsAimedAtAI`), with the document fenced as
  untrusted input. Behind the AI switch and budget; "not legal advice".
- **Verified email.** Every read of a document the user does not own (the inbox, the participant
  views, the review) needs `verifiedIdentityProblem(caller) === null`: an account opened in
  someone else's name must not read what was sent to that address. Only someone the document was
  sent to is told to verify; a stranger gets the answer they always got.

### Approvals

`cloud/lib/approvals.js`, class `contracts_SignApproval` (master-key only, an empty ACL on every
row, created on first use and by `databases/migrations/20261001120000-create_contracts_signapproval.cjs`;
indexes in `migrationdb/createSignApprovalIndexes.js`).

- **Asking.** `sign_document` on someone else's document checks everything a signature needs
  (`prepareAgentSignature`: the seat, the turn, the values; a missing value is refused with the
  list, so the user never approves something that cannot be signed), stores the values it would
  fill, the AI review (null when AI is off or fails; it waits up to 25 s, then joins the request
  when it lands), the agent and a fingerprint of the document, emails the user ("ChatGPT wants to
  sign ... for you", button "Review and approve" to `/approvals/:id`), and returns
  `{ status: "awaiting_approval", approvalId, appUrl, message }` with the approval card
  (`structuredContent: { view: "approval", approval, chatApproval, appUrl }`). One open request per
  seat: asking again with the same values returns it (with a new chat code), different values
  replace it. At most 10 new requests a minute per user.
- **Approving in the chat.** Only for apps whose sign-in redirected to a host on
  `CHAT_APPROVAL_HOSTS` (comma separated, default `chatgpt.com`, `none` turns it off): hosts known
  to keep a tool result's `_meta` from the model. There the result carries a single-use code in
  `_meta["docustamp/approvalNonce"]` (never in `structuredContent` or the text); only its sha256
  is stored, it lasts 24 hours, it is tied to the app's client id, a repeat `sign_document`
  replaces it, and any decision spends it. The card's buttons call the app-only
  `app_decide_approval { approvalId, nonce, decision }`; `app_approval { approvalId }` refreshes
  it. Everywhere else the card has one button that opens DocuStamp.
- **Approving in DocuStamp.** Cloud functions (session, the approval must be the user's):
  `listsignapprovals { status?: 'pending'|'all' }`, `getsignapproval { id }`,
  `getsignapprovalpage { id, page }` (a PNG data url of the page as the user will sign it),
  `decidesignapproval { id, decision }`.
- **Deciding** claims the row with a conditional write (pending -> approving, or declined), so the
  web and the chat cannot both sign. Approving re-checks the values and the fingerprint, then
  signs the current copy with `agentSignDocument(..., { agent, allowedBy: { via, approvalId } })`:
  the agent that asked is recorded even when the user approved in a web session. The result is
  `signed`, or `failed` with the reason in `error`.
- **Staying current.** Every read settles the request first: it expires when the document is
  completed, declined, voided, expired or deleted, when the user signed some other way, or when
  the file, the seats or the signers changed (the fingerprint covers `URL`, the placeholder ids,
  roles and contacts, and `Signers`; not the signed copy, so a co-signer signing does not expire it).
- **`get_approval { approvalId, waitSec? }`** long-polls (up to 55 s) until the user decides.

### The DocuStamp app inside ChatGPT and Claude (MCP Apps)

Hosts that render MCP Apps get screens, not just tools (`cloud/mcp/app.js`). One page, built from
`apps/web/src/mcp-app/` into `apps/web/dist/mcp-app.html` by `npm run build` (script
`scripts/build-mcp-app.mjs`: a single self-contained HTML file with the script, the CSS and the
IBM Plex Sans / Geist Mono fonts inlined, because the host sandbox loads nothing from outside), is
registered as the UI resource `ui://docustamp/app-v1`. Bump that version when the page and the data
it expects change incompatibly; hosts cache by uri.

| Tool | Where it shows |
| --- | --- |
| `open_docustamp` | ChatGPT sidebar app (`openai/ui` global entrypoint): In progress, Drafts, Completed, each document's page, signers and actions |
| `open_review_panel` | ChatGPT panel beside a conversation (thread entrypoint, "Review and send") |
| `show_document` | a card in the chat; a draft shows its signing page and a Send button so the user sends it themselves; a document sent to the user shows what it asks of them |
| `show_documents` | a short list card in the chat |
| `sign_document` | the "signed for you" document card, or the approval card for a document someone else sent |
| `app_home`, `app_document`, `app_page`, `app_approval`, `app_decide_approval` | data and actions the page uses, hidden from the model (`visibility: ["app"]`) |

The page acts only through the ordinary tools (`send_document`, `send_reminder`, `extend_expiry`,
`void_document`), so it can do nothing the connection could not; a read-only connection gets
`canWrite: false` and no action buttons. The exception is `app_decide_approval`, which needs the
approval code only the card holds. In ChatGPT the model reads `structuredContent` as well as the
text, so nothing secret goes there; the result's `_meta` is the page's alone. It uses the web app's design tokens
(`apps/web/src/styles/tokens.css`) and components, and takes only light or dark from the host.

To work on it without ChatGPT, run the server with `CORS_ORIGINS=http://localhost:3001`, then
`npm run dev` in apps/web and open
`http://localhost:3001/dev/mcp-host/?mcp=http://localhost:8080/api/mcp&token=os_...&tool=open_docustamp&mode=fullscreen`
(`mode` inline | fullscreen | panel, `theme` light | dark, `args` as JSON). The server re-reads the
built page on every request outside production, so `npm run build:mcp-app` is enough after a change.

### Tool safety labels

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) from one
table, `TOOL_ANNOTATIONS` in `cloud/mcp/server.js`, and the scope it needs in
`_meta.securitySchemes`. Hosts such as ChatGPT ask the user before running a tool marked
destructive. Four kinds:

- read only (23 tools): looks, changes nothing.
- changes (25): changes something in the account that can be put back; every draft edit is
  snapshotted first.
- destructive (6): deletes, overwrites workspace-wide branding, or signs for the user
  (`sign_document`, which cannot be taken back from here, only voided).
- outreach (7): emails people or arms an automatic send (`send_document`, `quick_send`,
  `send_reminder`, `resend_to`, `replace_signer`, `void_document`, `set_chain`). Marked
  destructive and open-world, because a sent email cannot be taken back.

`openWorldHint` is also set on the tools that may download a PDF from a public url or post to a
webhook url. A new tool without an entry in the table is refused at registration, and
`spec/OAuth.spec.js` checks the whole list.

Tools: `whoami`, `get_branding`, `update_branding`, `get_audit_trail`, `verify_document`, `void_document`, `replace_signer`, `resend_to`, `extend_expiry`, `wait_for`, `preview_page`, `find_text`, `detect_fields`, `place_field_at_text`, `upload_document`, `analyze_document`, `create_document`, `quick_send`,
`send_document`, `sign_document`, `get_approval`, `list_inbox`, `review_document`, `list_documents`, `get_document`, `get_signing_links`, `send_reminder`,
`list_contacts`, `add_contact`, `update_contact`, `delete_contact`, `list_templates`, `create_template`, `save_as_template`, `delete_template`, `create_document_from_template`, `list_folders`, `create_folder`, `merge_documents`, `create_upload`, `complete_upload`, `register_webhook`, `list_webhooks`, `test_webhook`, `delete_webhook`, plus the
draft tools below. `quick_send` = upload + AI analysis + bind recipients + create + email in one
call; when a role has no email it returns `needsRecipients` (with `suggestedEmail` when the
address was only printed in the document) and the **full** proposal instead of sending. Pass that
proposal back in `proposal` on the follow-up call to skip a second, identical model call.
`list_contacts`, `list_templates` and `list_documents` all take `limit` + `skip`.

### Conventions worth knowing (fixed 2026-08-22)

- **Checkbox / radio / dropdown `defaultValue`**: the API accepts option labels or 0-based indexes
  and always reads back labels. The stored widget JSON keeps the legacy contract the signer and
  the stamping code read: checkbox = array of option indexes, radio / dropdown = the label string
  (`widgets.normaliseDefaultValue` / `presentDefaultValue`). An unknown label is refused.
- **`hideLabel`** (checkbox / radio / dropdown) stops the option label being printed next to the
  box; `place_field_at_text` defaults it to true for a single-option box (the label is already on
  the page).
- **Drawn rules**: `find_text`, `detect_fields`, `place_field_at_text` and the AI transcript see
  underlines drawn as vectors (a border-bottom, a ruled line, a thin rectangle) as blanks, read
  from the page's drawing operators with the CTM tracked (`ai/pdfLayout.vectorRules`); such
  blanks carry `drawn: true`, and a rule with no text on its row becomes a text-less line `p<n>r<k>`.
- **Anchored sizing**: a field placed on a line takes its height from the line (`line height + 8`,
  at least the type's minimum); signature / stamp / draw keep their default height. A
  `widthToNextAnchor` gap narrower than the type's minimum width is an error, not a clamp.
- **`preview_page { mode: "signer" }`** draws every still-empty field as a light dashed box in its
  owner's colour (what the signer is asked to fill) plus prefilled values and ticks.
- **`verify_document`** hashes the exact bytes: pass `fileBase64`, or a url stored with
  `keepOriginal: true` (`upload_document`, `complete_upload`); the default upload flattens the PDF
  and changes the bytes.
- **`delete_template`** soft-deletes a template. **`envelope`** (`parts`, `pageCount`) is stored
  on the document and returned by `get_draft` / `get_document`.
- **`voided`** is a status of its own (`documentStatus`, `list_documents { status: "voided" }`,
  `wait_for`); a voided document's unsigned signers read `voided`. `get_audit_trail` entries carry
  the person inside `who` (`kind`, `name`, `email`, `contactId`, `role`), not at the top level.

### Webhooks, large uploads, envelopes, per-document dates

`register_webhook` / `list_webhooks` / `test_webhook` / `delete_webhook` (`cloud/lib/webhooks.js`,
class `contracts_Webhook`, master-key only, created on first use and by
`databases/migrations/20260822120000-create_contracts_webhook.cjs`). Events: `sent`, `viewed`,
`signed`, `completed`, `declined`, `voided`, `reminder`, `chained`, `received` (or `*`). Every delivery is a JSON POST
`{id, event, createdAt, document, signer?, reason?, chain?}` (`document` is the `get_document` summary without
signing links) with `X-DocuStamp-Event`, `X-DocuStamp-Delivery` and
`X-DocuStamp-Signature: sha256=HMAC_SHA256(secret, raw body)`; three attempts (0 s, 2 s, 8 s), 8 s
timeout, https only, private hosts refused, at most 10 per account. Delivery is fire-and-forget
from the action that caused the event and never fails it; the last status and failure count show
in `list_webhooks`. The secret is returned once by `register_webhook` (and by
`list_webhooks { showSecrets: true }`).

`received` is the one event about someone else's document: it goes to the recipient's own hooks
when a document sent to them becomes their turn (at send, or when the signer before them
finishes), with `document` = `{id, title, sender {name, company, email}, sentAt, expiresAt, myRole}`
and no links, so an agent can follow it with `list_inbox` or `get_document`.

`create_upload` / `complete_upload` (`cloud/lib/uploads.js`): a presigned PUT url on object
storage (15 minutes) for the raw bytes, then `complete_upload { uploadId }` reads them back,
flattens and stores them and returns the url. On local-disk storage `create_upload` answers
`mode: "direct"`. Download urls returned over the API / MCP now live for `API_FILE_URL_TTL`
seconds (default 3600, was 600).

`merge_documents` concatenates PDFs into one stored file and reports `parts` (first page and page
count of each); `create_document { attachments: [...] }` does the same inline and returns
`envelope.parts`, so an MSA + BAA + ACH is one document, one link, one OTP.

Settings gained `dateFormat` (one of the account's formats, e.g. `DD/MM/YYYY`), `timezone`
(IANA) and `is12HourTime`: stored on the document (`DateFormat`, `Timezone`, `Is12HourTime`),
used by the certificate and the signer's date fields instead of the account defaults.

### Chaining: send B when A completes

`chain` on `create_document`, `create_document_from_template`, `quick_send`, `update_draft` and
`create_template` (`{templateId, recipients?, name?, note?, message?}`, `null` removes it;
`cloud/lib/documents.js normaliseChain`, stored as `Chain`, migration
`databases/migrations/20260831120000-add_document_chain.cjs`): when the document completes, a
follow-up is created from `templateId` and sent automatically (`cloud/lib/chain.js`, fired from
the exactly-once completion branch of `signPdf`). Without `recipients` the completed document's
signers are carried over in order; with them, the list must fill every role of the target
template. A template's own `chain` is inherited by documents created from it (an explicit
`chain`, including `null`, wins). The follow-up goes out through the normal send path (mails,
reminders, `sent` webhook) and reports `chainedFrom`; the completed document reports `chain`
(the config) and, once fired, `chainResult` (`{status: sent|failed, documentId?, error?, at}`)
in `get_document`, and the `chained` webhook event carries the same outcome as `chain`.
Chains can be linked (B chains to C) for multi-step flows. `set_chain` (`cloud/lib/lifecycle.js
setDocumentChain`) sets, changes or removes the chain on an existing document: drafts go through
the versioned draft edit, sent-but-unfinished documents are stamped directly, and completed /
declined / voided documents are refused (the chain would never fire).

### Templates, contacts, folders (the write half)

`create_template` (`cloud/lib/templates.js`) builds a `contracts_Template` from a PDF, a list of
roles (labels only; they bind to people in `create_document_from_template`), fields in the
`create_document` shape (`recipient` = role index, role label or `"prefill"`), settings and the
default message. `save_as_template` is the web app's action for any owned document, optionally
under a new name. `update_contact` / `delete_contact` go through the same paths as the web app
(`editcontact`; soft delete). `list_folders` / `create_folder` expose the drive's folders
(`contracts_Document` rows with `Type: "Folder"`) so the `folderId` that `create_document` and
`update_draft` accept can be discovered or made.

### After sending: void, replace a signer, resend to one, extend, wait

`cloud/lib/lifecycle.js`. `void_document` withdraws a sent, uncompleted document: it is recorded
as declined by the sender (`IsVoided: true`, `voided: true` on the summary, a `Voided` audit entry),
the signing links stop working, and pending signers are emailed unless `notifySigners: false`.
`replace_signer` puts a different person in the seat of a signer who has not signed yet (their
fields stay; the new signer is mailed when it is their turn). `resend_to` mails the request again
to one pending signer (`send_document { resend: true }` mails everybody pending). `extend_expiry`
moves the deadline (`days` from now or `expiresAt`). `wait_for` long-polls up to 55 s until the
document reaches one of the given statuses, or until anything changes (a signature lands), and
returns the summary with `reached` / `timedOut`.

Signing urls and tokens are secret material: `get_document` and `send_document` leave them out
unless `includeLinks: true` (`get_signing_links` returns them on purpose). The REST API is
unchanged.

### Page previews and text-anchored placement (no AI)

`preview_page` (`cloud/lib/preview.js`) renders one page with pdf.js onto an `@napi-rs/canvas`
surface and returns a PNG image part plus a JSON part listing the fields on that page. `mode:
"overlay"` (default) draws every field as a translucent box in its owner's colour with a caption
(type, owner), prefilled values and ticked checkbox / radio options inside; `mode: "signer"` draws
no boxes, only what a signer sees before filling anything (prefilled text, the option boxes with
their ticks, laid out the way the stamping code lays them out). `source: "signed"` renders the
latest signed copy of a sent document. `scale` is pixels per PDF point (0.5 to 3, default 1.5; the
longer side is capped at 4000 px).

`find_text`, `detect_fields` and `place_field_at_text` (`cloud/lib/anchors.js`) work from the same
pdf.js text layout the AI is grounded on (`ai/pdfLayout.extractLayout`), in PDF points from the
top-left of the page box. `find_text` gives the page, line id, line box and the span of the phrase
inside the line (estimated per character), with any underline runs on that line. `detect_fields`
turns every "Label: ________" run into a typed candidate (signature, initials, date, name, email,
company, job title, text input), sitting on the rule, the server-side twin of the editor's
"Auto-detect fields"; it writes nothing. `place_field_at_text` finds a phrase and appends one field
after it: width from the blank run on the line, or up to `widthToNextAnchor` (a second phrase on
the same line), or `width` / the type default; text-like fields centre on the line, signature-like
fields sit on it; `align: "below" | "above"`, `occurrence`, `offsetX/Y` adjust. It is a normal
draft edit (snapshotted, undoable) and returns the draft plus `placed` (field, anchor, how the
width was derived).

### Audit trail, certificate data and copy verification

`get_audit_trail` (`cloud/lib/audit.js`) returns what the document page and the completion
certificate show, as JSON: `entries` (activity Viewed / Signed / Approved / Declined, `who` with
name, email, contactId and role, `at`, `ip`), `lifecycle` (created, sent, expires, completed,
declined with reason and by whom), `versions` (the draft history, newest first, with the reason and
origin of each change), `opens` (how often each signer opened their signing link: `total`,
`bySigner` with count, first and last time, and the 20 most recent opens with IP and browser;
every signing-page open counts, also after signing, and email opens are not tracked) and, once
completed, `certificate` (`documentHash` sha256 of the signed copy,
the signer table with viewed/signed times, open counts and IPs, the certificate url). `verify_document` takes a
PDF (`fileBase64` or `url`) and compares its sha256 with the stored hash: with `documentId` against
that document (`authentic` / `different` / `not_completed` / `no_stored_hash`), without one it looks
the hash up across your completed documents. It also reports whether the file is `sealed` (carries
a PDF digital signature).

`review_draft` also warns about: required prefill fields with no value (`prefill_required_empty`),
optional text fields that print as a blank line when left empty (`optional_text_field`), a signer
with a signature field but no date field (`signature_without_date`), and mails that would go out
as the platform's own name because neither the workspace sender name, the profile company nor "use
my name as sender" is set (`unbranded_sender`; `send_document` repeats it in `warnings`).

### Branding tools

`get_branding` / `update_branding` (`cloud/lib/branding.js`) read and write the workspace's email
branding, the same `partners_Tenant` fields Settings > Branding and Settings > Email templates write
through `updatetenant`: `senderName` (the From display name every mail goes out under; without one a
request goes out as the sender's company, which `effectiveSenderName` reports), `replyTo`, `footer`,
`logoUrl` (a file already uploaded to this server), `hidePoweredBy`, `workspaceName`, and the default
`requestSubject` / `requestBody` / `completionSubject` / `completionBody` templates with their
`{{variables}}` (listed in `templateVariables`). Writes go through `updateTenantForUser`, so the role
check (tenant admin or org admin; `canEdit` on the read) and the validation are exactly the web
app's. Pass only the fields to change; `null` or `""` clears one. A subject without its body (or
the reverse) is stored but not applied, and the tool warns.

### Draft tools (full control over anything not yet sent)

All of these live in `cloud/lib/drafts.js` and are shared by the MCP tools and the REST routes.
A document is a draft until `send_document`; after that it is read-only here (use
`duplicate_document` for an editable copy). Every mutation first snapshots the draft into
`contracts_DocumentVersion` (master-key-only class, max 40 versions per document, created on
first use and by `databases/migrations/20260821120000-create_contracts_documentversion.cjs`).

| Tool | What it does |
|---|---|
| `get_draft` | Everything about a document: recipients with contact ids and their fields (`key`, type, page, x, y, width, height, label, required, values, defaultValue), prefill fields, settings, email message, note, folder, version count, editor/send links. `pages: true` adds page sizes |
| `review_draft` | `readyToSend` plus `errors` (no recipients, missing/duplicate/invalid emails, unbound contact, no fields, field off the page or beyond the last page, too many reminders, unreadable PDF), `warnings` (recipient without fields or without a signature field, overlapping fields, untitled, long subject) and `info` |
| `update_draft` | Any of `name`, `note`, `description`, `settings` (partial merge), `message`, `folderId` (null = root), `url` / `fileBase64` (replace the PDF, fields kept), `recipients` (full list; a recipient keeps its fields when it matches an existing one by contact, email, role label, or same slot in a same-length list unless given a different role label; removed recipients lose theirs, reported as `droppedFields`) |
| `set_draft_fields` | `mode: "replace"` (default, empty list clears) or `"append"`; same field shape as `create_document` (`recipient` = index, email, role, or `"prefill"`) |
| `update_draft_field` | One field by `key`: x, y, page, width, height, label, required, values, defaultValue, readOnly, recipient (hand over, or `"prefill"`), type, dateFormat. Keeps its key |
| `remove_draft_fields` | By `keys`, or every field matching `recipient` / `type` / `page` (AND), or `all: true` |
| `ai_layout_draft` | Runs the AI over the draft's PDF; roles bind to the draft's recipients in order (or to `recipients`, which replaces the list first); `mode` replace/append; returns `needsRecipients` and changes nothing when a role cannot be bound. Turns on signing order when the AI says it matters |
| `save_draft_version` | Named checkpoint (`label`) |
| `list_draft_versions` | Newest first: version number, label, reason (the change it preceded), origin, name, field count, recipients, time |
| `get_draft_version` | Full content of one version (recipients, fields, settings, message) for comparing |
| `restore_draft_version` | Put the draft back to a version (number or versionId); the current state is saved first, so it is undoable |
| `undo_draft_change` | Restore the latest snapshot = the state before the most recent change. Calling it twice redoes |
| `duplicate_document` | New draft copying any owned document (draft, sent, completed): PDF, recipients, fields, settings, message |
| `delete_draft` | Soft delete (`IsArchive: true`, the web app's delete). `force: true` for sent/completed documents. The one tool that does **not** return the full draft: it answers `{ objectId, name, status, deleted, restorable }` |
| `restore_deleted_document` | Un-archive; without `documentId` lists the deleted documents |

Every draft tool that touches a document returns the `get_draft` document at the top level
(`objectId`, `status`, `signers`, `recipients`, `fieldCount`...), with call-specific extras
(`changed`, `removed`, `restored`, `copiedFrom`, `applied`...) beside it, like the other
document tools. The exception is `delete_draft` (and `DELETE /documents/:id`): the document is
archived, so it answers with the stub above rather than a full draft.

Field coordinates, as everywhere, are PDF points from the top-left of the page. Changes made
here show up in the web editor (`/editor/:id`) and send page (`/send/:id`) as if made there:
the same `Placeholders` / `Signers` fields are written, `Signers` stays index-parallel with the
signer groups, and widgets carry the editor's `options` (`name`, `status`, `hint`, `values`...).
The web app's own edits are not snapshotted (it writes the class directly), so `undo_draft_change`
reverts the last API/MCP change only.

Field coordinates everywhere are PDF points, origin top-left of the page (the stored
`xPosition`/`yPosition` system).

## 5. REST API v1

Base `https://sign.example.com/api/v1`, same token. JSON in/out; Parse error codes map to
HTTP (209→401, 119→403, 101→404, 155→429, validation→400).

| Route | Body / query | Returns |
|---|---|---|
| `GET /me` | | `{ name, email, company, ai }` |
| `POST /files` | `{ fileBase64, fileName? }` | `{ url }` |
| `POST /documents/analyze` | `{ url \| fileBase64, instructions?, recipients?, acceptExtractedRecipients? }` | proposal + `needsRecipients` |
| `POST /documents/quick-send` | `{ url \| fileBase64, fileName?, instructions?, recipients?, name?, settings?, message?, note?, dryRun?, acceptExtractedRecipients?, proposal? }` | `{ document, proposal }` or `{ document: null, needsRecipients, proposal }` (full proposal, hand it back to skip the second analysis) |
| `POST /documents` | `{ name, url, recipients[], fields?[], placeholders?[], settings?, message?, note?, description?, folderId?, send?, pageCount? }` (only these keys are read) | document summary |
| `GET /documents` | `?status=all\|draft\|in_progress\|completed\|declined\|expired&search=&limit=&skip=` | `{ documents[] }` |
| `GET /documents/:id` | | summary + `urls{ original, signed, certificate, app }` |
| `POST /documents/:id/send` | `{ resend? }` | summary + `mail{ sent, failed, signingLinks }` |
| `POST /documents/:id/remind` | | `{ sent, skipped }`; refused (400) for a document that was never sent, or is completed or declined, and 404 for a deleted one |
| `GET /documents/:id/signing-links` | | `{ links[] }` |
| `GET /documents/deleted` | `?limit=` | `{ documents[] }` soft-deleted |
| `GET /documents/:id/draft` | `?pages=true` | full draft (see `get_draft`) |
| `GET /documents/:id/review` | | `{ readyToSend, errors, warnings, info, ... }` |
| `PATCH /documents/:id` | `{ name?, note?, description?, settings?, message?, folderId?, url? \| fileBase64?, recipients? }` | document + `changed[]`, `droppedFields?` |
| `PUT /documents/:id/fields` | `{ fields[] }` replace; `fields` must be an array (an empty one clears the draft, a missing one is a 400, never a silent wipe) | document + `added`, `mode` |
| `POST /documents/:id/fields` | `{ fields[] }` append | same |
| `PATCH /documents/:id/fields/:key` | changes (x, y, page, width, height, label, required, values, defaultValue, readOnly, recipient, type, dateFormat) | document + `field`, `changed[]` |
| `DELETE /documents/:id/fields` | body or query: `keys`, `recipient`, `type`, `page`, `all` | document + `removed` |
| `DELETE /documents/:id/fields/:key` | | document + `removed` |
| `POST /documents/:id/ai-layout` | `{ instructions?, recipients?, mode? }` | document + `applied`, `proposal` (and `needsRecipients` when `applied: false`) |
| `GET /documents/:id/versions` | `?limit=` | `{ versions[] }` |
| `POST /documents/:id/versions` | `{ label? }` | version |
| `GET /documents/:id/versions/:v` | | version + `state` |
| `POST /documents/:id/versions/:v/restore` | | document + `restored` |
| `POST /documents/:id/undo` | | document + `restored` |
| `POST /documents/:id/duplicate` | `{ name? }` | document + `copiedFrom` |
| `DELETE /documents/:id` | `{ force? }` or `?force=true` | `{ deleted, restorable }` |
| `POST /documents/:id/restore` | | document + `restored: true` |
| `GET /contacts`, `POST /contacts` | `?search=` / `{ name, email, phone?, company?, jobTitle? }` | |
| `GET /templates` | | `{ templates[] }` with roles |
| `POST /templates/:id/documents` | `{ recipients[], name?, note?, settings?, message?, send? }` | document summary |

`fields[]`: `{ recipient: index \| email \| role \| "prefill", type, page, x, y, width?, height?,
label?, required?, values? }`. With neither `fields` nor `placeholders`, every recipient gets a
signature + date box at the bottom of the last page: the PDF is read for the real page count and
page size, and `pageCount` in the body is only the fallback when it cannot be read.

`POST /documents` and `POST /documents/quick-send` accept an **`Idempotency-Key`** header. The
same key from the same token replays the first answer (and waits for it while it is still
running) instead of creating and mailing a second copy, for 10 minutes. In-memory per process,
so it covers a client retry rather than two instances behind a load balancer.

Document summary: `{ objectId, name, status, createdAt, sentAt, expiresAt, fieldCount,
sendInOrder, otp, signers[{ order, role, name, email, contactId, status: pending|signed|declined,
signedAt, signingUrl }], hasCertificate }`.

## 6. Tests

```bash
cd apps/server && npx mongodb-runner start --port 27017
SERVER_URL=http://localhost:30001/test APP_ID=test MASTER_KEY=test TESTING=true npx jasmine --filter="API tokens"
TESTING=true npx jasmine spec/OAuth.spec.js
```

## 7. Known limits

- One personal token per user (rotate replaces it), with no scopes. OAuth connections have three
  scopes (`documents:read`, `documents:write`, `documents:sign`); there is no finer split yet.
- Agent signing covers the user's own documents. Documents other people send need an approval
  step that is not built yet; `sign_document` refuses them.
- OAuth: dynamic client registration only. Client ID Metadata Documents (CIMD) are not supported
  yet, and MCP Events (automations that start from a document event) are not implemented.
- Every rate limit and the idempotency store are in-memory per Node process; scale out and they
  multiply. There is no per-account cost ceiling on AI usage beyond the 10 calls/minute.
- The AI transcript stops at 60 pages and ~320k characters; fields the model puts on a page past
  that are dropped with a warning rather than placed.
- Draft history keeps the last 40 versions per document and only covers API/MCP edits, not the web editor's.
- Webhooks are best-effort (three attempts, no queue): a receiver that is down for a minute misses the event; reconcile with `get_document` / `wait_for`. No `expired` event (nothing runs at expiry).
- The MCP endpoint is stateless, so it cannot push `notifications/tools/list_changed`; a client that cached the tool list has to reconnect (or call `tools/list` again) to see new tools.
- The MCP endpoint is POST-only (no SSE resumption), by design.
- Radio buttons proposed by the AI use the 5×10 pt default; resize in the editor if needed.
