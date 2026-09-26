# Conventions for apps/web

The DocuStamp web app. Read this fully before writing code, and match the look of the existing screens.

## Stack

- Vite 8, React 19, TypeScript (strict, `noUnusedLocals`, `verbatimModuleSyntax`), Tailwind v4 (tokens in `src/index.css` `@theme`), react-router v7 (`createBrowserRouter` in `src/app/router.tsx`), TanStack Query for server state, zustand for tiny global UI state, `parse` SDK v8 (matches Parse Server 8), lucide-react icons, cmdk for the command palette, date-fns.
- No Material UI, no DaisyUI, no CSS-in-JS, no Redux. Do not add UI libraries; build on `src/components/ui`.
- Path alias `@/` = `src/`.

## Layout of the repo

```
src/
  app/            shell: router.tsx, AppShell.tsx (sidebar+topbar), Sidebar.tsx, CommandBar.tsx (⌘K), auth.tsx
  components/ui/  shared primitives: Button, Kbd, Pill, Avatar/AvatarStack, Input/Textarea/Select/Field,
                  Toggle/Checkbox, Card/Cap/PageTitle/Stat/EmptyState, Dialog, Tabs/Chip, Menu, Toast
  lib/            parse.ts (initParse, cloud(), parseHeaders), queryClient.ts, cn.ts, format.ts
                  (whenShort, untilShort, ago, initials, plural), hotkeys.ts (useHotkeys), store.ts (useBadges,
                  useCommands, usePalette)
  features/<name>/  one folder per feature. Pages are default exports named like the route file
                  (InboxPage.tsx). Put feature-local api.ts (queries/mutations), types.ts, components in the folder.
docs/             CONVENTIONS.md (this), BACKEND_API.md (the Parse contract, read it)
```

## Ownership rules (several people work in parallel)

- A feature agent edits ONLY `src/features/<its-name>/**`. It may ADD new files under `src/components/ui/` or `src/lib/` only if genuinely shared and not feature-specific, and must not modify existing shared files except to append an export to `src/components/ui/index.ts`. Never edit `router.tsx`, `Sidebar.tsx`, `CommandBar.tsx`, `auth.tsx`, `index.css`, `package.json` or another feature's folder. If you need a route or a shared change, write it down in your final report and the integrator will do it.
- Routes already exist in `router.tsx` for every page with the exact default-export filenames. Keep those filenames and default exports (`export default function InboxPage()`).
- Do not install packages. Everything needed is installed (`parse`, `@tanstack/react-query`, `zustand`, `cmdk`, `lucide-react`, `date-fns`, `clsx`). If you truly need something (e.g. `pdfjs-dist`, `react-pdf`, `signature_pad`), say so in your report; the integrator adds it. Exception: the editor and signer features are pre-approved to `npm install pdfjs-dist` and `signature_pad` (and `@types/...` if needed) because they cannot work without them; note it in the report.

## Shared infrastructure (read before building)

- `cloud(name, params)` in `@/lib/parse` calls cloud functions over raw fetch, sends BOTH session header spellings (`X-Parse-Session-Token` and `sessiontoken`, several server functions read the lowercase one), returns plain JSON and throws `CloudError` on error envelopes (including `{ error }` inside `result`). Prefer it over `Parse.Cloud.run`. `rest(path, { method, body, query })` hits Parse REST classes with the same headers.
- The server's plain Express routes (`/docxtopdf`, `/decryptpdf`, `/deleteuser/:id`, `/mcp`, `/v1`) live beside the Parse mount, never under it: use `customRouteBase()` from `@/lib/parse` (never a hand-rolled `SERVER_URL.replace`), and `@/lib/customRoutes` for the docx/decrypt uploads themselves.
- Shared rules that must not be re-derived per feature: `@/lib/pageBox` (page size and the CropBox correction, mirrors the server's `cloud/lib/pageBox.js`), `@/lib/recipients` (pairing `Placeholders` with `Signers`), `@/lib/signingLinks` (server-minted signing links; `fallbackSigningLink` is the only local builder), `@/lib/fileUsage` (`recordfileusage`, the only way to count an upload against the quota).
- `useExtUser()` in `@/lib/extUser` returns the `contracts_Users` row (plain JSON) for the signed-in user; `isAdminRole(role)`.
- `PdfViewer` in `@/components/pdf/PdfViewer` renders a PDF (url or bytes) at a width with a per-page overlay `(page, scale)`; overlay px = PDF point × scale; `maxPages` / `pages` for thumbnails; `PdfPageInfo` carries `renderHeight/cropX/cropY/rotation` (the page box comes from `@/lib/pageBox`, and `height` can exceed `renderHeight` on a cropped page); `useVisiblePage`. The editor has its own lazy variant in `features/editor/EditorPdf.tsx` (superset; candidates for merging).
- Installed libs beyond the stack: `pdfjs-dist`, `pdf-lib` (signer stamps and flattens client-side, the server's `signPdf` expects the finished bytes), `signature_pad`, `events` (aliased in `vite.config.ts` because the Parse SDK imports Node's `events` for LiveQuery).
- `useHotkeys(map, deps, { priority })`: page bindings win over the global top-bar ones (`N`, `S`, `T`, `,` are registered with `priority: "low"`). Handled keys are `preventDefault`ed. `shift+x` style combos work; a shifted letter without a shift binding falls through to the plain key.
- `useBadges` (sidebar counts), `useCommands` (⌘K page commands), `usePalette` in `@/lib/store`.

## Talking to the backend

- `import { Parse, cloud } from "@/lib/parse"`. Use `Parse.Query` for reads, `cloud("fnName", params)` for cloud functions. The session is handled by the SDK (`Parse.User.current()`); `useAuth()` from `@/app/auth` gives `{ user, login, logout }`.
- Wrap reads in TanStack Query (`useQuery`) with stable keys like `["documents", { view, page }]`; wrap writes in `useMutation` and invalidate. Put them in `features/<name>/api.ts`.
- Always convert Parse objects to plain typed records at the api boundary (`toDocument(obj): Document`). Components never touch `Parse.Object` directly.
- Consult `docs/BACKEND_API.md` for class names (`contracts_Document` etc.), fields, cloud functions and quirks. If the doc says something is unclear, read the server code under `apps/server/cloud/` rather than guessing, and note what you learned in your report.
- Errors: surface them with `toast.error("What failed", err.message)` from `@/components/ui`, and show inline errors on forms.

## UI rules (direction E)

- Tokens only: `bg-ground`, `bg-surface`, `border-line`, `text-ink`, `text-ink-2`, `text-muted`, `text-muted-2`, `text-faint`, `bg-accent`, `bg-accent-soft`, `text-accent`, `bg-warn-soft`/`text-warn-ink`, `bg-danger-soft`/`text-danger`, `bg-paper`, `bg-sand`. Fonts: `font-sans` (Instrument Sans, default), `font-serif` (Newsreader, one heading line per screen, e.g. `PageTitle`), `font-mono` (IDs, keys, timestamps). Radii `rounded-md` (8) for controls, `rounded-lg` (10) for cards, `rounded-xl` (12) for dialogs.
- Status colors mean things: green = action / needs you, amber = in progress, terracotta = urgency / declined / expired, ink = completed, neutral = draft. Use `Pill tone="accent|warn|danger|ink|neutral"`.
- Every list supports J/K to move, X to select, Enter to open, and the page's primary action has a key hint (`Button kbd="N"`). Use `useHotkeys` from `@/lib/hotkeys`. Show the hint row at the bottom of lists like the canvas does.
- Density: 13px body, 11px caps labels (`Cap`), table rows 46-54px, page padding 22-24px, sidebar is 228px. Tables are CSS grid rows, not `<table>`, with a 34px uppercase header row on `bg-surface-2`.
- Every data screen has loading (skeleton rows or the `Loader2` spinner), empty (`EmptyState` with one primary action) and error states.
- Icons: lucide only, `strokeWidth={1.6}`, 14-16px in controls. No emoji.
- Copy: plain, specific, sentence case. No em dashes anywhere (use commas, colons, or parentheses). Placeholders for brand: wordmark "DocuStamp", workspace "Acme Inc."
- Accessibility: real `<button>`s, `aria-label` on icon-only buttons, focus-visible rings (already global), 44px touch targets on signer mobile views.
- Responsive: desktop-first for the app shell (min 1024px), but the signer pages must work on phones (390px) like the canvas phone screens.

## Quality bar

- `npm run build` must pass (tsc + vite). Run it before finishing.
- No `any` unless interfacing with untyped Parse results, and then narrow immediately.
- No dead code, no commented-out blocks, no console.log left behind.
- Keep feature folders self-contained; a reader should understand a feature by reading `api.ts` then the page.
