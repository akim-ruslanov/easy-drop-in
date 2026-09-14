#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Installing frontend dependencies…"
  (cd "$ROOT/frontend" && npm install)
fi

echo "Backend  → http://localhost:8787"
echo "Frontend → http://localhost:5173"
echo

( cd "$ROOT/backend" && exec node server.mjs ) &
BACKEND_PID=$!
( cd "$ROOT/frontend" && exec node node_modules/vite/bin/vite.js ) &
FRONTEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

wait
