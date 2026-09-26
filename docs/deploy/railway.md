# Deploy DocuStamp on Railway

Railway runs the whole thing in one project: the DocuStamp image, a MongoDB
database and a volume for uploaded documents. HTTPS and the public address come
from Railway.

## What you need

- A Railway account on the Hobby plan or above. The free trial works for trying it out.
- An email service with an HTTPS API. **Railway blocks outgoing SMTP on the
  Free, Trial and Hobby plans** (only Pro allows it), so use
  [Mailgun](https://www.mailgun.com) there: DocuStamp sends through Mailgun's API,
  which Railway allows. On the Pro plan, SMTP works too.

## Set it up

1. **Create a project** and add a **MongoDB** database to it (New, Database,
   MongoDB). Keep the service name `MongoDB`.
2. **Add the app**: New, Docker Image, `ghcr.io/ophydami/docustamp:latest`.
   Name the service `DocuStamp`.
3. **Attach a volume** to DocuStamp, mounted at `/usr/src/app/files/files`.
   Uploaded and signed documents live there.
4. **Variables** on DocuStamp (the Raw Editor accepts this block as is):

   ```
   PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   MONGO_URL=${{MongoDB.MONGO_URL}}
   MASTER_KEY=<long random value>
   FILE_TOKEN_SECRET=<long random value>
   SIGNING_LINK_SECRET=<long random value>
   ACCOUNT_DELETION_SECRET=<long random value>
   MASTER_KEY_IPS=127.0.0.1,::1
   USE_LOCAL=true
   PORT=8080
   APP_NAME=DocuStamp
   MAILGUN_API_KEY=
   MAILGUN_DOMAIN=
   MAILGUN_SENDER=
   ```

   `${{RAILWAY_PUBLIC_DOMAIN}}` and `${{MongoDB.MONGO_URL}}` stay exactly as
   written: Railway fills them in. For
   each `<long random value>`, paste a different random string, for example the
   output of `openssl rand -hex 32`.

   Fill in the three Mailgun values: your API key, the sending domain
   (e.g. `mail.example.com`, set up in Mailgun's US region) and the bare from
   address (e.g. `no-reply@mail.example.com`; the app adds the sender's name).

5. **Settings** on DocuStamp:
   - Networking: **Generate Domain**, target port `8080`.
   - Healthcheck Path: `/api/app/health`, timeout `300` seconds (the first
     start sets up the database).
   - Keep it at **one replica**: automatic reminders run inside the app, and a
     second copy would send them twice.

6. **Deploy**, then open the generated domain and create the first account. It
   becomes the workspace admin.

`SERVER_URL` and `MONGODB_URI` are filled in by the app from `PUBLIC_URL` and
`MONGO_URL`, using a `docustamp` database. Even `PUBLIC_URL` is optional: without
it the app reads Railway's domain (`RAILWAY_PUBLIC_DOMAIN`) itself.

## A custom domain

Add it under Networking, then set `PUBLIC_URL=https://sign.example.com` on
DocuStamp and redeploy, so links in emails use it.

## Updating

Redeploy the DocuStamp service to pull the newest `latest` image. To stay on a
release, use `ghcr.io/ophydami/docustamp:0.1.0` as the image instead.

## The template recipe

This is how the one-click "Deploy on Railway" template is built. It takes about
ten minutes in Railway's dashboard, deploys nothing and costs nothing.

1. In your Railway workspace, open **Templates** and choose **New Template**.
2. **Add a service** from a **Docker Image**: `ghcr.io/ophydami/docustamp:latest`.
   Rename the service to `DocuStamp`.
3. **Add a database**: **MongoDB**. Keep its name `MongoDB`.
4. On **DocuStamp, Variables**, open the **Raw Editor** and paste:

   ```
   PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   MONGO_URL=${{MongoDB.MONGO_URL}}
   MASTER_KEY=${{secret(48)}}
   FILE_TOKEN_SECRET=${{secret(48)}}
   SIGNING_LINK_SECRET=${{secret(48)}}
   ACCOUNT_DELETION_SECRET=${{secret(48)}}
   MASTER_KEY_IPS=127.0.0.1,::1
   USE_LOCAL=true
   PORT=8080
   APP_NAME=DocuStamp
   MAILGUN_API_KEY=
   MAILGUN_DOMAIN=
   MAILGUN_SENDER=
   ```

   Then give the three Mailgun variables these descriptions, and mark them
   required:

   - `MAILGUN_API_KEY`: Your Mailgun API key. Railway blocks SMTP below the Pro plan, so DocuStamp sends through Mailgun's API.
   - `MAILGUN_DOMAIN`: Your Mailgun sending domain (US region), e.g. mail.example.com
   - `MAILGUN_SENDER`: The from address, e.g. no-reply@mail.example.com. The sender's name is added automatically.

5. On **DocuStamp, Settings**:
   - **Public Networking**: HTTP, port `8080`.
   - **Healthcheck Path**: `/api/app/health`.
   - **Volume**: mount path `/usr/src/app/files/files`.
6. **Publish** with:
   - Name: `DocuStamp`
   - Category: `Other` (or the closest to documents / productivity)
   - Short description: `Open source e-signature app. Send PDFs for signature, with audit trails, templates, an API and webhooks.`
   - Overview:

     ```
     DocuStamp is an open source e-signature app: send PDFs and Word files for
     signature, collect signatures from one or many people, and get back a
     digitally signed PDF with a completion certificate and a full audit trail.

     This template runs the DocuStamp image with MongoDB and a volume for
     documents. After it deploys, open the generated domain and create the first
     account; it becomes the workspace admin.

     Email: Railway blocks SMTP below the Pro plan, so fill in the Mailgun
     variables. Source and docs: https://github.com/ophydami/docustamp
     ```

The template page then shows the "Deploy on Railway" button link for the README.
