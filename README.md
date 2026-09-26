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

# 3. Download and start everything.
docker compose up -d
```

Open your domain in a browser and create the first account. HTTPS certificates are issued automatically by Caddy, so ports 80 and 443 must be reachable.

This runs three containers: DocuStamp itself (the web app and the server in one image), MongoDB, and Caddy for HTTPS. The DocuStamp image is published for both regular (amd64) and ARM servers at `ghcr.io/ophydami/docustamp`. A one-command installer and one-click setups for Railway, Render and Fly.io are on the way.

### Running just the image

The whole app is one image. It serves the web app at `/` and the API under `/api` on one port (`PORT`, default 8080), so it can run anywhere that runs a container, next to any MongoDB:

```bash
docker run -d -p 8080:8080 --env-file .env.prod \
  -e PUBLIC_URL=https://sign.example.com \
  -e SERVER_URL=https://sign.example.com/api/app \
  -v docustamp-files:/usr/src/app/files/files \
  ghcr.io/ophydami/docustamp:latest
```

Put HTTPS in front of it (a reverse proxy or your platform's), and keep `TRUST_PROXY=1` so the app sees the real client address. The health check is `/api/app/health`.

### Building the image yourself

`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` builds the image from your checkout (the root `Dockerfile`) instead of downloading it. You need your own build to change `APP_ID`, to turn on "Sign in with Google" (`GOOGLE_CLIENT_ID` in `.env`), or to point the app's "Source" links at your fork (`SOURCE_URL`), because those are baked into the web app.

**Updating:** `git pull && docker compose pull && docker compose up -d`. To stay on a specific release, put `DOCUSTAMP_VERSION=0.1.0` in `.env`.

**Backups:** back up the `data-volume` (the database) and `docustamp-files` (uploaded documents) Docker volumes, or use S3-compatible storage for documents (see `.env.example`).

### The signing certificate

Signed PDFs are sealed with a certificate so any later change is detectable. If you do not configure one, the server creates a self-signed certificate on first boot and keeps it in the database. PDF readers such as Adobe Acrobat only show a signature as trusted when the certificate comes from a certificate authority; to use one, put it in `PFX_BASE64` and `PASS_PHRASE`.

### Settings

Everything is configured through environment variables, listed with explanations in [`.env.example`](.env.example): branding, file storage, email, AI, rate limits and security hardening.

## Development

You need Node.js 24 (the version in `.nvmrc`) and MongoDB. The repository has two apps:

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

Credits, trademark notes and third-party notices are in [NOTICE](NOTICE).
