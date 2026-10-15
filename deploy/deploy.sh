#!/usr/bin/env bash
# Start or update the site. Run it from anywhere:
#     bash deploy/deploy.sh
# First run: asks for your domain and Cloudflare tunnel token and saves them in .env.
# Later runs: downloads your latest code from GitHub, rebuilds with fresh security fixes, restarts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't ready. Run 'sudo bash deploy/server-setup.sh' first, then log out and back in."
  exit 1
fi

if [ ! -f .env ]; then
  echo "First run: two questions."
  read -rp "Your domain (like filedost.in, no https:// or www): " DOMAIN
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#www.}"; DOMAIN="${DOMAIN%/}"
  read -rp "Cloudflare tunnel token (the long code after --token): " TUNNEL_TOKEN
  TUNNEL_TOKEN="${TUNNEL_TOKEN##* }"
  umask 077
  printf 'DOMAIN=%s\nTUNNEL_TOKEN=%s\n' "$DOMAIN" "$TUNNEL_TOKEN" > .env
  echo "Saved in $APP_DIR/.env (keep it private)."
fi

if grep -q REPLACE_ME .env; then
  echo ".env still has REPLACE_ME in it. Edit it with:  nano $APP_DIR/.env"
  exit 1
fi

cp deploy/docker-compose.override.yml docker-compose.override.yml

if [ -d .git ]; then
  echo "==> Getting the latest code from GitHub"
  git pull --ff-only
fi

echo "==> Building (the first build takes 10 to 20 minutes)"
docker compose build --pull
docker compose up -d --remove-orphans

echo "==> Waiting for the app to answer"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo
    echo "The app is running."
    DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
    echo "Open https://$DOMAIN in your browser."
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 3
done

echo "The app didn't start. Last lines of its log:"
docker compose logs --tail 60 app
exit 1
