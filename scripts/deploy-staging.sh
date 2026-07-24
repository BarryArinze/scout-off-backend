#!/usr/bin/env bash
# Deploy ScoutOff backend on the staging server.
# Invoked remotely by .github/workflows/deploy-staging.yml after the release
# tarball is uploaded and extracted.
#
# Dependency/build ordering rationale:
#   1. npm ci (full install, devDependencies included) — typescript lives under
#      devDependencies so it must be present for `npm run build` to succeed.
#   2. npm run build — compiles TypeScript to dist/ using the tsc binary that
#      was just installed.
#   3. npm prune --omit=dev — strips devDependencies from node_modules so the
#      running process only loads production packages.
#
# This ordering avoids the failure mode where --omit=dev is passed to npm ci
# before the build step, leaving tsc unavailable when it is needed.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

echo "Installing all dependencies (including devDependencies for build)..."
npm ci

echo "Building TypeScript..."
npm run build

echo "Pruning devDependencies..."
npm prune --omit=dev

echo "Restarting application..."
if systemctl list-units --full -all 2>/dev/null | grep -Fq 'scout-off-backend.service'; then
  sudo systemctl restart scout-off-backend
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart scout-off-backend 2>/dev/null || pm2 start dist/index.js --name scout-off-backend
else
  echo "No systemd unit or pm2 process found for scout-off-backend"
  exit 1
fi

echo "Staging deploy complete"
