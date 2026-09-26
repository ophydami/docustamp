# DocuStamp

Open source e-signature app you can run on your own server.

Send PDFs for signature, collect signatures from one or many people, and get back a digitally signed PDF with a full audit trail. Every document stays on infrastructure you control.

## Features

- **Send for signature:** upload a PDF or Word file, place fields (signature, initials, date, text, checkbox, stamp and more), and send it to one or many signers, in order or all at once.
- **Sign without an account:** signers use the link in their email, optionally confirmed with a one-time code sent to them.
- **Templates and bulk send:** save a document as a template and send it to many people in one go.
- **Reminders, expiry and follow-ups:** automatic reminders, expiry dates, voiding, replacing a signer, and chaining a follow-up document once one completes.
- **Proof:** every completed document gets a completion certificate and an audit trail (who opened and signed, when, and from which IP address), and the PDF is digitally signed so any later change is detectable.
- **Your brand:** workspace name, logo, email sender name, reply-to address and footer.
- **API and integrations:** a REST API, webhooks, and an MCP server so AI assistants such as Claude can prepare and send documents for you.
- **Optional AI:** finds the signers and places the fields on a new document for you (Claude, through the Anthropic API or Amazon Bedrock).
- **Seven languages:** English, German, Spanish, French, Hindi, Italian and Korean.

## Run it on your own server

You need a Linux server or VM with [Docker](https://docs.docker.com/engine/install/) (4 GB of memory is comfortable), a domain name pointed at the server, and an email-sending service (SMTP such as Amazon SES, Postmark or Mailgun). Most VPS providers block sending email directly from the server, so the email service is not optional.

```bash
git clone https://github.com/ophydami/docustamp.git
cd docustamp

# 1. Server settings: fill in MASTER_KEY and the email block at the top.
cp .env.example .env.prod
nano .env.prod

# 2. Your address, used for HTTPS and for the links in emails.
echo "HOST_URL=https://sign.example.com" > .env

# 3. Build and start everything.
docker compose up -d --build
```

Open your domain in a browser and create the first account. HTTPS certificates are issued automatically by Caddy, so ports 80 and 443 must be reachable.

The first build takes several minutes because the server image includes LibreOffice (used to convert Word files to PDF). A one-command installer, ready-made images and one-click setups for Railway, Render and Fly.io are on the way.

**Updating:** `git pull && docker compose up -d --build`

**Backups:** back up the `data-volume` (the database) and `opensign-files` (uploaded documents) Docker volumes, or use S3-compatible storage for documents (see `.env.example`).

### The signing certificate

Signed PDFs are sealed with a certificate so any later change is detectable. If you do not configure one, the server creates a self-signed certificate on first boot and keeps it in the database. PDF readers such as Adobe Acrobat only show a signature as trusted when the certificate comes from a certificate authority; to use one, put it in `PFX_BASE64` and `PASS_PHRASE`.

### Settings

Everything is configured through environment variables, listed with explanations in [`.env.example`](.env.example): branding, file storage, email, AI, rate limits and security hardening.

## Development

The repository has two apps:

- `apps/server`: the API, built on Parse Server and Express, with MongoDB.
- `apps/web`: the web app, built with Vite, React, TypeScript and Tailwind. See [`apps/web/README.md`](apps/web/README.md).

`make build` runs the whole stack locally with Docker. To work on the apps directly:

```bash
# Server (needs a MongoDB; set MONGODB_URI in apps/server/.env)
cd apps/server && npm install && npm start

# Web app (proxies /api to the server)
cd apps/web && npm install && npm run dev
```

Tests: `cd apps/server && MONGODB_TEST_URI=mongodb://localhost:27017/parse-test npx jasmine`, and `cd apps/web && npm run build && npm run lint`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

DocuStamp is licensed under the [GNU Affero General Public License v3.0](LICENSE). You can use, change, host and sell it. If you change it and let other people use your changed version over a network, you must offer them its source code too. The app has "Source" links for this; point them at your own repository with `VITE_SOURCE_URL` when you build the web app.

DocuStamp is a fork of [OpenSign](https://github.com/OpenSignLabs/OpenSign) and is grateful to its authors. It is not affiliated with OpenSign Labs or DocuSign. See [NOTICE](NOTICE) for details.
