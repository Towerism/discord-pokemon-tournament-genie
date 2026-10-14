#!/usr/bin/env bash
# Container smoke test for the `app` image (ADR-0009): the entrypoint, ownership, secrets, the setup code, the
# origin rule, logs, graceful stop and a restart that keeps state.
#
#   test/docker/smoke.sh [image]        default image: genie:test
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

IMAGE="${1:-genie:test}"
PUID=1234
PGID=2345
NAME="genie-smoke-$$"
LOG_CONTAINER="$NAME"
DATA="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  wipe "$IMAGE" "$DATA"
}
trap cleanup EXIT

start() {
  docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -e TZ=America/Chicago -v "$DATA:/data" "$@" "$IMAGE" >/dev/null
  wait_healthy "$NAME"
}
in_container() { docker exec "$NAME" "$@"; }
# The oldest node process is the server (later ones are our own `docker exec node`). Matched on argv[0]:
# Node 24 renames its main thread, so /proc/<pid>/comm isn't "node".
server_owner() {
  in_container sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$" | sort -n); do
    exe=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null | head -n 1)
    [ "${exe##*/}" = node ] && { stat -c "%u:%g" /proc/$p; break; }; done'
}
CODE_LINE='^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\] INFO: \[setup\] Setup isn.t finished\. Open /setup and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}$'

echo "first boot"
start
check "app.db is owned by PUID:PGID" test "$(in_container stat -c '%u:%g' /data/app.db)" = "$PUID:$PGID"
check "secrets/ is 0700 and owned by PUID" test "$(in_container stat -c '%a %u' /data/secrets)" = "700 $PUID"
for f in session-password vault.key; do
  check "secrets/$f is 0600 and owned by PUID" test "$(in_container stat -c '%a %u' /data/secrets/$f)" = "600 $PUID"
done
check "the server runs as PUID:PGID, not root" test "$(server_owner)" = "$PUID:$PGID"
check "exactly one setup-code line, in the exact form the deploy guide shows" \
  test "$(docker logs "$NAME" 2>&1 | grep -Ec "$CODE_LINE")" = 1
check "no secret value in the log" bash -c "
  ! docker logs '$NAME' 2>&1 | grep -qF \"\$(docker exec '$NAME' cat /data/secrets/session-password)\" &&
  ! docker logs '$NAME' 2>&1 | grep -qF \"\$(docker exec '$NAME' cat /data/secrets/vault.key)\""
check "the log is human-readable by default: no JSON records" bash -c "! docker logs '$NAME' 2>&1 | grep -q '^{\"level\"'"
check "TZ is honoured by the server's runtime" in_node "$NAME" \
  "process.exit(Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Chicago' && new Date('2026-01-15T12:00:00Z').getTimezoneOffset() === 360 ? 0 : 1)"
check "the setup wizard answers on localhost" in_node "$NAME" "
  fetch('http://127.0.0.1:3001/api/setup', { headers: { host: 'localhost:3001' } })
    .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
check "secrets are refused on a LAN address (ADR-0013)" in_node "$NAME" "
  const http = require('node:http');
  const req = http.request({ host: '127.0.0.1', port: 3001, path: '/api/setup/unlock', method: 'POST',
    headers: { host: '192.168.1.5:3001', 'content-type': 'application/json' } }, (res) => {
    let body = ''; res.on('data', (c) => (body += c));
    res.on('end', () => process.exit(res.statusCode === 403 && body.includes('insecure_origin') ? 0 : 1));
  });
  req.on('error', () => process.exit(1)); req.end(JSON.stringify({ code: 'AAAA-AAAA' }));"
check "the image carries no spikes, tests or .env files" \
  in_container sh -c '! test -e /app/spikes && ! test -e /app/test && ! find /app -name ".env*" -not -path "*/node_modules/*" | grep -q .'

SESSION="$(in_container cat /data/secrets/session-password)"
VAULT="$(in_container cat /data/secrets/vault.key)"
FIRST_CODE="$(docker logs "$NAME" 2>&1 | grep -Eo '[A-Z2-9]{4}-[A-Z2-9]{4}$' | tail -1)"

started=$(date +%s)
docker stop "$NAME" >/dev/null
check "stops gracefully within the 10 s timeout" test $(( $(date +%s) - started )) -lt 10
check "the exit code is clean (not SIGKILL)" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 137
docker rm "$NAME" >/dev/null

echo "second boot (same /data)"
start
check "the secrets are kept byte for byte" \
  test "$(in_container cat /data/secrets/session-password)$(in_container cat /data/secrets/vault.key)" = "$SESSION$VAULT"
check "the startup log says they were loaded, not generated" \
  bash -c "docker logs '$NAME' 2>&1 | grep -q 'Vault key: loaded from' && ! docker logs '$NAME' 2>&1 | grep -q 'generated into'"
check "setup is still open, so a new code is printed" bash -c "
  code=\$(docker logs '$NAME' 2>&1 | grep -Eo '[A-Z2-9]{4}-[A-Z2-9]{4}\$' | tail -1); [ -n \"\$code\" ] && [ \"\$code\" != '$FIRST_CODE' ]"
check "the image HEALTHCHECK reports healthy" bash -c "
  for _ in \$(seq 1 40); do
    [ \"\$(docker inspect -f '{{.State.Health.Status}}' '$NAME')\" = healthy ] && exit 0; sleep 1
  done; exit 1"

docker rm -f "$NAME" >/dev/null
wipe "$IMAGE" "$DATA"
DATA="$(mktemp -d)"

echo "fresh boot with NUXT_LOG_FORMAT=json"
start -e NUXT_LOG_FORMAT=json
check "the setup-code line is a JSON record" \
  grep -Eq '^\{"level":30,.*"scope":"setup","msg":"Setup isn.t finished\. Open /setup and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}"' <(docker logs "$NAME" 2>&1)

finish
