# DocuStamp in one image: the web app and the server.
#
# Stage 1 builds apps/web into static files. Stage 2 is the server (Node.js,
# LibreOffice for Word to PDF) with those files in ./web, which the server serves
# next to the API on one port (apps/server/cloud/lib/webApp.js). Run it with a
# MongoDB and the settings from .env.example; see the README.

# --- web app -------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
# Build-time settings of the web app. VITE_APPID must match the server's
# APP_ID; empty values fall back to the app's defaults.
ARG VITE_APPID=docustamp
ARG VITE_GOOGLE_CLIENT_ID=
ARG VITE_SOURCE_URL=
ENV VITE_APPID=$VITE_APPID \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID \
    VITE_SOURCE_URL=$VITE_SOURCE_URL
RUN npm run build

# --- server --------------------------------------------------------------------
# Node.js 24 LTS on Debian bookworm. The major-only tag picks up Node security
# releases on every build; Parse Server 8 supports Node 20, 22 and 24.
FROM node:24-bookworm

# LibreOffice converts uploaded Word files to PDF.
RUN apt-get update \
  && apt-get install -y libreoffice \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Dependencies first, so a code change does not reinstall them. npm ci installs
# exactly what package-lock.json pins, without the dev tools.
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY apps/server/ ./
COPY --from=web /web/dist ./web

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

# Parse Server's own health route, over loopback so the boot gate lets it through.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+(process.env.PARSE_MOUNT||'/app')+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node directly rather than npm start, so stop signals reach the server.
CMD ["node", "index.js"]
