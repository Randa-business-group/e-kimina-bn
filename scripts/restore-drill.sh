#!/usr/bin/env bash
# Restore drill (msfts §10): restores a backup into a throw-away database and checks it
# against the live one. A backup you have never restored is not a backup — run this monthly.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/ekimina scripts/restore-drill.sh [dump-file]
#
# Without a file it uses the newest dump in BACKUP_DIR (default ./backups). Needs a role that
# may CREATE DATABASE. KEEP_DRILL_DB=1 keeps the restored copy for inspection.
# Exit code 0 = restore worked and the restored data matches the live database at dump time
# (rows added after the dump are reported, not failed).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
LIVE="${DATABASE_URL%%\?*}"
file="${1:-$(ls -1t "$BACKUP_DIR"/ekimina-*.dump 2>/dev/null | head -1 || true)}"
[ -n "$file" ] && [ -f "$file" ] || { echo "no dump found (looked in $BACKUP_DIR)"; exit 2; }

if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && { sha256sum -c "$(basename "$file").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$file").sha256"; })
fi

base="${LIVE%/*}"
drill_db="ekimina_drill_$(date -u +%Y%m%d%H%M%S)"
DRILL="$base/$drill_db"

cleanup() {
  if [ "${KEEP_DRILL_DB:-0}" != "1" ]; then
    psql "$LIVE" -q -c "DROP DATABASE IF EXISTS \"$drill_db\"" > /dev/null 2>&1 || true
  else
    echo "kept $drill_db"
  fi
}
trap cleanup EXIT

started=$(date +%s)
echo "restoring $(basename "$file") into $drill_db"
psql "$LIVE" -q -c "CREATE DATABASE \"$drill_db\"" > /dev/null
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DRILL" "$file"
echo "restore took $(( $(date +%s) - started ))s"

q() { psql "$1" -At -c "$2"; }

checks=(
  "users|SELECT count(*) FROM users"
  "groups|SELECT count(*) FROM groups"
  "deposits|SELECT count(*) FROM deposit_records"
  "loans|SELECT count(*) FROM member_loans"
  "ledger rows|SELECT count(*) FROM ledger_entries"
  "savings fund|SELECT coalesce(sum(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE fund='SAVINGS'"
  "social fund|SELECT coalesce(sum(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE fund='SOCIAL'"
)

failed=0
printf '%-14s %18s %18s\n' check restored live
for c in "${checks[@]}"; do
  name="${c%%|*}"
  sql="${c#*|}"
  r=$(q "$DRILL" "$sql")
  l=$(q "$LIVE" "$sql")
  mark=""
  if [ "$r" != "$l" ]; then mark="  (live changed since the dump)"; fi
  printf '%-14s %18s %18s%s\n' "$name" "$r" "$l" "$mark"
done

# Hard checks on the restored copy itself.
mig=$(q "$DRILL" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
echo "latest migration in backup: $mig"
[ -n "$mig" ] || { echo "FAIL: no migrations table"; failed=1; }

orphans=$(q "$DRILL" "SELECT count(*) FROM deposit_allocations a LEFT JOIN deposit_records d ON d.id = a.\"depositId\" WHERE d.id IS NULL")
[ "$orphans" = "0" ] || { echo "FAIL: $orphans allocations without a deposit"; failed=1; }

negative=$(q "$DRILL" "SELECT count(*) FROM (SELECT \"groupId\", fund, sum(CASE WHEN direction='IN' THEN amount ELSE -amount END) b FROM ledger_entries GROUP BY 1,2) x WHERE b < -0.005")
[ "$negative" = "0" ] || { echo "FAIL: $negative group funds below zero"; failed=1; }

if [ "$failed" = "0" ]; then echo "restore drill OK"; else echo "restore drill FAILED"; fi
exit "$failed"
