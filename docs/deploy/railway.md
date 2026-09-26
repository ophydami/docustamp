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

   `${{MongoDB.MONGO_URL}}` stays exactly as written: Railway fills it in. For
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

You don't need to set `PUBLIC_URL`, `SERVER_URL` or `MONGODB_URI`: the app reads
Railway's domain (`RAILWAY_PUBLIC_DOMAIN`) and MongoDB link (`MONGO_URL`) and
fills them in, using a `docustamp` database.

## A custom domain

Add it under Networking, then set `PUBLIC_URL=https://sign.example.com` on
DocuStamp and redeploy, so links in emails use it.

## Updating

Redeploy the DocuStamp service to pull the newest `latest` image. To stay on a
release, use `ghcr.io/ophydami/docustamp:0.1.0` as the image instead.

## Turning this into a template

These steps are also the recipe for the one-click "Deploy on Railway" template:
in a working project, open Project Settings, choose **Generate Template from
Project**, and check the variables: replace the four random values with
`${{secret(48)}}` so every deploy generates its own, mark the three Mailgun ones
as required and give them descriptions. Publish it, and the template page gives
the button link for the README.
