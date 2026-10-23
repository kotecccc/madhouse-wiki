#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root on the Madhouse Wiki VPS" >&2
  exit 1
fi

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly DEPLOY_DIR=/opt/madhouse-wiki
readonly SYSTEMD_DIR=/etc/systemd/system
readonly NGINX_AVAILABLE=/etc/nginx/sites-available

install -d -m 0750 "${DEPLOY_DIR}"
install -m 0644 "${ROOT}/scripts/deploy/vps-compose.yml" "${DEPLOY_DIR}/vps-compose.yml"
install -m 0750 "${ROOT}/scripts/deploy/vps-release-update.sh" "${DEPLOY_DIR}/vps-release-update.sh"
install -m 0644 "${ROOT}/scripts/deploy/nginx-vps.conf" "${NGINX_AVAILABLE}/madhouse-wiki.conf"
install -m 0644 "${ROOT}/scripts/deploy/madhouse-wiki-release.service" "${SYSTEMD_DIR}/madhouse-wiki-release.service"
install -m 0644 "${ROOT}/scripts/deploy/madhouse-wiki-release.timer" "${SYSTEMD_DIR}/madhouse-wiki-release.timer"
install -m 0644 "${ROOT}/scripts/deploy/madhouse-wiki-cleanup.service" "${SYSTEMD_DIR}/madhouse-wiki-cleanup.service"
install -m 0644 "${ROOT}/scripts/deploy/madhouse-wiki-cleanup.timer" "${SYSTEMD_DIR}/madhouse-wiki-cleanup.timer"

if [[ ! -e "${DEPLOY_DIR}/wiki.env" ]]; then
  install -m 0600 "${ROOT}/scripts/deploy/vps-wiki.env.example" "${DEPLOY_DIR}/wiki.env"
fi
if [[ ! -e "${DEPLOY_DIR}/connector.env" ]]; then
  install -m 0600 "${ROOT}/scripts/deploy/vps-connector.env.example" "${DEPLOY_DIR}/connector.env"
fi
if [[ ! -e "${DEPLOY_DIR}/storage.env" ]]; then
  install -m 0600 "${ROOT}/scripts/deploy/vps-storage.env.example" "${DEPLOY_DIR}/storage.env"
fi

systemctl daemon-reload
echo "VPS Wiki runtime files installed; deployment and cleanup timers and Nginx site remain disabled."
