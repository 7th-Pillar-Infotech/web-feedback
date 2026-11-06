#!/usr/bin/env bash
#
# ensure-running.sh — idempotently bring the web-feedback collector up.
#
# Safe to run every time the skill is used:
#   - installs deps on first run (if node_modules is missing)
#   - does nothing if the collector is already healthy
#   - otherwise starts it detached (survives after this script exits)
#
# Env: PORT (default 4765). Logs to collector.log next to this script.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-4765}"
LOG="$DIR/collector.log"
cd "$DIR"

# Already healthy? Nothing to do.
if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "collector already running on http://localhost:${PORT}"
  exit 0
fi

# Install dependencies if any are missing. Checks each one (not just the first)
# so an existing install picks up newly-added deps like the capture engines
# (@zumer/snapdom, html2canvas) on upgrade rather than silently skipping them.
if [ ! -d node_modules/better-sqlite3 ] || [ ! -d node_modules/@zumer/snapdom ] || [ ! -d node_modules/html2canvas ]; then
  echo "installing collector dependencies..."
  npm install --no-audit --no-fund --silent
fi

# Start detached so it keeps running after this script (and the skill turn) ends.
echo "starting collector on http://localhost:${PORT}..."
nohup env PORT="${PORT}" node feedback-server.js >"${LOG}" 2>&1 &
disown || true

# Wait for it to become healthy (polls without foreground sleep).
if curl -sf --retry 30 --retry-delay 1 --retry-connrefused \
     "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "collector is up on http://localhost:${PORT}"
  exit 0
fi

echo "collector failed to start — see ${LOG}" >&2
exit 1
