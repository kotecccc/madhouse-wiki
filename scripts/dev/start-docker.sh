#!/bin/sh
set -eu
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then
    open -gj -a Docker
  fi
  attempts=0
  until docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 90 ]; then
      printf '%s\n' 'Docker did not become available within three minutes.' >&2
      exit 1
    fi
    sleep 2
  done
fi
exec docker compose -f "$root/compose.dev.yml" up -d --wait --wait-timeout 180
