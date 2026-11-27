#!/usr/bin/env bash
# PostgreSQL backup for E-kimina (msfts §10). Financial data: run it at least daily.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/ekimina scripts/backup.sh
#
# Env:
#   BACKUP_DIR               where dumps go (default ./backups)
#   BACKUP_RETENTION_DAYS    delete local dumps older than this (default 14)
#   BACKUP_GPG_RECIPIENT     encrypt the dump for this GPG key (recommended off-site)
#   BACKUP_UPLOAD_CMD        copy the file off the server; "{file}" is replaced, e.g.
#                            'aws s3 cp {file} s3://my-bucket/ekimina/' or 'rclone copy {file} remote:ekimina'
#
# Cron example (02:30 every night):
#   30 2 * * * cd /srv/ekimina-api && DATABASE_URL=... scripts/backup.sh >> /var/log/ekimina-backup.log 2>&1
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
URL="${DATABASE_URL%%\?*}" # pg_dump does not accept Prisma's ?schema=… parameter

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$BACKUP_DIR/ekimina-$stamp.dump"

echo "[$(date -u +%FT%TZ)] dumping database → $file"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$file" "$URL"

# Prove the archive is readable before trusting it.
pg_restore --list "$file" > /dev/null
size=$(wc -c < "$file" | tr -d ' ')

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$file.gpg" --encrypt "$file"
  rm -f "$file"
  file="$file.gpg"
fi

if command -v sha256sum > /dev/null; then
  sha256sum "$file" > "$file.sha256"
else
  shasum -a 256 "$file" > "$file.sha256"
fi

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  echo "[$(date -u +%FT%TZ)] uploading"
  eval "${BACKUP_UPLOAD_CMD//\{file\}/$file}"
  eval "${BACKUP_UPLOAD_CMD//\{file\}/$file.sha256}"
fi

find "$BACKUP_DIR" -name 'ekimina-*.dump*' -type f -mtime "+$RETENTION" -print -delete || true

echo "[$(date -u +%FT%TZ)] backup ok: $file ($size bytes)"
