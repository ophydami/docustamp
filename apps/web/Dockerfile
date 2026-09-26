# Build the static app, then serve it with Caddy on :3000 (same port the
# old client used, so the front Caddyfile's `reverse_proxy client:3000` stays).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Parse application id; docker-compose.yml passes the server's APP_ID.
ARG VITE_APPID=docustamp
ENV VITE_APPID=$VITE_APPID
# Same-origin API: the app calls /api/app, which the front proxy rewrites to the server.
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 3000
