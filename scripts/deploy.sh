#!/bin/bash
# Production deploy (see DEPLOYMENT.md §9). Copy to ~/deploy.sh on the server:
#   cp ~/SaasCRM/scripts/deploy.sh ~/deploy.sh && chmod +x ~/deploy.sh
#
# Fast by design:
#   - builds only transpile (esbuild / vite); type-check with `npm run typecheck` before pushing
#   - `npm ci` runs only when package-lock.json changed
#   - backend / frontend are skipped when nothing in them changed
# FORCE=1 ~/deploy.sh rebuilds and reinstalls everything.
set -euo pipefail
export NODE_OPTIONS=--max-old-space-size=1536

APP_DIR=~/SaasCRM
WEB_ROOT=/var/www/zeta-app
# Last commit that deployed successfully: a failed deploy is retried in full next time.
DEPLOYED_FILE=~/.zeta-deployed-commit
started=$(date +%s)

echo "Deploy started..."
cd "$APP_DIR"
git pull --ff-only origin main
after=$(git rev-parse HEAD)
before=$(cat "$DEPLOYED_FILE" 2>/dev/null || true)
if [ -z "$before" ] || ! git cat-file -e "$before^{commit}" 2>/dev/null; then
  echo "No previous deploy recorded: building everything"
  FORCE=1
fi
echo "Deploying ${before:0:7} -> ${after:0:7}"

# changed <path>: true if <path> changed since the last successful deploy (always with FORCE=1).
changed() {
  [ "${FORCE:-0}" = "1" ] && return 0
  ! git diff --quiet "$before" "$after" -- "$1"
}

# install_deps: npm ci only when the lockfile differs from the last install here.
install_deps() {
  local stamp=node_modules/.deploy-lock-hash
  local hash
  hash=$(sha256sum package-lock.json | cut -d' ' -f1)
  if [ "${FORCE:-0}" != "1" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$hash" ]; then
    echo "  dependencies unchanged, skipping npm ci"
  else
    npm ci --no-audit --no-fund
    mkdir -p node_modules
    echo "$hash" > "$stamp"
  fi
}

if changed backend; then
  echo "== Backend"
  cd "$APP_DIR/backend"
  install_deps
  npm run build
  pm2 restart zeta-api zeta-worker --update-env
else
  echo "== Backend unchanged, skipped"
fi

if changed frontend; then
  echo "== Frontend"
  cd "$APP_DIR/frontend"
  install_deps
  npm run build
  # rsync swaps files in place (no moment where the site is empty).
  if command -v rsync >/dev/null; then
    sudo rsync -a --delete dist/ "$WEB_ROOT"/
  else
    sudo rm -rf "$WEB_ROOT"/*
    sudo cp -r dist/* "$WEB_ROOT"/
  fi
else
  echo "== Frontend unchanged, skipped"
fi

echo "$after" > "$DEPLOYED_FILE"
echo "Deploy finished in $(( $(date +%s) - started ))s"
