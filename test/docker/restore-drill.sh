#!/usr/bin/env bash
# Restore drill (deploy guide, "Backups"): Appdata Backup saves the whole /data folder; restoring that folder
# brings Genie back with the same secrets and data. Restoring app.db without secrets/ generates new keys,
# which is the failure the guide warns about (the stored Discord credentials can't be unsealed any more).
#
#   test/docker/restore-drill.sh [image]        default image: genie:test
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

IMAGE="${1:-genie:test}"
PUID=1234
PGID=2345
NAME="genie-restore-$$"
DATA="$(mktemp -d)"
BACKUP="$(mktemp -d)"
PARTIAL="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  for dir in "$DATA" "$BACKUP" "$PARTIAL"; do wipe "$IMAGE" "$dir"; done
}
trap cleanup EXIT

start() { docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -v "$1:/data" "$IMAGE" >/dev/null; wait_healthy "$NAME"; }
stop() { docker stop "$NAME" >/dev/null; docker rm "$NAME" >/dev/null; }
# sql <dir> <statement>: runs SQL against a stopped install's app.db, as PUID (what the app runs as).
sql() {
  docker run --rm --user "$PUID:$PGID" -v "$1:/data" --entrypoint node "$IMAGE" -e "
    const Database = require('/app/.output/server/node_modules/better-sqlite3');
    const db = new Database('/data/app.db');
    const out = db.prepare(process.argv[1]).all?.() ?? null;
    console.log(JSON.stringify(out)); db.close();" "$2" 2>/dev/null || true
}
secrets() { docker run --rm -v "$1:/data" --entrypoint sh "$IMAGE" -c 'cat /data/secrets/session-password /data/secrets/vault.key'; }
# copy <from> <to> [what]: copies (part of) one data folder into another, keeping owners and modes.
copy() { docker run --rm -v "$1:/from" -v "$2:/to" --entrypoint sh "$IMAGE" -c "cd /from && cp -a ${3:-.} /to/"; }

echo "an install that has run once, with data in it"
start "$DATA"
stop
docker run --rm --user "$PUID:$PGID" -v "$DATA:/data" --entrypoint node "$IMAGE" -e "
  const Database = require('/app/.output/server/node_modules/better-sqlite3');
  const db = new Database('/data/app.db');
  db.prepare('insert into organizer_allowlist (discord_user_id, added_at) values (?, ?)').run('100000000000000042', 1);
  db.close();" >/dev/null
ORIGINAL_SECRETS="$(secrets "$DATA")"
MIGRATIONS="$(sql "$DATA" 'select count(*) as n from __drizzle_migrations')"

echo "restore the whole folder (what Appdata Backup saves)"
copy "$DATA" "$BACKUP"
start "$BACKUP"
check "the restored install is healthy" true
check "the secrets are the same" test "$(secrets "$BACKUP")" = "$ORIGINAL_SECRETS"
check "the startup log says the secrets were loaded, not generated" \
  bash -c "docker logs '$NAME' 2>&1 | grep -q 'Vault key: loaded from' && ! docker logs '$NAME' 2>&1 | grep -q 'generated into'"
stop
check "the data is there" test "$(sql "$BACKUP" 'select discord_user_id as id from organizer_allowlist')" = '[{"id":"100000000000000042"}]'
check "no migration ran twice" test "$(sql "$BACKUP" 'select count(*) as n from __drizzle_migrations')" = "$MIGRATIONS"

echo "restore app.db without secrets/ (what the guide warns against)"
copy "$DATA" "$PARTIAL" 'app.db'
start "$PARTIAL"
check "new keys are generated, and the log says so" \
  bash -c "docker logs '$NAME' 2>&1 | grep -q 'Vault key: generated into'"
check "they differ from the originals" test "$(secrets "$PARTIAL")" != "$ORIGINAL_SECRETS"
stop

finish
