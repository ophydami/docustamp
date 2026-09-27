# DocuStamp logo

A solid page with a rubber stamp cut out of it and a line of blue ink under the stamp. The name is IBM Plex Sans SemiBold, turned into outlines so the files need no font.

## Files

| File | Use it for |
| --- | --- |
| `docustamp-logo.svg` | The logo with the name, on white or light backgrounds |
| `docustamp-logo-on-dark.svg` | The logo with the name, on black or dark backgrounds |
| `docustamp-mark.svg` | The mark alone, on light backgrounds |
| `docustamp-mark-on-dark.svg` | The mark alone, on dark backgrounds |
| `docustamp-mark-mono.svg`, `docustamp-logo-mono.svg` | One colour (`currentColor`), for places that allow a single colour |
| `png/` | PNG exports: marks at 512 and 1024 px tall, logos 1200 px wide, and `social-preview.png` (1280 x 640) for link previews |

The app's own icons live in `apps/web/public`: `favicon.svg` (follows the browser's light or dark theme), `favicon.ico` (16, 32 and 48 px), `apple-touch-icon.png` and `email-logo.png`.

## Colours

| | Hex |
| --- | --- |
| Ink | `#09090B` |
| Blue | `#1447E6` |
| Paper (the page on dark backgrounds) | `#FAFAFA` |

## Using it

- Keep clear space around the logo of at least the width of the stamp.
- Don't use the mark smaller than 16 px tall, or the full logo smaller than 20 px tall.
- Don't recolour the page, stretch it, rotate it or add effects. The stamp is a cut-out, so whatever sits behind the page shows through it.

## Rebuilding

`source/build.mjs` draws every SVG from the same shapes. See the note at the top of that file.
