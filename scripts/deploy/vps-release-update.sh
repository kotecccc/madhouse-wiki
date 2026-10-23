#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT=/opt/madhouse-wiki
readonly REPOSITORY=kotecccc/madhouse-wiki
readonly RELEASE_API="https://api.github.com/repos/${REPOSITORY}/releases/latest"
readonly IMAGE_ARCHIVE=madhouse-wiki-image.tar.gz
readonly CHECKSUM_FILE="${IMAGE_ARCHIVE}.sha256"
readonly COMPOSE_FILE="${ROOT}/vps-compose.yml"
readonly RELEASE_ENV="${ROOT}/release.env"

umask 077
work="$(mktemp -d "/tmp/madhouse-wiki-release.XXXXXXXX")"
trap 'rm -rf -- "${work}"' EXIT

curl --fail --silent --show-error --location \
  --max-time 30 \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "${RELEASE_API}" --output "${work}/release.json"

readarray -t release_info < <(python3 - "${work}/release.json" <<'PY'
import json
import re
import sys
from urllib.parse import urlparse

with open(sys.argv[1], encoding="utf-8") as source:
    release = json.load(source)
tag = release.get("tag_name", "")
match = re.fullmatch(r"vps-([a-f0-9]{40})", tag)
if not match or release.get("draft") or release.get("prerelease"):
    raise SystemExit("latest GitHub release is not a stable VPS release")
assets = {item.get("name"): item.get("browser_download_url", "") for item in release.get("assets", [])}
for name in ("madhouse-wiki-image.tar.gz", "madhouse-wiki-image.tar.gz.sha256"):
    url = assets.get(name, "")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "github.com":
        raise SystemExit("VPS release is missing a valid public GitHub asset")
    print(url)
print(match.group(1))
PY
)

if [[ "${#release_info[@]}" -ne 3 ]]; then
  echo "GitHub release metadata did not contain the expected assets" >&2
  exit 1
fi
archive_url="${release_info[0]}"
checksum_url="${release_info[1]}"
candidate_sha="${release_info[2]}"
image_tag="madhouse-wiki:vps-${candidate_sha}"

if [[ -f "${RELEASE_ENV}" ]]; then
  previous_sha="$(sed -n 's/^MADHOUSE_RELEASE_SHA=//p' "${RELEASE_ENV}")"
else
  previous_sha=""
fi
if [[ -n "${previous_sha}" && ! "${previous_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Current release marker is invalid; refusing to update" >&2
  exit 1
fi
if [[ "${candidate_sha}" == "${previous_sha}" ]]; then
  exit 0
fi

curl --fail --silent --show-error --location --max-time 900 \
  --max-filesize 2000000000 "${archive_url}" \
  --output "${work}/${IMAGE_ARCHIVE}"
curl --fail --silent --show-error --location --max-time 30 \
  "${checksum_url}" --output "${work}/${CHECKSUM_FILE}"
if ! grep -Eq '^[a-f0-9]{64}  madhouse-wiki-image\.tar\.gz$' "${work}/${CHECKSUM_FILE}"; then
  echo "GitHub release checksum has an invalid format" >&2
  exit 1
fi
(
  cd "${work}"
  sha256sum --check --status "${CHECKSUM_FILE}"
)

docker load --input "${work}/${IMAGE_ARCHIVE}"
docker image inspect "${image_tag}" >/dev/null

compose() {
  docker compose \
    --project-name madhouse-wiki \
    --file "${COMPOSE_FILE}" \
    --env-file "${RELEASE_ENV}" \
    "$@"
}

write_release_env() {
  local sha="$1"
  local temporary="${RELEASE_ENV}.new"
  printf 'MADHOUSE_RELEASE_SHA=%s\n' "${sha}" > "${temporary}"
  chmod 0640 "${temporary}"
  mv -f -- "${temporary}" "${RELEASE_ENV}"
}

write_release_env "${candidate_sha}"
if compose up --detach --wait --wait-timeout 120; then
  echo "madhouse-wiki release activated: ${candidate_sha}"
  exit 0
fi

echo "madhouse-wiki release failed health checks: ${candidate_sha}" >&2
if [[ -n "${previous_sha}" ]]; then
  write_release_env "${previous_sha}"
  if compose up --detach --wait --wait-timeout 120; then
    echo "madhouse-wiki rolled back to ${previous_sha}" >&2
  else
    echo "madhouse-wiki rollback requires operator attention" >&2
  fi
else
  rm -f -- "${RELEASE_ENV}"
fi
exit 1
