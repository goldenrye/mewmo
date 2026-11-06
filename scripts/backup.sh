#!/bin/sh
set -eu
umask 077

case "${BACKUP_INTERVAL_SECONDS:-86400}" in *[!0-9]*|"") echo "Invalid interval"; exit 1;; esac
case "${BACKUP_RETENTION_DAYS:-14}" in *[!0-9]*|"") echo "Invalid retention"; exit 1;; esac
[ "${BACKUP_INTERVAL_SECONDS:-86400}" -ge 60 ] || exit 1
[ "${BACKUP_RETENTION_DAYS:-14}" -ge 1 ] || exit 1
backup_dir="${BACKUP_DIR:-/backups}"
mkdir -p "$backup_dir"
temp=""
trap '[ -z "$temp" ] || rm -f "$temp"; exit 0' INT TERM
while :; do
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    temp=$(mktemp "$backup_dir/.mewmo-XXXXXX")
    if pg_dump --format=custom --no-owner --no-acl --file="$temp" \
       && pg_restore --list "$temp" >/dev/null; then
        mv "$temp" "$backup_dir/mewmo-${stamp}-${temp##*-}.dump"
        temp=""
        find "$backup_dir" -name 'mewmo-*.dump' -type f -mtime "+${BACKUP_RETENTION_DAYS:-14}" -delete
        echo "Mewmo backup completed: ${stamp}"
        [ "${BACKUP_ONCE:-0}" != "1" ] || exit 0
    else
        rm -f "$temp"
        temp=""
        echo "Mewmo backup failed; check database access" >&2
        [ "${BACKUP_ONCE:-0}" != "1" ] || exit 1
    fi
    sleep "${BACKUP_INTERVAL_SECONDS:-86400}" &
    wait $!
done
