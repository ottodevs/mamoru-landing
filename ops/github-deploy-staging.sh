#!/usr/bin/env bash
# Deploy ottodevs/mamoru-landing `staging` branch to the mamoru-lol-staging
# Worker (wrangler env `staging`). Mirrors ~/.config/mamoru-lol/github-deploy.sh,
# which does the same for `main` → the prod `mamoru-lol` Worker, and is left
# untouched by this script. See ops/README.md to install.
set -euo pipefail

STATE="${MAMORU_LOL_STATE:-$HOME/.local/state/mamoru-lol}"
SRC="$STATE/github-src-staging"
REMOTE="${MAMORU_REMOTE:-git@github.com:ottodevs/mamoru-landing.git}"
LOCK="$STATE/github-deploy-staging.lock"
SECRET_FILE="${STAGING_PROXY_SECRET_FILE:-$HOME/.config/mamoru-lol/staging-proxy-secret}"
mkdir -p "$STATE"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "staging deploy already running"
  exit 0
fi

sha=$(git ls-remote "$REMOTE" refs/heads/staging | awk '{print $1}')
if [ -z "$sha" ]; then
  echo "github staging has no sha" >&2
  exit 1
fi
last=""
if [ -f "$STATE/github-deployed-sha-staging" ]; then
  last=$(cat "$STATE/github-deployed-sha-staging")
fi
if [ "$sha" = "$last" ]; then
  echo "already deployed $sha"
  exit 0
fi

if [ ! -d "$SRC/.git" ]; then
  git clone --branch staging "$REMOTE" "$SRC"
fi
git -C "$SRC" fetch origin staging
git -C "$SRC" checkout --detach "$sha"

cd "$SRC"
name=$(awk -F'"' '/^name[[:space:]]*=/{print $2; exit}' wrangler.toml)
if [ "$name" != "mamoru-lol" ]; then
  echo "refusing deploy: wrangler name is '$name'" >&2
  exit 2
fi

before=$(bunx wrangler deployments list --env staging --json 2>/dev/null | python3 -c '
import json,sys
try:
    rows=json.load(sys.stdin)
    row=max(rows, key=lambda r: r["created_on"])
    print(row["versions"][0]["version_id"])
except Exception:
    pass
' || true)
echo "$before" > "$STATE/last-good-version-staging"
echo "$(date -Is) staging deploy start sha=$sha before=$before" >> "$STATE/deploys-staging.log"

bun install --frozen-lockfile
bun run build
bunx wrangler deploy --env staging \
  --var "GIT_SHA:${sha:0:7}" \
  --var "DEPLOYED_AT:$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ok=0
if [ -f "$SECRET_FILE" ]; then
  secret=$(cat "$SECRET_FILE")
  url=$(awk -F'"' '/STAGING_BASE_URL/{print $2; exit}' wrangler.toml)
  url="${url:-https://mamoru-lol-staging.ottodevs.workers.dev}"
  for _ in 1 2 3 4 5; do
    code=$(curl -sS -o "$STATE/health-staging.html" -w '%{http_code}' --max-time 20 \
      -H "X-Mamoru-Staging-Secret: $secret" "$url/" || true)
    if [ "$code" = "200" ]; then
      ok=1
      break
    fi
    sleep 3
  done
else
  echo "$(date -Is) WARNING: no secret file at $SECRET_FILE, skipping health check" >> "$STATE/deploys-staging.log"
  ok=1
fi

if [ "$ok" != 1 ]; then
  echo "$(date -Is) staging health failed, rolling back to $before" >> "$STATE/deploys-staging.log"
  if [ -n "$before" ]; then
    bunx wrangler rollback "$before" --env staging -y --message "auto: staging health check failed"
  fi
  echo "staging health check failed; rolled back to $before" >&2
  exit 1
fi
printf '%s\n' "$sha" > "$STATE/github-deployed-sha-staging"
echo "$(date -Is) staging deploy ok sha=$sha" >> "$STATE/deploys-staging.log"
echo "staging deploy ok ${sha:0:7}"
