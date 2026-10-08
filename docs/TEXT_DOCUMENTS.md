# Written documents

A document does not have to start as a file. In the app, "Write it here" lets
someone type a document (title, headings, paragraphs, lists), format it, and
turn it into the PDF that gets sent for signature. The text stays editable
while the document is a draft: every change renders a fresh PDF and replaces
the draft's file.

This page is the contract between the pieces: the content model both sides
share, the server renderer and function, and the web editor.

## Content model

Stored on `contracts_Document.Content` (an Object column) and exchanged as
JSON. The TypeScript shape (`apps/web/src/features/compose/model.ts`) is the
reference; the server validates the same shape in
`apps/server/cloud/lib/textDocument.js`.

```ts
type PageSize = "letter" | "a4";
type Align = "left" | "center" | "right";

interface Run {
  text: string;          // may contain "\n" = soft line break inside the block
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[]; align?: Align }
  | { type: "paragraph"; runs: Run[]; align?: Align }   // runs: [] = blank line
  | { type: "list"; ordered: boolean; items: Run[][] }  // one Run[] per item
  | { type: "rule" }                                    // horizontal line
  | { type: "pageBreak" };

interface Content {
  version: 1;
  pageSize: PageSize;    // default "letter"
  blocks: Block[];
}
```

Limits (both sides enforce them, the server refuses with
`Parse.Error.VALIDATION_ERROR`):

| Limit | Value |
| --- | --- |
| `CONTENT_MAX_BLOCKS` | 600 |
| `CONTENT_MAX_CHARS` (sum of all run text lengths) | 120 000 |
| items per list | 200 |
| title | 250 characters (it is the document `Name`) |

Normalisation rules (server `normaliseContent`, web `htmlToContent`):

- Unknown block types are dropped. Unknown keys are dropped. An unknown
  `pageSize` becomes `letter`. On the server an empty list is dropped and a
  list over 200 items is refused; the web side truncates instead.
- Tabs become four spaces. Control characters other than `\n` are removed.
- `align` other than the three values is treated as `left`. `level` outside
  1..3 is clamped.
- Adjacent runs with the same styling may be merged. Empty runs are dropped.
- Missing `pageSize` means `letter`. `version` must be `1`.

## Server

### `apps/server/cloud/lib/textDocument.js`

```js
export const CONTENT_MAX_BLOCKS = 600;
export const CONTENT_MAX_CHARS = 120_000;
export const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

/** Validates and normalises caller input. Throws Parse.Error(VALIDATION_ERROR). */
export function normaliseContent(input) -> Content

/** Plain text, one block per line, list items prefixed with "- " or "1. ". */
export function contentText(content) -> string

/** Renders the PDF. `title` is drawn as the document heading when non-empty. */
export async function renderTextPdf({ title, content }) -> Promise<Uint8Array>

/** The same, with the page count the cloud function reports. */
export async function renderTextDocument({ title, content }) -> Promise<{ bytes, pageCount }>
```

Typography (IBM Plex Sans, the product font; files in `apps/server/font/`
`IBMPlexSans-{Regular,Bold,Italic,BoldItalic}.woff`, SIL OFL 1.1, attributed in
`NOTICE`):

| Element | Size | Weight | Line height | Space before / after |
| --- | --- | --- | --- | --- |
| Title | 22 pt | bold | 1.25 | 0 / 14 |
| Heading 1 | 18 pt | bold | 1.3 | 14 / 6 |
| Heading 2 | 14 pt | bold | 1.3 | 12 / 4 |
| Heading 3 | 11.5 pt | bold | 1.3 | 10 / 3 |
| Paragraph | 11 pt | regular | 1.5 | 0 / 7 |
| List item | 11 pt | regular | 1.5 | 0 / 3 (4 after the last item) |
| Footer (page number) | 9 pt | regular, 45% grey | | |

- Margins 72 pt on all sides. Text colour near-black (10% grey).
- Lists: text indented 20 pt; `•` or `1.` sit in the gutter; continuation lines
  align with the text indent.
- Rule: 0.75 pt line, 75% grey, 10 pt space before and after.
- Underline: 0.6 pt line just under the baseline of the underlined run.
- Word wrap is greedy on spaces; a single word wider than the line is broken
  by characters. `\n` in a run forces a line break.
- A heading never ends a page: if fewer than two body lines fit under it, it
  moves to the next page. A page break only takes effect once something is
  drawn after it, so one at the top of a page or at the very end adds nothing.
  Space before an element is dropped at the top of a page.
- Footer: "Page N of M" centred at y = 40, on every page when there is more
  than one page.
- PDF metadata: Title = title, Producer and Creator = "DocuStamp".
- Characters the font lacks render as its notdef glyph; nothing throws.

### Cloud function `rendertextpdf`

File `apps/server/cloud/parsefunction/renderTextPdf.js`, registered in
`cloud/main.js`.

```
params: { title?: string, content: Content }
result: { pdfBase64: string, pageCount: number, bytes: number }
```

- Needs a session (`request.user`), a `contracts_Users` row
  (`extUserForUser`) that is not disabled (`assertNotDisabled`).
- Rate limit: `checkRateLimit('rendertextpdf', userId, 240)` per minute.
- The server does not store the PDF here: the web app uploads the bytes with
  its usual `Parse.File` path and records storage usage itself.

### Column and creation

- Migration `apps/server/databases/migrations/20261008120000-add_document_content.cjs`
  adds `Content` (Object) to `contracts_Document`.
- `documentFields` (`cloud/lib/documents.js`) takes `input.content` and writes
  it to `Content`. `createdocumentfromapp` passes `doc.Content` through
  `normaliseContent` first.
- Later edits replace `URL` and `Content` together with a plain PUT from the
  web app (the class allows authenticated updates).

### Tests

`apps/server/spec/TextDocument.spec.js`: normalisation (limits, stripping,
clamping), `contentText`, rendering (page count grows with content, title and
body text are extractable with pdfjs, a page break adds a page, A4 page size),
and the cloud function (401 without a session, result shape with one).

## Web

### `apps/web/src/features/compose/model.ts`

The types above plus:

```ts
export const CONTENT_MAX_BLOCKS = 600;
export const CONTENT_MAX_CHARS = 120_000;
export function emptyContent(pageSize?: PageSize): Content;   // one empty paragraph
export function isContent(value: unknown): value is Content;   // tolerant shape check
export function contentHasText(content: Content): boolean;     // any non-blank run
export function contentText(content: Content): string;
export function contentCharCount(content: Content): number;
export function withPageSize(content: Content, pageSize: PageSize): Content;
/** The server's rules, applied client-side; truncates at the limits rather than throwing. */
export function normaliseContent(input: unknown): Content;
```

Load a draft's `Content` through `normaliseContent` before handing it to the
editor: it then has exactly the shape the editor emits, so the first value
renders once and later ones never move the caret.

### `apps/web/src/features/compose/api.ts`

```ts
export async function renderTextPdf(
  title: string,
  content: Content,
  opts?: { signal?: AbortSignal }
): Promise<{ bytes: Uint8Array; pageCount: number }>;

export function useRenderedPdf(
  title: string,
  content: Content | null,
  opts?: { delay?: number; enabled?: boolean }   // delay default 700 ms
): {
  bytes: Uint8Array | null;   // last successful render
  pageCount: number;
  rendering: boolean;
  error: string | null;
  stale: boolean;             // content changed since `bytes` was rendered
};
```

`renderTextPdf` calls `cloud("rendertextpdf")` from `@/lib/parse` and decodes
the base64. The hook debounces, aborts a render that is superseded, and keeps
the last good bytes while the next render runs. `stale` is derived from the
last rendered key, not stored: a state update per keystroke was enough for a
fast typing burst to trip React's nested-update guard.

### `apps/web/src/features/compose/Composer.tsx`

```ts
export interface ComposerProps {
  title: string;
  onTitle: (title: string) => void;
  value: Content;
  onChange: (content: Content) => void;
  autoFocus?: "title" | "body";
  disabled?: boolean;
  toolbarRight?: ReactNode;   // slot at the right end of the toolbar
  className?: string;
}
export function Composer(props: ComposerProps): JSX.Element;
```

- Title input (the document name) above the page; placeholder "Untitled
  document".
- Toolbar: text style (Paragraph, Heading 1, Heading 2, Heading 3), bold,
  italic, underline, bulleted list, numbered list, align left / center /
  right, divider, page break, "Signing block" (inserts the lines
  `Signature: ____________________`, `Name: ____________________`,
  `Date: ____________________`, which the field editor's auto-detect turns
  into fields), page size (Letter / A4).
- The page is a contenteditable sheet styled as white paper in both themes
  (`paper-white`), IBM Plex Sans, generous padding, hairline border.
- Keyboard: ⌘/Ctrl+B, I, U; "- ", "* ", "1. " at the start of an empty
  paragraph start a list; "# ", "## ", "### " make headings.
- Paste: HTML is parsed into the model (p, h1-h3, ul/ol/li, b/strong, i/em, u,
  and inline `font-weight` ≥ 600 / `font-style: italic` /
  `text-decoration: underline`), everything else becomes paragraphs from the
  plain text.
- `value` is written to the DOM only when it differs from the content the
  editor last emitted, so typing never moves the caret.
- Every edit calls `onChange` with the serialised content.
- All strings via `t("compose.…")` in `apps/web/src/locales/en.json` (the
  other locales are filled in during integration).

### Where it appears

- Send flow, step 1 ("What needs signing?"): next to the upload box, "Write it
  here". `/send?compose=1` opens step 1 in write mode.
- A draft that has `Content` shows the editor on step 1 instead of the file
  card. Edits autosave: render, upload, PUT `{ URL, Content, Name }`.
- Command bar: "Write a document".
- Document detail page: "Edit text" on a draft that has `Content`.
