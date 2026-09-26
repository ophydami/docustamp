# DocuStamp Backend API Contract

> Reference for building a frontend against the DocuStamp backend.
> Backend source: `apps/server` (Parse Server 8 + Express 5).
> It was first written against the previous frontend, which has since been
> removed; passages that describe that frontend are historical.
>
> Everything below was read out of the source in this repo. Where behaviour is
> ambiguous or looks like a bug it is called out explicitly rather than guessed at.

---

## Table of contents

1. [Topology and connection](#1-topology-and-connection)
2. [Auth flows](#2-auth-flows)
3. [Parse classes / data model](#3-parse-classes--data-model)
4. [Cloud functions reference](#4-cloud-functions-reference)
5. [Custom Express routes](#5-custom-express-routes-non-parse)
6. [Signing data model](#6-signing-data-model)
7. [Widgets / field types](#7-widgets--field-types)
8. [Files and PDFs](#8-files-and-pdfs)
9. [Reports (the magic objectIds)](#9-reports-the-magic-objectids)
10. [Realtime, mail, notifications, webhooks](#10-realtime-mail-notifications-webhooks)
11. [Quirks and gotchas](#11-quirks-and-gotchas)

---

## 1. Topology and connection

### 1.1 Server layout

`apps/server/index.js` builds a single Express app:

| Mount | What it is |
|---|---|
| `${PARSE_MOUNT \|\| "/app"}` | The Parse Server REST API (`/classes/...`, `/functions/...`, `/users/me`, `/files/...`, `/batch`, `/loginAs`) |
| `/public` | static assets |
| `/` | custom Express routes (`/docxtopdf`, `/decryptpdf`, `/delete-account/...`, `/deleteuser/:userId`) |
| `GET /` | health string `docustamp-server is running !!!` |

In the Docker image the server answers the whole site: the web app at `/` and the
API under `/api` (cloud/lib/webApp.js), so the browser-visible Parse base URL is
`https://<host>/api/app` and the custom Express routes live at
`https://<host>/api/docxtopdf` etc. The same paths also answer without the `/api`
prefix, for the server's own loopback calls and for proxies that strip it.

Relevant Parse Server config (`index.js`):

```js
appId: process.env.APP_ID || 'docustamp',
masterKey: process.env.MASTER_KEY,
serverURL: 'http://localhost:8080/app',        // internal, see Utils.js cloudServerUrl
publicServerURL: process.env.SERVER_URL,
maxLimit: 500,
maxUploadSize: '100mb',
allowClientClassCreation: false,
verifyUserEmails: false,
encodeParseObjectInCloudFunction: true,
auth: { google: { clientId: process.env.GOOGLE_CLIENT_ID }, sso: SSOAuth },
```

`app.use(cors())` with no options, i.e. **CORS is fully open** (`Access-Control-Allow-Origin: *`).
There is no `liveQuery` config — **LiveQuery is not enabled.**

Two request middlewares run before Parse:

* `req.headers['x-real-ip']` is set from `x-forwarded-for` (first entry) or the socket address. Cloud functions read this for audit trails / `OriginIp`.
* `req.headers['public_url']` is set to `https://` + `req.get('host')`. Cloud functions use this to build signing links in emails.
* Any `GET` under `/files/` **must** carry a `?token=<jwt>` query param or it is rejected with `400 {"message":"unauthorized"}` (see [§8](#8-files-and-pdfs)).

### 1.2 Environment variables the frontend cares about

The web app (`apps/web`, see `src/lib/parse.ts`) reads these at build time:

| Var | Notes |
|---|---|
| `VITE_APPID` | Parse application id, must match the server's `APP_ID` (default `"docustamp"`) |
| `VITE_SERVERURL` | full server URL, e.g. `https://sign.example.com/api/app`; unset means same-origin `/api/app` |
| `VITE_PARSE_MOUNT` / `VITE_CUSTOM_ROUTE_BASE` | where the plain Express routes live when they are not `VITE_SERVERURL` minus the last path segment |
| `VITE_GOOGLE_CLIENT_ID` | shows "Continue with Google" when set |
| `VITE_SOURCE_URL` | where the in-app "Source" links point |

### 1.3 How the base URL is resolved

`SERVER_URL` is `VITE_SERVERURL` or `window.location.origin + "/api/app"`, trailing
slashes removed. The Express routes (`/docxtopdf`, `/decryptpdf`, `/deleteuser`, `/mcp`,
`/v1`) hang off the same URL with the Parse mount stripped: `https://host/api/app` becomes
`https://host/api`.

### 1.4 Parse SDK initialisation

`initParse()` in `src/lib/parse.ts` is the only place the SDK is configured:

```ts
Parse.initialize(APP_ID, import.meta.env.VITE_JS_KEY || undefined);
Parse.serverURL = SERVER_URL;
```

No master key and no LiveQuery URL. The master key is never sent from the browser.

The previous frontend also cached connection info in localStorage:

```js
localStorage.setItem("parseAppId", appId);
localStorage.setItem("baseUrl", `${serverUrl_fn()}/`);   // NOTE: trailing slash
```

Because `baseUrl` already ends in `/`, all hand-rolled URLs are built as
`` `${baseUrl}functions/xyz` `` with **no** extra slash. (A couple of call sites get this
wrong — see [§11](#11-quirks-and-gotchas).)

### 1.5 Transport styles in use

The old frontend hits the backend three different ways. A new frontend can pick one,
but must understand all three because the server tolerates all of them.

**(a) Parse JS SDK** — `Parse.Cloud.run(name, params)`, `new Parse.Query(cls)`,
`obj.save()`. The SDK attaches `X-Parse-Application-Id` and
`X-Parse-Session-Token` automatically from `Parse.User.current()`.

**(b) Raw `axios` POST to `/functions/<name>`** — the majority of cloud-function
calls in the old frontend. Canonical shape:

```js
await axios.post(`${baseUrl}functions/getDrive`, { docId, limit, skip }, {
  headers: {
    "Content-Type": "application/json",
    "X-Parse-Application-Id": localStorage.getItem("parseAppId"),
    sessiontoken: localStorage.getItem("accesstoken")   // lowercase!
  }
});
// response: { result: <return value> }   (Parse wraps cloud fn returns in `result`)
```

**(c) Raw `axios` against Parse REST classes** — `GET/PUT/POST {baseUrl}classes/<Class>[/<objectId>]`
with `X-Parse-Session-Token`.

#### Session-token header spellings

Four spellings are in active use against the same server, and **the server reads
different ones in different functions**:

| Spelling | Read by |
|---|---|
| `X-Parse-Session-Token` | Parse Server itself (the standard) |
| `sessiontoken` | `getDocument`, `getDrive`, `getReport`, `getTemplate`, `createBatchDocs`, `triggerEvent`, `docxtopdf`, `deleteUserByAdmin` — these read `request.headers['sessiontoken']` directly |
| `sessionToken` | some frontend call sites (works because Node lowercases header names) |
| `x-parse-session-token` | `getReport` falls back to this |

**Recommendation for the new frontend:** always send **both**
`X-Parse-Session-Token` and `sessiontoken` with the same value on raw HTTP calls.
Several cloud functions authenticate by calling `GET {serverUrl}/users/me` with
`X-Parse-Session-Token: <the sessiontoken header>` — if that header is missing they
return `{ error: "Invalid session token" }` even though `request.user` was populated.

#### Cloud function response envelope

Parse wraps all cloud-function returns:

```jsonc
// success
{ "result": <whatever the function returned> }
// error
{ "code": 209, "error": "User is not authenticated." }
```

Some functions return an error **inside** `result` rather than throwing:

```jsonc
{ "result": { "error": "You don't have access of this document!" } }
{ "result": { "error": "Invalid session token" } }
```

So a new client must check `result.error` in addition to HTTP status.

### 1.6 Session storage and logout

localStorage keys the old frontend depends on:

| Key | Value |
|---|---|
| `accesstoken` | **the session token** (read by nearly every raw axios call) |
| `Parse/{appId}/currentUser` | Parse SDK's own current-user cache (read directly in ~22 places for `objectId`) |
| `UserInformation` | raw `_User` JSON |
| `Extand_Class` | `JSON.stringify([extUser])` — the `contracts_Users` row, **always a 1-element array** |
| `TenantId`, `TenantName` | from `extUser.TenantId` |
| `_user_role` | `UserRole.replace("contracts_","")` |
| `userEmail`, `username`, `profileImg` | display |
| `PageLanding`, `defaultmenuid`, `pageType` | landing route from `appInfo.settings` |
| `baseUrl`, `parseAppId` | connection |
| `appLogo`, `favicon`, `fev_Icon`, `appname`, `userSettings`, `i18nextLng`, `theme` | branding; survive logout |
| `isGuestSigner` | set to `true` by the guest-signing entry page |

Logout (`components/Header.jsx`, and 3 near-duplicates):

```js
await Parse.User.logOut();          // DELETE /app/logout (invalidates _Session)
// then localStorage.clear() and restore branding keys
```

### 1.7 Session validation

Three layers in the old frontend:

* `primitives/ValidateRoute.jsx` — non-blocking; revalidates `Parse.Query(Parse.User).get(currentUser.id, {sessionToken})` and silently clears storage on failure. Wraps `/`, `/addadmin`, `/upgrade-2.1`.
* `primitives/Validate.jsx` — blocking; renders `SessionExpiredModal` on failure. Wraps only `/load/recipientSignPdf/:docId/:contactBookId`. Defaults to *valid* when there is no `accesstoken` at all (correct for public guest signing).
* `layout/HomeLayout.jsx` — the real protected-route gate. Requires **both** `accesstoken` **and** `TenantId` in localStorage, otherwise renders `SessionExpiredModal`.

`utils/withSessionValidation.js` is a pre-flight HOF on mutating handlers:

```js
const tenantId = localStorage.getItem("TenantId");
const sessionToken = Parse.User?.current?.()?.getSessionToken?.();
if (!tenantId || !sessionToken) { dispatch(sessionStatus(false)); throw new Error("invalid session token"); }
```

Parse error code **209** = invalid session token. Only `pages/Form.jsx` handles it explicitly.

### 1.8 Route table of the old frontend (for parity)

| Path | Component | Public/Protected |
|---|---|---|
| `/` | `Login` | Public |
| `/addadmin` | `AddAdmin` | Public (self-gated: refuses if an admin exists) |
| `/upgrade-2.1` | `UpdateExistUserAdmin` | Public (gated by master key) |
| `/login/:base64url` | `GuestLogin` | **Public** — guest signer entry |
| `/load/recipientSignPdf/:docId/:contactBookId` | `PdfRequestFiles` | Semi-public (validates only if a token exists) |
| `/forgetpassword` | `ForgetPassword` | Public |
| `/debugpdf`, `/success`, `/emailbuilder` | — | Public |
| `/dashboard/:id` | `Dashboard` | Protected |
| `/report/:id` | `Report` | Protected |
| `/form/:id` | `Form` | Protected |
| `/drive` | `Drive` | Protected |
| `/managesign` | `ManageSign` | Protected |
| `/preferences` | `Preferences` | Protected |
| `/profile` | `UserProfile` | Protected |
| `/users` | `UserList` | Protected + admin-only body |
| `/changepassword` | `ChangePassword` | Protected |
| `/template/:templateId` | `TemplatePlaceholder` | Protected |
| `/signaturePdf/:docId` | `SignYourSelf` | Protected |
| `/draftDocument` | `DraftDocument` | Protected |
| `/placeHolderSign/:docId` | `PlaceHolderSign` | Protected |
| `/recipientSignPdf/:docId[/:contactBookId]` | `PdfRequestFiles` | Protected |
| `/verify-document` | `VerifyDocument` | Protected (100% client-side, no backend) |

---

## 2. Auth flows

### 2.1 Username / password login

```js
const _user = await Parse.Cloud.run("loginuser", { email, password });
await Parse.User.become(_user.sessionToken);
localStorage.setItem("accesstoken", _user.sessionToken);
```

`loginuser` (`cloud/parsefunction/loginUser.js`) is a thin wrapper over
`Parse.User.logIn(username, password)` returning `user.toJSON()` spread — i.e. the
full `_User` record **including `sessionToken`**.

Params: `{ email: string, password: string }` (`email` is passed as the *username*).
Throws `Parse.Error.PASSWORD_MISSING` if either is empty.

You can equally call the stock Parse login (`POST /app/login`) — `loginuser` adds nothing.

Error codes seen by the old frontend: `1001` → "action prohibited", anything else → invalid credentials.

### 2.2 Signup

Three distinct signup paths.

**(a) First-admin bootstrap** — `pages/AddAdmin.jsx`:

1. Create a raw `Parse.User` (`name`, `username`=email, `email`, `password`, `phone`) and `save()`.
2. `Parse.Cloud.run("addadmin", { userDetails: { name, email, phone, company, jobTitle, role: "contracts_Admin", timezone, pincode?, country?, state?, city?, address? } })`.
3. `Parse.User.become(sessionToken)`.

`addadmin` (`AddAdmin.js`) creates `partners_Tenant`, `contracts_Users`, then
`contracts_Organizations` (named after `Company`) and a `contracts_Teams` row named
`"All Users"`, and sets `UserRole=contracts_Admin`, `OrganizationId`, `TeamIds` on the ext user.
Returns `{ message: 'User sign up' | 'User already exist', sessionToken }`.

If the `_User` already exists, `addadmin` logs in as it via master key:
`POST {serverUrl}/loginAs?userId=<id>` with `X-Parse-Master-Key`.

**(b) Self-serve signup / post-login extra info** — `usersignup`:

```js
Parse.Cloud.run("usersignup", { userDetails: {
  name, email, phone, role: "contracts_User",
  company, jobTitle, timezone, pincode?, country?, state?, city?, address?
}});
// → { message: 'User sign up' | 'User already exist', sessionToken }
```

Creates `_User` (or `loginAs` if it exists), a `partners_Tenant`, and a
`<prefix>_Users` row where prefix is `role.split('_')[0]` (so `contracts_User` → `contracts_Users`).
Sets `normalizedEmail` on the `_User`.

**Note:** `usersignup` swallows all errors (`catch { console.log }` and returns `undefined`).

**(c) Admin invites a user** — `adduser`:

```js
Parse.Cloud.run("adduser", {
  name, email, phone, password, timezone,
  role: "OrgAdmin" | "Editor" | "User",       // NOT the contracts_ prefix
  team: "<contracts_Teams objectId>",
  tenantId: "<partners_Tenant objectId>",
  organization: { objectId: "<contracts_Organizations objectId>", company: "..." }
});
```

Server-side authorisation (`addUser.js`): caller must be `contracts_Admin` or
`contracts_OrgAdmin`; `tenantId` must equal the caller's own tenant; the target org must
belong to the caller's tenant; an `OrgAdmin` may only add to their own org; the team must
belong to the target org; `role` is restricted to the allow-list above (you can never
create a `contracts_Admin` here). Returns the saved `contracts_Users` JSON.

### 2.3 Google / SSO

The **server** registers two auth adapters (`index.js`):

```js
auth: { google: { clientId: process.env.GOOGLE_CLIENT_ID }, sso: SSOAuth }
```

`SSOAuth` (`auth/authadapter.js`) is only registered when `SSO_API_URL` is set. It
validates `authData.access_token` against `${SSO_API_URL}/oauth/userinfo` and requires
`response.data.email === authData.id`.

Usage would be the standard Parse `POST /app/users` with
`{ authData: { sso: { id: "<email>", access_token: "..." } } }`, or `linkWith`.

**The old frontend contains no Google or SSO login UI at all** — `appInfo.googleClientId`
is dead config, and `src/hook/useScript.js` (a leftover Google sign-in script loader) is
imported by nothing. A new frontend implementing SSO is building it from scratch.

### 2.4 Forgot / reset password

* **Forgot password (self-serve):** `Parse.User.requestPasswordReset(email)` → stock Parse
  `POST /app/requestPasswordReset`. Email templates are at
  `apps/server/files/password_reset_email.{txt,html}`. The reset itself is Parse
  Server's hosted page — there is **no in-app reset-with-token route**.
* **Change own password (logged in):** `Parse.User.logIn(email, currentPassword)` then
  `user.set("password", newPassword); user.save()`. Client-side policy: ≥8 chars,
  lower+upper+digit, one special char from `!@#$%^&*()-_=+{};:,<.>`.
* **Admin resets someone else's password:**

  ```js
  Parse.Cloud.run("resetpassword", { userId: "<_User objectId>", password: "..." });
  // → { status: "success", message: "Password has been reset." }
  ```

  `resetPassword.js` enforces: caller authenticated; caller ≠ target; caller is
  `contracts_Admin`/`contracts_OrgAdmin`; target is in the caller's tenant; target is
  **not** a `contracts_Admin`.

### 2.5 OTP login and the guest-signing entry point

The signing link that goes out in email is:

```
{publicUrl}/login/{base64}
base64 = btoa(`${documentId}/${signerEmail}/${contactBookObjectId}`)
```

(The 4th `/`-separated segment, when present, is a `sendmail` flag string, e.g. `"false"`.)

`pages/GuestLogin.jsx` decodes it with `atob`, splits on `/`, and:

1. Wipes localStorage (keeping `favicon`), sets `baseUrl`, `parseAppId`, `isGuestSigner=true`.
2. If **no** contactBookId in the payload → `Parse.Cloud.run("linkcontacttodoc", { email, docId })` to resolve/create a contact.
3. `Parse.Cloud.run("getDocument", { docId })`.
   * If it succeeds (document is **not** OTP-protected) → navigate to `/load/recipientSignPdf/{docId}/{contactId}`.
   * If it returns `{error: ...}` → the doc has `IsEnableOTP: true`, show the OTP modal.

OTP send:

```js
Parse.Cloud.run("SendOTPMailV1", { email, docId, TenantId? });   // → "Otp send"
```

OTP verify (**the only auth call made as raw REST**, deliberately without a session token):

```js
POST {baseUrl}functions/AuthLoginAsMail
headers: { "Content-Type": "application/json", "X-Parse-Application-Id": <appId> }
body:    { email, otp }
```

Response `result` is one of:

| `result` | Meaning |
|---|---|
| `"Invalid Otp"` | wrong code |
| `"user not found!"` | no `_User` with that email |
| `"Result not found"` | internal error |
| `{ objectId, sessionToken, ...user }` | success |

On success the frontend does `Parse.User.become(sessionToken)` and stores
`accesstoken` / `UserInformation` / `Parse/{appId}/currentUser`.

**Server behaviour** (`AuthLoginAsMail.js`): looks up `defaultdata_Otp` by `Email`, compares
`parseInt(otp)`, then master-key `POST {serverUrl}/loginAs?userId=<id>` to mint a session
without knowing the password. Also flips `emailVerified: true`.

**OTP storage:** class `defaultdata_Otp` with fields `Email` (string), `OTP` (number, 4 digits),
`TenantId`. There is **one row per email** — it is overwritten on each send, and it is
**never expired or deleted**. `SendMailOTPv1` generates `Math.floor(1000 + Math.random()*9000)`.

### 2.6 Email verification

```js
Parse.Cloud.run("verifyemail", { email, otp });
// → { message: "Email is verified." } | { message: "Email is already verified." }
// throws { code: 400, message: "OTP is invalid." }
```

Requires an authenticated `request.user`. Sets `emailVerified = true` on the `_User`.
Note `verifyUserEmails: false` in the Parse config, so Parse's own verification flow is off;
this is a separate OTP-based mechanism reusing `defaultdata_Otp`.

### 2.7 `getUserDetails` and the extended user

`contracts_Users` is the "extended user" / profile row that hangs off `_User`.

```js
Parse.Cloud.run("getUserDetails");            // current user
Parse.Cloud.run("getUserDetails", { email }); // → { objectId } only  (existence check)
Parse.Cloud.run("getUserDetails", { userId }) // additionally filters CreatedBy == userId
```

Server (`getUserDetails.js`) queries `contracts_Users` by `Email` and
`include`s `TenantId`, `UserId`, `CreatedBy`; `exclude`s `CreatedBy.authData`,
`TenantId.FileAdapters`, `TenantId.PfxFile`, `google_refresh_token`.

Return shapes (**inconsistent, watch out**):

* with `email` param → `{ objectId: "..." }`
* otherwise → the **full `contracts_Users` Parse object** (because
  `encodeParseObjectInCloudFunction: true`, over the SDK you get a `Parse.Object` and must
  use `.get("UserRole")`; over raw REST you get plain JSON in `result`)
* no row found → `""` (empty string)
* not authenticated → throws `Parse.Error.INVALID_SESSION_TOKEN` (209)

`isextenduser` is a separate, simpler existence check:

```js
Parse.Cloud.run("isextenduser", { email });   // → { isUserExist: boolean }
```

(The old frontend never calls it; it uses `getUserDetails({email})` instead.)

`getUserId` maps an email/username to a `_User` id:

```js
Parse.Cloud.run("getUserId", { email }) // or { username }
// → { id: "<_User objectId>" }
```

**Security note:** `getUserId` uses the master key and has **no authentication check** —
it is an unauthenticated email→userId oracle.

### 2.8 Tenant

`partners_Tenant` is the org/tenant record. Every `contracts_Users` row points at one
via `TenantId`.

```js
POST {baseUrl}functions/gettenant
body: { userId: "<_User objectId>" }   // or { contactId: "<contracts_Contactbook objectId>" }
// → the partners_Tenant object (FileAdapters and PfxFile excluded), or {}
```

`getTenant.js` resolves the tenant from `contracts_Users.TenantId`, falling back to
`partners_Tenant.UserId == CreatedBy || userId`. On error it returns the **string**
`"user does not exist!"`.

Update tenant mail templates and branding:

```js
Parse.Cloud.run("updatetenant", {
  tenantId,
  details: {
    RequestBody?, RequestSubject?, CompletionBody?, CompletionSubject?, EmailEditorType?,
    TenantName?, Logo?, EmailSenderName?, EmailFooter?, HidePoweredBy?, ReplyTo?
  }
});
// → the updated tenant (FileAdapters and PfxFile excluded), Logo presigned
```

Server enforces: caller must be `contracts_Admin`/`contracts_OrgAdmin` **and**
`tenantId` must equal the caller's own `TenantId`; a non-admin gets code 119
(`OPERATION_FORBIDDEN`). Any key outside the list above is refused with code 105
(`INVALID_KEY_NAME`): the whole call fails, nothing is written.

Branding validation (code 142, `VALIDATION_ERROR`, on failure):

| Key | Rule |
|---|---|
| `TenantName` | 1-100 chars, one line, no `<` `>` or control characters |
| `Logo` | http(s) URL that is either a `/files/<appId>/<name>` file on this server or an object on the configured storage bucket. The query string (a presigned token) is stripped before storing, so `partners_Tenant.afterFind` can re-sign it. `""` clears the logo |
| `EmailSenderName` | max 80 chars, one line (CR/LF would be header injection) |
| `EmailFooter` | max 500 chars, plain text; newlines allowed, `<` `>` refused |
| `ReplyTo` | a valid email address, lowercased |
| `HidePoweredBy` | boolean |

Passing `undefined`/`null` for a key **unsets** it; `""` unsets every optional key
(`TenantName` cannot be emptied). Upload a logo exactly like a signature image:
`new Parse.File(...).save()`, then `fileupload` for the signed URL, then send that URL
as `Logo`.

There is also `updateemailtemplates` with the same params, but it writes the same four
keys onto the caller's **`contracts_Users`** row instead of the tenant. (No admin check.)

Branding by domain (unauthenticated):

```js
Parse.Cloud.run("getlogobydomain", { domain: window.location.host });
// → { logo, favicon, appname, tenantName, hidePoweredBy, footer, user: "exist" | "not_exist" }
```

`appname` is the tenant's `TenantName` when it has one, and the server-wide constant
(`"DocuStamp"` by default) otherwise. `tenantName` is `""` when unknown. When no row matches the
`Domain` the server answers with the sole tenant on a single-tenant install, and with a
blank payload when there is more than one (the host is the only way to tell them apart).

`user === "not_exist"` means no tenant exists at all → the app should redirect to `/addadmin`
for first-run bootstrap.

### 2.9 Roles and admin

Role values (stored on `contracts_Users.UserRole`):

* `contracts_Admin` — tenant owner; exactly one is expected
* `contracts_OrgAdmin`
* `contracts_Editor`
* `contracts_User`
* `contracts_Guest` — used for `contracts_Contactbook` rows, not for app users

Role → landing page map lives client-side in `appInfo.settings`:

| role | menuId | pageType | pageId | extended_class |
|---|---|---|---|---|
| `contracts_Admin` | `VPh91h0ZHk` | `dashboard` | `35KBoSgoAK` | `contracts_Users` |
| `contracts_OrgAdmin` | `VPh91h0ZHk` | `dashboard` | `35KBoSgoAK` | `contracts_Users` |
| `contracts_Editor` | `H9vRfEYKhT` | `dashboard` | `35KBoSgoAK` | `contracts_Users` |
| `contracts_User` | `H9vRfEYKhT` | `dashboard` | `35KBoSgoAK` | `contracts_Users` |

Admin-related cloud functions:

```js
Parse.Cloud.run("checkadminexist");    // → "exist" | "not_exist"   (no auth required)
Parse.Cloud.run("getuserlistbyorg", { organizationId });  // → contracts_Users[] (with TeamIds included)
Parse.Cloud.run("getteams", { active: true });            // → contracts_Teams[]
Parse.Cloud.run("updateuserasadmin", { email, masterkey });  // → "admin_created"
```

`updateuserasadmin` requires the **literal `MASTER_KEY` value** as a body param. It promotes
an existing `contracts_Users` row to `contracts_Admin`, creates an org + "All Users" team,
and then **rewrites every other `contracts_Users` row in the database** to
`UserRole=contracts_User` with the new org/team/tenant. Used by the one-off `/upgrade-2.1` migration page.

User enable/disable is a **direct Parse write**, not a cloud function:

```js
const extUser = new Parse.Object("contracts_Users");
extUser.id = user.objectId;
extUser.set("IsDisabled", !IsDisabled);
await extUser.save();
```

### 2.10 Account deletion

Two flows.

**Self-serve, email-confirmed** (`senddeleterequest` + the `/delete-account` Express routes):

```js
Parse.Cloud.run("senddeleterequest", { userId, app? });   // → "mail sent."
```

Only works when the target ext-user's `UserRole === 'contracts_Admin'`; otherwise it throws
`"This action is not permitted. Kindly contact your administrator..."`.
It emails a link to `{SERVER_URL sans /app}/delete-account/{userId}`, which serves an HTML page
that drives:

| Route | Body | Behaviour |
|---|---|---|
| `GET /delete-account/:userId` | — | HTML OTP form |
| `POST /delete-account/:userId/otp` | — | sends an OTP; writes `DeleteOTP`, `DeleteOTPExpiry`, `DeleteOTPSentAt`, `DeleteOTPTries` on `contracts_Users`. `429` if inside the resend cooldown |
| `POST /delete-account/:userId` | `otp=<code>` (form-encoded) | verifies and deletes; `429` after `MAX_ATTEMPTS` |

**Admin-deletes-user:**

```
POST {api}/deleteuser/{targetUserObjectId}
headers: { sessiontoken: <session token> }
```

Caller must be `contracts_Admin`/`contracts_OrgAdmin`, cannot delete themselves, and an
`OrgAdmin` cannot delete an `Admin` or a user outside their org. Returns
`{ message: "..." }` with a 2xx/4xx status.

---

## 3. Parse classes / data model

### 3.1 Class-level permissions (CLP)

From `databases/migrations/20250424104819-change_permission.cjs`:

| Class | get | find | count | create | update | delete | addField |
|---|---|---|---|---|---|---|---|
| `contracts_Document` | `*` | requiresAuthentication | `*` | `*` | `*` | — | requiresAuth |
| `contracts_Template` | `*` | **{} (nobody)** | `*` | `*` | `*` | — | requiresAuth |
| `contracts_Contactbook` | `*` | `*` | `*` | `*` | `*` | — | — |
| `contracts_Signature` | `*` | `*` | `*` | `*` | `*` | — | — |
| `partners_Tenant` | — | — | — | — | — | — | — (master key only) |
| `partners_TenantCredits` | `*` | `*` | `*` | `*` | `*` | — | `*` |
| `partners_DataFiles` | — | — | — | `*` | — | — | `*` |
| `_User` | `*` | `*` | `*` | `*` | `*` | — | — |

Key consequences:

* **Nothing can be deleted via the REST API.** "Delete" everywhere is a soft delete:
  `IsArchive: true` on documents/templates/folders, `IsDeleted: true` on contacts.
* **`contracts_Template` cannot be queried with `find`** from a client — you must go
  through `getTemplate` / `getReport` (which run with the master key server-side).
* `partners_Tenant` is completely locked down — reachable only via `gettenant` /
  `getlogobydomain`, and writable only via `updatetenant` (admin, own tenant, §2.8).
* Object-level ACLs still apply on top (see [§6.6](#66-acl-behaviour)).

### 3.2 `_User`

| Field | Type | Notes |
|---|---|---|
| `username` | String | always the email |
| `email` | String | lowercased, whitespace-stripped |
| `normalizedEmail` | String | unique index (migration `20260402211408`) |
| `password` | String | write-only |
| `name` | String | |
| `phone` | String | indexed (`phone_1`) |
| `ProfilePic` | String (URL) | resolved to a presigned URL by the `afterFind` trigger |
| `emailVerified` | Boolean | |
| `authData` | Object | `google` / `sso` |

`afterFind(Parse.User)` (`UserAfterFInd.js`) rewrites `ProfilePic` to a presigned URL —
**but only when the query returns exactly one object** (`if (request.objects.length === 1)`).
This one-object guard is repeated in every `afterFind` trigger; see [§11](#11-quirks-and-gotchas).

### 3.3 `contracts_Users` (extended user / profile)

| Field | Type | Meaning |
|---|---|---|
| `UserId` | Pointer→`_User` | the login account |
| `CreatedBy` | Pointer→`_User` | who provisioned this user |
| `TenantId` | Pointer→`partners_Tenant` | **required by most flows** |
| `OrganizationId` | Pointer→`contracts_Organizations` | |
| `TeamIds` | Array\<Pointer→`contracts_Teams`\> | |
| `UserRole` | String | `contracts_Admin` \| `contracts_OrgAdmin` \| `contracts_Editor` \| `contracts_User` |
| `Name`, `Email`, `Phone`, `Company`, `JobTitle` | String | |
| `IsDisabled` | Boolean (default `false`) | soft-deactivate |
| `Timezone` | String | IANA tz, used for certificate timestamps |
| `Language` | String | i18n code |
| `DateFormat` | String | e.g. `MM/DD/YYYY`, `DD-MMM-YYYY` (see `selectFormat`) |
| `Is12HourTime` | Boolean | |
| `IsLTVEnabled` | Boolean | |
| `DownloadFilenameFormat` | String | `DOCNAME` \| `DOCNAME_SIGNED` \| `DOCNAME_EMAIL` \| `DOCNAME_EMAIL_DATE` |
| `UseNameAsSender` | Boolean | use the user's name (not email) in the mail `From` |
| `NotifyOnSignatures` | Boolean | default preference copied onto new documents |
| `SendinOrder` | Boolean | default preference |
| `IsTourEnabled` | Boolean | default preference |
| `SignatureType` | Array | `[{ name, enabled }]`, names include `draw`, `typed`, `upload`, `default` |
| `WidgetPreferences` | Array | currently only `[{ type:'date', isSigningDate, isReadOnly, date, format }]` |
| `TourStatus` | Array\<Object\> | e.g. `[{ requestSign: true }, { drive: true }]` |
| `DocumentCount`, `TemplateCount` | Number | incremented by `beforeSave`/cloud fns |
| `Webhook` | String | **field exists; nothing in this build reads or writes it** |
| `RequestBody`, `RequestSubject`, `CompletionBody`, `CompletionSubject`, `EmailEditorType` | String | per-user mail templates (written by `updateemailtemplates`) |
| `DeleteOTP`, `DeleteOTPExpiry`, `DeleteOTPSentAt`, `DeleteOTPTries` | mixed | account-deletion OTP state |
| `UserName`, `Tagline`, `SearchIndex`, `HeaderDocId` | mixed | legacy/unused in this build |

### 3.4 `partners_Tenant`

| Field | Type | Meaning |
|---|---|---|
| `UserId`, `CreatedBy` | Pointer→`_User` | tenant owner |
| `TenantName` | String | |
| `EmailAddress`, `ContactNumber` | String | |
| `Domain` | String | used by `getlogobydomain` |
| `Logo`, `Favicon` | String (URL) | presigned by the `afterFind` trigger, for 24h rather than the usual 200s (branding is cached by the client and read out of old emails) |
| `EmailSenderName` | String | From display name on every mail this tenant sends (max 80) |
| `EmailFooter` | String | plain-text footer appended to every mail (max 500) |
| `HidePoweredBy` | Boolean | drops the "Powered by" / spam-report line from outgoing mail |
| `ReplyTo` | String | reply-to address used when the mail does not carry its own |
| `IsActive` | Boolean | |
| `Address`, `City`, `State`, `Country`, `PinCode` | String | |
| `SignatureType` | Array | tenant-level allow-list of signature types |
| `RequestBody`, `RequestSubject`, `CompletionBody`, `CompletionSubject`, `EmailEditorType` | String | tenant mail templates |
| `PfxFile` | Object `{ base64, password }` | **per-tenant signing certificate** — always excluded from responses |
| `FileAdapters`, `ActiveFileAdapter` | mixed | EE feature; always excluded / unimplemented here |

### 3.5 `contracts_Document`

The central class. Fields the frontend reads/writes:

| Field | Type | Meaning |
|---|---|---|
| `Name` | String | title. Max **250** chars (enforced in `beforeSave`) |
| `Note` | String | max **200** chars |
| `Description` | String | max **500** chars |
| `URL` | String | the **original** (unsigned, flattened) PDF URL |
| `SignedUrl` | String | the current working PDF. Set the moment the doc is *sent*, and replaced after every signature. `SignedUrl == null/absent` ⇒ still a **draft** |
| `CertificateUrl` | String | completion certificate PDF, generated once `IsCompleted` |
| `DocumentHash` | String | sha256 of the final signed PDF, only set when completed |
| `Placeholders` | Array\<Object\> | field layout, see [§6](#6-signing-data-model) |
| `Signers` | Array\<Pointer→`contracts_Contactbook`\> | flat recipient list |
| `Viewers` | — | **not present in this build.** No `Viewers` field, no viewer role; `workflowUtils.isCompletionRelevant` only excludes `Role === 'prefill'` |
| `AuditTrail` | Array\<Object\> | see [§6.3](#63-audittrail) |
| `CreatedBy` | Pointer→`_User` | owner |
| `ExtUserPtr` | Pointer→`contracts_Users` | owner's profile (mail templates, tenant, timezone all resolve from here) |
| `Folder` | Pointer→`contracts_Document` | parent folder; absent = root of Drive |
| `Type` | String | `"Folder"` for folder rows, `"AIDoc"` for AI-generated, otherwise absent |
| `IsArchive` | Boolean | soft delete |
| `IsCompleted` | Boolean | all participants signed |
| `IsDeclined` | Boolean | |
| `DeclineReason` | String | |
| `DeclineBy` | Pointer→`_User` | |
| `IsSignyourself` | Boolean | self-sign flow (no recipients) |
| `SentToOthers` | Boolean | set `true` when sent for signature |
| `SendMail` | Boolean | set `true` after the request emails go out |
| `SendCompletionMail` | Boolean | |
| `IsSendMail` | Boolean | when explicitly `false`, `signPdf` skips the completion email (API-only path) |
| `SendinOrder` | Boolean | sequential signing |
| `SendInOrderStrict` | Boolean | hard-enforce sequence server-side (see [§6.5](#65-strict-signing-order)) |
| `TimeToCompleteDays` | Number | default **15**; drives `ExpiryDate` |
| `ExpiryDate` | Date | computed in `afterSave` as `createdAt + TimeToCompleteDays` |
| `AutomaticReminders` | Boolean | |
| `RemindOnceInEvery` | Number | days; default **5** |
| `NextReminderDate` | Date | computed in `afterSave` when `AutomaticReminders` |
| `IsEnableOTP` | Boolean | require the signer to be an authenticated Parse user |
| `IsTourEnabled` | Boolean | show the guided tour to signers |
| `AllowModifications` | Boolean | signer may move/add widgets |
| `NotifyOnSignatures` | Boolean | email the owner after each signature |
| `SignatureType` | Array | `[{ name, enabled }]` allow-list for this document |
| `PenColors` | Array\<String\> | allowed pen colours |
| `Bcc` | Array\<Object\> | `[{ Name, Email, ... }]`; only `.Email` is used |
| `Cc` | Array\<Object\> | same shape |
| `RedirectUrl` | String | where to send the signer after completion |
| `SenderName`, `SenderMail` | String | override the From/Reply-To |
| `RequestBody`, `RequestSubject`, `EmailEditorType` | String | per-document mail template snapshot |
| `TemplateId` | Pointer→`contracts_Template` | provenance |
| `BulkSendToken` | String | bulk-send correlation id (10 chars, set when the `type` header is `bulksend`) |
| `OriginIp` | String | creator's IP, filled in `afterSave` from `x-real-ip` |
| `DocSentAt` | Date | when it was sent for signature |
| `FileAdapterId` | String | EE; unused here |
| `DebugginLog` | String | last `signPdf` error message (written on failure) |
| `SharedWith`, `SharedWithUsers` | Array | present on templates; `getReport` also references them for docs |

### 3.6 `contracts_Template`

Same shape as `contracts_Document` minus the runtime-signing fields, plus:

| Field | Type | Meaning |
|---|---|---|
| `IsPublic` | Boolean | |
| `PublicRole` | Array | |
| `SharedWith` | Array\<Pointer→`contracts_Teams`\> | team sharing |
| `SharedWithUsers` | Array\<Pointer→`contracts_Users`\> | user sharing |
| `Folder` | Pointer→`contracts_Template` | |
| `EnablePhoneOTP`, `EnableEmailOTP` | Boolean | legacy |

Placeholders on a template have `signerObjId: ''` and `signerPtr: {}` — roles are unbound
until a document is created from the template.

### 3.7 `contracts_Contactbook`

| Field | Type | Meaning |
|---|---|---|
| `Name`, `Email`, `Phone`, `Company`, `JobTitle` | String | `Email` is always lowercased/stripped |
| `UserId` | Pointer→`_User` | every contact gets a shadow `_User` |
| `CreatedBy` | Pointer→`_User` | contact owner |
| `TenantId` | Pointer→`partners_Tenant` | |
| `UserRole` | String | always `contracts_Guest` |
| `IsDeleted` | Boolean | soft delete |
| `IsImported` | Boolean | set by `createbatchcontact` |
| `TourStatus` | Array\<Object\> | e.g. `[{ requestSign: true }]` |

**Important:** creating a contact **always creates a `_User`** whose `username`, `email`
*and* `password` are all the contact's email address. This happens in `savecontact`,
`editContact`, `linkContactToDoc` and the `contracts_Contactbook` `afterSave` trigger.

"Editing" a contact (`editcontact`) actually marks the old row `IsDeleted: true` and
creates a **new** row — the objectId changes.

### 3.8 `contracts_Signature`

| Field | Type | Meaning |
|---|---|---|
| `UserId` | Pointer→`_User` | |
| `ImageURL` | String (URL or base64) | the saved signature |
| `Initials` | String | |
| `Stamp` | String | |
| `SignatureName` | String | label |

`afterFind` presigns `ImageURL`, `Initials`, `Stamp` (again, only when exactly one object).

### 3.9 `contracts_Teams` / `contracts_Organizations`

`contracts_Teams`: `Name`, `IsActive` (default `true`), `ParentId` (Pointer→self),
`OrganizationId` (Pointer→`contracts_Organizations`), `Ancestors` (Array\<Pointer→self\>).

`afterSave` on `contracts_Teams` appends the team's own pointer to `Ancestors` on insert,
so `Ancestors` always includes self. Template sharing queries use
`SharedWith containedIn <flattened ancestor list>`.

`contracts_Organizations`: `Name`, `IsActive`, `ExtUserId` (Pointer→`contracts_Users`),
`CreatedBy` (Pointer→`_User`), `TenantId` (Pointer→`partners_Tenant`).

### 3.10 Other classes

| Class | Purpose |
|---|---|
| `defaultdata_Otp` | `{ Email, OTP: Number, TenantId }` — login/verify OTPs, one row per email, never expires |
| `partners_TenantCredits` | `{ PartnersTenant: Pointer, usedStorage: Number }` — storage accounting; written **unauthenticated** by the frontend |
| `partners_DataFiles` | `{ FileUrl, FileSize, TenantPtr, UserId }` — per-file accounting |
| `contracts_templateLinks` | `{ Type, TemplatePtr: Pointer→contracts_Template, Placeholders: Array }` — stores prefill responses without mutating the template |
| `Migrationdb` | migration bookkeeping |
| `contracts_Organizations` | `{ Name, IsActive, ExtUserId, CreatedBy, TenantId }` |
| `contracts_Subscriptions` | **does not exist in this build** — no schema, no code references |
| `contracts_TeamUser`, `contracts_Webhook`, `W9form`, `contracts_Tenant` | **do not exist in this build** (the tenant class is `partners_Tenant`) |

### 3.11 Writes that bypass cloud functions

Several mutations go straight to the Parse REST class API. A new backend must keep these
CLPs/ACLs working, or the new frontend must route them through cloud functions.

| Operation | Call |
|---|---|
| Rename document / folder | `PUT classes/contracts_Document/{id}` `{ Name }` |
| Delete document / folder / template | `PUT classes/contracts_Document\|contracts_Template/{id}` `{ IsArchive: true }` |
| Move to folder | `PUT classes/contracts_Document/{id}` `{ Folder: <Pointer> }` or `{ Folder: { "__op": "Delete" } }` |
| Extend expiry | `PUT classes/contracts_Document/{id}` `{ ExpiryDate: { "__type":"Date", iso } }` |
| Send for signature | `PUT classes/contracts_Document/{id}` `{ Name, Placeholders, SignedUrl, URL, Signers, SentToOthers: true, SignatureType, ExpiryDate }` |
| Mark request mail sent | `PUT classes/contracts_Document/{id}` `{ RequestBody, RequestSubject, SendMail: true }` |
| Delete contact | `PUT classes/contracts_Contactbook/{id}` `{ IsDeleted: true }` |
| Tour progress | `PUT classes/contracts_Users\|contracts_Contactbook/{id}` `{ TourStatus }` |
| Edit profile | `PUT classes/contracts_Users/{id}` `{ Phone, Name, JobTitle, Company, Language }` |
| Enable/disable user | Parse SDK save on `contracts_Users` `{ IsDisabled }` |
| Share template with teams | Parse SDK save on `contracts_Template` `{ SharedWith: Pointer[] }` |
| Create folder | Parse SDK save `{ Name, Type: "Folder", Folder?, CreatedBy, ExtUserPtr }` |
| Storage accounting | `GET/PUT/POST classes/partners_TenantCredits`, `POST classes/partners_DataFiles` |

Widget placement **autosaves every 2 s** (`PlaceHolderSign.jsx`, `TemplatePlaceholder.jsx`)
by saving the whole `Placeholders` array — there is no patch/merge and no optimistic
locking. Concurrent multi-signer signing is handled by re-fetching the document
immediately before embedding (comment in `PdfRequestFiles.jsx`: *"to resolve issue of
widgets get remove automatically when more than 1 signers try to sign doc at a time"*).

---

## 4. Cloud functions reference

All 55 functions registered in `cloud/main.js`. Call as either
`Parse.Cloud.run(name, params)` or `POST {baseUrl}functions/{name}` with a JSON body.

Legend for **Auth**: `session` = needs `request.user`; `sessiontoken hdr` = additionally
reads the raw `sessiontoken` header; `none` = no check at all.

### 4.1 Auth / user / tenant

| Function | Params | Returns | Auth | Used by |
|---|---|---|---|---|
| `loginuser` | `{ email, password }` | full `_User` JSON incl. `sessionToken` | none | Login |
| `usersignup` | `{ userDetails: {...} }` | `{ message, sessionToken }` | none | Login (extra-info modal) |
| `addadmin` | `{ userDetails: {...} }` | `{ message, sessionToken }` | none | AddAdmin (first run) |
| `adduser` | `{ name,email,phone,password,role,team,tenantId,organization,timezone }` | `contracts_Users` JSON | session + admin | UserList / AddUser |
| `checkadminexist` | — | `"exist"` \| `"not_exist"` | none | `/upgrade-2.1` |
| `updateuserasadmin` | `{ email, masterkey }` | `"admin_created"` | master key in body | `/upgrade-2.1` |
| `getUserId` | `{ email }` or `{ username }` | `{ id }` | **none** | internal (`savecontact`) |
| `getUserDetails` | `{}` \| `{ email }` \| `{ userId }` | `contracts_Users` object \| `{objectId}` \| `""` | session (unless `email`) | everywhere |
| `isextenduser` | `{ email }` | `{ isUserExist }` | none | (unused by old FE) |
| `resetpassword` | `{ userId, password }` | `{ status, message }` | session + admin | UserList |
| `verifyemail` | `{ email, otp }` | `{ message }` | session | VerifyEmail modal |
| `SendOTPMailV1` | `{ email, docId?, TenantId? }` | `"Otp send"` | none | GuestLogin |
| `AuthLoginAsMail` | `{ email, otp }` | user JSON \| `"Invalid Otp"` \| `"user not found!"` | none | GuestLogin |
| `gettenant` | `{ userId }` \| `{ contactId }` | `partners_Tenant` \| `{}` \| `"user does not exist!"` | none | Preferences, signing |
| `updatetenant` | `{ tenantId, details }` | tenant JSON | session + admin + own tenant | MailTemplateEditor, Branding |
| `updateemailtemplates` | `{ tenantId, details }` | `contracts_Users` JSON | session | (writes to ext user, not tenant) |
| `getlogobydomain` | `{ domain }` | `{ logo, favicon, appname, tenantName, hidePoweredBy, footer, user }` | none | Login bootstrap |
| `getteams` | `{ active?: boolean }` | `contracts_Teams[]` | session | AddUser |
| `getuserlistbyorg` | `{ organizationId }` | `contracts_Users[]` | session + tenant scope | UserList |
| `senddeleterequest` | `{ userId, app? }` | `"mail sent."` | session + target is Admin | UserProfile |
| `newsletter` | `{ name, email, domain }` | `"success"` | none | AddAdmin |

### 4.2 Preferences / signature

| Function | Params | Returns | Notes |
|---|---|---|---|
| `updatepreferences` | `{ SignatureType?, NotifyOnSignatures?, Timezone?, SendinOrder?, IsTourEnabled?, DateFormat?, Is12HourTime?, IsLTVEnabled?, DownloadFilenameFormat?, UseNameAsSender? }` | updated `contracts_Users` JSON | Requires at least one of `SignatureType`/`NotifyOnSignatures`/`Timezone` to be truthy or it throws, even if you only wanted to change e.g. `DateFormat` |
| `updatesignaturetype` | `{ SignatureType: [{name, enabled}] }` | `contracts_Users` JSON | rejects if 0 enabled, or if only `default` is enabled |
| `setwidgetpreferences` | `{ dateWidget: { isSigningDate, isReadOnly, date, format } }` | `{ WidgetPreferences, createdAt, updatedAt }` | upserts the `type:'date'` entry |
| `updatetourstatus` | `{ TourStatus: [...], ExtUserId }` | `contracts_Users` object | saves **without** master key, so ACL applies |
| `updatecontacttour` | `{ contactId }` | `contracts_Contactbook` object | sets `TourStatus` `requestSign: true`. **No auth check** |
| `savesignature` | `{ userId, signature?, initials?, stamp?, title?, id? }` | `contracts_Signature` object | only sets provided fields; `userId` must equal `request.user.id` |
| `managesign` | same as above | `contracts_Signature` object | sets **all** fields, blanking missing ones |
| `getdefaultsignature` | `{ userId }` | first `contracts_Signature` for the user | `userId` must equal `request.user.id` |

### 4.3 Documents

| Function | Params | Returns | Notes |
|---|---|---|---|
| `getDocument` | `{ docId, include? }` | full document JSON, or `{ error }` | Includes `ExtUserPtr`, `ExtUserPtr.TenantId`, `CreatedBy`, `Signers`, `AuditTrail.UserPtr`, `Placeholders`, `DeclineBy`. Excludes archived. **If `IsEnableOTP` is true**, requires the `sessiontoken` header and an ACL read grant, else returns `{error: "You don't have access of this document!"}` |
| `createdocumentfromapp` | `{ document: {...} }` | saved `contracts_Document` | The main "create/send document" entry point. See [§6.1](#61-creating-a-document) |
| `getDrive` | `{ docId?, limit, skip }` | `contracts_Document[]` | Folder browsing. `docId` = parent folder; omitted = root (`doesNotExist('Folder')`). Filters `CreatedBy == me`, `IsArchive != true`, orders `-updatedAt`, excludes `AuditTrail`/`OriginalDocument`/`SignedDocument`. **Auth via `sessiontoken` header only** |
| `filterdocs` | `{ searchTerm, limit?, skip?, caseSensitive? }` | `contracts_Document[]` | Regex `Name` search scoped to `CreatedBy == me`, excludes folders and archived. Default limit 300 |
| `getReport` | `{ reportId, limit, skip, searchTerm?, signerStatus? }` | array of rows, or `{ error }` | See [§9](#9-reports-the-magic-objectids) |
| `declinedoc` | `{ docId, reason?, userId }` | `"document declined"` | Sets `IsDeclined`, `DeclineReason`, `DeclineBy` and emails the owner. **`userId` is taken from the body with no verification** when `IsEnableOTP` is false |
| `signPdf` | see [§6.4](#64-signpdf) | `{ status:"success", data:<signedUrl> }` | |
| `generatecertificate` | `{ docId }` | `{ CertificateUrl }` | Only acts when `IsCompleted && !CertificateUrl`; otherwise returns `{CertificateUrl:""}`. **No auth check** |
| `getsignedurl` | `{ url, docId?, templateId? }` | presigned URL string | See [§8](#8-files-and-pdfs) |
| `savefile` | `{ fileBase64, fileName, id? }` | `{ url }` | Flattens PDFs before upload. **Appears to be broken — see §11** |
| `fileupload` | `{ url }` | `{ url: "<url>?token=<jwt>" }` | JWT-signs a local `/files/` URL, 200 s TTL. **No auth check** |
| `saveastemplate` | `{ docId }` | `contracts_Template` object | Strips responses/defaults, resets signer bindings |
| `recreatedoc` | `{ docId }` | `{ objectId, createdAt, updatedAt }` | Clones a document with `IsDeclined/IsCompleted=false` and cleared widget responses. Rejects `IsSignyourself` docs |
| `forwarddoc` | `{ docId, recipients: string[] }` | mail result | Max 10 recipients; emails the signed PDF as an attachment. Caller must be `CreatedBy` |
| `batchdocuments` | `{ Documents: "<JSON string>" }` + header `type: "quicksend"\|"bulksend"` | `{ total, created, failed, results: [{ index, objectId } \| { index, error }] }` | Fixed 2026-08-21: processes every row in chunks of 50, per-row results in submission order, bad rows do not abort the run, `bulksend` sets `BulkSendToken` |
| `triggerevent` | `{ event: "viewed", contactId, body: { objectId } }` | `{ message: "event called!" }` | Appends/updates a `Viewed` audit-trail entry |

### 4.4 Templates

| Function | Params | Returns | Notes |
|---|---|---|---|
| `getTemplate` | `{ templateId }` (+ `sessiontoken` header) | template JSON, or `{ error }` | Resolves team/user sharing via `SharedWith` / `SharedWithUsers` / `ExtUserPtr`. Includes `Signers`, `CreatedBy`, `ExtUserPtr.TenantId`, `Bcc`, `Cc`, and (in the shared path) `Placeholders.signerPtr` |
| `createduplicate` | `{ templateId }` | new template JSON | Caller must be `CreatedBy`. Copies the ACL verbatim |

There is **no `createDocumentFromTemplate`**. "Use template" is done client-side:
fetch the template with `getTemplate`, bind signers to placeholder roles, then call
`createdocumentfromapp` with `TemplateId` set.

### 4.5 Contacts

| Function | Params | Returns | Notes |
|---|---|---|---|
| `savecontact` | `{ name, email, phone?, company?, jobTitle?, tenantId? }` | `contracts_Contactbook` JSON | Throws `DUPLICATE_VALUE` if a non-deleted contact with that email already exists for this owner. Creates a shadow `_User` with password == email |
| `getcontact` | `{ contactId }` | `contracts_Contactbook` object | **No auth check** — any contact is readable by objectId |
| `editcontact` | `{ contactId, name, email, phone?, company?, jobTitle?, tenantId }` | new `contracts_Contactbook` JSON | Soft-deletes the old row, creates a new one (**objectId changes**) |
| `createbatchcontact` | `{ contacts: "<JSON string of array>" }` | `{ success, failed }` | Uses the Parse `/batch` endpoint with the master key. Sets `IsImported: true` |
| `getsigners` | `{ search }` | `contracts_Contactbook[]` | OR of `Name` / `Email` regex, scoped to `CreatedBy == me`, `IsDeleted != true` |
| `isuserincontactbook` | `{}` | contact object or `undefined` | Is the current user in their own contact book? |
| `linkcontacttodoc` | `{ docId, email, name?, phone?, jobTitle?, company? }` | `{ contactId }` | See [§6.7](#67-linkcontacttodoc-guest-binding) |

### 4.6 Mail

| Function | Params | Returns |
|---|---|---|
| `sendmailv3` | `{ recipient, subject, html, from, replyto?, text?, bcc?, cc?, extUserId? }` | `{ status: "success" \| "error" }` |

`sendmailv3` is the **only** generic mail endpoint exposed. It has **no authentication
check** — anyone with the app id can send arbitrary HTML email from the server's
configured sender. A footer "report as spam" paragraph is always appended to `html`.
`extUserId` increments the tenant's mail counter.

**Reminders (added 2026-08-21, `cloud/parsefunction/sendReminder.js`, `cloud/jobs/autoReminders.js`):**

```js
Parse.Cloud.run("sendreminder", { docId })
// → { sent: ["jane@acme.co"], skipped: [{ email, reason }] }
// reason: "already_signed" | "no_email" | "not_their_turn" | "mail_failed"
```

Auth: the caller must be the document owner (`CreatedBy` or `ExtUserPtr.UserId`) or a
`contracts_Admin` / `contracts_OrgAdmin` in the same tenant, else error 119. Rejects
completed, declined, archived and never-sent documents. Respects `SendinOrder` (only the
current signer gets mail). Uses the document's `RequestSubject`/`RequestBody`, then the
tenant's, then a built-in reminder template, with the same `{{vars}}` as the request mail.
Records `Reminders: [{ SentAt, To[], By }]` (capped at 50) and `LastReminderAt` on the
document; it does NOT write to `AuditTrail` (the PDF code matches audit entries by
`UserPtr.objectId` and would clobber or throw on a reminder entry).

Scheduled job `autoReminders` (registered with `Parse.Cloud.job`, ticked hourly from
`index.js`): documents with `AutomaticReminders: true`, `NextReminderDate <= now`, not
completed/declined/archived, `ExpiryDate > now`, `SignedUrl` set. Advances
`NextReminderDate` in whole `RemindOnceInEvery`-day steps past now, unsets it once the
next date would pass `ExpiryDate`. Env: `AUTO_REMINDERS` (default on),
`AUTO_REMINDERS_INTERVAL_MINUTES` (60), `AUTO_REMINDERS_MAX_DOCS` (200), `PUBLIC_URL` for
signing links. The old UI's "Send reminder" (re-invoking `sendmailv3`) is superseded.

---

## 5. Custom Express routes (non-Parse)

Mounted at the app root (so `/api/...` behind the proxy). Registered in
`cloud/routes/customApp.js`.

### `POST /docxtopdf`

```
Content-Type: multipart/form-data
headers: { sessiontoken: <session token> }
body:    file=<.docx>
→ 200 { "message": "success.", "url": "<pdf url>" }
→ 400 { "error": "We could not convert this DOCX file..." }
```

Multer memory storage, 50 MB limit, `.docx` extension **and** the Word MIME type (or
`application/octet-stream`) required. Converts via LibreOffice (`libreoffice-convert`) with
a concurrency limit of 1 (`DOCX2PDF_CONCURRENCY`) and a 90 s / 120 s timeout depending on
size, killing stuck `soffice` processes on timeout. Uploads via Parse `/files/{name}` with
the master key.

**Note:** if the tenant has `ActiveFileAdapter` set, it posts to
`/functions/savetofileadapter` — **a cloud function that does not exist in this build**, so
that branch always fails.

### `POST /decryptpdf`

```
Content-Type: multipart/form-data     (no auth headers at all)
body:    file=<encrypted pdf>, password=<string>
→ 200 application/pdf (binary body, Content-Disposition: inline; filename="decrypted.pdf")
→ 401 { "error": "Incorrect password." }
→ 4xx { "error": "Something went wrong." }
```

Uses `coherentpdf`. Writes the upload to `exports/` under its **original filename** (disk
storage, no sanitisation) and unlinks it afterwards.

### Account deletion routes

```
GET  /delete-account/:userId          → HTML OTP page
POST /delete-account/:userId/otp      → { ok, cooldownSec, expiresInMin } | 429 { error, retryAfterSec }
POST /delete-account/:userId          → form-encoded otp=<code>; plain-text status body
POST /deleteuser/:userId              → headers { sessiontoken }; { message }
```

---

## 6. Signing data model

### 6.1 Creating a document

The old frontend's `createDocument()` helper (`constant/Utils.js:995`) builds this payload
and POSTs it to `functions/createdocumentfromapp`:

```jsonc
{
  "document": {
    "Name": "Contract.pdf",
    "URL": "<original pdf url>",
    "SignedUrl": "<same url when sending>",   // presence of SignedUrl = "sent"
    "SentToOthers": true,
    "Description": "...",
    "Note": "...",
    "Placeholders": [ /* see 6.2 */ ],
    "Signers": [ { "__type":"Pointer", "className":"contracts_Contactbook", "objectId":"..." } ],
    "ExtUserPtr": { "__type":"Pointer", "className":"contracts_Users", "objectId":"..." },
    "CreatedBy":  { "__type":"Pointer", "className":"_User", "objectId":"..." },
    "SendinOrder": false,
    "SendInOrderStrict": false,
    "AutomaticReminders": false,
    "RemindOnceInEvery": 5,
    "IsEnableOTP": false,
    "IsTourEnabled": false,
    "AllowModifications": false,
    "TimeToCompleteDays": 15,
    "DocSentAt": { "__type":"Date", "iso":"2026-08-20T..." },
    "SignatureType": [{ "name":"draw", "enabled":true }, ...],
    "NotifyOnSignatures": true,
    "SenderName": "...", "SenderMail": "...",
    "Bcc": [ { "Email":"..." } ], "Cc": [ ... ],
    "RedirectUrl": "https://...",
    "TemplateId": { "__type":"Pointer","className":"contracts_Template","objectId":"..." },
    "PenColors": ["#000000"]
  }
}
```

`createDocumentFromApp.js` whitelists exactly these keys, coerces `TimeToCompleteDays` /
`RemindOnceInEvery` to numbers, and calls `setDocumentCount(ExtUserPtr.id)`.

Draft documents are created the same way but **without** `SignedUrl` — that's the sole
draft/sent discriminator used across every report query
(`SignedUrl: {$exists: false}` vs `{$ne: null}`).

### 6.2 `Placeholders`

`Placeholders` is an array of **one entry per role/recipient**:

```jsonc
[
  {
    "Id": 12345678,                       // randomId(8) — a NUMBER, not a string
    "Role": "Role 1",                     // or the literal "prefill"
    "blockColor": "#93a3db",              // "transparent" for prefill
    "signerObjId": "aBcD1234",            // contracts_Contactbook objectId, "" on templates
    "signerPtr": { "__type":"Pointer","className":"contracts_Contactbook","objectId":"aBcD1234" },
    "email": "signer@example.com",        // used for quick-send before a contact exists
    "Name": "Prefill by owner",           // only on the prefill entry
    "placeHolder": [
      {
        "pageNumber": 1,
        "pos": [ /* widget objects — see §7 */ ]
      }
    ]
  }
]
```

Rules:

* The entry with `Role === "prefill"` is **not a participant**: it is excluded from signer
  counts, completion checks, ordering and emails
  (`workflowUtils.isParticipantBasic`, `isCompletionRelevant`).
* `Signers` is a **parallel flat array** of contact pointers. Order matters when
  `SendinOrder` is set — the Nth placeholder maps to the Nth signer.
  `linkcontacttodoc` `splice`s into `Signers` at the placeholder index to keep them aligned.
* On a **template**, `signerObjId` is `""` and `signerPtr` is `{}`.
* `Placeholders` is stored as a real Mongo array (not a JSON string), but nested
  `signerPtr` pointers get denormalised by `include`s — `Utils.handleValidImage` normalises
  them back to `{__type:'Pointer',...}` on read.

### 6.3 `AuditTrail`

Array of plain objects (not pointers to a class):

```jsonc
[
  {
    "UserPtr": { "__type":"Pointer","className":"contracts_Contactbook","objectId":"..." },
    "Activity": "Signed",              // "Created" | "Viewed" | "Signed"
    "SignedUrl": "<url at the time>",
    "ipAddress": "203.0.113.9",
    "SignedOn": { "__type":"Date","iso":"..." },
    "ViewedOn": "2026-08-20T10:00:00.000Z",   // NOTE: an ISO *string*, not a Date object
    "Signature": "<base64 png, no data: prefix>"
  }
]
```

* `UserPtr.className` is `contracts_Contactbook` for recipients, `contracts_Users` for the
  document owner signing their own doc.
* `COMPLETION_ACTIVITIES = ['Signed']` — only `Signed` counts toward completion in this build.
* `triggerevent` writes `Viewed` entries with `ViewedOn` as a raw ISO string while
  `signPdf` writes `SignedOn` as a Date. Certificate generation handles both
  (`toTs()` in `GenerateCertificate.js`).

### 6.4 `signPdf`

```js
Parse.Cloud.run("signPdf", {
  pdfFile: "<base64 of the whole PDF, no data: prefix>",
  docId: "<contracts_Document objectId>",
  userId: "<contracts_Contactbook objectId>",   // omit when the OWNER is signing
  isCustomCompletionMail: false,
  signature: "<base64 png of the signature, for the certificate>",
  activity: "Signed"
});
// → { status: "success", data: "<new SignedUrl>" }
```

**The client flattens and stamps the PDF itself** (pdf-lib in `embedWidgetsToDoc`) and sends
the finished bytes. The server does not render widgets.

Server flow (`cloud/parsefunction/pdf/PDF.js`):

1. Load the document (`IsDeclined != true`, `IsArchive != true`). 404 if missing.
2. If `IsEnableOTP` → require `request.user`, else throw 209.
3. Resolve the signer: if `userId` is given, find it in `Signers` (className
   `contracts_Contactbook`); otherwise the signer is `ExtUserPtr` (className `contracts_Users`).
4. **Strict-order gate** (see below).
5. Build the audit-trail entry, compute `isCompleted`:
   `auditTrail.filter(Activity in ['Signed']).length >= Placeholders.filter(non-prefill).length`.
   If there are **no** `Signers` at all, `isCompleted = true` immediately (self-sign).
6. If completed: flatten the form, add a PKCS#7 signature placeholder, digitally sign with
   the PFX (`ExtUserPtr.TenantId.PfxFile` if present, else `PFX_BASE64`/`PASS_PHRASE` env),
   compute `DocumentHash` (sha256).
   If not completed: just persist the bytes as-is.
7. Upload to `exports/` then to Parse `/files/`, `PUT /classes/contracts_Document/{id}` with
   `{ SignedUrl, AuditTrail, IsCompleted[, DocumentHash] }`.
8. Fire-and-forget: `sendNotifyMail` (if `NotifyOnSignatures` and >1 signature outstanding),
   and on completion `sendMailsaveCertifcate` → generate + digitally sign the certificate,
   set `CertificateUrl`, email everyone the signed PDF as an attachment (unless
   `IsSendMail === false`).

Failures write `DebugginLog` onto the document and rethrow.

### 6.5 Strict signing order

```js
if (reqUserId && SendinOrder === true && SendInOrderStrict === true) { ... }
```

`findPendingPriorSigner` walks the non-prefill placeholders before yours and checks
whether each has a matching `Signed` audit entry. If any is missing, `signPdf` throws
`Parse.Error.OPERATION_FORBIDDEN` (**code 119**) with:

> "Strict signing order is enabled — please wait for the previous signers to complete their action before signing."

With `SendinOrder: true` but `SendInOrderStrict: false`, ordering is **email-only**: the
sender emails only the first signer, and the next email is triggered by the client after
each signature. Nothing stops an out-of-order signer who has the link.

### 6.6 ACL behaviour

The `contracts_Document` `afterSave` trigger (`DocumentAftersave.js`) rewrites the ACL on
every save:

```js
const newACL = new Parse.ACL();
newACL.setPublicReadAccess(false);
newACL.setPublicWriteAccess(false);
newACL.setReadAccess(CreatedBy.objectId, true);
newACL.setWriteAccess(CreatedBy.objectId, true);
Signers.forEach(s => {           // s.UserId — the shadow _User behind each contact
  newACL.setReadAccess(s.UserId.objectId, true);
  newACL.setWriteAccess(s.UserId.objectId, true);
});
```

So every signer gets **write** access to the whole document, and public access is off.
Documents with no signers get an owner-only ACL. The same pattern is applied to
`contracts_Template`.

`afterSave` also, on insert only:

* Sets `ExpiryDate = createdAt + TimeToCompleteDays` (default 15) — but **only when
  `Type` is `undefined` or `"AIDoc"`**, i.e. folders never expire.
* Sets `OriginIp` from `x-real-ip` if not already set.
* Sets `NextReminderDate = createdAt + RemindOnceInEvery` when `AutomaticReminders`.

`beforeSave` validates `Name`/`Note`/`Description` length and, when `SignedUrl`
transitions from absent to present, sets `DocSentAt = now` and increments the owner's
`DocumentCount`.

### 6.7 `linkcontacttodoc` (guest binding)

Called from the guest-login page when the signing link has no contact id yet.

```js
Parse.Cloud.run("linkcontacttodoc", { docId, email, name?, phone?, jobTitle?, company? });
// → { contactId: "..." }
```

Server logic:

1. Find the placeholder whose `email` matches. If none → `OPERATION_FORBIDDEN`.
2. If that placeholder already has a `signerObjId` → return it immediately.
3. Otherwise resolve a contact, in order:
   * an existing `contracts_Contactbook` for the doc owner with that email;
   * an existing `contracts_Users` with that email (creates a contact from its profile);
   * an existing `_User` with that email (needs `name`);
   * a brand-new `_User` (username/email/password all == the email) plus a contact.
4. `splice` the contact pointer into `Signers` at the placeholder index, set
   `signerObjId` + `signerPtr` on the placeholder, and grant the contact's `_User`
   read+write on the document ACL.

New contacts get `UserRole: 'contracts_Guest'` and `IsDeleted: false`.

### 6.8 The guest signing route

`/recipientSignPdf/:docId/:contactBookId` (and the pre-validated
`/load/recipientSignPdf/:docId/:contactBookId`) is the recipient signing page.

Call sequence in `pages/PdfRequestFiles.jsx`:

1. `functions/getDocument` `{ docId }` — with the `sessiontoken` header if one exists.
2. `functions/gettenant` `{ userId }` for tenant defaults.
3. If the current user has not already signed and the doc has signers +
   placeholders → `functions/triggerevent` `{ event:"viewed", contactId, body:{objectId} }`.
4. Resolve the signer identity:
   * OTP docs → `contactBook(contactId)` via `GET classes/contracts_Contactbook?where=...`;
   * non-OTP docs → `functions/getcontact` `{ contactId }` (no auth headers).
5. `getdefaultsignature` `{ userId }` to prefill the saved signature/initials/stamp.
6. On sign → `signPdfFun()` → `Parse.Cloud.run("signPdf", ...)`.
7. On decline → `functions/declinedoc` `{ docId, reason, userId }`.
8. Tour completion → `functions/updatecontacttour` `{ contactId }` or
   `PUT classes/contracts_Contactbook/{id}` `{ TourStatus }`.
9. Sequential sending: after a successful signature the client itself posts
   `functions/sendmailv3` to the *next* signer — **unless** the URL carries
   `?sendmail=false` (threaded through from the 4th segment of the base64 login payload).
   That is "quick send" mode: recipients are handed links directly instead of by email.
10. If `RedirectUrl` is set, a countdown then `window.open(redirectUrl, "_self")`.

Prefill values are **not** written back to the template. `utils/prefillUtils.js` stores them
in `contracts_templateLinks`:

```js
const query = new Parse.Query("contracts_templateLinks");
query.equalTo("TemplatePtr", templatePtr);   // Pointer → contracts_Template
query.equalTo("Type", mode);
let templateLink = await query.first();
// set: Type, TemplatePtr, Placeholders
```

Prefill images are embedded into the PDF client-side (`handleEmbedPrefillToDoc`) before the
document is created, and the flattened result is uploaded as the new `URL`.

### 6.9 Declining

```
POST {baseUrl}functions/declinedoc
body: { docId, reason, userId }
→ result: "document declined"
```

Sets `IsDeclined: true`, `DeclineReason`, `DeclineBy` (a `_User` pointer built from the
**body-supplied** `userId`), and emails the document owner. Refuses documents that are
already `IsCompleted` or `IsArchive`. If `IsEnableOTP` is set, it additionally requires
`request.user`, but still uses the body `userId` for `DeclineBy`.

---

## 7. Widgets / field types

### 7.1 Type strings

From the previous frontend's constants:

```js
export const textInputWidget = "text input";
export const drawWidget      = "draw";
export const textWidget      = "text";
export const radioButtonWidget = "radio button";
export const cellsWidget     = "cells";
```

The full palette (`widgets` array, in UI order):

| `type` | Meaning | Default W×H (px @ scale 1) |
|---|---|---|
| `signature` | drawn/typed/uploaded signature | 150 × 60 |
| `stamp` | image stamp (`isStamp: true`) | 150 × 60 |
| `initials` | initials | 50 × 50 |
| `text input` | single-line input filled by the signer | 150 × 19 |
| `name` | signer's name (prefilled) | 150 × 19 |
| `job title` | signer's job title | 150 × 19 |
| `company` | signer's company | 150 × 19 |
| `email` | signer's email | 150 × 19 |
| `date` | date field | 100 × 20 |
| `text` | static text placed by the sender | 150 × 19 |
| `cells` | boxed character cells (e.g. SSN) | 112 × 22 |
| `checkbox` | checkbox group | 15 × 19 |
| `dropdown` | select | 120 × 22 |
| `radio button` | radio group | 5 × 10 |
| `image` | image upload (`isStamp: true`) | 70 × 70 |
| `draw` | freehand drawing | 150 × 60 |
| *(default)* | — | 150 × 60 |

The drag-and-drop payloads carry stable numeric ids (`components/pdf/WidgetComponent.jsx`):
1 signature, 2 stamp, 3 initials, 4 text input, 6 name, 7 job title, 8 company, 9 email,
10 date, 11 text, 12 cells, 13 checkbox, 14 dropdown, 15 radio button, 16 image, 17 draw.
(**5 is unused.**)

Legacy/compat notes:

* The server accepts the legacy alias **`"textbox"`**; the client normalises it to
  `"text input"` (`normalizeDuplicateWidgetType`).
* `saveastemplate` and `recreatedoc` both rewrite `type === 'text'` → `'text input'`.
* The server-side prefill allow-lists use **legacy** names:
  `prefillDraftDocWidget = ['date','textbox','checkbox','radio button','image']` and
  `prefillDraftTemWidget = [...same, 'dropdown']` (`apps/server/Utils.js`).
  These do **not** match the current client type strings — treat them as dead constants.
* There is **no "textarea" widget** in this build.

#### Per-flow palette restrictions (client-side policy, not enforced server-side)

`components/pdf/WidgetComponent.jsx` narrows the palette depending on the flow:

| Flow | Available types |
|---|---|
| Request-signature placeholder (default) | everything except `text`, `draw` |
| Sign-yourself | everything except `dropdown`, `radio button`, `text input`, `draw` |
| `AllowModifications` + logged-in signer | everything except `dropdown`, `radio button`, `text input`, `date`, `image`, `checkbox`, `draw` |
| `AllowModifications` + guest signer | only `signature`, `stamp`, `initials`, `text`, `cells` |
| `Role: "prefill"` | only `radio button`, `text`, `date`, `image`, `checkbox`, `draw` (+ `dropdown` when enabled) |

### 7.2 Widget (`pos`) object shape

Built in `pages/PlaceHolderSign.jsx`, `SignyourselfPdf.jsx`, `TemplatePlaceholder.jsx`,
`PdfRequestFiles.jsx` — all identical:

```jsonc
{
  "key": 12345678,          // randomId() — an 8-digit NUMBER, unique within the doc
  "type": "signature",
  "xPosition": 123.45,      // in PDF-space units (see 7.4)
  "yPosition": 200.10,
  "Width": 150,
  "Height": 60,
  "scale": 0.812,           // containerScale at the time it was placed
  "zIndex": 3,
  "isStamp": true,          // only for type "stamp" and "image"
  "isMobile": false,        // legacy: set when placed from a mobile viewport (no longer written)
  "IsResize": false,        // set once the widget has been resized
  "options": { /* see 7.3 */ },

  // filled at signing time (these live on the widget, NOT inside options):
  "SignUrl": "data:image/png;base64,...",  // legacy mirror of options.response
  "ImageType": "default",                  // "default" when auto-applied from a saved signature
  "signatureType": "draw",                 // "draw" | "type" | "upload" | "default"
  "typeSignature": "John Doe",             // typed-signature only
  "typeFont": "Fasthand",
  "fontColor": "blue"
}
```

**Casing is inconsistent and load-bearing.** `xPosition`, `yPosition`, `scale`, `zIndex`,
`key`, `type`, `options`, `isStamp`, `isMobile` are lower-camel; `Width`, `Height`,
`IsResize`, `SignUrl`, `ImageType` are upper-camel.

`SignUrl` duplicates `options.response` for image-bearing widgets. The source comment
(`constant/Utils.js:2113`) says: *"`SignUrl` this is wrong nomenclature and maintain for
older code"*. A new frontend should write both for compatibility with the embed code, or
drop `SignUrl` only after confirming nothing reads it.

#### Sign-yourself uses a flat variant

In `SignyourselfPdf`, `Placeholders` has **no signer wrapper** — it is
`[{ pageNumber, pos: [...] }]` directly. Code disambiguates with:

```js
const isSigners = xyPosition.some((data) => data.signerPtr || data.Role === "prefill");
// and
xyPosition.some((item) => Array.isArray(item?.placeHolder));
```

Sign-yourself also strips `SignUrl` and `options.response` before persisting.

### 7.3 `options` schemas

Produced by `addWidgetOptions(type, signer, placeholder, role)`. Every widget starts with:

```js
{ name: `${type}-${generateId(6)}-${count}`, status: "required" }
```

`status` is `"required"` or `"optional"`. `name` is the field's machine name (auto-generated,
editable in the UI, and used to auto-apply duplicate values across widgets of the same name
for `name`/`company`/`job title`/`email`/`text input`).

| type | additional `options` keys |
|---|---|
| `signature`, `stamp`, `initials`, `image`, `dropdown`, `text`, `draw` | *(none beyond `name`/`status`)* |
| `checkbox` | `isReadOnly: false`, `isHideLabel: false` |
| `text input` | `isReadOnly: false` |
| `cells` | `cellCount: 5`, `defaultValue: ""`, `validation: {type:"", pattern:""}`, `isReadOnly: false` |
| `name`, `company`, `job title` | `defaultValue: <prefilled from signer or "">` |
| `email` | `validation: {type:"email", pattern:""}`, `defaultValue` |
| `date` | `response: ""`, `isReadOnly: false`, `validation: { type:"date-format", format:"MM/dd/yyyy" }` |
| `radio button` | `values: []`, `isReadOnly: false` |

Once the sender configures a widget (the settings modals) more keys appear. Full reference:

| `options` key | Applies to | Values |
|---|---|---|
| `name` | all | `` `${type}-${generateId(6)}-${n}` ``, e.g. `signature-aB3xY9-1`. **Must be unique across all signers** (client-enforced only) |
| `status` | all | `"required"` \| `"optional"` |
| `defaultValue` | text input, cells, name, company, job title, email, dropdown, radio, checkbox | string; **array of indices** for checkbox |
| `response` | all | the signer's answer. Base64 data URL for image-bearing types; array of indices for checkbox; the literal `"today"` is allowed for date |
| `validation` | text input, cells, email, date, checkbox | `{type, pattern}` \| `{type:"date-format", format}` \| `{minRequiredCount, maxRequiredCount}` (checkbox) \| `{}` |
| `values` | dropdown, radio button, checkbox | `string[]`, must be unique. Default `["Option-1","Option-2"]` |
| `layout` | checkbox, radio button | `"vertical"` (default) \| `"horizontal"` |
| `cellCount` | cells | int, default `5` |
| `isReadOnly` | text input, cells, checkbox, radio, dropdown, date | bool |
| `isHideLabel` | checkbox, radio button | bool |
| `hint` | most | string, max 40 chars |
| `fontSize` | text-ish | one of `[2,4,6,8,10,12,14,16,18,20,22,24,26,28]`, default `12` |
| `fontColor` | text-ish | `"red"` \| `"black"` \| `"blue"` \| `"yellow"`, default `"black"` |
| `rotation` | signature, initials | `0` \| `90` \| `180` \| `270` |
| `penColors` | signature, initials | `string[]` |

Adding/removing a dropdown/radio option adjusts the widget's `Height` by ±15 per option.

#### `validation.type` vocabulary

`utils/widgetUtils.js:getRegexForType`:

| `type` | Regex applied |
|---|---|
| `"email"` | `/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$/` |
| `"number"` | `^\d+(?:\.\d+)?$` |
| `"text"` | `/^[a-zA-Z ]+$/` |
| `"ssn"` | `/^(?!000\|666\|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/` (auto-sets `hint:"xxx-xx-xxxx"`, `cellCount:11`) |
| `"date-format"` | not a regex — `validation.format` holds a date-fns pattern |
| anything else | passed through as a literal regex |

When `validation.type === "regex"`, the actual expression lives in `validation.pattern`.

#### Response type compatibility

`utils/widgetUtils.js:isWidgetResponseCompatible` is the authoritative validator:

| type(s) | valid `response` |
|---|---|
| `signature`, `stamp`, `initials`, `image`, `draw` | base64 string |
| `checkbox` | `number[]` (indices into `options.values`) |
| `radio button`, `dropdown` | a string matching one of `options.values` (trimmed) |
| `date` | `"today"` or anything `new Date()` parses |
| `text`, `text input`, `cells`, `name`, `company`, `job title`, `email` | string or number |

#### Required-field rule

`constant/Utils.js:handleCheckResponse`:

```js
position.type === "signature" || (position.options?.status === "required" && position.type !== "checkbox")
```

i.e. **`signature` widgets are always mandatory regardless of `status`**, and checkboxes are
validated separately against `validation.minRequiredCount` / `maxRequiredCount`.

#### Duplicate auto-fill

Filling one of `name`, `company`, `job title`, `email`, `text input` propagates the
`response` to every same-`options.name` sibling across all pages, and blanks their
`defaultValue`.

`saveastemplate` clears `response`, `defaultValue` and forces `isReadOnly: false` and
`status: "required"` when converting a self-sign draft.

Date formats (`selectFormat`, identical client and server):
`MM/DD/YYYY`, `DD-MM-YYYY`, `DD/MM/YYYY`, `LL` → `MMMM dd, yyyy`, `DD MMM, YYYY`,
`YYYY-MM-DD`, `MM-DD-YYYY`, `MM.DD.YYYY`, `MMM DD, YYYY`, `MMMM DD, YYYY`,
`DD MMMM, YYYY`, `DD.MM.YYYY`, `DD-MMM-YYYY`; default `MM/dd/yyyy`.

### 7.4 Coordinate system

* `pageNumber` is **1-based**.
* `xPosition` / `yPosition` are the widget's top-left corner **in PDF-page units at
  scale 1**, measured from the top-left of the page. The client converts from screen
  pixels by dividing by `containerScale * scale`:

  ```js
  xPosition: getXPosition / (containerScale * scale),
  yPosition: getYPosition / (containerScale * scale),
  Width:     widgetWidth  / (containerScale * scale),
  Height:    widgetHeight / (containerScale * scale)
  ```

  where `containerScale = getContainerScale(pdfOriginalWidthHeight, pageNumber, containerWH)`
  is the ratio between the rendered container width and the PDF's intrinsic page width.
* `scale` on the widget records the `containerScale` at placement time.
* `SCALE_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]` is the zoom
  ladder. Zoom is applied as a **CSS transform on the container**, not to the pdf.js
  viewport — which is why drag-move only divides by `containerScale` while drop divides by
  `containerScale * scale`.
* Rendering multiplies back: `posWidth * containerScale`, `xPosition * containerScale`,
  and font sizes as `(options.fontSize || 12) * containerScale`.

#### `pdfOriginalWH` and the CropBox correction

The intrinsic page size must include the CropBox Y offset or every widget drifts:

```js
// constant/Utils.js:getOriginalWH
const getPage = await pdf.getPage(index + 1);
const y0 = getPage?.view[1] || 0;              // Letter page starts 7.92 from the bottom
let { width, height } = getPage.getViewport({ scale: 1 });
height = height + y0;                          // 792 + 7.92 = 799.92
pdfWHObj.push({ pageNumber: index + 1, width, height });
```

The pdf-lib side mirrors it: `const { y, width, height } = page.getCropBox(); originalHeight = height + y;`

#### Top-left → PDF bottom-left conversion (embed time)

`constant/Utils.js:compensateRotation` is the exact inverse a server-side renderer would need:

```js
let coordsFromBottomLeft = { x: x / scale };
if (pageRotation === 90 || pageRotation === 270) {
  coordsFromBottomLeft.y = dimensions.width  - (y + fontSize) / scale;
} else {
  coordsFromBottomLeft.y = dimensions.height - (y + fontSize) / scale;
}
// ...then 90/180/270 rotation matrices with +width / +height offsets
```

Embed-time fudge factors worth knowing:

* Text-type widgets (`text`, `text input`, `cells`, `name`, `company`, `job title`, `date`,
  `email`) get **`yPosition + 6`**.
* Checkbox metrics: `checkboxSize = fontSize - 1`, `checkboxTextGapFromLeft = fontSize + 3.4`,
  `verticalGap = fontSize + 5.5`, `currentY = yPos + 2`.
* Image widgets go through `getWidgetPosition`, which applies a viewport-ratio correction
  using a `vpWidth` recorded on the image (`pageRatio = pageWidth / (image.vpWidth * sizeRatio)`).

#### Legacy mobile compensation

```js
if (pos.isMobile && pos.scale) { return pos.IsResize ? posWidth : posWidth * pos.scale; }
else { return posWidth; }
```

`isMobile` is no longer written, so this only affects historical rows.

#### Copy-to-pages

`components/pdf/PlaceholderCopy.jsx` rescales by `widthRatio`/`heightRatio` when copying a
widget to a page of different dimensions, clamps to a 10 px margin, and generates a new
`key` plus a new `options.name` (`` `${type}${randomId(2)}` ``) per copy.

---

## 8. Files and PDFs

### 8.1 Storage backends

`index.js` picks the files adapter from `USE_LOCAL`:

* `USE_LOCAL !== 'true'` → `@parse/s3-files-adapter` against a DigitalOcean-Spaces-style
  S3 endpoint (`DO_ENDPOINT`, `DO_SPACE`, `DO_REGION`, `DO_ACCESS_KEY_ID`,
  `DO_SECRET_ACCESS_KEY`, `DO_BASEURL`) with `directAccess: true`, `presignedUrl: true`,
  `presignedUrlExpires: 900`, `preserveFileName: true`, `fileAcl: 'none'`.
* `USE_LOCAL === 'true'` (or S3 config fails) → `@parse/fs-files-adapter` writing to
  `./files`, served at `{serverURL}/files/{appId}/{filename}`.

### 8.2 Upload paths

**(a) `Parse.File` from the browser** — the normal path:

```js
const pdfFile = new Parse.File(fileName, { base64: base64Str });
const pdfData = await pdfFile.save();      // POST /app/files/{name}
const pdfUrl = pdfData.url();
const fileRes = await getSecureUrl(pdfUrl); // adds ?token=... for local storage
```

`getSecureUrl` (client, `constant/Utils.js:198`) checks whether the URL path contains
`/files/`; if so it calls `Parse.Cloud.run("fileupload", { url })` to get a JWT-signed
URL, otherwise returns it unchanged.

**(b) `savefile` cloud function** — flattens PDFs server-side before uploading:

```js
Parse.Cloud.run("savefile", { fileBase64, fileName, id? });  // → { url }
```

Accepts `.pdf` (flattened with `flattenPdf`), `.png`, `.jpg`, `.jpeg`.
**This function looks broken** — see [§11](#11-quirks-and-gotchas).

**(c) Server-side** — `parseUploadFile(fileName, fileData, mimeType)`
(`utils/fileUtils.js`) does `POST {cloudServerUrl}/files/{fileName}` with
`X-Parse-Master-Key`, used by `signPdf`, `generatecertificate` and `docxtopdf`.

### 8.3 Signed URL scheme

Two different signing mechanisms depending on the backend.

**Local storage (`/files/` in the path):** a JWT signed with `MASTER_KEY`:

```js
// getSignedUrl.js
const payload = { fileUrl, exp: Math.floor(Date.now()/1000) + 200 };  // 200 s default
return `${fileUrl}?token=${jwt.sign(payload, MASTER_KEY)}`;
```

The Express middleware in `index.js` intercepts every `GET` under `/files/` and calls
`validateSignedLocalUrl`. A request with **no** query string at all is rejected with
`400 {"message":"unauthorized"}`. A bad/expired token likewise.

**S3/Spaces:** a real AWS presigned GET, `expiresIn: 160` seconds
(`getPresignedUrl` in `getSignedUrl.js`).

**Getting a fresh URL:**

```js
POST {baseUrl}functions/getsignedurl
body: { url, docId?, templateId? }
→ result: "<presigned url string>"
```

Rules in `getSignedUrl(request)`:

* If `url` contains `/files/` → return a JWT-signed local URL (no auth check at all).
* Else if `docId`/`templateId` given → load the doc/template; if `IsEnableOTP` require
  `request.user`; then presign. If the doc isn't found, the input `url` is returned as-is.
* Else (no docId/templateId) → require `request.user`, then presign.

`fileupload` `{ url }` is a thinner variant that only does the local-JWT signing, with a
200 s TTL and **no auth check whatsoever**.

### 8.4 Automatic URL resolution on read

The `afterFind` triggers rewrite stored raw URLs into freshly-signed ones:

| Trigger | Fields rewritten |
|---|---|
| `contracts_Document` | `SignedUrl`, `URL`, `CertificateUrl`, plus prefill widget `options.response` images |
| `contracts_Template` | same |
| `contracts_Signature` | `ImageURL`, `Initials`, `Stamp` |
| `_User` | `ProfilePic` |
| `partners_Tenant` | `Logo`, `Favicon` |

**All five only run when the query returns exactly one object.** A `find()` returning a
list gets **raw, unsigned URLs** that will 400 when fetched from local storage.

### 8.5 Uploading a source document (the `Form.jsx` pipeline)

Accepted inputs: `application/pdf`, `.docx`, `image/png`, `image/jpeg`.
Client cap: `maxFileSize = 80` MB (`constant/const.js`). Server cap: `maxUploadSize: '100mb'`.

Pre-processing, all client-side, before a single byte reaches Parse:

1. Password-protected PDF → `POST {api}/decryptpdf` (multipart, no auth) → decrypted blob.
2. `clearAcroFields()` — flatten any existing AcroForm.
3. PNG/JPEG → wrapped into a one-page PDF with pdf-lib.
4. `.docx` → `POST {api}/docxtopdf` (multipart, `sessiontoken` header) → `{ url }` → fetched as an arraybuffer.
5. All inputs **merged into one PDF**, `pdfDoc.save({ useObjectStreams: false })`.
6. `new Parse.File(name, [...pdfBytes], "application/pdf").save({ progress })` → `getSecureUrl(url)`.
7. `SaveFileSize(byteLength, url, tenantId, userId)`.
8. The resulting URL is set as `URL` on the new document/template.

### 8.6 Rendering the PDF — and why CORS is not a problem

The old frontend uses `react-pdf` / `pdfjs-dist` with the worker loaded from a CDN:

```js
pdfjs.GlobalWorkerOptions.workerSrc =
  `//unpkg.com/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
```

**A remote URL is never handed to `<Document>`.** The PDF is always fetched first and
converted to a base64 data URL:

```js
const pdfDataBase64 = `data:application/pdf;base64,${props.pdfBase64Url}`;
<Document file={pdfDataBase64} onLoadSuccess={pdf => setAllPagesCount(pdf.numPages)} />
```

There is **no `crossOrigin`, no `withCredentials`, no Vite dev proxy** anywhere. The only
CORS requirement is that the storage bucket (or the wide-open server `cors()`) permits a
plain `fetch()` from the app origin. The fetch helpers are:

* `getBase64FromUrl(url)` — `fetch` → `blob` → `FileReader.readAsDataURL`
* `convertPdfArrayBuffer(url)` — `fetch` → `arrayBuffer()`; returns the literal string `"Error"` on failure
* `loadPdfOnce(url)` — `utils/widgetUtils.js`

For local file storage the JWT expires in 200 s, so any long-lived page must re-request a
fresh URL via `getsignedurl` before download/print.

Download filename is built server-side by `buildDownloadFilename(formatId, ctx)` from
`ExtUserPtr.DownloadFilenameFormat`:

| formatId | Result |
|---|---|
| `DOCNAME` | `Contract.pdf` |
| `DOCNAME_SIGNED` | `Contract - Signed.pdf` |
| `DOCNAME_EMAIL` | `Contract - user@example.com.pdf` |
| `DOCNAME_EMAIL_DATE` | `Contract - user@example.com - 20-Aug-2026 10:30 AM.pdf` |

### 8.7 Storage accounting

`SaveFileSize(size, fileUrl, tenantId, userId)` (client) and `saveFileUsage` (server)
both write to `partners_TenantCredits.usedStorage` and create a `partners_DataFiles` row.
The client version sends **only `X-Parse-Application-Id`** — no session token — relying on
the permissive CLP on those two classes.

---

## 9. Reports (the magic objectIds)

`getReport` is the paginated list endpoint behind every table screen. The `reportId` is a
hard-coded key that selects a canned `where` clause and key list from
`cloud/parsefunction/reportsJson.js`.

```
POST {baseUrl}functions/getReport
headers: { "X-Parse-Application-Id", sessiontoken }
body:    { reportId, limit, skip, searchTerm?, signerStatus? }
→ result: [ ...rows ]   |   { error: "Invalid session token" | "Report is not available!" | "You don't have access!" }
```

Internally it authenticates via `GET /users/me` with the `sessiontoken` header, builds a
REST `GET /classes/{cls}?where=...&keys=...&order=-updatedAt&skip=&limit=&include=` and
calls it **with the master key**. Ordering is always `-updatedAt`. Include is always
`AuditTrail.UserPtr,Placeholders.signerPtr,ExtUserPtr.TenantId`.

| reportId | Name | Class | `where` |
|---|---|---|---|
| `ByHuevtCFY` | **Draft Documents** | `contracts_Document` | `Type != Folder`, `IsCompleted != true`, `IsDeclined != true`, `IsArchive != true`, `SignedUrl $exists false`, `CreatedBy == me` |
| `4Hhwbp482K` | **Need your sign** | `contracts_Document` | not completed/declined/archived, `SignedUrl != null`, `ExpiryDate > now`, `Placeholders != null`, `Signers $inQuery {contracts_Contactbook where UserId == me}` |
| `1MwEuxLEkF` | **In-progress documents** | `contracts_Document` | `SignedUrl != null`, `Placeholders != null`, not completed/declined/archived, `CreatedBy == me`, `ExpiryDate > now` |
| `kQUoW4hUXz` | **Completed Documents** | `contracts_Document` | `IsCompleted == true`, `IsDeclined != true`, `IsArchive != true`, `$or [CreatedBy == me, Signers $inQuery ...]` |
| `UPr2Fm5WY3` | **Declined Documents** | `contracts_Document` | `Type == null`, `IsArchive != true`, `IsDeclined == true`, `CreatedBy == me` |
| `zNqBHXHsYH` | **Expired Documents** | `contracts_Document` | not completed/declined/archived, `Type != Folder`, `SignedUrl != null`, `ExpiryDate < now`, `CreatedBy == me` |
| `d9k3UfYHBc` | **Recently sent for signatures** (dashboard) | `contracts_Document` | same as In-progress |
| `5Go51Q7T8r` | **Recent signature requests** (dashboard) | `contracts_Document` | same as Need-your-sign |
| `kC5mfynCi4` | **Drafts** (dashboard) | `contracts_Document` | same as Draft Documents |
| `contacts` | **Contactbook** | `contracts_Contactbook` | `CreatedBy == me`, `IsDeleted != true`; keys `Name,Email,Phone,JobTitle,Company` |
| `6TeaPr321t` | **Templates** | `contracts_Template` | `Type != Folder`, `IsArchive != true`, **plus** team/user sharing resolution (see below) |

**Key sets returned** (`keys=` on the REST query, so anything not listed is absent):

```js
commanKeys = ['IsSignyourself','URL','Name','Note','SignedUrl','AuditTrail','Folder.Name',
  'ExtUserPtr.Name','ExtUserPtr.Email','ExtUserPtr.DownloadFilenameFormat','ExtUserPtr.Company',
  'ExtUserPtr.Phone','Signers.Name','Signers.Email','Signers.Phone','Placeholders','TemplateId',
  'ExpiryDate','SenderName','SenderMail'];

filterKeys = ['TimeToCompleteDays','AllowModifications','IsEnableOTP','IsTourEnabled',
  'NotifyOnSignatures','RedirectUrl','SendinOrder'];

inProgressKeys = [...commanKeys, 'AuditTrail.UserPtr','SendMail','RequestBody','RequestSubject',
  'EmailEditorType','ExtUserPtr.TenantId.RequestBody','ExtUserPtr.TenantId.RequestSubject',
  'ExtUserPtr.TenantId.EmailEditorType','DocSentAt'];

needYourSignKeys = [...commanKeys, 'Signers.UserId'];
```

* Declined adds `DeclineReason`; Completed adds `IsCompleted`; Templates adds
  `IsPublic, SharedWith.Name, SendinOrder, SignatureType, NotifyOnSignatures`.

**Templates access resolution** (`reportId === '6TeaPr321t'`): the function loads the
caller's `contracts_Users` with `TeamIds` included, flattens every team's `Ancestors` into
one array, and replaces the `where` with

```jsonc
{ "Type": {"$ne":"Folder"}, "IsArchive": {"$ne":true},
  "$or": [ {"SharedWith": {"$in": [...ancestorTeamPointers]}},
           {"ExtUserPtr": {"__type":"Pointer","className":"contracts_Users","objectId":"<me>"}},
           {"SharedWithUsers": {"__type":"Pointer","className":"contracts_Users","objectId":"<me>"}} ] }
```

If the user has no teams, it falls back to `CreatedBy == me`.
(**Bug:** when the caller has no `contracts_Users` row at all, the code sets
`CreatedBy` and then dereferences `extUser.id` anyway → TypeError.)

**Search** (`applySearch`): for `contacts`, `$or [Name regex, Email regex]`. For everything
else, `$or [Name regex, Signers $inQuery {Email regex}]`, combined with any pre-existing
access `$or` via `$and`.

**`signerStatus`** (documents only): `"all"` (omit the param), `"viewed"` → adds
`AuditTrail.Activity: "Viewed"`, `"signed"` → `"Signed"`.

### 9.1 Client-side post-filtering (server pagination is broken for two reports)

For `4Hhwbp482K` (Need your sign) and `5Go51Q7T8r` (Recent signature requests) the old
frontend **ignores the requested page** and forces `skip: 0, limit: 200`, then filters in
JavaScript — re-checking that some `Signers[].UserId.objectId === currentUser.id` and that
no `AuditTrail` entry has `Activity === "Signed"` for the current user
(`pages/Report.jsx`, `components/dashboard/DashboardReport.jsx`, `components/dashboard/DashboardCard.jsx`).

This is because the canned `where` cannot express "and I have not signed it yet".
A new frontend either has to replicate the same client-side filter, or the backend query
for those two report ids needs fixing. Beyond 200 matching documents the list is wrong.

### 9.2 Extra selectable columns

`extraCols` (`json/ReportJson.js`) — user-toggleable table columns, persisted in
`localStorage.reportColumns`:
`Note`, `Time to complete (Days)`, `Enable Tour`, `Notify on signatures`, `Redirect url`,
`Created Date`, `Updated Date`; plus `Expiry Date` for `4Hhwbp482K`.

Column → field mapping lives in `primitives/RenderReportCell.jsx`:
`Title`→`Name` (+`ExpiryDate.iso`), `Reason`→`DeclineReason`, `Folder`→`Folder.Name`,
`Owner`→`ExtUserPtr.Name`, `Signers`→`Signers[]` + `AuditTrail`, `Sent Date`→`DocSentAt.iso`.

### 9.3 Dashboard tiles

The previous frontend's dashboard config (dashboard id `35KBoSgoAK`) drove two count
cards that hit `GET /classes/contracts_Document?where=...&count=1` **directly**, plus three
embedded reports (`5Go51Q7T8r`, `d9k3UfYHBc`, `kC5mfynCi4`).

The two count cards store their `where` clause as a **template string with hash
placeholders**, substituted client-side by `constant/getReplacedHashQuery.js`:

| Token | Replaced with |
|---|---|
| `#objectId#` | `Extand_Class[0].objectId` (the `contracts_Users` id) |
| `#UserId.objectId#` | `Extand_Class[0].UserId.objectId` (the `_User` id) |
| `#today#` | `new Date().toISOString()` |
| `#Date#` | the literal `Date` |
| `#*ne`, `#*gt`, `#*exists` … | decoded to `$ne`, `$gt`, `$exists` (`#*` → `$`) |
| anything else | `Parse.User.current().id` |

Example (Out for signatures card), after substitution:

```jsonc
where={"Type":{"$ne":"Folder"},"Signers":{"$exists":true},"Placeholders":{"$exists":true},
"SignedUrl":{"$exists":true},"IsCompleted":{"$ne":true},"IsDeclined":{"$ne":true},
"IsArchive":{"$ne":true},"CreatedBy":{"__type":"Pointer","className":"_User","objectId":"..."},
"ExpiryDate":{"$gt":{"__type":"Date","iso":"..."}}}&count=1&limit=0
```

The `4Hhwbp482K` card is special-cased to call `getReport` (with `limit: 200`) instead of
counting.

> **Bug:** the "Need your Signature" count card's `where` uses
> `"Signers": {"$in":[{"className":"contracts_Users",...}]}` — but `Signers` actually holds
> `contracts_Contactbook` pointers, so this count is always 0.
> The report behind the card (`4Hhwbp482K`) uses the correct `$inQuery`.

### 9.4 Form ids and sidebar menu ids (for route parity)

`form` pages (`json/FormJson.js`, route `/form/:id`):

| id | Screen | Target class |
|---|---|---|
| `sHAnZphf69` | Sign yourself | `contracts_Document` |
| `8mZzFxbG1z` | Request signatures | `contracts_Document` (+ signers, Bcc, Cc) |
| `template` | Create template | `contracts_Template` |

`report` pages: the ids in the table above. `drive`, `managesign`, `preferences`, `users`,
`profile`, `changepassword`, `verify-document` are plain routes.

The sidebar also lists **`generatetoken` (API Token)** and **`webhook`** — but neither has a
route in `App.jsx`, a page component, or a backend implementation in this build. They are
dead links.

---

## 10. Realtime, mail, notifications, webhooks

### 10.1 Realtime

**There is none.** No LiveQuery server, no WebSockets, no SSE, no polling loops. Every
list refresh is a manual re-fetch. Document status changes are only visible on reload.

### 10.2 Mail

Two providers, selected at boot in `index.js` and again per-call in the mail helpers:

* **SMTP** (`nodemailer`) when `smtpenable` — `SMTP_HOST`, `SMTP_PORT` (default 465),
  `SMTP_USERNAME`/`SMTP_USER_EMAIL`, `SMTP_PASS`. `secure` is `true` unless the port
  is set and isn't 465.
* **Mailgun** when `MAILGUN_API_KEY` is set — `MAILGUN_DOMAIN`, `MAILGUN_SENDER`.

Three mail helpers:

| Helper | Exposed as | Purpose |
|---|---|---|
| `sendMailv3.js` | cloud fn `sendmailv3` | generic HTML mail (signature requests, reminders) |
| `sendSystemMail.js` | internal only | decline / signed notifications |
| `sendMailWithAttachment.js` | internal only | completion mail with signed PDF + certificate attached |

Mail-merge variables (`replaceMailVaribles`, `{{var}}` syntax):

```
document_title, note, sender_name, sender_mail, sender_phone,
receiver_name, receiver_email, receiver_phone,
expiry_date, company_name, signing_url
```

Template resolution order for a **request** email: document `RequestBody/RequestSubject`
→ tenant `RequestBody/RequestSubject` → built-in `mailTemplate()`.
For a **completion** email: tenant `CompletionBody/CompletionSubject` → built-in.

Automated mails sent by the server:

* **On each signature** — `sendNotifyMail` to the owner, only when
  `NotifyOnSignatures` is set **and** more than one signature is still outstanding.
* **On completion** — `sendCompletedMail` to every signer + the owner, with the signed
  PDF and certificate attached; honours `Bcc`, `Cc`, `SenderMail`, `SenderName`.
  Skipped when `IsSendMail === false`.
* **On decline** — `sendDeclineMail` to the owner (not sent when the decliner *is* the owner).
* **Bulk send summary** — `sendOwnerSummaryEmail` after `batchdocuments`.

Everything else (the initial "please sign" email, reminders, sequential next-signer
emails) is triggered **by the client** calling `sendmailv3`.

#### Tenant branding on outgoing mail

`cloud/parsefunction/tenantBranding.js` is applied inside every `sendMailProvider`
(`sendmailv3`, `sendSystemMail`, `sendMailWithAttachment`), so no call site has to opt
in. It resolves the tenant from `params.tenantId`, or from `params.extUserId` via
`contracts_Users.TenantId`, caches it for 60s, and then:

* `from` display name ← `EmailSenderName` when the tenant has one (the address stays
  `SMTP_USER_EMAIL` / `MAILGUN_SENDER`; only the name changes);
* `replyto` ← the mail's own value, else the tenant's `ReplyTo`;
* the footer appended to `html` becomes `EmailFooter` (escaped, newlines kept) followed
  by the "Powered by" / spam-report line, which `HidePoweredBy` removes.

When neither `tenantId` nor `extUserId` is present (password resets and the
verification mails Parse Server sends through the `index.js` adapter, the
delete-account route) the tenant is unknowable and behaviour is unchanged.

`sendreminder` brands in `deliverMail`, before its pluggable transport, so a spy
transport in the specs sees the same params a real send would.

### 10.3 Webhooks / Zapier / API tokens

**Updated 2026-08-21:** personal API tokens, a stateless MCP endpoint (`/api/mcp`), a REST API
(`/api/v1/*`) and AI document preparation (`aistatus`, `aianalyzedocument`,
`aipreparedocument`, `generateapitoken`, `revokeapitoken`, `getapitoken`) now exist. They are
documented in `docs/AI_AND_MCP.md` at the repo root. Outbound webhooks are still not implemented.
The paragraph below describes the state before that change.

**Not implemented in this build (historical).** Grepping the whole server for `webhook`, `zapier`,
`apitoken` finds only:

* a `Webhook` String field on `contracts_Users` (nothing reads or writes it);
* unrelated OpenShift build-trigger secrets in `openshift.json`.

When this section was written there was no public REST API (`/api/v1/...`), no API-key
auth and no outbound webhook dispatcher. DocuStamp has since added all three; see
`docs/AI_AND_MCP.md`.

---

## 10b. Hardening applied on 2026-08-21 (supersedes older notes below)

Shared helpers live in `cloud/parsefunction/authGuard.js`. Tests: `spec/SecurityHardening.spec.js`.

- **`sendmailv3`**: validates recipients (syntax, at most 25 across to/cc/bcc, subject <= 998 chars, body <= 512 KB); resolves the caller from `request.user` or the legacy `sessionToken` / `x-parse-session-token` headers; rate limited 60/min per user and 30/min per IP. Authorization: with `docId`/`templateId` the caller must be owner or signer (or every recipient must be a participant of that document); with `extUserId` the caller must be that ext user, or every recipient must be one of its contacts / a placeholder email on one of its documents (this keeps the anonymous next-signer mail and the `createBatchDocs` loopback working); with neither, only authenticated callers pass (anonymous gets 209).
- **`getUserId`**: master key or an authenticated caller required (209); callers only resolve themselves, same-tenant/org users or their own contacts, anything else returns 101 like a miss. `savecontact` / `editcontact` now call it with the master key.
- **`fileupload`**: the URL must be an http(s) URL whose path is `.../files/<app id>/<filename>`; caller query strings are stripped before signing; anonymous calls still allowed (non-OTP guests need it for image widgets and prefill) at 60/min per IP, 120/min per user.
- **`generatecertificate`**: an already generated certificate is returned read-only without a session (docId-scoped, completed documents only, which is what the public done page hits); generating one requires owner or signer (209/119), 10/min. `PFX_BASE64` is only read on the generation branch.
- **`usersignup` / `addadmin`**: `loginAs` removed. For an existing `_User` a session is issued only if the typed password logs in, or the caller already holds a session for that account; otherwise `{ message: 'User already exist' }` without a token. `normalizeEmail` (previously undefined in `usersignup.js`, which made fresh signups return `undefined`) is fixed.
- **All five `*AfterFind` triggers** now sign URLs for every object in a result (cap 200, concurrency 10, per-field try/catch, objects without URLs skipped). List queries return usable file URLs; the "single object only" notes in §8.4 and §11 are historical.
- **`getcontact`**: owner/creator/self/same-tenant callers get the full row; everyone else (including the session-less guest signer) gets a reduced projection (no CreatedBy/TenantId/ACL) and only when the contact is a signer on a live document (optional `docId` narrows it); 60/min per IP.
- Still open: `fileupload` and `getcontact` stay reachable anonymously for the non-OTP guest flow; `createBatchDocs` loopback mail is authorized through the extUserId rule rather than credentials (passing the master key there would be cleaner).

## 11. Quirks and gotchas

### Data-shape quirks

1. **`Placeholders` is a real array, not a JSON string** — but `batchdocuments` and
   `createbatchcontact` take their payload as a **stringified JSON** parameter
   (`{ Documents: JSON.stringify([...]) }`, `{ contacts: JSON.stringify([...]) }`).
2. **`Placeholders[].Id` is a Number**, not a string (`randomId(8)` returns an integer).
   Same for widget `key`.
3. **`AuditTrail` mixes date representations**: `SignedOn` is a Parse Date,
   `ViewedOn` is a raw ISO string.
4. **`Signers` and `Placeholders` are parallel arrays** kept in sync by index.
   `linkcontacttodoc` `splice`s into `Signers` at the placeholder index. Reordering one
   without the other silently corrupts sequential signing.
5. **`Role: "prefill"`** is a magic placeholder entry, not a person. Filter it out of every
   signer count, recipient list and progress indicator.
6. **`SignedUrl` presence is the draft/sent flag.** It is not "the signed document" — it
   is set to the *original* URL at send time and replaced after each signature.
7. **`Viewers` does not exist** in this build, despite being referenced in EE docs.
   `workflowUtils` has hooks for a viewer role (`isCompletionRelevant` just returns
   `isParticipantBasic`) but no viewer concept is wired up.
8. **`Extand_Class` in localStorage is always a 1-element array.** Read as `[0]`.
9. **`getUserDetails` returns three different types** depending on params:
   a Parse object, `{objectId}`, or `""`.
10. **`gettenant` returns a string** (`"user does not exist!"`) on error, not an object.
11. **String sentinels instead of error codes** across several functions:
    `"Invalid Otp"`, `"user not found!"`, `"exist"`/`"not_exist"`, `"admin_created"`,
    `"document declined"`, `"Otp send"`, `"mail sent."`.

### Trigger quirks

12. **All five `afterFind` triggers only fire when the query returns exactly one object**
    (`if (request.objects.length === 1)`). List queries return **raw, unsigned URLs** which
    will 400 against local file storage. Always fetch a single document (via `getDocument`)
    before rendering a PDF, or call `getsignedurl` explicitly.
13. **`afterSave` on `contracts_Document` rewrites the ACL on every save.** Any ACL you set
    client-side is discarded. Every signer gets **write** access to the entire document.
14. **`ExpiryDate` is only computed on insert**, and only when `Type` is `undefined` or
    `"AIDoc"`. Changing `TimeToCompleteDays` later does not move the expiry date — the
    frontend has to `PUT` `ExpiryDate` itself (which `DocumentsReport.jsx` does).
15. **(fixed 2026-08-21) `NextReminderDate` is now read by the `autoReminders` job.** Previously automatic reminders were not
    implemented in this build.
16. **`contracts_Contactbook.afterSave` creates a `_User` for every contact** with
    `username`/`email`/`password` all set to the contact's email address. This is by design
    (it is what lets a guest sign) but it means every contacted email becomes a
    password-guessable account.

### Timezone / formatting

17. Certificate timestamps are rendered in `ExtUserPtr.Timezone` using
    `ExtUserPtr.DateFormat` and `ExtUserPtr.Is12HourTime` (`formatDateTime` in
    `apps/server/Utils.js`). Everything **stored** is UTC. Expiry-date emails use
    `toLocaleDateString('en-US')` on the **server's** locale/timezone, so the date shown in
    the email can differ from the certificate by a day.
18. `selectFormat` maps a small enum of format labels to `date-fns` patterns and silently
    falls back to `MM/dd/yyyy` for anything unknown.

### Auth / security

19. **Many cloud functions have no authentication check at all**, and several use the
    master key internally:
    `getUserId`, `getcontact`, `updatecontacttour`, `fileupload`, `generatecertificate`,
    `sendmailv3`, `SendOTPMailV1`, `AuthLoginAsMail`, `gettenant`, `getlogobydomain`,
    `checkadminexist`, `isextenduser`, `loginuser`, `usersignup`, `addadmin`.
    `sendmailv3` in particular is an open mail relay for anyone who knows the app id.
20. **`declinedoc` trusts the body-supplied `userId`** for `DeclineBy` even in the
    OTP-protected path.
21. **`defaultdata_Otp` rows never expire and are never deleted.** One row per email; the
    OTP is a 4-digit number with no rate limiting on `AuthLoginAsMail`.
22. **`updateuserasadmin` takes the raw `MASTER_KEY` as a request body parameter.**
23. **Four different session-token header spellings** are in use. Send both
    `X-Parse-Session-Token` and `sessiontoken` on raw HTTP calls.
24. **`partners_TenantCredits` / `partners_DataFiles` writes go out unauthenticated**
    (app id only), relying on wide-open CLPs.
25. `masterKeyIps: ['0.0.0.0/0', '::/0']` — the master key is accepted from anywhere.

### Apparent bugs (verify before relying on this behaviour)

26. **`batchdocuments` (fixed 2026-08-21).** It used to create only the first document and return
    `{ total: 1, created: 1, failed: 0 }`; `generateId` was not imported so the `bulksend` path threw.
    Now: every row is built with its own try/catch, posted to `/batch` in chunks of 50 (5 in flight),
    mailed 5 at a time, and the response carries per-row `results`. See `createBatchDocs.js` and
    `spec/createBatchDocs.spec.js`.

27. **`generateId` in `createBatchDocs.js` (fixed 2026-08-21).** It is now imported from `Utils.js`; `bulksend` sets a 10-char `BulkSendToken`.

28. **`savefile` assigns to an undeclared variable** (`fileUrl = getSecureUrl(...)`) inside
    an ES module, i.e. strict mode → `ReferenceError: fileUrl is not defined`. The
    `Parse.File` path above it is commented out. This cloud function appears to be
    non-functional; the frontend uses `new Parse.File(...)` instead.

29. **`docxtopdf` calls `/functions/savetofileadapter`**, which is not defined anywhere in
    this build. Only the `else` branch (direct Parse `/files/` upload) works, i.e. tenants
    with `ActiveFileAdapter` set will always fail DOCX conversion.

30. **`getReport` for `6TeaPr321t` dereferences `extUser.id` after handling the
    `!extUser` case**, so a user with no `contracts_Users` row gets a TypeError instead of
    the intended `CreatedBy == me` fallback.

31. **`AuthLoginAsMail` calls `reject(...)` outside a Promise** in one branch
    (`if (res) {...} else { reject('user not found!') }` inside an `async` function) —
    that path throws `ReferenceError` and is swallowed into `"Result not found"`.

32. **`getSignedUrl` double-slash**: `constant/Utils.js` builds
    `` `${localStorage.getItem("baseUrl")}/functions/getsignedurl` `` while `baseUrl`
    already ends in `/`, producing `.../api/app//functions/getsignedurl`. Parse tolerates it.

33. **Dashboard "Need your Signature" count card** queries `Signers $in [contracts_Users pointer]`
    but `Signers` holds `contracts_Contactbook` pointers — the count is always 0.

34. **`updatepreferences` requires one of `SignatureType`/`NotifyOnSignatures`/`Timezone`**
    to be present or it throws `"Please provide parameters."`, even when you only want to
    change `DateFormat`, `IsLTVEnabled`, `SendinOrder`, etc.

35. **`editcontact` changes the contact's objectId.** Any document already referencing the
    old contact keeps pointing at the soft-deleted row.

### Client-side-only invariants the backend does not enforce

38. **`options.name` uniqueness across all signers** is validated only in the browser
    (`widgetUtils.hasDuplicateWidgetNames`, `WidgetNameModal`). The server accepts duplicates.
39. **The per-flow widget palette restrictions** (§7.1) are UI policy only — the server
    stores whatever widget types you send.
40. **Response type/format validation** (`isWidgetResponseCompatible`, `getRegexForType`,
    `minRequiredCount`/`maxRequiredCount`) is entirely client-side. `signPdf` receives an
    already-rendered PDF and never inspects the widget responses.
41. **The reminder-count cap** (`TimeToCompleteDays / RemindOnceInEvery <= 15`) is checked
    both client-side and in `beforeSave` — that one *is* enforced.
42. `Name` ≤ 250, `Note` ≤ 200, `Description` ≤ 500 are enforced in `beforeSave`, but
    **only on insert** (`if (!request.original)`), so updates can exceed the limits.

### Missing when this was written

36. Not present at the time (the REST API, API tokens, webhooks and automatic reminders
    have since been added; see `docs/AI_AND_MCP.md`): public REST API v1, API tokens, webhooks, Zapier,
    `contracts_Subscriptions`, viewer/approver roles, `savetofileadapter`, automatic
    reminders, `sendmail`/`sendDoc`/`pdfSign` cloud functions (the equivalents here are
    `sendmailv3` and `signPdf`), and any Google/SSO login UI.

37. The previous frontend's VerifyDocument page ("verify a signed PDF") was **entirely
    client-side** — it parses the PKCS#7 signature with `pdf-lib` + `pkijs` + `asn1js` and
    makes no backend calls at all. A new frontend can port it verbatim.
