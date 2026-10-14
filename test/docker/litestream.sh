#!/usr/bin/env bash
# Optional Litestream (ADR-0009, the kit's entrypoint): with a replica URL set, the database is replicated, and a
# fresh /data restores it from the replica at boot. The kit's own container tests cover the failure modes.
#
#   test/docker/litestream.sh [image]        default image: genie:test
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

IMAGE="${1:-genie:test}"
PUID=1234
PGID=2345
NAME="genie-litestream-$$"
LOG_CONTAINER="$NAME"
DATA="$(mktemp -d)"
FRESH="$(mktemp -d)"
REPLICA="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  for dir in "$DATA" "$FRESH" "$REPLICA"; do wipe "$IMAGE" "$dir"; done
}
trap cleanup EXIT

# The replica folder must be writable by PUID, as an Unraid share would be.
docker run --rm -v "$REPLICA:/replica" --entrypoint chown "$IMAGE" "$PUID:$PGID" /replica

start() {
  docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL=file:///replica \
    -v "$1:/data" -v "$REPLICA:/replica" "$IMAGE" >/dev/null
  wait_healthy "$NAME"
}
replica_files() { docker run --rm -v "$REPLICA:/replica" --entrypoint sh "$IMAGE" -c 'find /replica -type f | wc -l'; }

echo "replicating"
start "$DATA"
check "the entrypoint says it is replicating" bash -c "docker logs '$NAME' 2>&1 | grep -q '\[entrypoint\] litestream: replicating /data/app.db to file:///replica'"
replicated=false
for _ in $(seq 1 30); do
  if [ "$(replica_files)" -gt 0 ]; then replicated=true; break; fi
  sleep 1
done
check "the replica receives data within 30 s" test "$replicated" = true
KEY="$(docker exec "$NAME" cat /data/secrets/vault.key)"
check "the vault key never reaches the replica" \
  test "$(docker run --rm -v "$REPLICA:/replica" --entrypoint sh "$IMAGE" -c "grep -rlF '$KEY' /replica | wc -l")" = 0
started=$(date +%s)
docker stop "$NAME" >/dev/null
check "stops within Docker's 10 s timeout under Litestream" test $(( $(date +%s) - started )) -lt 10
check "the exit code is clean (not SIGKILL)" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 137
docker rm "$NAME" >/dev/null

echo "a fresh /data restores from the replica"
start "$FRESH"
check "the entrypoint restored app.db from the replica" \
  bash -c "docker logs '$NAME' 2>&1 | grep -q '\[entrypoint\] litestream: restored /data/app.db from replica'"
docker stop "$NAME" >/dev/null; docker rm "$NAME" >/dev/null

finish
