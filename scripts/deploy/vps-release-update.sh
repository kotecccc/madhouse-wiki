#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT=/opt/madhouse-wiki
readonly REPOSITORY=kotecccc/madhouse-wiki
readonly RELEASE_API="https://api.github.com/repos/${REPOSITORY}/releases/latest"
readonly COMPARE_API="https://api.github.com/repos/${REPOSITORY}/compare"
readonly IMAGE_ARCHIVE=madhouse-wiki-image.tar.gz
readonly CHECKSUM_FILE="${IMAGE_ARCHIVE}.sha256"
readonly COMPOSE_FILE="${ROOT}/vps-compose.yml"
readonly BRIDGE_COMPOSE_FILE="${ROOT}/vps-bridge-compose.yml"
readonly BRIDGE_ENABLED_MARKER="${ROOT}/bridge-enabled"
readonly RELEASE_ENV="${ROOT}/release.env"
readonly PREVIOUS_RELEASE_ENV="${ROOT}/previous-release.env"
readonly ROLLBACK_FLOOR_ENV="${ROOT}/rollback-floor.env"
readonly BEFORE_DOWNLOAD_KB=$((6 * 1024 * 1024))
readonly BEFORE_LOAD_KB=$((4 * 1024 * 1024))
readonly RESERVE_KB=$((1024 * 1024))

case "${1:-}" in
  ""|--check-space) ;;
  *) echo "Usage: $0 [--check-space]" >&2; exit 2 ;;
esac
if [[ "$#" -gt 1 ]]; then exit 2; fi

# Shared by the timer, manual updates and the space-only maintenance command.
umask 077
exec 9>"${ROOT}/release-update.lock"
if ! flock -n 9; then
  echo "madhouse-wiki updater is already running"
  exit 0
fi

work="$(mktemp -d "/tmp/madhouse-wiki-release.XXXXXXXX")"
probe_name=""
finish() {
  if [[ -n "${probe_name}" ]]; then
    docker container rm "${probe_name}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${work}"
}
trap finish EXIT

read_marker() {
  local path="$1" key="$2" value="" contents
  if [[ -f "${path}" ]]; then
    contents="$(cat "${path}")" || return 1
    if [[ "${contents}" != "${key}="* ]]; then
      echo "Invalid release retention marker; refusing to update or clean images" >&2
      return 1
    fi
    value="${contents#${key}=}"
    if [[ ! "${value}" =~ ^[a-f0-9]{40}$ ]]; then
      if [[ -n "${value}" || "${key}" != MADHOUSE_PREVIOUS_RELEASE_SHA ]]; then
        echo "Invalid release retention marker; refusing to update or clean images" >&2
        return 1
      fi
    fi
  fi
  printf '%s' "${value}"
}
previous_sha="$(read_marker "${RELEASE_ENV}" MADHOUSE_RELEASE_SHA)"
retained_previous_sha="$(read_marker "${PREVIOUS_RELEASE_ENV}" MADHOUSE_PREVIOUS_RELEASE_SHA)"
minimum_safe_sha="$(read_marker "${ROLLBACK_FLOOR_ENV}" MADHOUSE_MINIMUM_SAFE_RELEASE_SHA)"
bridge_enabled=0
compose_files=(--file "${COMPOSE_FILE}")
if [[ -e "${BRIDGE_ENABLED_MARKER}" ]]; then
  if [[ ! -f "${BRIDGE_ENABLED_MARKER}" || "$(cat "${BRIDGE_ENABLED_MARKER}")" != "enabled" || -z "${minimum_safe_sha}" || ! -f "${BRIDGE_COMPOSE_FILE}" || ! -f "${ROOT}/bridge.env" ]]; then
    echo "Bridge configuration or rollback floor is missing; refusing update" >&2
    exit 1
  fi
  bridge_enabled=1
  compose_files+=(--file "${BRIDGE_COMPOSE_FILE}")
fi
protected_release_sha="${previous_sha}"
protected_previous_sha="${retained_previous_sha}"
retention_known=0
if [[ -f "${PREVIOUS_RELEASE_ENV}" ]]; then retention_known=1; fi
initial_retention_known="${retention_known}"
candidate_sha=""

# Once route-aware state exists, never install or automatically roll back to a
# revision that can ignore it. Failure to establish ancestry is a hard stop.
at_or_above_rollback_floor() {
  local sha="$1" comparison_file="${work}/rollback-floor-comparison.json" ahead
  if [[ -z "${minimum_safe_sha}" || "${sha}" == "${minimum_safe_sha}" ]]; then return 0; fi
  # Page two omits GitHub's potentially very large changed-file patches. The
  # comparison metadata still establishes the merge base and commit count.
  curl --fail --silent --show-error --location --max-time 30 --max-filesize 1000000 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "${COMPARE_API}/${minimum_safe_sha}...${sha}?per_page=1&page=2" --output "${comparison_file}" || return 1
  ahead="$(python3 - "${comparison_file}" "${minimum_safe_sha}" "${sha}" <<'PYCODE'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    comparison = json.load(source)
if not isinstance(comparison, dict):
    raise SystemExit("invalid release ancestry")
base = comparison.get("base_commit")
merge_base = comparison.get("merge_base_commit")
commits = comparison.get("commits")
total = comparison.get("total_commits")
if (not isinstance(base, dict) or base.get("sha") != sys.argv[2]
    or not isinstance(merge_base, dict) or merge_base.get("sha") != sys.argv[2]
    or comparison.get("status") != "ahead" or type(comparison.get("ahead_by")) is not int
    or comparison["ahead_by"] < 1 or type(total) is not int
    or total != comparison["ahead_by"] or not isinstance(commits, list) or len(commits) > 1
    or type(comparison.get("behind_by")) is not int
    or comparison["behind_by"] != 0):
    raise SystemExit("release is below or unrelated to the rollback floor")
print(total)
PYCODE
  )" || return 1
  if [[ "${ahead}" -eq 1 ]]; then
    # Avoid page one (which includes patches) even for a single commit.
    curl --fail --silent --show-error --location --max-time 30 --max-filesize 1000000 \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      "https://api.github.com/repos/${REPOSITORY}/git/commits/${sha}" --output "${comparison_file}" || return 1
    python3 - "${comparison_file}" "${minimum_safe_sha}" "${sha}" <<'PYCODE'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source: commit = json.load(source)
if (not isinstance(commit, dict) or commit.get("sha") != sys.argv[3]
    or not isinstance(commit.get("parents"), list)
    or not any(isinstance(parent, dict) and parent.get("sha") == sys.argv[2] for parent in commit["parents"])):
    raise SystemExit("release ancestry could not be verified")
PYCODE
  else
    curl --fail --silent --show-error --location --max-time 30 --max-filesize 1000000 \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      "${COMPARE_API}/${minimum_safe_sha}...${sha}?per_page=1&page=${ahead}" --output "${comparison_file}" || return 1
    python3 - "${comparison_file}" "${minimum_safe_sha}" "${sha}" "${ahead}" <<'PYCODE'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source: comparison = json.load(source)
commits = comparison.get("commits") if isinstance(comparison, dict) else None
if (not isinstance(comparison, dict) or comparison.get("base_commit", {}).get("sha") != sys.argv[2]
    or comparison.get("merge_base_commit", {}).get("sha") != sys.argv[2]
    or comparison.get("status") != "ahead" or type(comparison.get("ahead_by")) is not int
    or comparison.get("ahead_by") != int(sys.argv[4]) or type(comparison.get("total_commits")) is not int
    or comparison.get("total_commits") != int(sys.argv[4]) or type(comparison.get("behind_by")) is not int
    or comparison.get("behind_by") != 0
    or not isinstance(commits, list) or len(commits) != 1 or not isinstance(commits[0], dict)
    or commits[0].get("sha") != sys.argv[3]):
    raise SystemExit("release ancestry could not be verified")
PYCODE
  fi
}

cleanup_old_images() {
  # A legacy installation has no trustworthy previous-release pointer. Do not
  # guess it from image timestamps or delete anything until it is initialized.
  if [[ "${retention_known}" -ne 1 ]]; then
    echo "Wiki image cleanup skipped: previous release is not recorded" >&2
    return 0
  fi
  docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' > "${work}/images" || return 1
  docker container ls --all --quiet > "${work}/containers" || return 1
  : > "${work}/protected-images" || return 1
  local sha tag image_id container_id found
  for sha in "${protected_release_sha}" "${protected_previous_sha}"; do
    if [[ -n "${sha}" ]]; then
      image_id="$(docker image inspect --format '{{.Id}}' "madhouse-wiki:vps-${sha}")" || return 1
      if [[ ! "${image_id}" =~ ^sha256:[a-f0-9]{64}$ ]]; then return 1; fi
      printf '%s\n' "${image_id}" >> "${work}/protected-images" || return 1
    fi
  done
  while IFS= read -r container_id; do
    if [[ -n "${container_id}" ]]; then
      image_id="$(docker container inspect --format '{{.Image}}' "${container_id}")" || return 1
      if [[ ! "${image_id}" =~ ^sha256:[a-f0-9]{64}$ ]]; then return 1; fi
      printf '%s\n' "${image_id}" >> "${work}/protected-images" || return 1
    fi
  done < "${work}/containers"
  while read -r tag image_id; do
    if [[ ! "${tag}" =~ ^madhouse-wiki:vps-[a-f0-9]{40}$ ]]; then continue; fi
    if [[ ! "${image_id}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Invalid Docker image inventory; cleanup aborted" >&2
      return 1
    fi
    sha="${tag#madhouse-wiki:vps-}"
    if [[ "${sha}" == "${protected_release_sha}" || "${sha}" == "${protected_previous_sha}" || "${sha}" == "${candidate_sha}" ]]; then continue; fi
    if grep -Fxq "${image_id}" "${work}/protected-images"; then
      continue
    else
      found="$?"
      if [[ "${found}" -ne 1 ]]; then return 1; fi
    fi
    # Never force removal: Docker also checks references added after inventory.
    docker image rm "${tag}" || return 1
  done < "${work}/images"
}

prepare_space_paths() {
  local docker_root
  docker_root="$(docker info --format '{{.DockerRootDir}}')" || return 1
  if [[ "${docker_root}" != /* || ! -d "${docker_root}" ]]; then
    echo "Cannot determine Docker data filesystem" >&2
    return 1
  fi
  space_paths=("${work}" "${ROOT}" "${docker_root}")
  # This VPS uses the containerd image store, separate from DockerRootDir.
  if [[ -d /var/lib/containerd ]]; then space_paths+=(/var/lib/containerd); fi
}

minimum_free_kb() {
  local path available minimum=""
  for path in "${space_paths[@]}"; do
    available="$(df -Pk "${path}" | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $4 }')" || return 1
    if [[ ! "${available}" =~ ^[0-9]+$ ]]; then
      echo "Cannot determine free disk space; refusing to update" >&2
      return 1
    fi
    if [[ -z "${minimum}" || "${available}" -lt "${minimum}" ]]; then minimum="${available}"; fi
  done
  printf '%s' "${minimum}"
}

require_free_space() {
  local required="$1" available
  available="$(minimum_free_kb)" || return 1
  if [[ "${available}" -lt "${required}" ]]; then
    cleanup_old_images || return 1
    available="$(minimum_free_kb)" || return 1
  fi
  if [[ "${available}" -lt "${required}" ]]; then
    echo "Insufficient disk space: need ${required} KiB, available ${available} KiB; running release unchanged" >&2
    return 1
  fi
  echo "Disk space check passed: ${available} KiB available (required ${required} KiB)"
}

if [[ "${1:-}" == --check-space ]]; then
  prepare_space_paths
  require_free_space "${BEFORE_DOWNLOAD_KB}"
  exit 0
fi

curl --fail --silent --show-error --location \
  --max-time 30 \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "${RELEASE_API}" --output "${work}/release.json"

python3 - "${work}/release.json" > "${work}/release-info" <<'PY'
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

release_info=()
while IFS= read -r line; do
  release_info+=("${line}")
done < "${work}/release-info"

if [[ "${#release_info[@]}" -ne 3 ]]; then
  echo "GitHub release metadata did not contain the expected assets" >&2
  exit 1
fi
archive_url="${release_info[0]}"
checksum_url="${release_info[1]}"
candidate_sha="${release_info[2]}"
image_tag="madhouse-wiki:vps-${candidate_sha}"

# No transition is needed; avoid repeated ancestry API calls on every poll.
if [[ "${candidate_sha}" == "${previous_sha}" ]]; then
  exit 0
fi

if [[ -n "${minimum_safe_sha}" ]]; then
  if [[ -z "${previous_sha}" ]] || ! at_or_above_rollback_floor "${previous_sha}"; then
    echo "Current release is not verified above the rollback floor; refusing update" >&2
    exit 1
  fi
  if ! at_or_above_rollback_floor "${candidate_sha}"; then
    echo "Candidate is not verified above the rollback floor; refusing update" >&2
    exit 1
  fi
fi

prepare_space_paths
require_free_space "${BEFORE_DOWNLOAD_KB}"

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

require_free_space "${BEFORE_LOAD_KB}"
docker load --input "${work}/${IMAGE_ARCHIVE}"
docker image inspect "${image_tag}" >/dev/null
require_free_space "${RESERVE_KB}"
# Never start it: creating a container verifies that the image actually unpacks,
# even when Docker load printed an unpack error but returned success.
probe_name="madhouse-wiki-image-check-${candidate_sha:0:12}-$$"
docker create --pull=never --name "${probe_name}" --network none --entrypoint /bin/true "${image_tag}" >/dev/null
docker container rm "${probe_name}" >/dev/null
probe_name=""
rm -f -- "${work}/${IMAGE_ARCHIVE}"
require_free_space "${RESERVE_KB}"

compose() {
  docker compose \
    --project-name madhouse-wiki \
    "${compose_files[@]}" \
    --env-file "${RELEASE_ENV}" \
    "$@"
}

verify_bridge_configuration() {
  if [[ "${bridge_enabled}" -eq 1 ]]; then
    [[ -f "${BRIDGE_ENABLED_MARKER}" && "$(cat "${BRIDGE_ENABLED_MARKER}")" == "enabled" && -f "${BRIDGE_COMPOSE_FILE}" && -f "${ROOT}/bridge.env" ]]
  else
    [[ ! -e "${BRIDGE_ENABLED_MARKER}" ]]
  fi
}

stop_wiki_and_wait_for_lease() {
  # docker compose stop returns only after the old process has stopped. Its
  # durable worker lease may still live for 15 seconds; never delete it or
  # start the candidate/rollback worker until that window has elapsed.
  if [[ -f "${RELEASE_ENV}" ]]; then
    if [[ "${bridge_enabled}" -eq 1 ]]; then
      compose stop connector wiki
    else
      compose stop wiki
    fi
  else
    # First deployment has no release marker yet. Supply only the image SHA
    # needed to resolve Compose and stop any existing Wiki container safely.
    MADHOUSE_RELEASE_SHA="${candidate_sha}" docker compose \
      --project-name madhouse-wiki \
      "${compose_files[@]}" \
      --env-file /dev/null \
      stop wiki
  fi
  sleep 16
}

write_release_env() {
  local sha="$1"
  local temporary="${RELEASE_ENV}.new"
  printf 'MADHOUSE_RELEASE_SHA=%s\n' "${sha}" > "${temporary}"
  chmod 0640 "${temporary}"
  mv -f -- "${temporary}" "${RELEASE_ENV}"
}

write_previous_release_env() {
  local sha="$1" temporary="${PREVIOUS_RELEASE_ENV}.new"
  printf 'MADHOUSE_PREVIOUS_RELEASE_SHA=%s\n' "${sha}" > "${temporary}"
  chmod 0640 "${temporary}"
  mv -f -- "${temporary}" "${PREVIOUS_RELEASE_ENV}"
}

restore_previous_release_env() {
  if [[ "${initial_retention_known}" -eq 1 ]]; then
    write_previous_release_env "${retained_previous_sha}"
  else
    rm -f -- "${PREVIOUS_RELEASE_ENV}"
  fi
}

current_floor="$(read_marker "${ROLLBACK_FLOOR_ENV}" MADHOUSE_MINIMUM_SAFE_RELEASE_SHA)" || { echo "Invalid rollback floor; refusing update" >&2; exit 1; }
if [[ "${current_floor}" != "${minimum_safe_sha}" ]]; then
  echo "Rollback floor changed during update; refusing to stop Wiki" >&2
  exit 1
fi
verify_bridge_configuration || { echo "Bridge configuration changed during update; refusing to stop services" >&2; exit 1; }
stop_wiki_and_wait_for_lease
# Persist the rollback pointer before publishing the candidate marker, so a
# process interruption cannot leave the prior current image unprotected.
write_previous_release_env "${previous_sha}"
write_release_env "${candidate_sha}"
if compose up --detach --wait --wait-timeout 120; then
  echo "madhouse-wiki release activated: ${candidate_sha}"
  if ! compose exec --no-TTY wiki node scripts/deploy/release-notification.mjs; then
    echo "Release is healthy; administrator notification requires attention" >&2
  fi
  protected_release_sha="${candidate_sha}"
  protected_previous_sha="${previous_sha}"
  retention_known=1
  # Cleanup failure cannot turn a healthy activation into a destructive rollback.
  if ! cleanup_old_images; then
    echo "Release is healthy; old Wiki image cleanup requires attention" >&2
  fi
  exit 0
fi

echo "madhouse-wiki release failed health checks: ${candidate_sha}" >&2
if [[ -n "${previous_sha}" ]]; then
  current_floor="$(read_marker "${ROLLBACK_FLOOR_ENV}" MADHOUSE_MINIMUM_SAFE_RELEASE_SHA)" || { echo "Invalid rollback floor; refusing rollback" >&2; exit 1; }
  if [[ "${current_floor}" != "${minimum_safe_sha}" ]] || ! at_or_above_rollback_floor "${previous_sha}"; then
    echo "Rollback floor changed or previous release is unsafe; operator attention required" >&2
    exit 1
  fi
  verify_bridge_configuration || { echo "Bridge configuration changed; refusing rollback" >&2; exit 1; }
  stop_wiki_and_wait_for_lease
  write_release_env "${previous_sha}"
  restore_previous_release_env
  if compose up --detach --wait --wait-timeout 120; then
    echo "madhouse-wiki rolled back to ${previous_sha}" >&2
  else
    echo "madhouse-wiki rollback requires operator attention" >&2
  fi
else
  rm -f -- "${RELEASE_ENV}"
  restore_previous_release_env
fi
exit 1
