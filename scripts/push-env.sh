#!/usr/bin/env bash
# Push the environment this app needs from .env into Vercel production.
#
# Values are piped on stdin and never echoed. APP_URL is deliberately excluded:
# it must point at the deployment, not at localhost, so it is set separately
# once the production URL is known.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS=(
  DATABASE_URL
  STRAVA_CLIENT_ID
  STRAVA_CLIENT_SECRET
  ADMIN_TOKEN
  STRAVA_WEBHOOK_VERIFY_TOKEN
  ANTHROPIC_API_KEY
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID
  CRON_SECRET
)

[ -f .env ] || { echo "no .env found"; exit 1; }

for key in "${KEYS[@]}"; do
  value="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')"
  if [ -z "$value" ]; then
    echo "  SKIP  $key (empty in .env)"
    continue
  fi
  # Remove first so re-running is idempotent rather than erroring on conflict.
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" production >/dev/null
  echo "  set   $key"
done

echo
echo "Not set here: APP_URL — run this once the deployment URL is known:"
echo "  vercel env add APP_URL production   # https://<your-app>.vercel.app"
