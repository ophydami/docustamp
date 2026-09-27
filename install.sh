#!/usr/bin/env bash
# DocuStamp installer: runs DocuStamp, MongoDB and Caddy (automatic HTTPS) with
# Docker on a Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/ophydami/docustamp/main/install.sh | sudo bash
#
# It asks for your domain and email settings, creates the secrets, downloads the
# release's files into /opt/docustamp, starts everything and adds a `docustamp`
# command (status, logs, update, backup, restore). Running it again keeps your
# settings and secrets and brings the files and the image up to date.
#
# Unattended installs set the answers as environment variables:
#   DOCUSTAMP_YES=1        never ask; fail if something required is missing
#   DOCUSTAMP_DOMAIN       the address people will use, e.g. sign.example.com
#   DOCUSTAMP_TLS          on (default), or off for plain http (local tests only)
#   DOCUSTAMP_EMAIL        smtp, mailgun or none
#   SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASS SMTP_USER_EMAIL   for smtp
#   MAILGUN_API_KEY MAILGUN_DOMAIN MAILGUN_SENDER                 for mailgun
#   DOCUSTAMP_DIR          install folder (default /opt/docustamp)
#   DOCUSTAMP_VERSION      release to install, e.g. 0.1.2 (default: the latest)
#   DOCUSTAMP_FILES_DIR    take the files from this checkout instead of GitHub
set -euo pipefail

REPO="ophydami/docustamp"
DIR="${DOCUSTAMP_DIR:-/opt/docustamp}"
BIN="/usr/local/bin/docustamp"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

# Prompts read the terminal even when the script itself arrives through a pipe.
TTY=""
if [ -z "${DOCUSTAMP_YES:-}" ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask VAR "Question" [default]: keeps VAR when it is already set.
ask() {
  local var=$1 question=$2 default=${3:-} answer
  if [ -n "${!var:-}" ]; then return; fi
  if [ -z "$TTY" ]; then
    [ -n "$default" ] || die "$var is required when running unattended."
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then question="$question [$default]"; fi
  read -r -p "$question: " answer <"$TTY"
  printf -v "$var" '%s' "${answer:-$default}"
}

ask_secret() {
  local var=$1 question=$2 answer
  if [ -n "${!var:-}" ]; then return; fi
  [ -n "$TTY" ] || die "$var is required when running unattended."
  read -r -s -p "$question: " answer <"$TTY"
  echo
  printf -v "$var" '%s' "$answer"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# An env-file line that docker compose reads back exactly as written.
env_line() {
  local key=$1 value=$2
  if [[ "$value" != *"'"* ]]; then
    printf "%s='%s'\n" "$key" "$value"
  else
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//\$/\\\$}
    printf '%s="%s"\n' "$key" "$value"
  fi
}

fetch() { # fetch <path in the repo> <destination>
  local path=$1 dest=$2
  if [ -n "${DOCUSTAMP_FILES_DIR:-}" ]; then
    cp "$DOCUSTAMP_FILES_DIR/$path" "$dest"
  else
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/$path" -o "$dest" ||
      curl -fsSL "https://raw.githubusercontent.com/$REPO/main/$path" -o "$dest"
  fi
}

# --- checks ------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Run the installer as root, e.g. with sudo."
[ "$(uname -s)" = "Linux" ] || die "DocuStamp installs on Linux servers."
case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "Unsupported processor: $(uname -m). DocuStamp images exist for x86_64 and arm64." ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (https://get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Install the docker-compose-plugin package."

# --- version -----------------------------------------------------------------
VERSION="${DOCUSTAMP_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$VERSION" ] || die "Could not look up the latest DocuStamp release."
fi
VERSION=${VERSION#v}
if [ "$VERSION" = "main" ]; then REF=main; else REF="v$VERSION"; fi

mkdir -p "$DIR"
cd "$DIR"

# --- settings (first install only) -----------------------------------------
if [ -f .env.prod ]; then
  say "Existing install found in $DIR: keeping its settings and secrets."
  HOST_URL=$(sed -n "s/^HOST_URL=['\"]\{0,1\}\([^'\"]*\).*/\1/p" .env | head -n1)
  [ -n "$HOST_URL" ] || die "$DIR/.env has no HOST_URL."
else
  echo
  echo "DocuStamp needs a domain (or subdomain) pointing at this server, for example"
  echo "sign.example.com. HTTPS certificates are issued for it automatically."
  ask DOCUSTAMP_DOMAIN "Domain"
  DOMAIN=${DOCUSTAMP_DOMAIN#http://}
  DOMAIN=${DOMAIN#https://}
  DOMAIN=${DOMAIN%%/*}
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "\"$DOMAIN\" is not a domain name."

  if [ "${DOCUSTAMP_TLS:-on}" = "off" ]; then
    HOST_URL="http://$DOMAIN"
  else
    HOST_URL="https://$DOMAIN"
    PUBLIC_IP=$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
    RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
    if [ -z "$RESOLVED" ]; then
      warn "$DOMAIN does not resolve yet. Point an A record at ${PUBLIC_IP:-this server} before opening it; HTTPS starts working once it does."
    elif [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
      warn "$DOMAIN points at $RESOLVED, but this server's address is $PUBLIC_IP. HTTPS will not work until the A record points here."
    fi
  fi

  echo
  echo "Signing requests, reminders and password resets are sent by email."
  echo "  smtp     any mail service with SMTP (Amazon SES, Postmark, Mailgun, ...)"
  echo "  mailgun  Mailgun's API"
  echo "  none     set it up later in $DIR/.env.prod"
  ask DOCUSTAMP_EMAIL "Email (smtp, mailgun or none)" none
  case "$DOCUSTAMP_EMAIL" in
    smtp)
      ask SMTP_HOST "SMTP host"
      ask SMTP_PORT "SMTP port" 587
      ask SMTP_USER_EMAIL "From address (e.g. no-reply@$DOMAIN)"
      ask SMTP_USERNAME "SMTP username" "$SMTP_USER_EMAIL"
      ask_secret SMTP_PASS "SMTP password"
      ;;
    mailgun)
      ask_secret MAILGUN_API_KEY "Mailgun API key"
      ask MAILGUN_DOMAIN "Mailgun sending domain"
      ask MAILGUN_SENDER "From address (e.g. no-reply@$DOMAIN)"
      ;;
    none) ;;
    *) die "Email must be smtp, mailgun or none." ;;
  esac

  say "Writing settings and new secrets to $DIR/.env.prod"
  umask 077
  {
    echo "# DocuStamp settings, written by install.sh on $(date -u +%Y-%m-%d)."
    echo "# Every option is described in https://github.com/$REPO/blob/main/.env.example"
    echo "# PUBLIC_URL and SERVER_URL come from HOST_URL in .env."
    env_line MASTER_KEY "$(random_secret)"
    env_line FILE_TOKEN_SECRET "$(random_secret)"
    env_line SIGNING_LINK_SECRET "$(random_secret)"
    env_line ACCOUNT_DELETION_SECRET "$(random_secret)"
    env_line MASTER_KEY_IPS "127.0.0.1,::1"
    env_line MONGODB_URI "mongodb://mongo:27017/docustamp"
    env_line USE_LOCAL "true"
    env_line TRUST_PROXY "1"
    env_line APP_NAME "DocuStamp"
    env_line GOOGLE_CLIENT_ID ""
    if [ "$DOCUSTAMP_EMAIL" = "smtp" ]; then
      env_line SMTP_ENABLE "true"
      env_line SMTP_HOST "$SMTP_HOST"
      env_line SMTP_PORT "$SMTP_PORT"
      env_line SMTP_USERNAME "$SMTP_USERNAME"
      env_line SMTP_PASS "$SMTP_PASS"
      env_line SMTP_USER_EMAIL "$SMTP_USER_EMAIL"
    elif [ "$DOCUSTAMP_EMAIL" = "mailgun" ]; then
      env_line MAILGUN_API_KEY "$MAILGUN_API_KEY"
      env_line MAILGUN_DOMAIN "$MAILGUN_DOMAIN"
      env_line MAILGUN_SENDER "$MAILGUN_SENDER"
    fi
  } >.env.prod
  umask 022
fi

# --- files -------------------------------------------------------------------
say "Downloading DocuStamp $VERSION"
fetch docker-compose.yml docker-compose.yml
fetch Caddyfile Caddyfile
fetch scripts/docustamp "$BIN"
chmod 755 "$BIN"
if [ "$DIR" != "/opt/docustamp" ]; then
  sed -i "s|^DIR=\"\${DOCUSTAMP_DIR:-/opt/docustamp}\"|DIR=\"\${DOCUSTAMP_DIR:-$DIR}\"|" "$BIN"
fi

{
  env_line COMPOSE_PROJECT_NAME docustamp
  env_line HOST_URL "$HOST_URL"
  env_line DOCUSTAMP_VERSION "$VERSION"
} >.env
chmod 600 .env .env.prod

# --- server tuning -----------------------------------------------------------
MEM_KB=$(awk '/^MemTotal/ {print $2}' /proc/meminfo)
if [ "${MEM_KB:-0}" -lt 3500000 ] && [ -z "$(swapon --show=NAME --noheadings 2>/dev/null)" ]; then
  say "Adding 2 GB of swap: converting Word files with LibreOffice needs headroom on small servers"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in the firewall"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

# --- start -------------------------------------------------------------------
say "Starting DocuStamp, MongoDB and Caddy"
docker compose pull --quiet
docker compose up -d --remove-orphans

say "Waiting for DocuStamp to be ready (the first start sets up the database)"
for _ in $(seq 1 90); do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/api/app/health >/dev/null 2>&1; then
    echo
    say "DocuStamp is running."
    echo
    echo "  Open $HOST_URL and create the first account: it becomes the workspace admin."
    echo "  Settings: $DIR/.env.prod (then run: docustamp restart)"
    echo "  Commands: docustamp status | logs | update | backup | restore"
    if [ "${DOCUSTAMP_EMAIL:-}" = "none" ]; then
      echo "  Email is not set up yet, so signing requests will not be sent. Add it in .env.prod."
    fi
    exit 0
  fi
  sleep 2
done

docker compose logs --tail=80 app >&2 || true
die "DocuStamp did not become ready in 3 minutes. The logs above show why; run 'docustamp logs' for more."
