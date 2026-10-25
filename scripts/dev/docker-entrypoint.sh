#!/bin/sh
set -eu
cd /app
expected=$(sha256sum package.json package-lock.json | sha256sum | cut -d ' ' -f 1)
installed=$(cat node_modules/.madhouse-dev-deps 2>/dev/null || true)
if [ "$expected" != "$installed" ]; then
  printf '%s\n' 'Synchronizing Linux dependencies for the current package lock…'
  npm ci --include=dev
  printf '%s\n' "$expected" > node_modules/.madhouse-dev-deps
fi
exec "$@"
