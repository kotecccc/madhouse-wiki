#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run only against an offline, quiescent copy; this script cannot verify that
# the storage service has stopped or that the copy is mutually consistent.
: "${MADHOUSE_STORAGE_BACKUP_ROOT:?set backup root}"
: "${MADHOUSE_STORAGE_BACKUP_RECIPIENT:?set age recipient}"
[[ "${MADHOUSE_STORAGE_OFFLINE_CONFIRMED:-0}" == 1 ]] || { printf '%s\n' 'storage_backup_offline_confirmation_required' >&2; exit 1; }
command -v age >/dev/null || { printf '%s\n' 'storage_backup_age_required' >&2; exit 1; }
root=$MADHOUSE_STORAGE_BACKUP_ROOT
[[ -d "$root/data" && ! -L "$root/data" && -d "$root/backups" && ! -L "$root/backups" ]] || { printf '%s\n' 'storage_backup_directory_invalid' >&2; exit 1; }
archive=$(mktemp "$root/backups/.storage-backup.XXXXXXXX")
cleanup() { rm -f -- "$archive"; }
trap cleanup EXIT
# Never stage an unencrypted archive; pipefail ensures tar and age both succeed.
tar -C "$root" -czf - data | age --encrypt --recipient "$MADHOUSE_STORAGE_BACKUP_RECIPIENT" > "$archive"
[[ -s "$archive" ]] || { printf '%s\n' 'storage_backup_empty' >&2; exit 1; }
final="$root/backups/storage-$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$archive" .age).age"
[[ ! -e "$final" && ! -L "$final" ]] || { printf '%s\n' 'storage_backup_destination_exists' >&2; exit 1; }
mv -- "$archive" "$final"
trap - EXIT
printf '%s\n' "$final"
