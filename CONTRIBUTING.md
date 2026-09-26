# Contributing to DocuStamp

Thanks for helping. Bug reports, fixes, translations and documentation are all welcome.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected and what happened. Security problems go through [SECURITY.md](SECURITY.md) instead, never a public issue.
- **Bigger changes:** open an issue first to talk it through, so your time is not spent on something that will not be merged.

## Setting up

See the Development section of the [README](README.md). In short: `apps/server` is the API (Parse Server, Express, MongoDB) and `apps/web` is the web app (Vite, React, TypeScript, Tailwind).

## Before opening a pull request

Run the checks CI runs:

```bash
cd apps/server
npm run lint
MONGODB_TEST_URI=mongodb://localhost:27017/parse-test npx jasmine

cd ../web
npm run lint
npm run i18n:check   # every locale has the same keys as en.json
npm run mcp:check    # the settings page lists the server's MCP tools
npm run build        # type-check and build
```

Then:

- Keep each pull request to one change, with a clear title and a short description of what and why.
- Add or update tests for server changes.
- Match the style of the surrounding code; Prettier is set up for both apps.
- User-facing text goes through the translation files in `apps/web/src/locales`. Add new keys to `en.json` and the other locales.

## License of contributions

DocuStamp is licensed under the AGPL-3.0. By opening a pull request you agree that your contribution is licensed under the same terms.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
